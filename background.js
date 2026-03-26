// ─── Helpers ───

const MAX_SESSION_SECONDS = 7200; // 2-hour cap — anything longer is a tracking error

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

function getStartOfDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// ─── Session State ───

let memDomain = null;
let memStartTime = null;

async function getActiveSession() {
  if (memDomain !== null && memStartTime !== null) {
    return { currentDomain: memDomain, sessionStartTime: memStartTime };
  }

  const data = await browser.storage.local.get('activeSession');
  if (data.activeSession && data.activeSession.currentDomain) {
    memDomain = data.activeSession.currentDomain;
    memStartTime = data.activeSession.sessionStartTime;
    return data.activeSession;
  }
  return { currentDomain: null, sessionStartTime: null };
}

async function setActiveSession(domain, startTime) {
  memDomain = domain;
  memStartTime = startTime;
  await browser.storage.local.set({ activeSession: { currentDomain: domain, sessionStartTime: startTime } });
}

// ─── Migrate legacy data format ───
// Old format: { chunks: [], aggregates: {} }
// New format: { sessions: [] }

function migrateDayData(dayData) {
  if (dayData.sessions) return dayData; // Already new format

  const sessions = [];

  // Migrate chunks
  if (Array.isArray(dayData.chunks)) {
    dayData.chunks.forEach(c => {
      sessions.push({
        domain: c.domain,
        start: c.start,
        end: c.end,
        duration: c.duration
      });
    });
  }

  // Migrate aggregates
  if (dayData.aggregates && typeof dayData.aggregates === 'object') {
    for (const [domain, data] of Object.entries(dayData.aggregates)) {
      if (typeof data === 'number') {
        sessions.push({ domain, start: null, end: null, duration: data });
      } else if (Array.isArray(data)) {
        data.forEach(s => {
          sessions.push({
            domain,
            start: s.start || null,
            end: s.end || null,
            duration: s.duration
          });
        });
      }
    }
  }

  return { sessions };
}

// ─── Save a completed session ───

async function saveSession(domain, startTime, endTime) {
  let durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));
  if (durationSeconds < 1) return;

  // Cap at maximum to prevent tracking errors
  durationSeconds = Math.min(durationSeconds, MAX_SESSION_SECONDS);

  const startDate = getDateString(startTime);
  const endDate = getDateString(endTime);

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
        duration: Math.min(beforeMidnight, MAX_SESSION_SECONDS)
      });
    }
    if (afterMidnight > 0) {
      await writeToDayStorage(endDate, {
        domain,
        start: midnightMs,
        end: endTime,
        duration: Math.min(afterMidnight, MAX_SESSION_SECONDS)
      });
    }
  } else {
    await writeToDayStorage(startDate, {
      domain,
      start: startTime,
      end: endTime,
      duration: durationSeconds
    });
  }
}

async function writeToDayStorage(dateKey, session) {
  const data = await browser.storage.local.get(dateKey);
  let dayData = data[dateKey] ? migrateDayData(data[dateKey]) : { sessions: [] };
  dayData.sessions.push(session);
  await browser.storage.local.set({ [dateKey]: dayData });
}

async function getDayDataWithActiveSession(dateKey) {
  const stored = await browser.storage.local.get(dateKey);
  let dayData = stored[dateKey] ? migrateDayData(stored[dateKey]) : { sessions: [] };
  dayData = JSON.parse(JSON.stringify(dayData));

  const { currentDomain, sessionStartTime } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return dayData;

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
    ongoing: true
  });

  return dayData;
}

// ─── Finalize & Start Sessions ───

async function finalizeSession() {
  const { currentDomain, sessionStartTime } = await getActiveSession();
  if (!currentDomain || !sessionStartTime) return;

  const endTime = Date.now();
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
    await setActiveSession(domain, Date.now());
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
      const { currentDomain } = await getActiveSession();

      if (newDomain === currentDomain) return;

      await startSession(tabs[0].url);
    } else {
      await finalizeSession();
    }
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
});
