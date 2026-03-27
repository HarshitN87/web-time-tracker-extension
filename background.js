// ─── Helpers ───

const MAX_SESSION_SECONDS = 7200; // 2-hour cap — anything longer is a tracking error
const ACTIVE_SESSION_STALE_MS = 45000;
const DEFAULT_NOTIFICATION_PREFS = {
  budgetAlerts: true,
  dailySummary: true,
  dailySummaryTime: '18:00',
  anomalyAlerts: false
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

// ─── Session State ───

let memDomain = null;
let memStartTime = null;
let memLastSeenAt = null;

async function getActiveSession() {
  if (memDomain !== null && memStartTime !== null) {
    return { currentDomain: memDomain, sessionStartTime: memStartTime, lastSeenAt: memLastSeenAt };
  }

  const data = await browser.storage.local.get('activeSession');
  if (data.activeSession && data.activeSession.currentDomain) {
    memDomain = data.activeSession.currentDomain;
    memStartTime = data.activeSession.sessionStartTime;
    memLastSeenAt = data.activeSession.lastSeenAt || data.activeSession.sessionStartTime;
    return data.activeSession;
  }
  return { currentDomain: null, sessionStartTime: null, lastSeenAt: null };
}

async function setActiveSession(domain, startTime, lastSeenAt = startTime) {
  memDomain = domain;
  memStartTime = startTime;
  memLastSeenAt = lastSeenAt;
  await browser.storage.local.set({ activeSession: { currentDomain: domain, sessionStartTime: startTime, lastSeenAt } });
}

async function touchActiveSession(timestamp) {
  const { currentDomain, sessionStartTime } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return;
  await setActiveSession(currentDomain, sessionStartTime, timestamp);
}

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

async function getNotificationState() {
  const data = await browser.storage.local.get('notificationState');
  return data.notificationState || { budgetAlerts: {}, anomalyAlerts: {}, dailySummaryDate: null };
}

async function setNotificationState(state) {
  await browser.storage.local.set({ notificationState: state });
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

async function syncDailySummaryAlarm() {
  const prefs = await getNotificationPrefs();
  await browser.alarms.clear('dailySummary');
  if (!prefs.dailySummary) return;

  const [hourStr, minuteStr] = (prefs.dailySummaryTime || '18:00').split(':');
  const next = new Date();
  next.setHours(Number(hourStr) || 18, Number(minuteStr) || 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);

  await browser.alarms.create('dailySummary', {
    when: next.getTime(),
    periodInMinutes: 24 * 60
  });
}

async function getStoredDaySessions(dateKey) {
  const stored = await browser.storage.local.get(dateKey);
  const dayData = stored[dateKey] && Array.isArray(stored[dateKey].sessions)
    ? stored[dateKey]
    : { sessions: [] };
  return dayData.sessions || [];
}

async function maybeSendBudgetAlerts() {
  const prefs = await getNotificationPrefs();
  if (!prefs.budgetAlerts) return;

  const allData = await browser.storage.local.get(null);
  const projectMappings = allData.projectMappings || {};
  const projectGoals = allData.projectGoals || {};
  const weekStart = getWeekStartString();
  const dateKeys = Object.keys(allData).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key) && key >= weekStart).sort();
  const totals = {};

  dateKeys.forEach((dateKey) => {
    const dayData = allData[dateKey] && Array.isArray(allData[dateKey].sessions)
      ? allData[dateKey]
      : { sessions: [] };
    dayData.sessions.forEach((session) => {
      const projectName = session.projectFocus || projectMappings[session.domain];
      if (!projectName) return;
      totals[projectName] = (totals[projectName] || 0) + session.duration;
    });
  });

  const state = await getNotificationState();
  state.budgetAlerts ||= {};

  for (const [projectName, goalSecs] of Object.entries(projectGoals)) {
    const total = totals[projectName] || 0;
    const stateKey = `${weekStart}:${projectName}`;
    if (goalSecs > 0 && total >= goalSecs && !state.budgetAlerts[stateKey]) {
      await createNotification(`budget-${stateKey}`, 'Project budget reached', `${projectName} has reached ${Math.round((total / goalSecs) * 100)}% of its weekly goal.`);
      state.budgetAlerts[stateKey] = true;
    }
  }

  await setNotificationState(state);
}

