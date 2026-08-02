document.addEventListener('DOMContentLoaded', async () => {

  // ═══ Constants ═══

  const VALID_LABELS = ['productive', 'neutral', 'distracting'];
  const LABEL_NAMES = { productive: 'Productive', neutral: 'Neutral', distracting: 'Distracting' };
  const STITCH_GAP_MS = 3 * 60 * 1000;
  const BLOCK_GAP_MS = 3 * 60 * 1000;
  const COMPACT_AFTER_DAYS = 90;

  // Coverage below this and the split is more default than measurement, so it
  // gets shown as provisional rather than asserted.
  const CONFIDENCE_UNTAGGED_LIMIT = 0.4;

  // Deviation detection — median and median-absolute-deviation, so "unusual" is
  // measured against your own spread rather than a constant somebody picked.
  const DEVIATION_MAD_THRESHOLD = 3;
  const DEVIATION_MIN_DAYS = 7;
  const DEVIATION_MIN_SECONDS = 15 * 60;
  const DEVIATION_WINDOW_DAYS = 28;

  const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  const REFLECTION_QUESTIONS = [
    'Which hour this week would you take back?',
    'What did the time on your top site actually buy you?',
    'Where did the week go differently from how you planned it?',
    'What is one thing you want next week to look like instead?'
  ];

  // ═══ State ═══

  let scope = { mode: 'day', anchor: todayKey() };
  let sessions = [];          // stitched, scope-limited
  let prevSessions = [];      // same length, immediately before
  let scopeDayKeys = [];
  let deviations = [];
  let hasSynthetic = false;

  let labelRules = {};
  let projectsMap = {};
  let projectGoals = {};
  let projectMeta = {};
  let plans = {};
  let speedBumpSites = {};
  let activeProjectFocus = null;

  let whereFilter = 'all';
  let whereGroup = 'label';
  let whereSort = 'time';
  let openDetailDomain = null;
  let openDetailLabel = null;
  let reviewWeekOffset = 0;
  let dayKeyCache = null;

  let FOCUS_COLOR = '#4A6552';
  let DISTRACT_COLOR = '#B03A2B';
  let NEUTRAL_COLOR = '#9A9384';
  let FAINT_COLOR = '#A9A294';
  let SERIES_PALETTE = ['#4A6552', '#8C6A3F', '#5A6B7D', '#7A5468', '#6E7A4A', '#9A9384'];

  // ═══ Small utilities ═══

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    if (node) node.textContent = '';
  }

  function isDayKey(key) {
    return /^\d{4}-\d{2}-\d{2}$/.test(key);
  }

  function normalizeLabel(label) {
    if (label === 'distraction') return 'distracting';
    return VALID_LABELS.includes(label) ? label : null;
  }

  function keyOf(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function todayKey() {
    return keyOf(new Date());
  }

  // `new Date('2026-08-01')` parses as UTC midnight, which lands on the previous
  // day west of UTC. Day keys are always local dates, so parse them as such.
  function parseKey(dateStr) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function startOfDay(dateStr) {
    return parseKey(dateStr).getTime();
  }

  function shiftKey(dateStr, days) {
    const date = parseKey(dateStr);
    date.setDate(date.getDate() + days);
    return keyOf(date);
  }

  function mondayOf(dateStr) {
    const date = parseKey(dateStr);
    const weekday = date.getDay();
    date.setDate(date.getDate() - (weekday === 0 ? 6 : weekday - 1));
    return keyOf(date);
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return total > 0 ? '< 1m' : '0m';
  }

  function formatHour(hour) {
    const display = hour % 12 === 0 ? 12 : hour % 12;
    return `${display}${hour >= 12 ? 'PM' : 'AM'}`;
  }

  function formatClockTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function pct(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 100) : 0;
  }

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

  function readToken(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function refreshThemeColors() {
    FOCUS_COLOR = readToken('--good', FOCUS_COLOR);
    DISTRACT_COLOR = readToken('--bad', DISTRACT_COLOR);
    NEUTRAL_COLOR = readToken('--idle', NEUTRAL_COLOR);
    FAINT_COLOR = readToken('--faint', FAINT_COLOR);
    SERIES_PALETTE = [1, 2, 3, 4, 5, 6].map((i, idx) => readToken(`--series-${i}`, SERIES_PALETTE[idx]));
  }

  function labelColor(label) {
    if (label === 'productive') return FOCUS_COLOR;
    if (label === 'distracting') return DISTRACT_COLOR;
    if (label === 'neutral') return NEUTRAL_COLOR;
    return FAINT_COLOR;
  }

  // Stable per domain, but drawn from the theme's muted series rather than each
  // site's brand colour — a page of logo colours reads as noise, not data.
  function domainColor(domain) {
    let hash = 0;
    const name = domain || '?';
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return SERIES_PALETTE[Math.abs(hash) % SERIES_PALETTE.length];
  }

  // Locally drawn monogram instead of a remote favicon service. Fetching favicons
  // would hand the full list of browsed domains to a third party, which is exactly
  // what this extension promises not to do.
  function domainBadge(domain, size = 16) {
    const badge = el('span', 'domain-badge', (domain || '?').replace(/^www\./, '').charAt(0).toUpperCase());
    badge.style.setProperty('--badge-size', `${size}px`);
    badge.style.backgroundColor = domainColor(domain || '?');
    badge.setAttribute('aria-hidden', 'true');
    return badge;
  }

  function emptyState(message) {
    return el('div', 'empty-state', message);
  }

  // ═══ Label rules ═══
  //
  // Mirrors the resolver in background.js. A label is not a property of a
  // domain — youtube.com is research during a thesis session and a sink at
  // midnight — so a rule carries a condition and the first match wins.

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
    // Path conditions are evaluated live at capture time; a stored session keeps
    // only its domain, so they cannot be re-checked here.
    if (when.path && !context.path) return false;
    if (when.path && !context.path.startsWith(when.path)) return false;
    if (typeof when.fromHour === 'number' && typeof when.toHour === 'number') {
      if (!hourInWindow(new Date(context.at).getHours(), when.fromHour, when.toHour)) return false;
    }
    return true;
  }

  function ruleIsConditional(rule) {
    const when = rule.when || {};
    return Boolean(when.project || when.path || typeof when.fromHour === 'number');
  }

  function describeRule(rule) {
    const when = rule.when || {};
    const parts = [];
    if (when.project) parts.push(`during ${when.project}`);
    if (typeof when.fromHour === 'number') parts.push(`between ${formatHour(when.fromHour)} and ${formatHour(when.toHour)}`);
    if (when.path) parts.push(`on paths starting ${when.path}`);
    return parts.length ? parts.join(', ') : 'by default';
  }

  // Returns null for untagged rather than falling back to neutral. Untagged time
  // is a gap in the data, and reporting it as neutral tells a user who has never
  // tagged anything that their time is 100% neutral.
  function labelOf(session) {
    const explicit = normalizeLabel(session.productivityLabel);
    if (explicit) return explicit;

    const rules = labelRules[session.domain] || [];
    const context = { at: session.start, project: session.projectFocus || null, path: null };
    for (const rule of rules) {
      if (ruleMatches(rule, context)) return normalizeLabel(rule.label);
    }
    return null;
  }

  async function saveLabelRules() {
    await browser.storage.local.set({ labelRules });
  }

  // ═══ Scope ═══

  function scopeKeys() {
    if (scope.mode === 'day') return [scope.anchor];

    if (scope.mode === 'week') {
      const monday = mondayOf(scope.anchor);
      return Array.from({ length: 7 }, (_, i) => shiftKey(monday, i));
    }

    if (scope.mode === 'month') {
      const date = parseKey(scope.anchor);
      const days = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      return Array.from({ length: days }, (_, i) => keyOf(new Date(date.getFullYear(), date.getMonth(), i + 1)));
    }

    return dayKeyCache || [];
  }

  function previousScopeKeys() {
    const keys = scopeKeys();
    if (!keys.length || scope.mode === 'all') return [];
    const firstStart = startOfDay(keys[0]);
    return keys.map((_, index) => {
      const date = new Date(firstStart);
      date.setDate(date.getDate() - keys.length + index);
      return keyOf(date);
    });
  }

  function scopeLabel() {
    const keys = scopeKeys();
    if (scope.mode === 'all') return 'All time';

    if (scope.mode === 'day') {
      if (scope.anchor === todayKey()) return 'Today';
      if (scope.anchor === shiftKey(todayKey(), -1)) return 'Yesterday';
      return parseKey(scope.anchor).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    if (scope.mode === 'week') {
      if (keys[0] === mondayOf(todayKey())) return 'This week';
      const start = parseKey(keys[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const end = parseKey(keys[6]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `${start} – ${end}`;
    }

    const date = parseKey(scope.anchor);
    const now = new Date();
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'This month';
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function atLatestScope() {
    if (scope.mode === 'all') return true;
    const today = todayKey();
    if (scope.mode === 'day') return scope.anchor === today;
    if (scope.mode === 'week') return mondayOf(scope.anchor) === mondayOf(today);
    const anchor = parseKey(scope.anchor);
    const now = new Date();
    return anchor.getFullYear() === now.getFullYear() && anchor.getMonth() === now.getMonth();
  }

  function shiftScope(direction) {
    if (scope.mode === 'all') return;
    if (direction > 0 && atLatestScope()) return;

    if (scope.mode === 'day') {
      scope.anchor = shiftKey(scope.anchor, direction);
    } else if (scope.mode === 'week') {
      scope.anchor = shiftKey(mondayOf(scope.anchor), direction * 7);
    } else {
      const date = parseKey(scope.anchor);
      date.setDate(1);
      date.setMonth(date.getMonth() + direction);
      scope.anchor = keyOf(date);
    }

    if (parseKey(scope.anchor) > new Date()) scope.anchor = todayKey();
    loadAndRender();
  }

  function setScopeMode(mode) {
    if (scope.mode === mode) return;
    scope.mode = mode;
    scope.anchor = todayKey();
    document.querySelectorAll('.scope-mode').forEach((button) => {
      button.classList.toggle('active', button.dataset.scopeMode === mode);
    });
    loadAndRender();
  }

  // ═══ Data ═══

  // Cached so that filtering, sorting and regrouping never touch storage. The
  // previous build re-read the entire history on every filter-pill click.
  async function listDayKeys() {
    if (dayKeyCache) return dayKeyCache;
    const all = await browser.storage.local.get(null);
    dayKeyCache = Object.keys(all).filter(isDayKey).sort();
    return dayKeyCache;
  }

  // A compacted day stores per-domain totals rather than individual visits.
  // Expanding it here keeps every consumer working; `synthetic` marks the ones
  // whose clock times are no longer real so the rhythm view can exclude them.
  function expandDay(dateKey, dayData) {
    if (!dayData) return [];

    if (dayData.compacted && dayData.totals) {
      const base = startOfDay(dateKey);
      return Object.entries(dayData.totals).map(([domain, entry]) => ({
        domain,
        start: base,
        end: base + (entry.duration || 0) * 1000,
        duration: entry.duration || 0,
        visits: entry.visits || 1,
        ...(entry.label ? { productivityLabel: entry.label } : {}),
        synthetic: true,
        _dateKey: dateKey
      }));
    }

    if (!Array.isArray(dayData.sessions)) return [];
    return dayData.sessions.map(session => ({ ...session, _dateKey: dateKey }));
  }

  // Rejoins a visit you interrupted. The key case is leaving a site and coming
  // straight back: the detour lands between the two records, so comparing only
  // against the immediately preceding record never merges them and the return
  // reads as a second visit. This tracks the last record per domain instead, so
  // an intervening site does not break the visit apart.
  //
  // Durations are summed rather than recomputed from start and end, so the time
  // spent on the detour is never absorbed into this site's total. Because a
  // merged session can then span other sessions, each keeps the real intervals
  // it was built from in `segments`, and anything that buckets by clock time
  // walks those rather than the outer span.
  function stitch(list) {
    const valid = list.filter(session => session.start && session.end);
    if (!valid.length) return [];

    valid.sort((a, b) => a.start - b.start);

    const merged = [];
    const lastOfDomain = new Map();

    valid.forEach((raw) => {
      const previous = lastOfDomain.get(raw.domain);
      const withinWindow = previous && (raw.start - previous.end) < STITCH_GAP_MS;
      const bothReal = previous && !previous.synthetic && !raw.synthetic;
      // Never merge across midnight. The background already splits a session at
      // the day boundary so each day owns its own time; rejoining the halves
      // would hand the whole thing to whichever day started it.
      const sameDay = previous && previous._dateKey === raw._dateKey;
      // Two visits the user deliberately labelled differently are two visits,
      // whatever the gap between them.
      const labelsClash = previous
        && normalizeLabel(previous.productivityLabel)
        && normalizeLabel(raw.productivityLabel)
        && normalizeLabel(previous.productivityLabel) !== normalizeLabel(raw.productivityLabel);

      if (withinWindow && bothReal && sameDay && !labelsClash) {
        previous.end = Math.max(previous.end, raw.end);
        previous.duration = (previous.duration || 0) + (raw.duration || 0);
        previous.segments.push({ start: raw.start, end: raw.end });
        if (raw.ongoing) previous.ongoing = true;
        if (raw.capped) previous.capped = true;
        if (raw.productivityLabel && !previous.productivityLabel) {
          previous.productivityLabel = raw.productivityLabel;
        }
        if (raw.projectFocus && !previous.projectFocus) {
          previous.projectFocus = raw.projectFocus;
        }
        return;
      }

      const entry = { ...raw, segments: [{ start: raw.start, end: raw.end }] };
      merged.push(entry);
      lastOfDomain.set(raw.domain, entry);
    });

    return merged.sort((a, b) => a.start - b.start);
  }

  // A stitched session's outer span can cover time that belongs to other sites,
  // so anything measuring clock time reads the real intervals instead.
  function segmentsOf(session) {
    return session.segments || [{ start: session.start, end: session.end }];
  }

  async function fetchSessions(keys) {
    if (!keys.length) return [];
    const response = await browser.runtime.sendMessage({ action: 'getRangeData', dates: keys });
    const days = (response && response.days) || {};
    const collected = [];
    keys.forEach((dateKey) => {
      collected.push(...expandDay(dateKey, days[dateKey]));
    });
    return stitch(collected);
  }

  // Trailing per-domain daily totals, used for the deviation check. Bounded to
  // the window, so it never grows into a full-history scan.
  async function computeDeviations() {
    const today = todayKey();
    const keys = Array.from({ length: DEVIATION_WINDOW_DAYS }, (_, i) => shiftKey(today, -i));
    const stored = await browser.storage.local.get(keys);

    const history = {};
    const current = {};

    keys.forEach((dateKey) => {
      const dayTotals = {};
      expandDay(dateKey, stored[dateKey]).forEach((session) => {
        if (!session.domain) return;
        dayTotals[session.domain] = (dayTotals[session.domain] || 0) + (session.duration || 0);
      });

      if (dateKey === today) {
        Object.assign(current, dayTotals);
      } else {
        Object.entries(dayTotals).forEach(([domain, total]) => {
          (history[domain] = history[domain] || []).push(total);
        });
      }
    });

    const found = [];
    Object.entries(current).forEach(([domain, total]) => {
      if (total < DEVIATION_MIN_SECONDS) return;
      const past = history[domain] || [];

      if (past.length < DEVIATION_MIN_DAYS) {
        if (past.length === 0) found.push({ domain, kind: 'new', total });
        return;
      }

      const center = median(past);
      const score = (total - center) / spreadOf(past, center);
      if (score >= DEVIATION_MAD_THRESHOLD) {
        found.push({ domain, kind: 'high', total, median: center, score });
      }
    });

    return found.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  async function loadAndRender() {
    if (scope.mode === 'all') await listDayKeys();

    scopeDayKeys = scopeKeys();
    sessions = await fetchSessions(scopeDayKeys);
    prevSessions = await fetchSessions(previousScopeKeys());
    hasSynthetic = sessions.some(session => session.synthetic);
    deviations = await computeDeviations();

    renderAll();
  }

  // ═══ Aggregation ═══

  function totalOf(list) {
    return list.reduce((sum, session) => sum + (session.duration || 0), 0);
  }

  function splitOf(list) {
    const split = { productive: 0, neutral: 0, distracting: 0, untagged: 0 };
    list.forEach((session) => {
      split[labelOf(session) || 'untagged'] += session.duration || 0;
    });
    return split;
  }

  // One row per site per label. A site whose default is neutral but which has
  // three sessions tagged productive appears in both groups, carrying only the
  // time that belongs to each. Collapsing it to a single dominant label — as an
  // earlier version did — made a session tag you had just set invisible in the
  // group you set it for.
  function domainLabelRows(list) {
    const map = {};
    list.forEach((session) => {
      if (!session.domain) return;
      const label = labelOf(session) || 'untagged';
      const key = `${session.domain}::${label}`;
      const entry = map[key] || (map[key] = {
        domain: session.domain,
        label,
        duration: 0,
        visits: 0,
        capped: false
      });
      entry.duration += session.duration || 0;
      entry.visits += session.visits || 1;
      if (session.capped) entry.capped = true;
    });
    return Object.values(map);
  }

  // One row per site, every label folded together. Used when the grouping axis
  // is the project rather than the label, so a site is not listed twice inside
  // the same project.
  function domainRows(list) {
    const map = {};
    list.forEach((session) => {
      if (!session.domain) return;
      const entry = map[session.domain] || (map[session.domain] = {
        domain: session.domain,
        label: null,
        duration: 0,
        visits: 0,
        shares: { productive: 0, neutral: 0, distracting: 0, untagged: 0 },
        capped: false
      });
      entry.duration += session.duration || 0;
      entry.visits += session.visits || 1;
      entry.shares[labelOf(session) || 'untagged'] += session.duration || 0;
      if (session.capped) entry.capped = true;
    });
    return Object.values(map);
  }

  function projectOf(session) {
    return session.projectFocus || projectsMap[session.domain] || null;
  }

  function hourBuckets(list) {
    const buckets = Array.from({ length: 24 }, () => ({ productive: 0, neutral: 0, distracting: 0, untagged: 0, total: 0 }));
    list.forEach((session) => {
      if (session.synthetic || !session.start || !session.end) return;
      const label = labelOf(session) || 'untagged';
      segmentsOf(session).forEach((segment) => {
        let cursor = segment.start;
        while (cursor < segment.end) {
          const current = new Date(cursor);
          const hour = current.getHours();
          const hourEnd = new Date(current);
          hourEnd.setMinutes(59, 59, 999);
          const sliceEnd = Math.min(segment.end, hourEnd.getTime() + 1);
          const seconds = Math.max(0, Math.floor((sliceEnd - cursor) / 1000));
          buckets[hour][label] += seconds;
          buckets[hour].total += seconds;
          cursor = sliceEnd;
        }
      });
    });
    return buckets;
  }

  function dayHourMatrix(list) {
    const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
    list.forEach((session) => {
      if (session.synthetic || !session.start || !session.end) return;
      segmentsOf(session).forEach((segment) => {
        let cursor = segment.start;
        while (cursor < segment.end) {
          const current = new Date(cursor);
          const weekday = (current.getDay() + 6) % 7; // Monday-first
          const hour = current.getHours();
          const hourEnd = new Date(current);
          hourEnd.setMinutes(59, 59, 999);
          const sliceEnd = Math.min(segment.end, hourEnd.getTime() + 1);
          matrix[weekday][hour] += Math.max(0, (sliceEnd - cursor) / 1000);
          cursor = sliceEnd;
        }
      });
    });
    return matrix;
  }

  function buildBlocks(list) {
    const ordered = list
      .filter(session => !session.synthetic && session.start && session.end)
      .sort((a, b) => a.start - b.start);

    const blocks = [];
    let current = null;

    ordered.forEach((session) => {
      const label = labelOf(session) || 'untagged';
      if (!current || (session.start - current.end) > BLOCK_GAP_MS) {
        current = {
          start: session.start,
          end: session.end,
          duration: session.duration || 0,
          domains: [session.domain],
          weights: { productive: 0, neutral: 0, distracting: 0, untagged: 0 },
          switches: 0
        };
        current.weights[label] += session.duration || 0;
        blocks.push(current);
        return;
      }

      if (current.domains[current.domains.length - 1] !== session.domain) current.switches++;
      current.end = Math.max(current.end, session.end);
      current.duration += session.duration || 0;
      if (!current.domains.includes(session.domain)) current.domains.push(session.domain);
      current.weights[label] += session.duration || 0;
    });

    return blocks;
  }

  function countSwitches(list) {
    const ordered = list
      .filter(session => !session.synthetic && session.start)
      .sort((a, b) => a.start - b.start);
    let count = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].domain !== ordered[i - 1].domain) count++;
    }
    return count;
  }

  // ═══ Home strip ═══

  function renderHome() {
    const total = totalOf(sessions);
    const split = splitOf(sessions);
    const previousTotal = totalOf(prevSessions);

    $('home-total').textContent = formatTime(total);

    const totalMeta = $('home-total-meta');
    if (scope.mode === 'all') {
      totalMeta.textContent = `${scopeDayKeys.length} day${scopeDayKeys.length === 1 ? '' : 's'} on record`;
      totalMeta.className = 'home-meta';
    } else if (previousTotal === 0) {
      totalMeta.textContent = 'no prior period to compare';
      totalMeta.className = 'home-meta';
    } else {
      const diff = total - previousTotal;
      totalMeta.textContent = diff === 0
        ? 'same as the period before'
        : `${diff > 0 ? '↑' : '↓'} ${formatTime(Math.abs(diff))} vs the period before`;
      totalMeta.className = `home-meta ${diff > 0 ? 'up' : diff < 0 ? 'down' : 'same'}`;
    }

    // Split bar
    const bar = $('home-split-bar');
    const legend = $('home-split-legend');
    clear(bar);
    clear(legend);

    const untaggedShare = total > 0 ? split.untagged / total : 0;
    const provisional = untaggedShare > CONFIDENCE_UNTAGGED_LIMIT;
    bar.classList.toggle('is-provisional', provisional);

    if (total === 0) {
      bar.appendChild(el('div', 'home-split-empty'));
      legend.appendChild(el('span', 'home-split-note', 'Nothing tracked in this range.'));
    } else {
      [
        ['productive', split.productive, FOCUS_COLOR],
        ['neutral', split.neutral, NEUTRAL_COLOR],
        ['distracting', split.distracting, DISTRACT_COLOR],
        ['untagged', split.untagged, FAINT_COLOR]
      ].forEach(([name, value, color]) => {
        if (value <= 0) return;
        const segment = el('div', `home-split-segment ${name}`);
        segment.style.width = `${(value / total) * 100}%`;
        segment.style.backgroundColor = color;
        segment.title = `${name}: ${formatTime(value)}`;
        bar.appendChild(segment);

        const item = el('span', 'home-split-item');
        const dot = el('i');
        dot.style.backgroundColor = color;
        item.append(dot, document.createTextNode(`${pct(value, total)}% ${name}`));
        legend.appendChild(item);
      });

      if (provisional) {
        legend.appendChild(el('span', 'home-split-note',
          'Provisional — too much is untagged to call this a measurement.'));
      }
    }

    // Untagged
    $('home-untagged').textContent = total > 0 ? `${pct(split.untagged, total)}%` : '—';
    const untaggedMeta = $('home-untagged-meta');
    clear(untaggedMeta);
    if (split.untagged > 0) {
      untaggedMeta.appendChild(document.createTextNode(`${formatTime(split.untagged)} · `));
      const link = el('button', 'link-inline', 'tag it');
      link.addEventListener('click', () => { reviewWeekOffset = 0; openReview(); });
      untaggedMeta.appendChild(link);
    } else if (total > 0) {
      untaggedMeta.textContent = 'everything is labelled';
    }

    // Notable
    const top = deviations[0];
    if (!top) {
      $('home-notable').textContent = 'Nothing unusual';
      $('home-notable-meta').textContent = 'today sits inside your normal range';
    } else if (top.kind === 'new') {
      $('home-notable').textContent = top.domain;
      $('home-notable-meta').textContent = `new — no history in the last ${DEVIATION_WINDOW_DAYS} days`;
    } else {
      $('home-notable').textContent = top.domain;
      $('home-notable-meta').textContent = `${formatTime(top.total)} today vs a typical ${formatTime(top.median)}`;
    }
  }

  // ═══ Where ═══

  function renderWhere() {
    const container = $('where-list');
    clear(container);

    const total = totalOf(sessions);
    if (!sessions.length) {
      container.appendChild(emptyState('Nothing tracked in this range yet.'));
      renderProjects();
      return;
    }

    const rows = whereGroup === 'project' ? domainRows(sessions) : domainLabelRows(sessions);
    const sortValue = entry => whereSort === 'visits' ? entry.visits : entry.duration;
    const maxValue = Math.max(...rows.map(sortValue), 1);

    if (whereGroup === 'project') {
      renderGroupedByProject(container, rows, maxValue, sortValue);
    } else {
      renderGroupedByLabel(container, rows, maxValue, sortValue, total);
    }

    renderProjects();
  }

  function domainRow(entry, maxValue, sortValue, color, labelFocus = null) {
    const row = el('button', 'where-row');
    row.setAttribute('aria-label', labelFocus
      ? `${entry.domain}, ${formatTime(entry.duration)} ${labelFocus}`
      : `${entry.domain}, ${formatTime(entry.duration)}`);

    const badge = domainBadge(entry.domain, 18);
    const name = el('span', 'where-row-name', entry.domain);
    name.title = entry.domain;

    const track = el('div', 'where-row-track');
    const fill = el('div', 'where-row-fill');
    fill.style.backgroundColor = color;
    fill.style.width = `${(sortValue(entry) / maxValue) * 100}%`;
    track.appendChild(fill);

    const value = el('span', 'where-row-value', whereSort === 'visits'
      ? `${entry.visits} visit${entry.visits === 1 ? '' : 's'}`
      : formatTime(entry.duration));

    row.append(badge, name, track, value);

    if (entry.capped) {
      const flag = el('span', 'where-row-flag', 'capped');
      flag.title = 'At least one visit ran past the 2-hour safety cap, so this total is a floor, not the exact figure.';
      row.appendChild(flag);
    }

    // Opening from a label group scopes the drawer to that group's visits, so
    // the sessions you see are the ones the row was counting.
    row.addEventListener('click', () => openDetail(entry.domain, labelFocus));
    return row;
  }

  function renderGroupedByLabel(container, domains, maxValue, sortValue, total) {
    const groups = [
      { key: 'productive', label: 'Productive', color: FOCUS_COLOR },
      { key: 'neutral', label: 'Neutral', color: NEUTRAL_COLOR },
      { key: 'distracting', label: 'Distracting', color: DISTRACT_COLOR },
      { key: 'untagged', label: 'Untagged', color: FAINT_COLOR }
    ];

    let rendered = 0;

    groups.forEach((group) => {
      if (whereFilter !== 'all' && whereFilter !== group.key) return;

      const members = domains
        .filter(entry => entry.label === group.key)
        .sort((a, b) => sortValue(b) - sortValue(a));
      if (!members.length) return;

      rendered += members.length;
      const groupTotal = members.reduce((sum, entry) => sum + entry.duration, 0);

      const head = el('div', 'where-group-head');
      const dot = el('span', 'where-group-dot');
      dot.style.backgroundColor = group.color;
      head.append(
        dot,
        el('span', 'where-group-name', group.label),
        el('span', 'where-group-total', `${formatTime(groupTotal)} · ${pct(groupTotal, total)}%`)
      );
      container.appendChild(head);

      members.forEach(entry => container.appendChild(domainRow(entry, maxValue, sortValue, group.color, group.key)));
    });

    if (!rendered) container.appendChild(emptyState('Nothing in this filter for the selected range.'));
  }

  function renderGroupedByProject(container, domains, maxValue, sortValue) {
    const buckets = {};
    domains.forEach((entry) => {
      // Rows here fold every label together, so the filter asks whether the site
      // has any time under that label rather than comparing a single label.
      if (whereFilter !== 'all' && !entry.shares[whereFilter]) return;
      const name = projectsMap[entry.domain] || 'Unassigned';
      (buckets[name] = buckets[name] || []).push(entry);
    });

    const sum = list => list.reduce((total, entry) => total + entry.duration, 0);
    const names = Object.keys(buckets).sort((a, b) => {
      if (a === 'Unassigned') return 1;
      if (b === 'Unassigned') return -1;
      return sum(buckets[b]) - sum(buckets[a]);
    });

    if (!names.length) {
      container.appendChild(emptyState('Nothing in this filter for the selected range.'));
      return;
    }

    names.forEach((name) => {
      const members = buckets[name].sort((a, b) => sortValue(b) - sortValue(a));
      const color = name === 'Unassigned' ? FAINT_COLOR : domainColor(name);

      const head = el('div', 'where-group-head');
      const dot = el('span', 'where-group-dot');
      dot.style.backgroundColor = color;
      head.append(
        dot,
        el('span', 'where-group-name', name),
        el('span', 'where-group-total', formatTime(sum(members)))
      );
      container.appendChild(head);

      members.forEach(entry => container.appendChild(domainRow(entry, maxValue, sortValue, color)));
    });
  }

  // ═══ Projects ═══

  function projectDirection(name) {
    return (projectMeta[name] && projectMeta[name].direction) || 'floor';
  }

  async function weekTotalsByProject() {
    const monday = mondayOf(todayKey());
    const keys = Array.from({ length: 7 }, (_, i) => shiftKey(monday, i));
    const weekSessions = await fetchSessions(keys);
    const totals = {};
    weekSessions.forEach((session) => {
      const name = projectOf(session);
      if (!name) return;
      totals[name] = (totals[name] || 0) + (session.duration || 0);
    });
    return totals;
  }

  async function renderProjects() {
    const container = $('project-list');
    if (!container) return;
    clear(container);

    const names = [...new Set([...Object.values(projectsMap), ...Object.keys(projectGoals)])]
      .filter(Boolean)
      .sort();

    if (!names.length) {
      container.appendChild(emptyState('No projects yet. A project is a set of sites with a weekly goal.'));
      return;
    }

    const weekTotals = await weekTotalsByProject();

    names.forEach((name) => {
      const card = el('div', 'project-card');
      const goal = projectGoals[name] || null;
      const direction = projectDirection(name);
      const thisWeek = weekTotals[name] || 0;
      const isFocused = activeProjectFocus && activeProjectFocus.projectName === name;

      const head = el('div', 'project-head');
      const titleGroup = el('div', 'project-title-group');
      const dot = el('span', 'project-dot');
      dot.style.backgroundColor = domainColor(name);
      titleGroup.append(dot, el('span', 'project-name', name));

      const actions = el('div', 'project-actions');

      const focusBtn = el('button', `project-btn${isFocused ? ' active' : ''}`,
        isFocused ? 'Stop session' : 'Start session');
      focusBtn.addEventListener('click', async () => {
        activeProjectFocus = isFocused ? null : { projectName: name, startTime: Date.now() };
        await browser.storage.local.set({ activeProjectFocus });
        await browser.runtime.sendMessage({ action: 'syncProjectFocusBoundary' });
        renderProjects();
      });

      const editBtn = el('button', 'project-btn subtle', 'Edit');
      editBtn.addEventListener('click', () => openProjectModal(name));

      const deleteBtn = el('button', 'project-btn subtle danger', 'Delete');
      deleteBtn.addEventListener('click', async () => {
        const mapped = Object.keys(projectsMap).filter(domain => projectsMap[domain] === name);
        const confirmed = confirm(
          `Delete the project "${name}"?\n\n` +
          `${mapped.length} site${mapped.length === 1 ? '' : 's'} will be unmapped and the goal removed. ` +
          'Your tracked history is not deleted.'
        );
        if (!confirmed) return;

        mapped.forEach(domain => { delete projectsMap[domain]; });
        delete projectGoals[name];
        delete projectMeta[name];
        if (activeProjectFocus && activeProjectFocus.projectName === name) {
          activeProjectFocus = null;
          await browser.storage.local.set({ activeProjectFocus: null });
          await browser.runtime.sendMessage({ action: 'syncProjectFocusBoundary' });
        }
        await browser.storage.local.set({ projectMappings: projectsMap, projectGoals, projectMeta });
        renderProjects();
      });

      actions.append(focusBtn, editBtn, deleteBtn);
      head.append(titleGroup, actions);
      card.appendChild(head);

      if (goal) {
        // A floor that is exceeded is the good outcome; a ceiling that is
        // exceeded is not. The old build painted both as "over budget".
        const met = direction === 'floor' ? thisWeek >= goal : thisWeek <= goal;
        const progress = el('div', 'project-progress');

        const labels = el('div', 'project-progress-labels');
        labels.append(
          el('span', null, direction === 'floor' ? 'Weekly goal — reach' : 'Weekly goal — stay under'),
          el('span', 'project-progress-value', `${formatTime(thisWeek)} / ${formatTime(goal)}`)
        );

        const track = el('div', 'project-bar-track');
        const fill = el('div', 'project-bar-fill');
        fill.style.width = `${Math.min((thisWeek / goal) * 100, 100)}%`;
        fill.style.backgroundColor = met ? FOCUS_COLOR : (direction === 'ceiling' ? DISTRACT_COLOR : NEUTRAL_COLOR);
        track.appendChild(fill);

        const status = el('span', `project-status ${met ? 'met' : 'open'}`,
          direction === 'floor'
            ? (met ? 'Goal met' : `${formatTime(goal - thisWeek)} to go`)
            : (met ? 'Within budget' : `${formatTime(thisWeek - goal)} over`));

        progress.append(labels, track, status);
        card.appendChild(progress);
      }

      const domainList = el('div', 'project-domains');
      Object.keys(projectsMap).filter(domain => projectsMap[domain] === name).forEach((domain) => {
        const pill = el('span', 'project-domain-pill');
        pill.appendChild(document.createTextNode(domain));
        const remove = el('button', 'project-domain-remove', '×');
        remove.setAttribute('aria-label', `Remove ${domain} from ${name}`);
        remove.addEventListener('click', async () => {
          delete projectsMap[domain];
          await browser.storage.local.set({ projectMappings: projectsMap });
          renderProjects();
        });
        pill.appendChild(remove);
        domainList.appendChild(pill);
      });
      card.appendChild(domainList);

      container.appendChild(card);
    });
  }

  // ═══ Detail drawer: the primary drill-down ═══

  const drawer = $('detail-drawer');

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    openDetailDomain = null;
    openDetailLabel = null;
  }

  function openDetail(domain, labelFocus = null) {
    openDetailDomain = domain;
    openDetailLabel = labelFocus;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    renderDetail();
    $('drawer-close').focus();
  }

  function renderDetail() {
    if (!openDetailDomain) return;
    const domain = openDetailDomain;

    const title = $('drawer-title');
    clear(title);
    title.append(domainBadge(domain, 24), el('span', 'drawer-title-name', domain));
    if (openDetailLabel) {
      const chip = el('span', 'rule-chip', LABEL_NAMES[openDetailLabel] || 'Untagged');
      chip.style.borderColor = labelColor(openDetailLabel === 'untagged' ? null : openDetailLabel);
      chip.style.color = labelColor(openDetailLabel === 'untagged' ? null : openDetailLabel);
      title.appendChild(chip);
    }

    const body = $('drawer-body');
    clear(body);

    const all = sessions.filter(session => session.domain === domain);
    // Scoped to the group the row came from, so the figures below are the ones
    // that row was counting rather than the site's whole total.
    const own = openDetailLabel
      ? all.filter(session => (labelOf(session) || 'untagged') === openDetailLabel)
      : all;

    const total = totalOf(own);
    const visits = own.reduce((sum, session) => sum + (session.visits || 1), 0);

    const stats = el('div', 'drawer-stats');
    [
      [openDetailLabel ? `${LABEL_NAMES[openDetailLabel] || 'Untagged'} · ${scopeLabel().toLowerCase()}` : scopeLabel(), formatTime(total)],
      ['Share', `${pct(total, totalOf(sessions))}%`],
      ['Visits', String(visits)],
      ['Average visit', formatTime(visits ? total / visits : 0)]
    ].forEach(([label, value]) => {
      const cell = el('div', 'drawer-stat');
      cell.append(el('span', 'drawer-stat-label', label), el('span', 'drawer-stat-value', value));
      stats.appendChild(cell);
    });
    body.appendChild(stats);

    if (openDetailLabel && own.length !== all.length) {
      const note = el('div', 'drawer-scope-note');
      note.append(document.createTextNode(
        `Showing the ${(LABEL_NAMES[openDetailLabel] || 'untagged').toLowerCase()} share only — ${formatTime(totalOf(all))} total across all labels. `));
      const showAll = el('button', 'link-inline', 'See every visit');
      showAll.addEventListener('click', () => {
        openDetailLabel = null;
        renderDetail();
      });
      note.appendChild(showAll);
      body.appendChild(note);
    }

    if (own.some(session => session.capped)) {
      body.appendChild(el('div', 'drawer-warning',
        'At least one visit ran past the 2-hour safety cap. The total above is a floor, not the exact figure.'));
    }

    body.appendChild(el('h5', 'drawer-section', 'Counts as'));
    body.appendChild(buildRuleEditor(domain));

    body.appendChild(el('h5', 'drawer-section', 'If-then plan'));
    body.appendChild(buildPlanEditor(domain));

    body.appendChild(el('h5', 'drawer-section', 'Speed bump'));
    body.appendChild(buildSpeedBumpEditor(domain));

    body.appendChild(el('h5', 'drawer-section', openDetailLabel
      ? `${LABEL_NAMES[openDetailLabel] || 'Untagged'} visits in ${scopeLabel().toLowerCase()}`
      : `Visits in ${scopeLabel().toLowerCase()}`));
    body.appendChild(buildSessionList(domain, own));
  }

  function buildRuleEditor(domain) {
    const wrap = el('div', 'rule-editor');
    const rules = labelRules[domain] || [];

    if (!rules.length) {
      wrap.appendChild(el('p', 'rule-empty', 'Untagged. Its time is counted but lands in no column.'));
    }

    rules.forEach((rule, index) => {
      const row = el('div', 'rule-row');
      const chip = el('span', 'rule-chip', LABEL_NAMES[rule.label] || rule.label);
      chip.style.borderColor = labelColor(rule.label);
      chip.style.color = labelColor(rule.label);

      const remove = el('button', 'rule-remove', '×');
      remove.setAttribute('aria-label', 'Remove this rule');
      remove.addEventListener('click', async () => {
        labelRules[domain] = rules.filter((_, i) => i !== index);
        if (!labelRules[domain].length) delete labelRules[domain];
        await saveLabelRules();
        renderDetail();
        renderHome();
        renderWhere();
      });

      row.append(chip, el('span', 'rule-desc', describeRule(rule)), remove);
      wrap.appendChild(row);
    });

    // Add-rule form
    const form = el('div', 'rule-form');

    const labelSelect = el('select', 'clean-input rule-input');
    labelSelect.setAttribute('aria-label', 'Label');
    VALID_LABELS.forEach((value) => {
      const option = el('option', null, LABEL_NAMES[value]);
      option.value = value;
      labelSelect.appendChild(option);
    });

    const whenSelect = el('select', 'clean-input rule-input');
    whenSelect.setAttribute('aria-label', 'Condition');
    [
      ['always', 'by default'],
      ['hours', 'between hours'],
      ['project', 'during a project'],
      ['path', 'on a path']
    ].forEach(([value, text]) => {
      const option = el('option', null, text);
      option.value = value;
      whenSelect.appendChild(option);
    });

    const detailWrap = el('div', 'rule-form-detail');

    const fromInput = el('select', 'clean-input rule-input');
    const toInput = el('select', 'clean-input rule-input');
    fromInput.setAttribute('aria-label', 'From hour');
    toInput.setAttribute('aria-label', 'To hour');
    for (let hour = 0; hour < 24; hour++) {
      [fromInput, toInput].forEach((select) => {
        const option = el('option', null, formatHour(hour));
        option.value = String(hour);
        select.appendChild(option);
      });
    }
    fromInput.value = '22';
    toInput.value = '6';

    const projectSelect = el('select', 'clean-input rule-input');
    projectSelect.setAttribute('aria-label', 'Project');
    [...new Set(Object.values(projectsMap))].sort().forEach((name) => {
      const option = el('option', null, name);
      option.value = name;
      projectSelect.appendChild(option);
    });

    const pathInput = el('input', 'clean-input rule-input');
    pathInput.type = 'text';
    pathInput.placeholder = '/watch';
    pathInput.setAttribute('aria-label', 'Path prefix');

    function syncForm() {
      clear(detailWrap);
      if (whenSelect.value === 'hours') {
        detailWrap.append(el('span', 'rule-form-word', 'from'), fromInput, el('span', 'rule-form-word', 'to'), toInput);
      } else if (whenSelect.value === 'project') {
        if (projectSelect.options.length) detailWrap.appendChild(projectSelect);
        else detailWrap.appendChild(el('span', 'rule-form-word', 'create a project first'));
      } else if (whenSelect.value === 'path') {
        detailWrap.appendChild(pathInput);
      }
    }
    whenSelect.addEventListener('change', syncForm);
    syncForm();

    const addBtn = el('button', 'btn-outline-settings rule-add', 'Add rule');
    addBtn.addEventListener('click', async () => {
      const when = {};
      if (whenSelect.value === 'hours') {
        when.fromHour = Number(fromInput.value);
        when.toHour = Number(toInput.value);
      } else if (whenSelect.value === 'project') {
        if (!projectSelect.value) return;
        when.project = projectSelect.value;
      } else if (whenSelect.value === 'path') {
        const path = pathInput.value.trim();
        if (!path) return;
        when.path = path.startsWith('/') ? path : `/${path}`;
      }

      const rule = { label: labelSelect.value, when };
      const existing = labelRules[domain] || [];
      // Conditional rules are tried before the default, so they have to sit
      // above it in the list.
      labelRules[domain] = ruleIsConditional(rule)
        ? [rule, ...existing]
        : [...existing.filter(ruleIsConditional), rule];

      await saveLabelRules();
      renderDetail();
      renderHome();
      renderWhere();
    });

    form.append(labelSelect, whenSelect, detailWrap, addBtn);
    wrap.appendChild(form);

    if ((labelRules[domain] || []).some(rule => (rule.when || {}).path)) {
      wrap.appendChild(el('p', 'rule-note',
        'Path rules are applied as you browse. Past visits keep only their domain, so they are not re-labelled retroactively.'));
    }

    return wrap;
  }

  function buildPlanEditor(domain) {
    const wrap = el('div', 'plan-editor');
    wrap.appendChild(el('p', 'plan-intro',
      'Naming the cue and the replacement is the single best-evidenced thing you can do here. It gets shown back to you at the moment it applies.'));

    const row = el('div', 'plan-row');
    row.appendChild(el('span', 'plan-prefix', `When I open ${domain}, I will`));

    const input = el('input', 'clean-input plan-input');
    input.type = 'text';
    input.value = plans[domain] || '';
    input.placeholder = 'close it and go back to the draft';
    input.setAttribute('aria-label', `If-then plan for ${domain}`);

    const save = el('button', 'btn-outline-settings', 'Save');
    save.addEventListener('click', async () => {
      const value = input.value.trim();
      if (value) plans[domain] = value;
      else delete plans[domain];
      await browser.storage.local.set({ plans });
      save.textContent = 'Saved';
      setTimeout(() => { save.textContent = 'Save'; }, 1200);
    });

    row.append(input, save);
    wrap.appendChild(row);
    return wrap;
  }

  function buildSpeedBumpEditor(domain) {
    const wrap = el('div', 'speedbump-editor');
    const config = speedBumpSites[domain] || {};

    wrap.appendChild(el('p', 'plan-intro',
      'A pause, not a wall. Opening this site shows today’s number and your plan, then lets you through. ' +
      'Off unless you turn it on, and it asks for access to this site only.'));

    const row = el('label', 'speedbump-row');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = Boolean(config.enabled);
    row.append(toggle, el('span', null, `Show a speed bump on ${domain}`));

    const status = el('p', 'speedbump-status');

    toggle.addEventListener('change', async () => {
      const origins = [`*://${domain}/*`, `*://*.${domain}/*`];

      if (toggle.checked) {
        let granted = false;
        try {
          // Must be the first thing in the handler — awaiting anything before
          // this loses the user gesture the permission prompt requires.
          granted = await browser.permissions.request({ origins });
        } catch (error) {
          granted = false;
        }
        if (!granted) {
          toggle.checked = false;
          status.textContent = 'Access to this site was not granted, so the speed bump stays off.';
          return;
        }
        speedBumpSites[domain] = { ...config, enabled: true };
        status.textContent = 'On. It appears at most once every 30 minutes.';
      } else {
        delete speedBumpSites[domain];
        status.textContent = 'Off.';
        try {
          await browser.permissions.remove({ origins });
        } catch (error) {
          // Access may be retained for other reasons; the script is
          // unregistered below regardless.
        }
      }

      await browser.storage.local.set({ speedBumpSites });
      await browser.runtime.sendMessage({ action: 'syncSpeedBump' });
    });

    wrap.append(row, status);
    return wrap;
  }

  function buildSessionList(domain, own) {
    const wrap = el('div', 'session-list');
    const real = own.filter(session => !session.synthetic).sort((a, b) => b.start - a.start);

    if (!real.length) {
      wrap.appendChild(el('p', 'rule-empty', 'No individual visits stored for this range.'));
      return wrap;
    }

    real.slice(0, 40).forEach((session) => {
      const row = el('div', 'session-row');
      const when = el('span', 'session-when',
        `${parseKey(session._dateKey).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${formatClockTime(session.start)}`);

      const select = el('select', 'clean-input session-select');
      select.setAttribute('aria-label', 'Label for this visit');
      [['', 'Untagged'], ...VALID_LABELS.map(value => [value, LABEL_NAMES[value]])].forEach(([value, text]) => {
        const option = el('option', null, text);
        option.value = value;
        select.appendChild(option);
      });
      select.value = labelOf(session) || '';

      select.addEventListener('change', async () => {
        await setSessionLabel(session, select.value || null);
        renderHome();
        renderWhere();
        // Relabelling can move a visit out of the group the drawer is scoped to,
        // so the list has to be rebuilt rather than left showing a stale row.
        renderDetail();
      });

      row.append(when, el('span', 'session-duration', formatTime(session.duration)), select);
      wrap.appendChild(row);
    });

    return wrap;
  }

  // Writes onto the stored day record. `sessions` is a stitched in-memory
  // projection that also carries the live ongoing slice — persisting it would
  // flatten the raw history and double-count active time.
  async function setSessionLabel(session, label) {
    const dateKey = session._dateKey;
    if (!dateKey) return;

    const stored = await browser.storage.local.get(dateKey);
    const day = stored[dateKey];
    if (!day || !Array.isArray(day.sessions)) return;

    day.sessions.forEach((raw) => {
      if (raw.domain !== session.domain) return;
      if (raw.start >= session.start && raw.end <= session.end) {
        if (label) raw.productivityLabel = label;
        else delete raw.productivityLabel;
      }
    });

    await browser.storage.local.set({ [dateKey]: day });
    if (label) session.productivityLabel = label;
    else delete session.productivityLabel;
  }

  // ═══ When ═══

  function renderWhen() {
    const container = $('rhythm');
    const title = $('rhythm-title');
    const note = $('rhythm-note');
    clear(container);
    clear(note);

    const real = sessions.filter(session => !session.synthetic);

    if (!real.length) {
      title.textContent = 'Rhythm';
      container.appendChild(emptyState(
        hasSynthetic
          ? 'This range is compacted history — totals are exact, but the individual clock times are gone.'
          : 'Nothing tracked in this range yet.'
      ));
      renderBlocks([]);
      return;
    }

    if (hasSynthetic) {
      note.textContent = 'Compacted days are excluded — their clock times are no longer stored.';
    }

    if (scope.mode === 'day') {
      title.textContent = 'Hour by hour';
      renderHourBars(container, real);
    } else if (scope.mode === 'month') {
      title.textContent = 'Day by day';
      renderCalendar(container, real);
    } else {
      title.textContent = scope.mode === 'all' ? 'Typical week' : 'Hour by day';
      renderHeatmap(container, real);
    }

    renderBlocks(real);
  }

  function renderHourBars(container, list) {
    const buckets = hourBuckets(list);
    const max = Math.max(...buckets.map(bucket => bucket.total), 1);

    const graph = el('div', 'hour-bars');
    buckets.forEach((bucket, hour) => {
      const bar = el('div', 'hour-bar');
      bar.style.height = bucket.total ? `${Math.max(6, (bucket.total / max) * 100)}%` : '2px';
      bar.title = `${formatHour(hour)} — ${formatTime(bucket.total)}`;

      if (bucket.total > 0) {
        const stops = [];
        let cursor = 0;
        [
          ['productive', FOCUS_COLOR],
          ['distracting', DISTRACT_COLOR],
          ['neutral', NEUTRAL_COLOR],
          ['untagged', FAINT_COLOR]
        ].forEach(([key, color]) => {
          const share = (bucket[key] / bucket.total) * 100;
          if (share <= 0) return;
          stops.push(`${color} ${cursor}% ${cursor + share}%`);
          cursor += share;
        });
        bar.style.background = `linear-gradient(180deg, ${stops.join(', ')})`;
        bar.classList.add('has-usage');
      }

      graph.appendChild(bar);
    });

    const axis = el('div', 'hour-axis');
    ['12AM', '6AM', '12PM', '6PM', '12AM'].forEach(text => axis.appendChild(el('span', null, text)));

    const peak = buckets.reduce((best, bucket, hour) => bucket.total > buckets[best].total ? hour : best, 0);
    const summary = el('div', 'rhythm-summary');
    if (buckets[peak].total > 0) {
      summary.append(
        document.createTextNode('Busiest around '),
        el('strong', null, formatHour(peak)),
        document.createTextNode(` with ${formatTime(buckets[peak].total)}.`)
      );
    }

    container.append(graph, axis, summary);
  }

  function renderHeatmap(container, list) {
    const matrix = dayHourMatrix(list);
    const max = Math.max(...matrix.flat(), 1);

    const grid = el('div', 'heatmap');
    matrix.forEach((row, dayIndex) => {
      grid.appendChild(el('div', 'heatmap-day', DAY_SHORT[dayIndex]));
      row.forEach((value, hour) => {
        const cell = el('div', 'heatmap-cell');
        if (value > 0) {
          cell.classList.add('has-data');
          cell.style.opacity = String(Math.min(0.15 + (value / max) * 0.85, 1));
          cell.title = `${DAY_LONG[dayIndex]} ${formatHour(hour)} — ${formatTime(value)}`;
        }
        grid.appendChild(cell);
      });
    });

    const axis = el('div', 'heatmap-axis');
    for (let hour = 0; hour < 24; hour += 3) {
      const marker = el('span', null, formatHour(hour));
      marker.style.gridColumn = 'span 3';
      axis.appendChild(marker);
    }

    const legend = el('div', 'heatmap-legend');
    legend.append(el('span', null, 'less'), el('div', 'heatmap-gradient'), el('span', null, 'more'));

    container.append(grid, axis, legend);
  }

  function renderCalendar(container, list) {
    const totals = {};
    list.forEach((session) => {
      totals[session._dateKey] = (totals[session._dateKey] || 0) + (session.duration || 0);
    });

    const keys = scopeKeys();
    const max = Math.max(...Object.values(totals), 1);
    const today = todayKey();

    const grid = el('div', 'calendar');
    DAY_SHORT.forEach(name => grid.appendChild(el('div', 'calendar-head', name)));

    // Pad to the first weekday so columns line up with the header.
    const firstWeekday = (parseKey(keys[0]).getDay() + 6) % 7;
    for (let i = 0; i < firstWeekday; i++) grid.appendChild(el('div', 'calendar-pad'));

    keys.forEach((key) => {
      const value = totals[key] || 0;
      const cell = el('button', 'calendar-cell');
      if (key > today) cell.classList.add('is-future');
      if (key === today) cell.classList.add('is-today');

      const bar = el('span', 'calendar-bar');
      bar.style.height = value ? `${Math.max(8, (value / max) * 100)}%` : '0';
      bar.style.backgroundColor = FOCUS_COLOR;

      cell.append(el('span', 'calendar-date', String(parseKey(key).getDate())), bar);
      cell.title = `${parseKey(key).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${formatTime(value)}`;
      cell.addEventListener('click', () => {
        scope = { mode: 'day', anchor: key };
        document.querySelectorAll('.scope-mode').forEach((button) => {
          button.classList.toggle('active', button.dataset.scopeMode === 'day');
        });
        loadAndRender();
      });

      grid.appendChild(cell);
    });

    container.appendChild(grid);
  }

  function renderBlocks(list) {
    const stats = $('switch-stats');
    const container = $('session-blocks');
    clear(stats);
    clear(container);

    if (!list.length) {
      container.appendChild(emptyState('No blocks to show for this range.'));
      return;
    }

    const blocks = buildBlocks(list);
    const switches = countSwitches(list);

    // The count is measured. There is deliberately no "cost of switching" figure
    // derived from it — the resumption times in the literature describe
    // interrupted tasks, not tab switches, and a tab switch is often the work.
    stats.append(
      el('strong', null, String(switches)),
      document.createTextNode(` site switch${switches === 1 ? '' : 'es'} across ${blocks.length} block${blocks.length === 1 ? '' : 's'} of activity.`)
    );

    blocks
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 12)
      .forEach((block) => {
        const [dominant] = Object.entries(block.weights).sort((a, b) => b[1] - a[1]);
        const label = dominant && dominant[1] > 0 ? dominant[0] : 'untagged';

        const card = el('div', 'block-card');
        const head = el('div', 'block-head');
        head.append(
          el('span', 'block-title', block.domains.length === 1 ? block.domains[0] : `${block.domains.length} sites`),
          el('span', 'block-duration', formatTime(block.duration))
        );

        const tag = el('span', 'block-tag', LABEL_NAMES[label] || 'Untagged');
        tag.style.color = labelColor(label === 'untagged' ? null : label);
        tag.style.borderColor = labelColor(label === 'untagged' ? null : label);

        card.append(
          head,
          el('div', 'block-meta',
            `${formatClockTime(block.start)} – ${formatClockTime(block.end)} · ${block.switches} switch${block.switches === 1 ? '' : 'es'}`),
          tag
        );
        container.appendChild(card);
      });
  }

  // ═══ Review ═══

  const reviewModal = $('review-modal');

  function reviewWeekKeys() {
    const monday = shiftKey(mondayOf(todayKey()), -reviewWeekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => shiftKey(monday, i));
  }

  function openReview() {
    reviewModal.classList.add('open');
    reviewModal.setAttribute('aria-hidden', 'false');
    renderReview();
  }

  function closeReview() {
    reviewModal.classList.remove('open');
    reviewModal.setAttribute('aria-hidden', 'true');
  }

  async function renderReview() {
    const keys = reviewWeekKeys();
    const previousKeys = Array.from({ length: 7 }, (_, i) => shiftKey(keys[0], i - 7));

    const [weekSessions, previousSessions] = await Promise.all([
      fetchSessions(keys),
      fetchSessions(previousKeys)
    ]);

    $('review-range').textContent =
      `${parseKey(keys[0]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ` +
      `${parseKey(keys[6]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    $('review-next').disabled = reviewWeekOffset === 0;

    const totalsByDay = keys.map(key => totalOf(weekSessions.filter(session => session._dateKey === key)));
    const total = totalsByDay.reduce((sum, value) => sum + value, 0);
    const previousTotal = totalOf(previousSessions);
    const activeDays = totalsByDay.filter(value => value > 0).length;
    const peakIndex = totalsByDay.reduce((best, value, index) => value > totalsByDay[best] ? index : best, 0);

    const statsWrap = $('review-stats');
    clear(statsWrap);

    [
      ['Total', formatTime(total), previousTotal > 0 ? total - previousTotal : null],
      ['Daily average', formatTime(activeDays ? total / activeDays : 0), null],
      ['Active days', `${activeDays} / 7`, null],
      ['Busiest', totalsByDay[peakIndex] > 0 ? DAY_LONG[peakIndex] : '—', null]
    ].forEach(([label, value, delta]) => {
      const cell = el('div', 'digest-stat');
      cell.append(el('span', 'digest-stat-label', label), el('span', 'digest-stat-value', value));
      if (delta !== null) {
        cell.appendChild(el('span', `digest-stat-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}`,
          delta === 0 ? 'same as last week' : `${delta > 0 ? '↑' : '↓'} ${formatTime(Math.abs(delta))} vs last week`));
      }
      statsWrap.appendChild(cell);
    });

    const daysWrap = $('review-days');
    clear(daysWrap);
    const maxDay = Math.max(...totalsByDay, 1);
    const today = todayKey();

    keys.forEach((key, index) => {
      const row = el('div', 'day-row');
      row.appendChild(el('div', `day-label${key === today ? ' is-today' : ''}`, DAY_SHORT[index]));

      const track = el('div', 'day-bar-track');
      const fill = el('div', `day-bar-fill${key === today ? ' today' : ''}`);
      fill.style.width = `${(totalsByDay[index] / maxDay) * 100}%`;
      track.appendChild(fill);
      row.appendChild(track);

      row.appendChild(el('div', `day-time${key === today ? ' is-today' : ''}`,
        totalsByDay[index] > 0 ? formatTime(totalsByDay[index]) : (key > today ? '' : '—')));
      daysWrap.appendChild(row);
    });

    renderInbox(weekSessions);
    renderReviewNotable();
    await renderReflection(keys[0]);
  }

  // The highest-leverage surface in the app: every derived number is only as
  // good as label coverage, and this is where coverage gets fixed in one pass.
  function renderInbox(weekSessions) {
    const intro = $('review-inbox-intro');
    const container = $('review-inbox');
    clear(container);

    const untagged = weekSessions.filter(session => !labelOf(session));
    if (!untagged.length) {
      intro.textContent = 'Everything this week is labelled.';
      return;
    }

    const grouped = {};
    untagged.forEach((session) => {
      const entry = grouped[session.domain] || (grouped[session.domain] = { domain: session.domain, duration: 0 });
      entry.duration += session.duration || 0;
    });

    const rows = Object.values(grouped).sort((a, b) => b.duration - a.duration);
    intro.textContent = `${formatTime(totalOf(untagged))} across ${rows.length} site${rows.length === 1 ? '' : 's'}. ` +
      'Setting a default here labels the site everywhere, including in your history.';

    rows.forEach((entry) => {
      const row = el('div', 'inbox-row');
      const name = el('span', 'inbox-name', entry.domain);
      name.title = entry.domain;

      const buttons = el('div', 'inbox-buttons');
      VALID_LABELS.forEach((label) => {
        const button = el('button', 'inbox-btn', LABEL_NAMES[label]);
        button.style.setProperty('--inbox-color', labelColor(label));
        button.addEventListener('click', async () => {
          const existing = (labelRules[entry.domain] || []).filter(ruleIsConditional);
          labelRules[entry.domain] = [...existing, { label, when: {} }];
          await saveLabelRules();
          row.remove();
          renderHome();
          renderWhere();
          if (!container.children.length) intro.textContent = 'Everything this week is labelled.';
        });
        buttons.appendChild(button);
      });

      row.append(domainBadge(entry.domain, 18), name, el('span', 'inbox-amount', formatTime(entry.duration)), buttons);
      container.appendChild(row);
    });
  }

  function renderReviewNotable() {
    const container = $('review-notable');
    clear(container);

    if (!deviations.length) {
      container.appendChild(el('p', 'rule-empty', 'Nothing sits outside your normal range right now.'));
      return;
    }

    deviations.slice(0, 4).forEach((deviation) => {
      const row = el('div', 'notable-row');
      row.append(
        domainBadge(deviation.domain, 18),
        el('span', 'notable-name', deviation.domain),
        el('span', 'notable-meta', deviation.kind === 'new'
          ? `new — no history in the last ${DEVIATION_WINDOW_DAYS} days`
          : `${formatTime(deviation.total)} today against a typical ${formatTime(deviation.median)}`)
      );
      container.appendChild(row);
    });
  }

  let reflectionTimer = null;

  async function renderReflection(weekStartKey) {
    const stored = await browser.storage.local.get('reflections');
    const reflections = stored.reflections || {};
    const existing = reflections[weekStartKey];

    // Stable per week rather than random, so returning to a week shows the same
    // question you answered.
    const index = weekStartKey.split('-').reduce((sum, part) => sum + Number(part), 0) % REFLECTION_QUESTIONS.length;
    $('review-question').textContent = REFLECTION_QUESTIONS[index];

    const input = $('review-reflection');
    input.value = existing ? existing.text : '';
    $('review-saved').textContent = existing
      ? `Saved ${new Date(existing.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : '';

    input.oninput = () => {
      clearTimeout(reflectionTimer);
      reflectionTimer = setTimeout(async () => {
        const latest = await browser.storage.local.get('reflections');
        const next = latest.reflections || {};
        const text = input.value.trim();
        if (text) next[weekStartKey] = { text, savedAt: Date.now() };
        else delete next[weekStartKey];
        await browser.storage.local.set({ reflections: next });
        $('review-saved').textContent = text ? 'Saved' : '';
      }, 600);
    };
  }

  // ═══ Project modal ═══

  const projectModal = $('add-project-modal');
  let editingProject = null;
  let projectDirectionChoice = 'floor';

  function openProjectModal(existingName = null) {
    editingProject = existingName;
    $('add-project-title').textContent = existingName ? `Edit ${existingName}` : 'New project';
    $('new-project-name').value = existingName || '';
    $('new-project-domain').value = '';
    $('new-project-goal').value = existingName && projectGoals[existingName]
      ? String(projectGoals[existingName] / 3600)
      : '';
    projectDirectionChoice = existingName ? projectDirection(existingName) : 'floor';
    document.querySelectorAll('#new-project-direction .seg-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.direction === projectDirectionChoice);
    });
    $('btn-save-project').textContent = existingName ? 'Save project' : 'Create project';
    $('project-form-error').hidden = true;
    projectModal.classList.add('open');
    projectModal.setAttribute('aria-hidden', 'false');
    $('new-project-name').focus();
  }

  function closeProjectModal() {
    projectModal.classList.remove('open');
    projectModal.setAttribute('aria-hidden', 'true');
    editingProject = null;
  }

  function normalizeDomainInput(value) {
    const raw = value.trim().toLowerCase();
    if (!raw) return '';
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
    } catch (error) {
      return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  // ═══ Settings ═══

  const settingsModal = $('settings-modal');

  function closeSettings() {
    settingsModal.classList.remove('open');
    settingsModal.setAttribute('aria-hidden', 'true');
  }

  function renderLastExport(timestamp) {
    $('last-export-hint').textContent = timestamp
      ? `Last export: ${new Date(timestamp).toLocaleString()}`
      : 'Last export: never';
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    const now = Date.now();
    renderLastExport(now);
    browser.storage.local.set({ lastExportAt: now }).catch(console.warn);
  }

  // Rolls old days into per-domain daily totals. Every total stays exact; what
  // goes is the individual visit times, which you can no longer act on anyway.
  async function compactHistory() {
    const cutoff = shiftKey(todayKey(), -COMPACT_AFTER_DAYS);
    const keys = (await listDayKeys()).filter(key => key < cutoff);
    if (!keys.length) return { days: 0 };

    const stored = await browser.storage.local.get(keys);
    const writes = {};
    let compacted = 0;

    keys.forEach((key) => {
      const day = stored[key];
      if (!day || day.compacted || !Array.isArray(day.sessions)) return;

      const totals = {};
      day.sessions.forEach((session) => {
        if (!session.domain) return;
        const entry = totals[session.domain] || (totals[session.domain] = { duration: 0, visits: 0 });
        entry.duration += session.duration || 0;
        entry.visits += 1;
        const label = normalizeLabel(session.productivityLabel);
        if (label && !entry.label) entry.label = label;
      });

      writes[key] = { compacted: true, totals };
      compacted++;
    });

    if (compacted) await browser.storage.local.set(writes);
    return { days: compacted };
  }

  async function importJson(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      alert('That file is not valid JSON. Only a Flow Tracker JSON export can be imported.');
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      alert('That file is not a Flow Tracker export.');
      return;
    }

    const dayKeys = Object.keys(parsed).filter(isDayKey);
    if (!dayKeys.length) {
      alert('No tracked days found in that file. Only a Flow Tracker JSON export can be imported.');
      return;
    }

    const confirmed = confirm(
      `Import ${dayKeys.length} day${dayKeys.length === 1 ? '' : 's'} of history?\n\n` +
      'Days already present are merged — visits that exist in both are not duplicated. ' +
      'Projects, rules and preferences in the file are ignored, so your current setup is kept.'
    );
    if (!confirmed) return;

    const existing = await browser.storage.local.get(dayKeys);
    const writes = {};

    dayKeys.forEach((key) => {
      const incoming = parsed[key];
      if (!incoming || !Array.isArray(incoming.sessions)) return;

      const current = existing[key] && Array.isArray(existing[key].sessions) ? existing[key].sessions : [];
      const seen = new Set(current.map(session => `${session.domain}|${session.start}|${session.end}`));
      const added = incoming.sessions.filter((session) => {
        const signature = `${session.domain}|${session.start}|${session.end}`;
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      });

      writes[key] = { sessions: [...current, ...added].sort((a, b) => a.start - b.start) };
    });

    const count = Object.keys(writes).length;
    await browser.storage.local.set(writes);
    dayKeyCache = null;
    alert(`Imported ${count} day${count === 1 ? '' : 's'}.`);
    await loadAndRender();
  }

  // ═══ Render ═══

  function renderAll() {
    $('scope-label').textContent = scopeLabel();
    $('scope-next').disabled = atLatestScope();
    $('scope-prev').disabled = scope.mode === 'all';

    renderHome();
    renderWhere();
    renderWhen();
    if (openDetailDomain) renderDetail();
  }

  // ═══ Wiring ═══

  const storageInit = await browser.storage.local.get([
    'labelRules', 'productivityLabels', 'projectMappings', 'projectGoals', 'projectMeta',
    'plans', 'speedBumpSites', 'activeProjectFocus', 'darkMode', 'themePrefs',
    'notificationPrefs', 'trackingPrefs', 'lastExportAt'
  ]);

  projectsMap = storageInit.projectMappings || {};
  projectGoals = storageInit.projectGoals || {};
  projectMeta = storageInit.projectMeta || {};
  plans = storageInit.plans || {};
  speedBumpSites = storageInit.speedBumpSites || {};
  activeProjectFocus = storageInit.activeProjectFocus || null;

  // Migrate the flat domain -> label map if the background script has not
  // already done it this session.
  if (storageInit.labelRules) {
    labelRules = storageInit.labelRules;
  } else {
    labelRules = {};
    Object.entries(storageInit.productivityLabels || {}).forEach(([domain, label]) => {
      const normalized = normalizeLabel(label);
      if (normalized) labelRules[domain] = [{ label: normalized, when: {} }];
    });
    await browser.storage.local.set({ labelRules });
  }

  if (storageInit.darkMode || (storageInit.themePrefs && storageInit.themePrefs.darkMode)) {
    document.documentElement.classList.add('dark-theme');
  }

  refreshThemeColors();

  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(other => other.classList.remove('active'));
      document.querySelectorAll('.view-content').forEach(view => view.classList.remove('active'));
      tab.classList.add('active');
      $(`view-${tab.dataset.view}`).classList.add('active');
    });
  });

  // Scope
  document.querySelectorAll('.scope-mode').forEach((button) => {
    button.addEventListener('click', () => setScopeMode(button.dataset.scopeMode));
  });
  $('scope-prev').addEventListener('click', () => shiftScope(-1));
  $('scope-next').addEventListener('click', () => shiftScope(1));

  // Where controls — all operate on already-loaded data, no storage reads.
  document.querySelectorAll('#where-filters .filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#where-filters .filter-pill').forEach(other => other.classList.remove('active'));
      pill.classList.add('active');
      whereFilter = pill.dataset.filter;
      renderWhere();
    });
  });

  $('where-group').addEventListener('change', (event) => {
    whereGroup = event.target.value;
    renderWhere();
  });

  $('where-sort').addEventListener('change', (event) => {
    whereSort = event.target.value;
    renderWhere();
  });

  // Drawer
  $('drawer-close').addEventListener('click', closeDrawer);
  drawer.addEventListener('click', (event) => {
    if (event.target === drawer) closeDrawer();
  });

  // Review
  $('review-btn').addEventListener('click', () => { reviewWeekOffset = 0; openReview(); });
  $('review-close').addEventListener('click', closeReview);
  $('review-prev').addEventListener('click', () => { reviewWeekOffset++; renderReview(); });
  $('review-next').addEventListener('click', () => {
    if (reviewWeekOffset === 0) return;
    reviewWeekOffset--;
    renderReview();
  });
  reviewModal.addEventListener('click', (event) => {
    if (event.target === reviewModal) closeReview();
  });

  // Settings
  $('settings-btn').addEventListener('click', () => {
    settingsModal.classList.add('open');
    settingsModal.setAttribute('aria-hidden', 'false');
  });
  $('settings-close').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (event) => {
    if (event.target === settingsModal) closeSettings();
  });

  $('settings-version').textContent = `Flow Tracker v${browser.runtime.getManifest().version}`;
  renderLastExport(storageInit.lastExportAt);

  // Preferences
  const notificationPrefs = {
    budgetAlerts: storageInit.notificationPrefs?.budgetAlerts ?? true,
    deviationAlerts: storageInit.notificationPrefs?.deviationAlerts ?? false
  };
  const trackingPrefs = {
    idleDetection: storageInit.trackingPrefs?.idleDetection ?? true,
    idleThresholdSeconds: storageInit.trackingPrefs?.idleThresholdSeconds ?? 180,
    ignoreIdleWhenPlaying: storageInit.trackingPrefs?.ignoreIdleWhenPlaying ?? true
  };

  $('budget-alerts-toggle').checked = notificationPrefs.budgetAlerts;
  $('deviation-alerts-toggle').checked = notificationPrefs.deviationAlerts;
  $('idle-detection-toggle').checked = trackingPrefs.idleDetection;
  $('ignore-idle-playing-toggle').checked = trackingPrefs.ignoreIdleWhenPlaying;
  $('idle-threshold').value = String(trackingPrefs.idleThresholdSeconds);
  $('idle-threshold').disabled = !trackingPrefs.idleDetection;
  $('dark-mode-toggle').checked = document.documentElement.classList.contains('dark-theme');

  async function saveNotificationPrefs(next) {
    Object.assign(notificationPrefs, next);
    await browser.storage.local.set({ notificationPrefs: { ...notificationPrefs } });
  }

  async function saveTrackingPrefs(next) {
    Object.assign(trackingPrefs, next);
    $('idle-threshold').disabled = !trackingPrefs.idleDetection;
    await browser.storage.local.set({ trackingPrefs: { ...trackingPrefs } });
    try {
      await browser.runtime.sendMessage({ action: 'syncTrackingPrefs' });
    } catch (error) {
      console.warn('Failed to sync tracking prefs:', error);
    }
  }

  $('budget-alerts-toggle').addEventListener('change', e => saveNotificationPrefs({ budgetAlerts: e.target.checked }));
  $('deviation-alerts-toggle').addEventListener('change', e => saveNotificationPrefs({ deviationAlerts: e.target.checked }));
  $('idle-detection-toggle').addEventListener('change', e => saveTrackingPrefs({ idleDetection: e.target.checked }));
  $('ignore-idle-playing-toggle').addEventListener('change', e => saveTrackingPrefs({ ignoreIdleWhenPlaying: e.target.checked }));
  $('idle-threshold').addEventListener('change', e => saveTrackingPrefs({ idleThresholdSeconds: Number(e.target.value) || 180 }));

  $('dark-mode-toggle').addEventListener('change', async (event) => {
    document.documentElement.classList.toggle('dark-theme', event.target.checked);
    // Charts paint with resolved colour values, so they have to be repainted
    // when the palette underneath them changes.
    refreshThemeColors();
    renderAll();
    await browser.storage.local.set({ darkMode: event.target.checked });
  });

  // Data actions
  $('btn-export-json').addEventListener('click', async () => {
    const all = await browser.storage.local.get(null);
    download(JSON.stringify(all, null, 2), `flow_tracker_export_${Date.now()}.json`, 'application/json');
  });

  $('btn-export-csv').addEventListener('click', async () => {
    const all = await browser.storage.local.get(null);
    // Quote every field: an unescaped comma or quote in a domain would silently
    // shift every following column in the exported file.
    const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = [['Date', 'Domain', 'Start', 'End', 'Duration (s)', 'Label'].map(cell).join(',')];

    Object.keys(all).filter(isDayKey).sort().forEach((key) => {
      expandDay(key, all[key]).forEach((session) => {
        rows.push([
          key,
          session.domain,
          session.synthetic ? '' : new Date(session.start).toISOString(),
          session.synthetic ? '' : new Date(session.end).toISOString(),
          session.duration,
          labelOf(session) || 'untagged'
        ].map(cell).join(','));
      });
    });

    download(rows.join('\n') + '\n', `flow_tracker_export_${Date.now()}.csv`, 'text/csv');
  });

  $('btn-import-json').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) await importJson(file);
  });

  $('btn-compact').addEventListener('click', async () => {
    const button = $('btn-compact');
    button.disabled = true;
    const result = await compactHistory();
    button.disabled = false;
    $('compact-hint').textContent = result.days
      ? `Compacted ${result.days} day${result.days === 1 ? '' : 's'}.`
      : `Nothing older than ${COMPACT_AFTER_DAYS} days to compact.`;
    if (result.days) await loadAndRender();
  });

  $('clear-data-btn').addEventListener('click', async () => {
    const range = $('clear-data-range').value;
    const rangeText = range === 'all' ? 'all time' : `the last ${range} days`;
    if (!confirm(`Clear tracking history for ${rangeText}? This cannot be undone.`)) return;

    const keys = await listDayKeys();
    let toRemove;

    if (range === 'all') {
      // Clear tracked history only. Projects, goals, rules and preferences are
      // configuration, not history — wiping them here would be a nasty surprise.
      toRemove = [...keys, 'activeSession', 'activeProjectFocus', 'notificationState'];
    } else {
      const earliest = shiftKey(todayKey(), -(parseInt(range, 10) - 1));
      toRemove = keys.filter(key => key >= earliest);
    }

    await browser.storage.local.remove(toRemove);
    dayKeyCache = null;
    closeSettings();
    await loadAndRender();
  });

  // Project modal
  document.querySelector('.show-new-project-btn').addEventListener('click', () => openProjectModal());
  $('add-project-close').addEventListener('click', closeProjectModal);
  projectModal.addEventListener('click', (event) => {
    if (event.target === projectModal) closeProjectModal();
  });

  document.querySelectorAll('#new-project-direction .seg-btn').forEach((button) => {
    button.addEventListener('click', () => {
      projectDirectionChoice = button.dataset.direction;
      document.querySelectorAll('#new-project-direction .seg-btn').forEach((other) => {
        other.classList.toggle('active', other === button);
      });
    });
  });

  $('btn-save-project').addEventListener('click', async () => {
    const name = $('new-project-name').value.trim();
    const domain = normalizeDomainInput($('new-project-domain').value);
    const hours = Number($('new-project-goal').value.trim());
    const error = $('project-form-error');

    if (!name) {
      error.textContent = 'Give the project a name.';
      error.hidden = false;
      return;
    }
    // No invented default. A goal the user never set should never drive a
    // progress bar, a status pill, or a notification.
    if (!(hours > 0)) {
      error.textContent = 'Set a weekly goal in hours — it is what the progress bar measures against.';
      error.hidden = false;
      return;
    }
    if (!editingProject && !domain) {
      error.textContent = 'Add at least one site so there is something to attribute.';
      error.hidden = false;
      return;
    }

    if (domain) projectsMap[domain] = name;
    projectGoals[name] = Math.round(hours * 3600);
    projectMeta[name] = { direction: projectDirectionChoice };

    await browser.storage.local.set({ projectMappings: projectsMap, projectGoals, projectMeta });
    closeProjectModal();
    renderProjects();
  });

  // Keyboard
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (drawer.classList.contains('open')) return closeDrawer();
      closeSettings();
      closeProjectModal();
      closeReview();
      return;
    }

    // Don't hijack arrow keys while typing, or while a dialog has focus.
    const target = event.target;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.querySelector('.modal-overlay.open') || drawer.classList.contains('open')) return;

    if (event.key === 'ArrowLeft') shiftScope(-1);
    else if (event.key === 'ArrowRight') shiftScope(1);
  });

  // Live updates
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (Object.keys(changes).some(isDayKey)) {
      dayKeyCache = null;
      loadAndRender();
      return;
    }

    if (changes.labelRules) {
      labelRules = changes.labelRules.newValue || {};
      renderHome();
      renderWhere();
      renderWhen();
    }
    if (changes.projectMappings) {
      projectsMap = changes.projectMappings.newValue || {};
      renderWhere();
    }
    if (changes.projectGoals) {
      projectGoals = changes.projectGoals.newValue || {};
      renderProjects();
    }
    if (changes.activeProjectFocus) {
      activeProjectFocus = changes.activeProjectFocus.newValue || null;
      renderProjects();
    }
    if (changes.plans) plans = changes.plans.newValue || {};
  });

  await loadAndRender();
});
