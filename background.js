// ─── Helpers ───

const MAX_SESSION_SECONDS = 7200; // 2-hour cap — anything longer is likely a tracking error
const ACTIVE_SESSION_STALE_MS = 45000;
const STARTUP_STALE_SESSION_MS = 5 * 60 * 1000;
const NOTIFICATION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
// A tag set on a site survives a quick detour to another tab and back, so
// "mark this as distracting" does not evaporate the moment you check your email.
const SESSION_LABEL_CARRY_MS = 5 * 60 * 1000;

// A deviation has to clear this many median-absolute-deviations from your own
// trailing median before it counts as unusual. Fixed multipliers of the mean
// (the old "1.8x") fire constantly on light days and never on heavy ones.
const DEVIATION_MAD_THRESHOLD = 3;
const DEVIATION_MIN_DAYS = 7;
const DEVIATION_MIN_SECONDS = 15 * 60;

const VALID_LABELS = ['productive', 'neutral', 'distracting'];

const LABEL_BADGES = {
  productive: { text: 'P', color: '#4A6552' },
  neutral: { text: 'N', color: '#7D776B' },
  distracting: { text: 'D', color: '#B03A2B' }
};

const DEFAULT_NOTIFICATION_PREFS = {
  budgetAlerts: true,
  deviationAlerts: false
};

const DEFAULT_TRACKING_PREFS = {
  idleDetection: true,
  idleThresholdSeconds: 180,
  ignoreIdleWhenPlaying: true
};

function getDomain(url) {
  if (!url || url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('moz-extension://')) {
    return null;
  }
  if (url.startsWith('file://') || url.toLowerCase().endsWith('.pdf')) {
    return 'Document';
  }
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    return hostname;
  } catch (e) {
    return null;
  }
}

function getPath(url) {
  try {
    return new URL(url).pathname || '/';
  } catch (e) {
    return null;
  }
}

function getDateString(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTodayString() {
  return getDateString(Date.now());
}

function getWeekStartString(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const day = date.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - mondayOffset);
  date.setHours(0, 0, 0, 0);
  return getDateString(date.getTime());
}

function getStartOfDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// Date arithmetic rather than +24h, so DST-shortened/lengthened days still land
// on real local midnight.
function getNextMidnight(timestamp) {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

function normalizeLabel(label) {
  if (label === 'distraction') return 'distracting';
  return VALID_LABELS.includes(label) ? label : null;
}

function isDayKey(key) {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

// ─── Session State ───

let memDomain = null;
let memStartTime = null;
let memLastSeenAt = null;
let memLabel = null;
// Held for rule evaluation only. The path is never written to history — knowing
// which article you read is a different privacy proposition from knowing which
// site you were on, and this extension only promises the second.
let memPath = null;

async function getActiveSession() {
  if (memDomain !== null && memStartTime !== null) {
    return {
      currentDomain: memDomain,
      sessionStartTime: memStartTime,
      lastSeenAt: memLastSeenAt,
      sessionLabel: memLabel
    };
  }

  const data = await browser.storage.local.get('activeSession');
  if (data.activeSession && data.activeSession.currentDomain) {
    memDomain = data.activeSession.currentDomain;
    memStartTime = data.activeSession.sessionStartTime;
    memLastSeenAt = data.activeSession.lastSeenAt || data.activeSession.sessionStartTime;
    memLabel = data.activeSession.sessionLabel || null;
    return { ...data.activeSession, sessionLabel: memLabel };
  }
  return { currentDomain: null, sessionStartTime: null, lastSeenAt: null, sessionLabel: null };
}

async function setActiveSession(domain, startTime, lastSeenAt = startTime, sessionLabel = null) {
  memDomain = domain;
  memStartTime = startTime;
  memLastSeenAt = lastSeenAt;
  memLabel = sessionLabel;
  if (!domain) memPath = null;
  await browser.storage.local.set({
    activeSession: { currentDomain: domain, sessionStartTime: startTime, lastSeenAt, sessionLabel }
  });
}

async function touchActiveSession(timestamp) {
  const { currentDomain, sessionStartTime, sessionLabel } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return;
  await setActiveSession(currentDomain, sessionStartTime, timestamp, sessionLabel);
}

// ─── Label rules ───
//
// A label is not a property of a domain. youtube.com is research during a thesis
// session and a sink at midnight, and every tool in this category gets this
// wrong by storing one label per host. A rule carries a condition; the first
// rule whose condition matches wins, and a rule with an empty condition is the
// domain's default.
//
//   labelRules[domain] = [
//     { label: 'productive',  when: { project: 'Thesis' } },
//     { label: 'distracting', when: { fromHour: 22, toHour: 6 } },
//     { label: 'neutral',     when: {} }
//   ]

async function getLabelRules() {
  const data = await browser.storage.local.get(['labelRules', 'productivityLabels']);
  if (data.labelRules) return data.labelRules;

  // One-time migration from the flat domain -> label map.
  const legacy = data.productivityLabels || {};
  const migrated = {};
  Object.entries(legacy).forEach(([domain, label]) => {
    const normalized = normalizeLabel(label);
    if (normalized) migrated[domain] = [{ label: normalized, when: {} }];
  });
  await browser.storage.local.set({ labelRules: migrated });
  await browser.storage.local.remove('productivityLabels');
  return migrated;
}

function hourInWindow(hour, fromHour, toHour) {
  if (fromHour === toHour) return true;
  // A window like 22 -> 6 wraps past midnight.
  return fromHour < toHour
    ? hour >= fromHour && hour < toHour
    : hour >= fromHour || hour < toHour;
}

function ruleMatches(rule, context) {
  const when = rule.when || {};
  if (when.project && when.project !== context.project) return false;
  if (when.path) {
    if (!context.path || !context.path.startsWith(when.path)) return false;
  }
  if (typeof when.fromHour === 'number' && typeof when.toHour === 'number') {
    const hour = new Date(context.at).getHours();
    if (!hourInWindow(hour, when.fromHour, when.toHour)) return false;
  }
  return true;
}

// True when the rule depends on something that cannot be reconstructed from a
// stored session later — which decides whether the resolved label has to be
// frozen onto the record at save time.
function ruleIsConditional(rule) {
  const when = rule.when || {};
  return Boolean(when.project || when.path || typeof when.fromHour === 'number');
}

function resolveLabelFromRules(rules, domain, context) {
  const domainRules = (rules && rules[domain]) || [];
  for (const rule of domainRules) {
    if (ruleMatches(rule, context)) {
      return { label: normalizeLabel(rule.label), conditional: ruleIsConditional(rule) };
    }
  }
  return { label: null, conditional: false };
}

async function resolveLabelForDomain(domain, overrides = {}) {
  if (!domain) return { label: null, conditional: false };
  const rules = await getLabelRules();
  const focus = await getActiveProjectFocus();
  return resolveLabelFromRules(rules, domain, {
    at: overrides.at || Date.now(),
    path: overrides.path !== undefined ? overrides.path : memPath,
    project: overrides.project !== undefined ? overrides.project : (focus ? focus.projectName : null)
  });
}

// ─── Session labels ───

async function getLabelCarry() {
  const data = await browser.storage.local.get('sessionLabelCarry');
  const carry = data.sessionLabelCarry || {};
  const now = Date.now();
  let changed = false;
  Object.entries(carry).forEach(([domain, entry]) => {
    if (!entry || !entry.expiresAt || entry.expiresAt < now) {
      delete carry[domain];
      changed = true;
    }
  });
  if (changed) await browser.storage.local.set({ sessionLabelCarry: carry });
  return carry;
}

async function rememberLabelCarry(domain, label) {
  if (!domain) return;
  const carry = await getLabelCarry();
  if (label) {
    carry[domain] = { label, expiresAt: Date.now() + SESSION_LABEL_CARRY_MS };
  } else {
    delete carry[domain];
  }
  await browser.storage.local.set({ sessionLabelCarry: carry });
}

async function getCarriedLabel(domain) {
  if (!domain) return null;
  const carry = await getLabelCarry();
  const entry = carry[domain];
  return entry ? normalizeLabel(entry.label) : null;
}

// Applies a tag to the session that is running right now. The label is stored on
// the live session and written into the record when the session is finalized, so
// the time you are spending as you press the button lands in the right bucket.
async function setActiveSessionLabel(label) {
  const normalized = normalizeLabel(label);
  const { currentDomain, sessionStartTime, lastSeenAt } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return { ok: false, reason: 'no-active-session' };

  await setActiveSession(currentDomain, sessionStartTime, lastSeenAt, normalized);
  await rememberLabelCarry(currentDomain, normalized);
  await updateBadge();
  return { ok: true, domain: currentDomain, label: normalized };
}

// Writes the domain's unconditional default — the rule with an empty condition.
// Conditional rules above it are left alone, so pinning a default never silently
// destroys a "productive during Thesis" rule the user set earlier.
async function setDomainDefaultLabel(domain, label) {
  if (!domain) return { ok: false, reason: 'no-domain' };
  const normalized = normalizeLabel(label);
  const rules = await getLabelRules();
  const existing = (rules[domain] || []).filter(rule => ruleIsConditional(rule));

  if (normalized) {
    rules[domain] = [...existing, { label: normalized, when: {} }];
  } else if (existing.length) {
    rules[domain] = existing;
  } else {
    delete rules[domain];
  }

  await browser.storage.local.set({ labelRules: rules });
  await updateBadge();
  return { ok: true, domain, label: normalized };
}

// ─── Toolbar badge ───

async function updateBadge() {
  try {
    const { currentDomain, sessionLabel } = await getActiveSession();
    const resolved = currentDomain ? await resolveLabelForDomain(currentDomain) : { label: null };
    const effective = normalizeLabel(sessionLabel) || resolved.label;
    const badge = effective ? LABEL_BADGES[effective] : null;

    await browser.action.setBadgeText({ text: badge ? badge.text : '' });
    if (badge) {
      await browser.action.setBadgeBackgroundColor({ color: badge.color });
      if (browser.action.setBadgeTextColor) {
        await browser.action.setBadgeTextColor({ color: '#FFFFFF' });
      }
    }
  } catch (error) {
    console.warn('Badge update failed:', error);
  }
}

// ─── Preferences ───

async function getActiveProjectFocus() {
  const data = await browser.storage.local.get('activeProjectFocus');
  const focus = data.activeProjectFocus;
  if (!focus || !focus.projectName || !focus.startTime) return null;
  return focus;
}

async function getNotificationPrefs() {
  const data = await browser.storage.local.get('notificationPrefs');
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(data.notificationPrefs || {}) };
}

async function getTrackingPrefs() {
  const data = await browser.storage.local.get('trackingPrefs');
  return { ...DEFAULT_TRACKING_PREFS, ...(data.trackingPrefs || {}) };
}

async function getNotificationState() {
  const data = await browser.storage.local.get('notificationState');
  return data.notificationState || { budgetAlerts: {}, deviationAlerts: {} };
}

async function setNotificationState(state) {
  await browser.storage.local.set({ notificationState: state });
}

// Dedup markers are only meaningful for the period they belong to. Without this
// the two maps grow by one entry per project/domain per week/day, forever.
function pruneNotificationState(state) {
  const weekStart = getWeekStartString();
  const todayKey = getTodayString();

  state.budgetAlerts = Object.fromEntries(
    Object.entries(state.budgetAlerts || {}).filter(([key]) => key.startsWith(`${weekStart}:`))
  );
  state.deviationAlerts = Object.fromEntries(
    Object.entries(state.deviationAlerts || {}).filter(([key]) => key.startsWith(`${todayKey}:`))
  );
  return state;
}

async function createNotification(id, title, message) {
  try {
    await browser.notifications.create(id, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon.svg'),
      title,
      message
    });
  } catch (error) {
    console.warn('Notification failed:', error);
  }
}