async function maybeSendAnomalyAlerts() {
  const prefs = await getNotificationPrefs();
  if (!prefs.anomalyAlerts) return;

  const allData = await browser.storage.local.get(null);
  const todayKey = getTodayString();
  const todaySessions = (allData[todayKey] && Array.isArray(allData[todayKey].sessions)
    ? allData[todayKey]
    : { sessions: [] }).sessions || [];
  const priorKeys = Object.keys(allData).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key) && key < todayKey).sort();
  const priorDomains = new Set();
  const priorTotals = {};
  const priorDays = {};

  priorKeys.forEach((dateKey) => {
    const dayData = allData[dateKey] && Array.isArray(allData[dateKey].sessions)
      ? allData[dateKey]
      : { sessions: [] };
    const dayTotals = {};
    dayData.sessions.forEach((session) => {
      priorDomains.add(session.domain);
      dayTotals[session.domain] = (dayTotals[session.domain] || 0) + session.duration;
    });
    Object.entries(dayTotals).forEach(([domain, total]) => {
      priorTotals[domain] = (priorTotals[domain] || 0) + total;
      priorDays[domain] = (priorDays[domain] || 0) + 1;
    });
  });

  const todayTotals = {};
  todaySessions.forEach((session) => {
    todayTotals[session.domain] = (todayTotals[session.domain] || 0) + session.duration;
  });

  const state = await getNotificationState();
  state.anomalyAlerts ||= {};

  for (const [domain, total] of Object.entries(todayTotals)) {
    const newKey = `new:${todayKey}:${domain}`;
    if (!priorDomains.has(domain) && !state.anomalyAlerts[newKey]) {
      await createNotification(`anomaly-${newKey}`, 'New domain spotted', `${domain} appeared for the first time in your recent history today.`);
      state.anomalyAlerts[newKey] = true;
      continue;
    }

    const avg = priorDays[domain] ? priorTotals[domain] / priorDays[domain] : 0;
    const highKey = `high:${todayKey}:${domain}`;
    if (avg > 0 && total >= Math.max(avg * 1.8, 30 * 60) && !state.anomalyAlerts[highKey]) {
      await createNotification(`anomaly-${highKey}`, 'Usage anomaly detected', `${domain} is running much hotter than usual today at ${Math.round(total / 60)} minutes.`);
      state.anomalyAlerts[highKey] = true;
    }
  }

  await setNotificationState(state);
}

async function maybeSendDailySummary() {
  const prefs = await getNotificationPrefs();
  if (!prefs.dailySummary) return;

  const todayKey = getTodayString();
  const state = await getNotificationState();
  if (state.dailySummaryDate === todayKey) return;

  const sessions = await getStoredDaySessions(todayKey);
  const total = sessions.reduce((sum, session) => sum + session.duration, 0);
  const domainTotals = {};
  sessions.forEach((session) => {
    domainTotals[session.domain] = (domainTotals[session.domain] || 0) + session.duration;
  });
  const topDomain = Object.entries(domainTotals).sort((a, b) => b[1] - a[1])[0];
  const totalMinutes = Math.round(total / 60);
  const summary = topDomain
    ? `You tracked ${totalMinutes} minutes today. Top domain: ${topDomain[0]}.`
    : 'No browser activity was tracked today.';

  await createNotification(`daily-summary-${todayKey}`, 'Daily summary', summary);
  state.dailySummaryDate = todayKey;
  await setNotificationState(state);
}

// ─── Save a completed session ───

async function saveSession(domain, startTime, endTime) {
  let durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
  if (durationSeconds < 1) return;

  // Cap at maximum to prevent tracking errors
  durationSeconds = Math.min(durationSeconds, MAX_SESSION_SECONDS);

  const startDate = getDateString(startTime);
  const endDate = getDateString(endTime);
  const activeProjectFocus = await getActiveProjectFocus();
  const projectFocus = activeProjectFocus && activeProjectFocus.startTime <= endTime
    ? activeProjectFocus.projectName
    : null;

  if (startDate !== endDate) {
    // Session spans midnight — split into two
    const midnightMs = getStartOfDay(endDate);

    const beforeMidnight = Math.max(0, Math.floor((midnightMs - startTime) / 1000));
    const afterMidnight = Math.max(0, Math.floor((endTime - midnightMs) / 1000));

    if (beforeMidnight > 0) {
      await writeToDayStorage(startDate, {
        domain,
        start: startTime,
        end: midnightMs,
        duration: Math.min(beforeMidnight, MAX_SESSION_SECONDS),
        ...(projectFocus ? { projectFocus } : {})
      });
    }
    if (afterMidnight > 0) {
      await writeToDayStorage(endDate, {
        domain,
        start: midnightMs,
        end: endTime,
        duration: Math.min(afterMidnight, MAX_SESSION_SECONDS),
        ...(projectFocus ? { projectFocus } : {})
      });
    }
  } else {
    await writeToDayStorage(startDate, {
      domain,
      start: startTime,
      end: endTime,
      duration: durationSeconds,
      ...(projectFocus ? { projectFocus } : {})
    });
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

async function getDayDataWithActiveSession(dateKey) {
  const stored = await browser.storage.local.get(dateKey);
  let dayData = stored[dateKey] && Array.isArray(stored[dateKey].sessions)
    ? stored[dateKey]
    : { sessions: [] };
  dayData = JSON.parse(JSON.stringify(dayData));

  const { currentDomain, sessionStartTime } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return dayData;
  const activeProjectFocus = await getActiveProjectFocus();

  const dayStart = getStartOfDay(dateKey);
  const dayEnd = dayStart + (24 * 60 * 60 * 1000);
  const activeEnd = Date.now();

  const overlapStart = Math.max(sessionStartTime, dayStart);
  const overlapEnd = Math.min(activeEnd, dayEnd);

  if (overlapEnd <= overlapStart) return dayData;

  let durationSeconds = Math.max(0, Math.floor((overlapEnd - overlapStart) / 1000));
  durationSeconds = Math.min(durationSeconds, MAX_SESSION_SECONDS);
  if (durationSeconds < 1) return dayData;

  dayData.sessions.push({
    domain: currentDomain,
    start: overlapStart,
    end: overlapEnd,
    duration: durationSeconds,
    ...(activeProjectFocus && activeProjectFocus.startTime <= overlapEnd ? { projectFocus: activeProjectFocus.projectName } : {}),
    ongoing: true
  });

  return dayData;
}

// ─── Finalize & Start Sessions ───

async function finalizeSession() {
  const { currentDomain, sessionStartTime, lastSeenAt } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return;

  const endTime = Math.min(Date.now(), lastSeenAt || Date.now());
  const domain = currentDomain;
  const start = sessionStartTime;

  // Reset state BEFORE saving to prevent race conditions
  await setActiveSession(null, null);

  console.log(`[Flow Tracker] Finalized session for ${domain}`);
  await saveSession(domain, start, endTime);
}

async function startSession(url) {
  const domain = getDomain(url);
  const { currentDomain } = await getActiveSession();

  if (domain === currentDomain) return; // Already tracking

  await finalizeSession();

  if (domain) {
    const now = Date.now();
    await setActiveSession(domain, now, now);
    console.log(`[Flow Tracker] Started session for ${domain}`);
  }
}

// ─── State Checking ───

async function checkCurrentState() {
  try {
    const window = await browser.windows.getLastFocused();
    if (!window || !window.focused) {
      await finalizeSession();
      return;
    }

    const tabs = await browser.tabs.query({ active: true, windowId: window.id });
    if (tabs.length > 0 && tabs[0].url) {
      const newDomain = getDomain(tabs[0].url);
      const { currentDomain, lastSeenAt } = await getActiveSession();
      const now = Date.now();
      const isStale = lastSeenAt && (now - lastSeenAt) > ACTIVE_SESSION_STALE_MS;

      if (newDomain === currentDomain && !isStale) {
        await touchActiveSession(now);
        return;
      }

      if (newDomain === currentDomain && isStale) {
        await finalizeSession();
        if (newDomain) {
          await setActiveSession(newDomain, now, now);
        }
        return;
      }

      await startSession(tabs[0].url);
    } else {
      await finalizeSession();
    }
    await maybeSendBudgetAlerts();
    await maybeSendAnomalyAlerts();
  } catch (e) {
    console.error("Error checking state:", e);
    await finalizeSession();
  }
}

// Queue for safe sequential execution
let stateQueue = Promise.resolve();

function queueStateCheck() {
  stateQueue = stateQueue.then(() => checkCurrentState()).catch(e => console.error(e));
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
queueStateCheck();
setInterval(queueStateCheck, 15000);
syncDailySummaryAlarm().catch(console.error);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailySummary') {
    maybeSendDailySummary().catch(console.error);
  }
});

// ─── Message Listener for Dashboard ───

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getLatestData' || message.action === 'getDayData') {
    (async () => {
      await stateQueue;
      const dateKey = message.date || getTodayString();
      const dayData = await getDayDataWithActiveSession(dateKey);
      sendResponse(dayData);
    })();
    return true;
  }

  if (message.action === 'syncProjectFocusBoundary') {
    (async () => {
      await stateQueue;
      await finalizeSession();
      await checkCurrentState();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'syncNotificationPrefs') {
    (async () => {
      await syncDailySummaryAlarm();
      sendResponse({ ok: true });
    })();
    return true;
  }
});