function getWeekDateKeys(weekStart) {
  const keys = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(getStartOfDay(weekStart));
    day.setDate(day.getDate() + i);
    keys.push(getDateString(day.getTime()));
  }
  return keys;
}

function getTrailingDateKeys(days, endTimestamp = Date.now()) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(endTimestamp);
    day.setDate(day.getDate() - i);
    keys.push(getDateString(day.getTime()));
  }
  return keys;
}

function sessionsOf(dayData) {
  return dayData && Array.isArray(dayData.sessions) ? dayData.sessions : [];
}

async function maybeSendBudgetAlerts() {
  const prefs = await getNotificationPrefs();
  if (!prefs.budgetAlerts) return;

  // Only this week's days are needed — reading the whole store here meant every
  // check scanned the entire history.
  const weekStart = getWeekStartString();
  const dateKeys = getWeekDateKeys(weekStart);

  const allData = await browser.storage.local.get([...dateKeys, 'projectMappings', 'projectGoals']);
  const projectMappings = allData.projectMappings || {};
  const projectGoals = allData.projectGoals || {};
  const totals = {};

  dateKeys.forEach((dateKey) => {
    sessionsOf(allData[dateKey]).forEach((session) => {
      const projectName = session.projectFocus || projectMappings[session.domain];
      if (!projectName) return;
      totals[projectName] = (totals[projectName] || 0) + session.duration;
    });
  });

  const state = pruneNotificationState(await getNotificationState());

  // Only projects with a goal the user actually set. A project with no goal gets
  // no progress bar and no notification, rather than an invented 8 hours.
  for (const [projectName, goalSecs] of Object.entries(projectGoals)) {
    const total = totals[projectName] || 0;
    const stateKey = `${weekStart}:${projectName}`;
    if (goalSecs > 0 && total >= goalSecs && !state.budgetAlerts[stateKey]) {
      await createNotification(
        `budget-${stateKey}`,
        'Weekly goal reached',
        `${projectName} has reached its weekly goal of ${Math.round(goalSecs / 3600)}h.`
      );
      state.budgetAlerts[stateKey] = true;
    }
  }

  await setNotificationState(state);
}

// ─── Deviation detection ───
//
// Median and median-absolute-deviation rather than mean and a fixed multiplier.
// MAD is robust to the handful of outlier days that every real history contains,
// so "unusual" is measured against your own spread instead of against a constant
// somebody picked.

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianAbsoluteDeviation(values, center) {
  if (!values.length) return 0;
  // 1.4826 rescales MAD to be comparable to a standard deviation for normal data.
  return 1.4826 * median(values.map(value => Math.abs(value - center)));
}

// MAD is exactly zero for a perfectly steady series — a site you open for the
// same ten minutes every day. That is the case where a spike is most obviously
// unusual, so flooring the spread keeps it detectable instead of dividing by
// zero and silently skipping it. The floor is relative to the median so it
// scales, with an absolute minimum so tiny habits do not fire on a stray minute.
function spreadOf(values, center) {
  return Math.max(medianAbsoluteDeviation(values, center), center * 0.15, 60);
}

function findDeviations(dailyTotalsByDomain, todayTotals) {
  const deviations = [];

  Object.entries(todayTotals).forEach(([domain, todayTotal]) => {
    const history = dailyTotalsByDomain[domain] || [];
    if (todayTotal < DEVIATION_MIN_SECONDS) return;

    if (history.length < DEVIATION_MIN_DAYS) {
      // Not enough history to say what normal looks like. A domain with no prior
      // days at all is genuinely new, which is worth one line and no arithmetic.
      if (history.length === 0) {
        deviations.push({ domain, kind: 'new', todayTotal });
      }
      return;
    }

    const center = median(history);
    const score = (todayTotal - center) / spreadOf(history, center);
    if (score >= DEVIATION_MAD_THRESHOLD) {
      deviations.push({ domain, kind: 'high', todayTotal, median: center, score });
    }
  });

  return deviations.sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function maybeSendDeviationAlerts() {
  const prefs = await getNotificationPrefs();
  if (!prefs.deviationAlerts) return;

  const todayKey = getTodayString();
  const historyKeys = getTrailingDateKeys(29).filter(key => key !== todayKey);
  const allData = await browser.storage.local.get([todayKey, ...historyKeys]);

  const dailyTotalsByDomain = {};
  historyKeys.forEach((dateKey) => {
    const dayTotals = {};
    sessionsOf(allData[dateKey]).forEach((session) => {
      if (!session.domain) return;
      dayTotals[session.domain] = (dayTotals[session.domain] || 0) + (session.duration || 0);
    });
    Object.entries(dayTotals).forEach(([domain, total]) => {
      (dailyTotalsByDomain[domain] = dailyTotalsByDomain[domain] || []).push(total);
    });
  });

  const todayTotals = {};
  sessionsOf(allData[todayKey]).forEach((session) => {
    if (!session.domain) return;
    todayTotals[session.domain] = (todayTotals[session.domain] || 0) + (session.duration || 0);
  });

  const state = pruneNotificationState(await getNotificationState());
  const deviations = findDeviations(dailyTotalsByDomain, todayTotals).slice(0, 1);

  for (const deviation of deviations) {
    const stateKey = `${todayKey}:${deviation.domain}`;
    if (state.deviationAlerts[stateKey]) continue;

    const message = deviation.kind === 'new'
      ? `${deviation.domain} is new — it has no prior history in the last 28 days.`
      : `${deviation.domain} is at ${Math.round(deviation.todayTotal / 60)} min today against a typical ${Math.round(deviation.median / 60)} min.`;

    await createNotification(`deviation-${stateKey}`, 'Unusual for you', message);
    state.deviationAlerts[stateKey] = true;
  }

  await setNotificationState(state);
}

// ─── Save a completed session ───

async function saveSession(domain, startTime, endTime, sessionLabel = null) {
  const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
  if (durationSeconds < 1) return;

  const activeProjectFocus = await getActiveProjectFocus();
  const projectFocus = activeProjectFocus && activeProjectFocus.startTime <= endTime
    ? activeProjectFocus.projectName
    : null;

  let productivityLabel = normalizeLabel(sessionLabel);

  // A rule that depends on the clock, the path, or the active project cannot be
  // re-evaluated once the session is history — the context is gone. Freeze those
  // onto the record. An unconditional default is deliberately *not* frozen, so
  // retagging a domain later still corrects its past sessions.
  if (!productivityLabel) {
    const resolved = await resolveLabelForDomain(domain, { at: startTime, project: projectFocus });
    if (resolved.label && resolved.conditional) productivityLabel = resolved.label;
  }

  // Walk day boundaries so a session that crosses one *or more* midnights is
  // attributed to every day it actually touched, rather than dumping the whole
  // span onto the first and last day.
  let sliceStart = startTime;
  while (sliceStart < endTime) {
    const dateKey = getDateString(sliceStart);
    const sliceEnd = Math.min(endTime, getNextMidnight(sliceStart));
    const sliceSeconds = Math.max(0, Math.floor((sliceEnd - sliceStart) / 1000));

    if (sliceSeconds > 0) {
      const capped = sliceSeconds > MAX_SESSION_SECONDS;
      await writeToDayStorage(dateKey, {
        domain,
        start: sliceStart,
        end: sliceEnd,
        // Cap per stored slice to keep a single tracking glitch from poisoning a
        // day — but record that it happened. Silently dropping an hour of a long
        // video with no trace anywhere is worse than the glitch it guards against.
        duration: Math.min(sliceSeconds, MAX_SESSION_SECONDS),
        ...(capped ? { capped: true, uncappedDuration: sliceSeconds } : {}),
        ...(productivityLabel ? { productivityLabel } : {}),
        ...(projectFocus ? { projectFocus } : {})
      });
    }

    sliceStart = sliceEnd;
  }
}

async function writeToDayStorage(dateKey, session) {
  const data = await browser.storage.local.get(dateKey);
  let dayData = data[dateKey] && Array.isArray(data[dateKey].sessions)
    ? data[dateKey]
    : { sessions: [] };
  dayData.sessions.push(session);
  await browser.storage.local.set({ [dateKey]: dayData });
}

function buildLiveSlice(dateKey, session, activeProjectFocus) {
  const dayStart = getStartOfDay(dateKey);
  const dayEnd = dayStart + (24 * 60 * 60 * 1000);
  const activeEnd = Date.now();

  const overlapStart = Math.max(session.sessionStartTime, dayStart);
  const overlapEnd = Math.min(activeEnd, dayEnd);
  if (overlapEnd <= overlapStart) return null;

  let durationSeconds = Math.max(0, Math.floor((overlapEnd - overlapStart) / 1000));
  durationSeconds = Math.min(durationSeconds, MAX_SESSION_SECONDS);
  if (durationSeconds < 1) return null;

  const label = normalizeLabel(session.sessionLabel);
  return {
    domain: session.currentDomain,
    start: overlapStart,
    end: overlapEnd,
    duration: durationSeconds,
    ...(label ? { productivityLabel: label } : {}),
    ...(activeProjectFocus && activeProjectFocus.startTime <= overlapEnd
      ? { projectFocus: activeProjectFocus.projectName }
      : {}),
    ongoing: true
  };
}

async function getDayDataWithActiveSession(dateKey) {
  const stored = await browser.storage.local.get(dateKey);
  let dayData = stored[dateKey] && Array.isArray(stored[dateKey].sessions)
    ? stored[dateKey]
    : { sessions: [] };
  dayData = { sessions: dayData.sessions.map(session => ({ ...session })) };

  const session = await getActiveSession();
  if (!session.currentDomain || !session.sessionStartTime) return dayData;

  const activeProjectFocus = await getActiveProjectFocus();
  const slice = buildLiveSlice(dateKey, session, activeProjectFocus);
  if (slice) dayData.sessions.push(slice);

  return dayData;
}

// Reads a whole scope in one pass. The dashboard used to ask for one day at a
// time, which meant a month view issued thirty round trips through the queue.
async function getRangeData(dateKeys) {
  const keys = (dateKeys || []).filter(isDayKey);
  if (!keys.length) return { days: {} };

  const stored = await browser.storage.local.get(keys);
  const session = await getActiveSession();
  const activeProjectFocus = session.currentDomain ? await getActiveProjectFocus() : null;

  const days = {};
  keys.forEach((dateKey) => {
    const sessions = sessionsOf(stored[dateKey]).map(entry => ({ ...entry }));
    if (session.currentDomain && session.sessionStartTime) {
      const slice = buildLiveSlice(dateKey, session, activeProjectFocus);
      if (slice) sessions.push(slice);
    }
    days[dateKey] = { sessions };
  });

  return { days };
}

// ─── Finalize & Start Sessions ───

async function finalizeSession() {
  const { currentDomain, sessionStartTime, lastSeenAt, sessionLabel } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return;

  const endTime = Math.min(Date.now(), lastSeenAt || Date.now());
  const domain = currentDomain;
  const start = sessionStartTime;
  const label = sessionLabel;
  const path = memPath;

  // Reset state BEFORE saving to prevent race conditions
  await setActiveSession(null, null);
  memPath = path; // saveSession still needs it for path-conditioned rules

  await saveSession(domain, start, endTime, label);
  memPath = null;

  // Keep the tag warm briefly so returning to the same site resumes it.
  if (label) await rememberLabelCarry(domain, label);
}

async function startSession(url) {
  const domain = getDomain(url);
  const { currentDomain } = await getActiveSession();

  if (domain === currentDomain) {
    memPath = getPath(url);
    return; // Already tracking
  }

  await finalizeSession();

  if (domain) {
    const now = Date.now();
    memPath = getPath(url);
    const carried = await getCarriedLabel(domain);
    await setActiveSession(domain, now, now, carried);
  }
  await updateBadge();
}

// ─── State Checking ───

let isUserIdle = false;

async function clearStaleStartupSession() {
  const { currentDomain, lastSeenAt } = await getActiveSession();
  if (!currentDomain || !lastSeenAt) return;
  if ((Date.now() - lastSeenAt) <= STARTUP_STALE_SESSION_MS) return;

  console.log('[Flow Tracker] Cleared stale startup session');
  await setActiveSession(null, null);
}

async function isPlayingMedia(tab) {
  const prefs = await getTrackingPrefs();
  return Boolean(prefs.ignoreIdleWhenPlaying && tab && tab.audible);
}

async function checkCurrentState() {
  try {
    const window = await browser.windows.getLastFocused();
    if (!window || !window.focused) {
      await finalizeSession();
      await updateBadge();
      return;
    }

    const tabs = await browser.tabs.query({ active: true, windowId: window.id });
    const activeTab = tabs.length > 0 ? tabs[0] : null;

    // A window can be focused while nobody is at the keyboard. Stop the clock
    // unless something is actually playing in the tab.
    if (isUserIdle && !(await isPlayingMedia(activeTab))) {
      await finalizeSession();
      await updateBadge();
      return;
    }

    if (activeTab && activeTab.url) {
      const newDomain = getDomain(activeTab.url);
      const { currentDomain, lastSeenAt } = await getActiveSession();
      const now = Date.now();
      const isStale = lastSeenAt && (now - lastSeenAt) > ACTIVE_SESSION_STALE_MS;

      if (newDomain === currentDomain && !isStale) {
        memPath = getPath(activeTab.url);
        await touchActiveSession(now);
      } else if (newDomain === currentDomain && isStale) {
        await finalizeSession();
        if (newDomain) {
          memPath = getPath(activeTab.url);
          await setActiveSession(newDomain, now, now, await getCarriedLabel(newDomain));
        }
      } else {
        await startSession(activeTab.url);
      }
    } else {
      await finalizeSession();
    }

    await updateBadge();
    // Runs on every check, not only when the domain happens to change — the
    // early returns above used to make budget alerts miss entirely during a long
    // single-domain session.
    await runNotificationChecks();
  } catch (e) {
    console.error("Error checking state:", e);
    await finalizeSession();
  }
}

let lastNotificationCheckAt = 0;

async function runNotificationChecks() {
  // Both checks scan history; without throttling they would re-read storage on
  // every tab switch.
  if (Date.now() - lastNotificationCheckAt < NOTIFICATION_CHECK_INTERVAL_MS) return;
  lastNotificationCheckAt = Date.now();
  await maybeSendBudgetAlerts();
  await maybeSendDeviationAlerts();
}

// Queue for safe sequential execution
let stateQueue = Promise.resolve();

function enqueue(task) {
  const result = stateQueue.then(task, task);
  stateQueue = result.catch(e => console.error(e));
  return result;
}

function queueStateCheck() {
  enqueue(() => checkCurrentState());
}

// ─── Idle detection ───

async function syncIdleDetection() {
  const prefs = await getTrackingPrefs();
  if (!prefs.idleDetection) {
    isUserIdle = false;
    return;
  }
  // Firefox clamps the detection interval to a minimum of 15 seconds.
  const seconds = Math.max(15, Number(prefs.idleThresholdSeconds) || DEFAULT_TRACKING_PREFS.idleThresholdSeconds);
  try {
    browser.idle.setDetectionInterval(seconds);
    const state = await browser.idle.queryState(seconds);
    isUserIdle = state !== 'active';
  } catch (error) {
    console.warn('Idle detection unavailable:', error);
    isUserIdle = false;
  }
}

if (browser.idle && browser.idle.onStateChanged) {
  browser.idle.onStateChanged.addListener(async (state) => {
    const prefs = await getTrackingPrefs();
    if (!prefs.idleDetection) {
      isUserIdle = false;
      return;
    }
    isUserIdle = state !== 'active';
    queueStateCheck();
  });
}

// ─── Speed bump ───
//
// A pause, not a wall. Blocking is the intervention users reject, and it works by
// taking the choice away; this shows the number and the plan, then lets you
// through every time. Off by default, opt-in per site, and each site's host
// permission is requested individually at the moment it is enabled — nothing
// here is granted at install.

const SPEED_BUMP_COOLDOWN_MS = 30 * 60 * 1000;

async function getSpeedBumpSites() {
  const data = await browser.storage.local.get('speedBumpSites');
  return data.speedBumpSites || {};
}

function originPatternsFor(domain) {
  return [`*://${domain}/*`, `*://*.${domain}/*`];
}

async function syncSpeedBumpScripts() {
  if (!browser.scripting || !browser.scripting.registerContentScripts) return;

  const sites = await getSpeedBumpSites();
  const matches = [];

  for (const [domain, config] of Object.entries(sites)) {
    if (!config || !config.enabled) continue;
    const origins = originPatternsFor(domain);
    try {
      if (await browser.permissions.contains({ origins })) matches.push(...origins);
    } catch (error) {
      console.warn('Permission check failed for', domain, error);
    }
  }

  try {
    const existing = await browser.scripting.getRegisteredContentScripts({ ids: ['speed-bump'] });
    if (existing.length) await browser.scripting.unregisterContentScripts({ ids: ['speed-bump'] });
  } catch (error) {
    // No script registered yet — nothing to unregister.
  }

  if (!matches.length) return;

  try {
    // No stylesheet: the overlay lives in a closed shadow root and carries its
    // own styles, so nothing the page defines can reach it and nothing it
    // defines can leak out.
    await browser.scripting.registerContentScripts([{
      id: 'speed-bump',
      matches,
      js: ['content/speedbump.js'],
      runAt: 'document_idle'
    }]);
  } catch (error) {
    console.warn('Could not register the speed bump:', error);
  }
}

async function getSpeedBumpContext(domain) {
  if (!domain) return { show: false };

  const sites = await getSpeedBumpSites();
  const config = sites[domain];
  if (!config || !config.enabled) return { show: false };

  const now = Date.now();
  if (config.lastShownAt && (now - config.lastShownAt) < SPEED_BUMP_COOLDOWN_MS) {
    return { show: false };
  }

  const todayKey = getTodayString();
  const stored = await browser.storage.local.get([todayKey, 'plans']);
  const secondsToday = sessionsOf(stored[todayKey])
    .filter(session => session.domain === domain)
    .reduce((sum, session) => sum + (session.duration || 0), 0);

  sites[domain] = { ...config, lastShownAt: now };
  await browser.storage.local.set({ speedBumpSites: sites });

  return {
    show: true,
    domain,
    secondsToday,
    plan: (stored.plans || {})[domain] || null
  };
}

// ─── Event Listeners ───

browser.tabs.onActivated.addListener(queueStateCheck);

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) {
    queueStateCheck();
  }
});

browser.windows.onFocusChanged.addListener(queueStateCheck);

// Initial start
clearStaleStartupSession()
  .catch(e => console.error("Error clearing stale startup session:", e))
  .finally(queueStateCheck);
setInterval(queueStateCheck, 15000);
syncIdleDetection().catch(console.error);
syncSpeedBumpScripts().catch(console.error);
getLabelRules().then(updateBadge).catch(console.error);

// ─── Message Listener for Dashboard, Popup & Content Script ───

const handlers = {
  async getDayData(message) {
    return enqueue(() => getDayDataWithActiveSession(message.date || getTodayString()));
  },

  async getLatestData(message) {
    return enqueue(() => getDayDataWithActiveSession(message.date || getTodayString()));
  },

  async getRangeData(message) {
    // Read through the same queue as the writers, otherwise a state check can
    // land mid-read and skew the numbers.
    return enqueue(() => getRangeData(message.dates));
  },

  async getPopupContext() {
    return enqueue(async () => {
      await checkCurrentState();
      const { currentDomain, sessionStartTime, sessionLabel } = await getActiveSession();
      const todayKey = getTodayString();
      const dayData = await getDayDataWithActiveSession(todayKey);
      const domainSeconds = dayData.sessions
        .filter(s => s.domain === currentDomain)
        .reduce((sum, s) => sum + (s.duration || 0), 0);
      const totalSeconds = dayData.sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
      const untaggedSeconds = dayData.sessions
        .filter(s => !normalizeLabel(s.productivityLabel))
        .reduce((sum, s) => sum + (s.duration || 0), 0);
      const resolved = await resolveLabelForDomain(currentDomain);
      const focus = await getActiveProjectFocus();

      return {
        domain: currentDomain,
        sessionStartTime,
        sessionLabel: normalizeLabel(sessionLabel),
        ruleLabel: resolved.label,
        ruleIsConditional: resolved.conditional,
        effectiveLabel: normalizeLabel(sessionLabel) || resolved.label || null,
        domainSeconds,
        totalSeconds,
        untaggedSeconds,
        projectFocus: focus,
        isIdle: isUserIdle
      };
    });
  },

  async setSessionLabel(message) {
    return enqueue(() => setActiveSessionLabel(message.label));
  },

  async setDomainLabel(message) {
    return enqueue(() => setDomainDefaultLabel(message.domain, message.label));
  },

  async syncProjectFocusBoundary() {
    await enqueue(async () => {
      await finalizeSession();
      await checkCurrentState();
    });
    return { ok: true };
  },

  async syncTrackingPrefs() {
    await syncIdleDetection();
    return { ok: true };
  },

  async syncSpeedBump() {
    await syncSpeedBumpScripts();
    return { ok: true };
  },

  async getSpeedBumpContext(message, sender) {
    const domain = message.domain || (sender && sender.url ? getDomain(sender.url) : null);
    return getSpeedBumpContext(domain);
  },

  async resolveLabel(message) {
    return resolveLabelForDomain(message.domain, message.context || {});
  }
};

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = message && handlers[message.action];
  if (!handler) return false;

  handler(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error(`Handler ${message.action} failed:`, error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
});
