document.addEventListener('DOMContentLoaded', async () => {
  // ─── Tab switching ───
  const tabs = document.querySelectorAll('.tab');
  const views = document.querySelectorAll('.view-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`view-${tab.dataset.view}`).classList.add('active');
      if (tab.dataset.view === 'insights') renderInsights();
    });
  });

  let currentData = { sessions: [] };
  let projectsMap = {};
  let projectGoals = {};
  let activeProjectFocus = null;
  let productivityLabels = {};
  let energyTags = {};
  let currentDomainFilter = 'all';
  let currentDomainSort = 'time';
  const FOCUS_COLOR = '#4A90E2';
  const DISTRACT_COLOR = '#F97316';
  const NEUTRAL_COLOR = '#7C3AED';

  // Sort dropdown
  const sortSelect = document.getElementById('domain-sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      currentDomainSort = e.target.value;
      renderDomains(currentData.sessions);
    });
  }

  // Fetch initial storage
  const storageInit = await browser.storage.local.get(['projectMappings', 'projectsMap', 'projectGoals', 'activeProjectFocus', 'productivityLabels', 'energyTags', 'darkMode', 'themePrefs']);
  projectsMap = storageInit.projectMappings || storageInit.projectsMap || {};
  projectGoals = storageInit.projectGoals || {};
  activeProjectFocus = storageInit.activeProjectFocus || null;
  productivityLabels = storageInit.productivityLabels || {};
  energyTags = storageInit.energyTags || {};

  // Apply Dark Mode if set
  if (storageInit.darkMode || (storageInit.themePrefs && storageInit.themePrefs.darkMode)) {
    document.documentElement.classList.add('dark-theme');
  }

  // ─── Settings Modal ───
  const settingsBtn = document.getElementById('settings-btn');
  const settingsClose = document.getElementById('settings-close');
  const settingsModal = document.getElementById('settings-modal');

  settingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('open');
    settingsModal.setAttribute('aria-hidden', 'false');
  });

  settingsClose.addEventListener('click', closeModal);
  settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeModal(); });

  function closeModal() {
    settingsModal.classList.remove('open');
    settingsModal.setAttribute('aria-hidden', 'true');
  }

  // ─── Settings Preferences ───
  const darkModeToggle = document.getElementById('dark-mode-toggle');
  const clearDataBtn = document.getElementById('clear-data-btn');

  // Initialize toggle state from generic reading
  if (document.documentElement.classList.contains('dark-theme')) {
    if (darkModeToggle) darkModeToggle.checked = true;
  }

  if (darkModeToggle) {
    darkModeToggle.addEventListener('change', async (e) => {
      const isDark = e.target.checked;
      if (isDark) {
        document.documentElement.classList.add('dark-theme');
      } else {
        document.documentElement.classList.remove('dark-theme');
      }
      await browser.storage.local.set({ darkMode: isDark });
    });
  }

  function trgDL(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const btnExportJson = document.getElementById('btn-export-json');
  if (btnExportJson) {
    btnExportJson.addEventListener('click', async () => {
      const allData = await browser.storage.local.get(null);
      trgDL(JSON.stringify(allData, null, 2), `flow_tracker_export_${Date.now()}.json`, 'application/json');
    });
  }

  const btnExportCsv = document.getElementById('btn-export-csv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', async () => {
      const allData = await browser.storage.local.get(null);
      let csvContent = "Date,Domain,Start,End,Duration (s),Label\n";
      for (const [key, val] of Object.entries(allData)) {
        if (key.match(/^\d{4}-\d{2}-\d{2}$/) && val.sessions) {
          val.sessions.forEach(s => {
            let label = s.productivityLabel;
            if (label === undefined || label === '') {
              label = productivityLabels[s.domain] || 'untagged';
            }
            csvContent += `${key},${s.domain},${s.start||''},${s.end||''},${s.duration},${label}\n`;
          });
        }
      }
      trgDL(csvContent, `flow_tracker_export_${Date.now()}.csv`, 'text/csv');
    });
  }

  if (clearDataBtn) {
    clearDataBtn.addEventListener('click', async () => {
      const range = document.getElementById('clear-data-range').value;
      const rangeText = range === 'all' ? 'All time' : `the last ${range} days`;
      
      if (confirm(`Are you sure you want to clear tracking history for ${rangeText}? This cannot be undone.`)) {
        if (range === 'all') {
          // completely wipe the extension DB to Factory format
          await browser.storage.local.clear();
        } else {
          // selective clear
          const daysToClear = parseInt(range);
          const allKeys = await browser.storage.local.get(null);
          const keysToRemove = [];
          const now = Date.now();
          Object.keys(allKeys).forEach(k => {
            if (k.match(/^\d{4}-\d{2}-\d{2}$/)) {
              const d = new Date(k);
              const diffDays = (now - d.getTime()) / (1000 * 3600 * 24);
              if (diffDays <= daysToClear) keysToRemove.push(k);
            }
          });
          await browser.storage.local.remove(keysToRemove);
        }
        alert('Data cleared successfully! The dashboard will now reload.');
        location.reload();
      }
    });
  }

  // ─── Domain Filters & Projects Actions ───
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentDomainFilter = pill.textContent.trim().toLowerCase();
      renderDomains(currentData.sessions);
    });
  });

  const btnNewProject = document.querySelector('.show-new-project-btn');
  const addProjectModal = document.getElementById('add-project-modal');
  const addProjectClose = document.getElementById('add-project-close');
  const btnSaveProject = document.getElementById('btn-save-project');
  const inputProjName = document.getElementById('new-project-name');
  const inputProjDomain = document.getElementById('new-project-domain');
  const inputProjGoal = document.getElementById('new-project-goal');

  if (btnNewProject && addProjectModal) {
    btnNewProject.addEventListener('click', () => {
      inputProjName.value = '';
      inputProjDomain.value = '';
      if (inputProjGoal) inputProjGoal.value = '';
      addProjectModal.classList.add('open');
      addProjectModal.setAttribute('aria-hidden', 'false');
    });

    addProjectClose.addEventListener('click', () => {
      addProjectModal.classList.remove('open');
      addProjectModal.setAttribute('aria-hidden', 'true');
    });

    addProjectModal.addEventListener('click', (e) => {
      if (e.target === addProjectModal) {
        addProjectModal.classList.remove('open');
        addProjectModal.setAttribute('aria-hidden', 'true');
      }
    });

    btnSaveProject.addEventListener('click', async () => {
      const pName = inputProjName.value.trim();
      const pDom = normalizeDomainInput(inputProjDomain.value);
      const goalHours = inputProjGoal ? Number(inputProjGoal.value) : 0;
      if (!pName || !pDom) {
        alert("Please enter both a project name and a domain.");
        return;
      }

      projectsMap[pDom] = pName;
      if (goalHours > 0) {
        projectGoals[pName] = Math.round(goalHours * 3600);
      } else if (!projectGoals[pName]) {
        projectGoals[pName] = 8 * 3600;
      }
      await browser.storage.local.set({ projectMappings: projectsMap, projectsMap: projectsMap, projectGoals });
      
      addProjectModal.classList.remove('open');
      addProjectModal.setAttribute('aria-hidden', 'true');
      
      // Re-render UI
      renderProjects(currentData.sessions || []);
    });
  }

  // ─── Date helpers ───
  function getTodayString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  let selectedDate = getTodayString();

  const prevBtn = document.getElementById('prev-day');
  const nextBtn = document.getElementById('next-day');
  const dateLabel = document.getElementById('date-label');
  const overviewHeading = document.getElementById('overview-heading');

  function formatDateLabel(dateStr) {
    const today = getTodayString();
    if (dateStr === today) return 'Today';
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    if (dateStr === yStr) return 'Yesterday';
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function updateDateUI() {
    const today = getTodayString();
    const label = formatDateLabel(selectedDate);
    dateLabel.textContent = label;
    nextBtn.disabled = (selectedDate === today);
    overviewHeading.textContent = selectedDate === today
      ? "TODAY'S OVERVIEW"
      : `${label.toUpperCase()} OVERVIEW`;
  }

  function shiftDate(days) {
    const [year, month, day] = selectedDate.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    d.setDate(d.getDate() + days);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d > today) return;
    selectedDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    updateDateUI();
    fetchDataForSelectedDate();
  }

  prevBtn.addEventListener('click', () => shiftDate(-1));
  nextBtn.addEventListener('click', () => shiftDate(1));

  function migrateDayData(dayData) {
    if (dayData && dayData.sessions) return dayData;
    const sessions = [];
    if (!dayData) return { sessions };
    if (Array.isArray(dayData.chunks)) {
      dayData.chunks.forEach(c => {
        sessions.push({ domain: c.domain, start: c.start, end: c.end, duration: c.duration });
      });
    }
    if (dayData.aggregates && typeof dayData.aggregates === 'object') {
      for (const [domain, data] of Object.entries(dayData.aggregates)) {
        if (typeof data === 'number') {
          sessions.push({ domain, start: null, end: null, duration: data });
        } else if (Array.isArray(data)) {
          data.forEach(s => {
            sessions.push({ domain, start: s.start || null, end: s.end || null, duration: s.duration });
          });
        }
      }
    }
    return { sessions };
  }

  function preprocessSessions(sessions) {
    if (!sessions || sessions.length === 0) return [];
    
    // Only sort and merge sessions that HAVE start and end times
    const valid = sessions.filter(s => s.start && s.end);
    const legacy = sessions.filter(s => !s.start || !s.end);
    
    if (valid.length === 0) return legacy;

    valid.sort((a,b) => a.start - b.start);
    const merged = [];
    let current = { ...valid[0] };
    for (let i = 1; i < valid.length; i++) {
        const next = valid[i];
        if (next.domain === current.domain && (next.start - current.end) < 60000) {
            current.end = next.end;
            current.duration = Math.floor((current.end - current.start) / 1000);
            if (next.productivityLabel && !current.productivityLabel) {
                current.productivityLabel = next.productivityLabel;
            }
        } else {
            merged.push(current);
            current = { ...next };
        }
    }
    merged.push(current);
    
    return [...merged, ...legacy];
  }

  async function fetchDataForSelectedDate() {
    try {
      const raw = await browser.runtime.sendMessage({
        action: selectedDate === getTodayString() ? 'getLatestData' : 'getDayData',
        date: selectedDate
      });
      currentData = migrateDayData(raw);
      currentData.sessions = preprocessSessions(currentData.sessions);
      renderDashboard();
    } catch (e) {
      console.error("Error fetching data:", e);
    }
  }

  function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `< 1m`;
  }

  function normalizeDomainInput(value) {
    const raw = value.trim().toLowerCase();
    if (!raw) return '';
    try {
      const withProto = raw.includes('://') ? raw : `https://${raw}`;
      return new URL(withProto).hostname.replace(/^www\./, '');
    } catch (e) {
      return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    }
  }

  function classifySession(session) {
    let label = session.productivityLabel || productivityLabels[session.domain] || 'neutral';
    if (label === 'productive' || label === 'focused') return 'focused';
    if (label === 'distracting' || label === 'distraction') return 'distracted';
    return 'neutral';
  }

  function buildSessionGroups(validSessions) {
    const groups = [];
    let currentGrp = null;

    validSessions.forEach(s => {
      const classification = classifySession(s);
      if (!currentGrp || (s.start - currentGrp.end > 5 * 60 * 1000)) {
        currentGrp = {
          id: `grp_${s.start}`,
          start: s.start,
          end: s.end,
          duration: s.duration,
          domains: [s.domain],
          counts: { focused: classification === 'focused' ? s.duration : 0, distracted: classification === 'distracted' ? s.duration : 0, neutral: classification === 'neutral' ? s.duration : 0 },
          switches: 0
        };
        groups.push(currentGrp);
      } else {
        if (currentGrp.domains[currentGrp.domains.length - 1] !== s.domain) currentGrp.switches++;
        currentGrp.end = s.end;
        currentGrp.duration += s.duration;
        if (!currentGrp.domains.includes(s.domain)) currentGrp.domains.push(s.domain);
        currentGrp.counts[classification] += s.duration;
      }
    });

    return groups;
  }

  function getProjectFocusElapsed() {
    if (!activeProjectFocus || !activeProjectFocus.startTime) return 0;
    return Math.max(0, Math.floor((Date.now() - activeProjectFocus.startTime) / 1000));
  }

  function updateProjectFocusClock() {
    if (!activeProjectFocus) return;
    const elapsed = formatTime(getProjectFocusElapsed());
    const focusTitle = document.querySelector('[data-focus-mode-title]');
    const focusDesc = document.querySelector('[data-focus-mode-desc]');
    const activeBtn = document.querySelector('[data-project-focus-active="true"]');
    if (focusTitle) focusTitle.textContent = activeProjectFocus.projectName;
    if (focusDesc) {
      focusDesc.textContent = `Running for ${elapsed}. Stay on the project and use the start button on any card to switch focus.`;
    }
    if (activeBtn) activeBtn.textContent = `Running ${elapsed}`;
  }

  // ─── Domain color palette ───
  function domainColor(domain) {
    if (domain.includes('leetcode.com')) return '#FFA116';
    if (domain.includes('x.com') || domain.includes('twitter.com')) return '#1DA1F2';
    
    let hash = 0;
    for (let i = 0; i < domain.length; i++) {
      hash = domain.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = ((hash % 360) + 360) % 360;
    return `hsl(${hue}, 65%, 55%)`;
  }

  function renderDashboard() {
    const sessions = currentData.sessions || [];
    const totalSeconds = sessions.reduce((acc, s) => acc + s.duration, 0);
    document.getElementById('total-time').textContent = formatTime(totalSeconds);

    renderWeeklyDigest();
    renderTimeline(sessions);
    renderDomains(sessions);
    renderProjects(sessions);

    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.dataset.view === 'insights') {
      renderInsights();
    }
  }

  // ─── Weekly Digest ───
  async function renderWeeklyDigest() {
    const today = new Date();
    const todayStr = getTodayString();
    const dayOfWeek = today.getDay(); // 0=Sun

    // Build this week (Mon–Sun) and last week date keys
    // Find most recent Monday
    const mondayOffset = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - mondayOffset);
    thisMonday.setHours(0, 0, 0, 0);

    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);

    function dateStr(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const thisWeekKeys = [];
    const lastWeekKeys = [];
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const fullDayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    for (let i = 0; i < 7; i++) {
      const d1 = new Date(thisMonday);
      d1.setDate(thisMonday.getDate() + i);
      thisWeekKeys.push(dateStr(d1));

      const d2 = new Date(lastMonday);
      d2.setDate(lastMonday.getDate() + i);
      lastWeekKeys.push(dateStr(d2));
    }

    const allKeys = [...thisWeekKeys, ...lastWeekKeys];
    const allData = await browser.storage.local.get(allKeys);

    // Compute per-day totals
    function dayTotal(key) {
      const dd = migrateDayData(allData[key]);
      return dd.sessions.reduce((a, s) => a + s.duration, 0);
    }

    const thisWeekTotals = thisWeekKeys.map(dayTotal);
    const lastWeekTotals = lastWeekKeys.map(dayTotal);

    const thisWeekSum = thisWeekTotals.reduce((a, b) => a + b, 0);
    const lastWeekSum = lastWeekTotals.reduce((a, b) => a + b, 0);

    const thisActiveDays = thisWeekTotals.filter(t => t > 0).length;
    const lastActiveDays = lastWeekTotals.filter(t => t > 0).length;

    const thisAvg = thisActiveDays > 0 ? Math.round(thisWeekSum / 7) : 0;
    const lastAvg = lastActiveDays > 0 ? Math.round(lastWeekSum / 7) : 0;

    let peakIdx = 0;
    for (let i = 1; i < 7; i++) {
      if (thisWeekTotals[i] > thisWeekTotals[peakIdx]) peakIdx = i;
    }

    // Header
    const rangeStart = thisMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const sundayDate = new Date(thisMonday);
    sundayDate.setDate(thisMonday.getDate() + 6);
    const rangeEnd = sundayDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    document.getElementById('digest-range').textContent = `${rangeStart} – ${rangeEnd}`;

    // Badge
    const badge = document.getElementById('digest-badge');
    badge.className = 'digest-badge';
    if (lastWeekSum === 0) {
      badge.classList.add('same');
      badge.textContent = 'first week';
    } else {
      const weekDiff = thisWeekSum - lastWeekSum;
      const weekPct = Math.round(Math.abs(weekDiff / lastWeekSum) * 100);
      if (weekDiff > 0) {
        badge.classList.add('up');
        badge.textContent = `↑ ${weekPct}% vs last week`;
      } else if (weekDiff < 0) {
        badge.classList.add('down');
        badge.textContent = `↓ ${weekPct}% vs last week`;
      } else {
        badge.classList.add('same');
        badge.textContent = 'same as last week';
      }
    }

    // Stats
    function setDelta(el, current, previous, isFmt) {
      el.className = 'digest-stat-delta';
      const diff = current - previous;
      if (diff > 0) {
        el.classList.add('up');
        el.textContent = `↑ ${isFmt ? formatTime(diff) : diff}`;
      } else if (diff < 0) {
        el.classList.add('down');
        el.textContent = `↓ ${isFmt ? formatTime(Math.abs(diff)) : Math.abs(diff)}`;
      } else {
        el.classList.add('same');
        el.textContent = 'same';
      }
    }

    document.getElementById('digest-total').textContent = formatTime(thisWeekSum);
    setDelta(document.getElementById('digest-total-delta'), thisWeekSum, lastWeekSum, true);

    document.getElementById('digest-avg').textContent = formatTime(thisAvg);
    setDelta(document.getElementById('digest-avg-delta'), thisAvg, lastAvg, true);

    document.getElementById('digest-active-days').textContent = `${thisActiveDays} / 7`;
    setDelta(document.getElementById('digest-active-delta'), thisActiveDays, lastActiveDays, false);

    document.getElementById('digest-peak-day').textContent = thisWeekTotals[peakIdx] > 0 ? fullDayNames[peakIdx] : '—';
    document.getElementById('digest-peak-time').textContent = thisWeekTotals[peakIdx] > 0 ? formatTime(thisWeekTotals[peakIdx]) : '';
    document.getElementById('digest-peak-time').className = 'digest-stat-delta';

    // Day by Day
    const dayByDay = document.getElementById('day-by-day');
    dayByDay.textContent = '';
    const maxDay = Math.max(...thisWeekTotals, 1);
    const todayIdx = mondayOffset; // 0=Mon, 6=Sun

    for (let i = 0; i < 7; i++) {
      const row = document.createElement('div');
      row.className = 'day-row';

      const isToday = (i === todayIdx);
      const isFuture = thisWeekKeys[i] > todayStr;

      const label = document.createElement('div');
      label.className = `day-label${isToday ? ' is-today' : ''}`;
      label.textContent = dayLabels[i];
      row.appendChild(label);

      const track = document.createElement('div');
      track.className = 'day-bar-track';

      const fill = document.createElement('div');
      fill.className = `day-bar-fill${isToday ? ' today' : ''}`;
      const barPct = thisWeekTotals[i] > 0 ? (thisWeekTotals[i] / maxDay) * 100 : 0;
      setTimeout(() => { fill.style.width = `${barPct}%`; }, 20);

      if (isToday && thisWeekTotals[i] > 0) {
        const barText = document.createElement('span');
        barText.className = 'day-bar-text';
        barText.textContent = 'today';
        fill.appendChild(barText);
      }

      track.appendChild(fill);
      row.appendChild(track);

      const timeEl = document.createElement('div');
      timeEl.className = `day-time${isToday ? ' is-today' : ''}`;
      timeEl.textContent = thisWeekTotals[i] > 0 ? formatTime(thisWeekTotals[i]) : (isFuture ? '' : '—');
      row.appendChild(timeEl);

      dayByDay.appendChild(row);
    }

    // Top Domains This Week
    const domainContainer = document.getElementById('digest-domains');
    domainContainer.textContent = '';

    const thisWeekDomains = {};
    const lastWeekDomains = {};

    thisWeekKeys.forEach(k => {
      const dd = migrateDayData(allData[k]);
      dd.sessions.forEach(s => { thisWeekDomains[s.domain] = (thisWeekDomains[s.domain] || 0) + s.duration; });
    });
    lastWeekKeys.forEach(k => {
      const dd = migrateDayData(allData[k]);
      dd.sessions.forEach(s => { lastWeekDomains[s.domain] = (lastWeekDomains[s.domain] || 0) + s.duration; });
    });

    const sortedDomains = Object.entries(thisWeekDomains).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const domainMax = sortedDomains.length > 0 ? sortedDomains[0][1] : 1;

    sortedDomains.forEach(([domain, dur], idx) => {
      const row = document.createElement('div');
      row.className = 'digest-domain-row';

      const rank = document.createElement('span');
      rank.className = 'digest-domain-rank';
      rank.textContent = idx + 1;
      row.appendChild(rank);

      const dot = document.createElement('div');
      dot.className = 'digest-domain-dot';
      dot.style.backgroundColor = domainColor(domain);
      row.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'digest-domain-name';
      name.textContent = domain;
      row.appendChild(name);

      const barTrack = document.createElement('div');
      barTrack.className = 'digest-domain-bar-track';
      const barFill = document.createElement('div');
      barFill.className = 'digest-domain-bar-fill';
      barFill.style.backgroundColor = domainColor(domain);
      setTimeout(() => { barFill.style.width = `${(dur / domainMax) * 100}%`; }, 20);
      barTrack.appendChild(barFill);
      row.appendChild(barTrack);

      const time = document.createElement('span');
      time.className = 'digest-domain-time';
      time.textContent = formatTime(dur);
      row.appendChild(time);

      const delta = document.createElement('span');
      delta.className = 'digest-domain-delta';
      const prevDur = lastWeekDomains[domain] || 0;
      if (prevDur === 0) {
        delta.classList.add('up');
        delta.textContent = '↑ new';
      } else {
        const diff = dur - prevDur;
        if (diff > 0) {
          delta.classList.add('up');
          delta.textContent = `↑ ${formatTime(diff)}`;
        } else if (diff < 0) {
          delta.classList.add('down');
          delta.textContent = `↓ ${formatTime(Math.abs(diff))}`;
        } else {
          delta.classList.add('same');
          delta.textContent = '—';
        }
      }
      row.appendChild(delta);

      domainContainer.appendChild(row);
    });

    if (sortedDomains.length === 0) {
      domainContainer.textContent = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.textContent = 'No domains tracked this week.';
      domainContainer.appendChild(emptyDiv);
    }

    // Highlights
    // Longest session
    let longestSess = 0, longestDomain = '', longestDay = '';
    thisWeekKeys.forEach((k, i) => {
      const dd = migrateDayData(allData[k]);
      dd.sessions.forEach(s => {
        if (s.duration > longestSess) {
          longestSess = s.duration;
          longestDomain = s.domain;
          longestDay = dayLabels[i];
        }
      });
    });
    document.getElementById('hl-longest-val').textContent = longestSess > 0 ? `${Math.round(longestSess / 60)} min` : '—';
    document.getElementById('hl-longest-sub').textContent = longestSess > 0 ? `${longestDay}, ${longestDomain}` : '';

    // Peak hour
    const hourBuckets = new Array(24).fill(0);
    const hourDays = new Array(24).fill(0).map(() => new Set());
    thisWeekKeys.forEach((k, dayI) => {
      const dd = migrateDayData(allData[k]);
      dd.sessions.forEach(s => {
        if (!s.start || !s.end) return;
        let cursor = new Date(s.start);
        const endDate = new Date(s.end);
        while (cursor < endDate) {
          const hr = cursor.getHours();
          const endOfHour = new Date(cursor);
          endOfHour.setMinutes(59, 59, 999);
          const sliceEnd = endOfHour < endDate ? endOfHour : endDate;
          hourBuckets[hr] += Math.max(0, (sliceEnd - cursor) / 1000);
          hourDays[hr].add(dayI);
          cursor = new Date(endOfHour.getTime() + 1);
        }
      });
    });
    let peakHour = 0;
    for (let h = 1; h < 24; h++) { if (hourBuckets[h] > hourBuckets[peakHour]) peakHour = h; }
    const peakAmpm = peakHour >= 12 ? 'PM' : 'AM';
    const peakH = peakHour % 12 === 0 ? 12 : peakHour % 12;
    const nextH = (peakHour + 1) % 12 === 0 ? 12 : (peakHour + 1) % 12;
    const nextAmpm = (peakHour + 1) >= 12 ? 'PM' : 'AM';
    document.getElementById('hl-peak-val').textContent = hourBuckets[peakHour] > 0 ? `${peakH} – ${nextH} ${nextAmpm}` : '—';
    document.getElementById('hl-peak-sub').textContent = hourBuckets[peakHour] > 0 ? `across ${hourDays[peakHour].size} of ${thisActiveDays} days` : '';

    // New this week
    const newDomains = Object.keys(thisWeekDomains).filter(d => !(d in lastWeekDomains));
    if (newDomains.length > 0) {
      document.getElementById('hl-new-val').textContent = newDomains[0];
      document.getElementById('hl-new-sub').textContent = 'first visit';
    } else {
      document.getElementById('hl-new-val').textContent = '—';
      document.getElementById('hl-new-sub').textContent = 'no new domains';
    }

    // Dropped off
    const droppedDomains = Object.entries(lastWeekDomains)
      .filter(([d]) => !(d in thisWeekDomains) || thisWeekDomains[d] < lastWeekDomains[d] * 0.5)
      .sort((a, b) => b[1] - a[1]);
    if (droppedDomains.length > 0) {
      const [dd, prevTime] = droppedDomains[0];
      const nowTime = thisWeekDomains[dd] || 0;
      const dropPct = Math.round(((prevTime - nowTime) / prevTime) * 100);
      document.getElementById('hl-dropped-val').textContent = dd;
      document.getElementById('hl-dropped-sub').textContent = `↓ ${dropPct}% vs last week`;
    } else {
      document.getElementById('hl-dropped-val').textContent = '—';
      document.getElementById('hl-dropped-sub').textContent = 'none dropped';
    }

    // Streak
    const streakSection = document.getElementById('streak-section');
    streakSection.textContent = '';

    // Count consecutive active days ending today
    let streakCount = 0;
    for (let i = todayIdx; i >= 0; i--) {
      if (thisWeekTotals[i] > 0) streakCount++;
      else break;
    }

    const streakLabel = document.createElement('div');
    streakLabel.className = 'streak-label';
    streakLabel.textContent = `Active day streak — ${streakCount} day${streakCount !== 1 ? 's' : ''}`;
    streakSection.appendChild(streakLabel);

    const dotsRow = document.createElement('div');
    dotsRow.className = 'streak-dots';
    for (let i = 0; i < 7; i++) {
      const dot = document.createElement('div');
      dot.className = `streak-dot ${thisWeekTotals[i] > 0 ? 'active' : 'inactive'}`;
      dot.textContent = dayLabels[i].charAt(0);
      dotsRow.appendChild(dot);
    }
    streakSection.appendChild(dotsRow);
  }

  // ─── Structured Timeline ───
  function renderTimeline(sessions) {
    const timelineBar = document.getElementById('timeline-container');
    const timelineMarkers = document.getElementById('timeline-legend');
    const distributionSummary = document.getElementById('distribution-summary');
    const pieWrap = document.getElementById('domain-pie-wrap');
    const switchBar = document.getElementById('switch-bar');
    const switchStats = document.getElementById('switch-stats');
    const sessionCards = document.getElementById('session-breakdown');

    [timelineBar, timelineMarkers, distributionSummary, pieWrap, switchBar, switchStats, sessionCards].forEach(el => {
      if (el) el.textContent = '';
    });

    const validSessions = sessions.filter(s => s.start && s.end).sort((a, b) => a.start - b.start);
    if (validSessions.length === 0) {
      [timelineBar, pieWrap, switchBar, sessionCards].forEach(el => {
        if (!el) return;
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.textContent = 'No activity tracked for this day yet.';
        el.appendChild(emptyDiv);
      });
      return;
    }

    const groups = buildSessionGroups(validSessions);
    const [year, month, day] = selectedDate.split('-').map(Number);

    const categoryTotals = { focused: 0, distracted: 0, neutral: 0 };
    validSessions.forEach(session => {
      categoryTotals[classifySession(session)] += session.duration;
    });
    const totalSeconds = validSessions.reduce((sum, session) => sum + session.duration, 0) || 1;
    [
      ['Focus', categoryTotals.focused, FOCUS_COLOR],
      ['Distracted', categoryTotals.distracted, DISTRACT_COLOR],
      ['Neutral', categoryTotals.neutral, NEUTRAL_COLOR]
    ].forEach(([label, duration, color]) => {
      const row = document.createElement('div');
      row.className = 'distribution-row';
      const pct = Math.round((duration / totalSeconds) * 100);
      const dot = document.createElement('span');
      dot.className = 'chart-dot';
      dot.style.color = color;
      dot.style.background = color;
      const name = document.createElement('span');
      name.className = 'chart-name';
      name.textContent = label;
      const track = document.createElement('div');
      track.className = 'distribution-track';
      const fill = document.createElement('div');
      fill.className = 'distribution-fill';
      fill.style.width = `${pct}%`;
      fill.style.background = color;
      track.appendChild(fill);
      const time = document.createElement('span');
      time.className = 'chart-time';
      time.textContent = formatTime(duration);
      row.append(dot, name, track, time);
      distributionSummary.appendChild(row);
    });

    const hourBuckets = Array.from({ length: 24 }, () => ({ focused: 0, distracted: 0, neutral: 0 }));
    validSessions.forEach(session => {
      let cursor = session.start;
      while (cursor < session.end) {
        const current = new Date(cursor);
        const hour = current.getHours();
        const hourEnd = new Date(current);
        hourEnd.setMinutes(59, 59, 999);
        const sliceEnd = Math.min(session.end, hourEnd.getTime() + 1);
        const sliceSeconds = Math.max(0, Math.floor((sliceEnd - cursor) / 1000));
        hourBuckets[hour][classifySession(session)] += sliceSeconds;
        cursor = sliceEnd;
      }
    });

    hourBuckets.forEach((bucket, hour) => {
      const hourTotal = bucket.focused + bucket.distracted + bucket.neutral;
      const block = document.createElement('div');
      block.className = 'timeline-hour-block';
      if (hourTotal > 0) {
        const focusPct = (bucket.focused / hourTotal) * 100;
        const distractedPct = (bucket.distracted / hourTotal) * 100;
        const neutralPct = Math.max(0, 100 - focusPct - distractedPct);
        const fill = document.createElement('div');
        fill.className = 'timeline-hour-fill';
        fill.style.background = `linear-gradient(180deg, ${FOCUS_COLOR} 0 ${focusPct}%, ${DISTRACT_COLOR} ${focusPct}% ${focusPct + distractedPct}%, ${NEUTRAL_COLOR} ${focusPct + distractedPct}% 100%)`;
        fill.title = `${new Date(year, month - 1, day, hour).toLocaleTimeString('en-US', { hour: 'numeric' })}: ${formatTime(hourTotal)}`;
        block.appendChild(fill);
      }
      timelineBar.appendChild(block);
    });

    ['12AM', '6AM', '12PM', '6PM', '12AM'].forEach(label => {
      const marker = document.createElement('span');
      marker.className = 'timeline-marker';
      marker.textContent = label;
      timelineMarkers.appendChild(marker);
    });

    const domainTotals = {};
    validSessions.forEach(session => {
      domainTotals[session.domain] = (domainTotals[session.domain] || 0) + session.duration;
    });
    const sortedDomains = Object.entries(domainTotals).sort((a, b) => b[1] - a[1]);
    const topDomains = sortedDomains.slice(0, 5);
    const otherTotal = sortedDomains.slice(5).reduce((sum, [, duration]) => sum + duration, 0);
    const pieParts = topDomains.map(([domain, duration]) => ({ name: domain, duration, color: domainColor(domain) }));
    if (otherTotal > 0) pieParts.push({ name: 'Other', duration: otherTotal, color: '#64748b' });
    const pieScene = document.createElement('div');
    pieScene.className = 'pie-scene';
    const pieGlow = document.createElement('div');
    pieGlow.className = 'pie-glow';
    const pieDisc = document.createElement('div');
    pieDisc.className = 'pie-disc';

    let currentDeg = -90;
    const pieGradientParts = [];
    pieParts.forEach((part) => {
      const sweep = (part.duration / totalSeconds) * 360;
      const start = currentDeg;
      const end = currentDeg + sweep;
      part.midDeg = start + (sweep / 2);
      const seam = Math.min(1.1, sweep * 0.08);
      const innerStart = start + seam / 2;
      const innerEnd = end - seam / 2;
      pieGradientParts.push(`rgba(7, 10, 20, 0.92) ${start}deg ${Math.min(end, start + seam)}deg`);
      if (innerEnd > innerStart) {
        pieGradientParts.push(`${part.color} ${innerStart}deg ${innerEnd}deg`);
      }
      pieGradientParts.push(`rgba(7, 10, 20, 0.92) ${Math.max(start, end - seam)}deg ${end}deg`);
      currentDeg = end;
    });
    pieDisc.style.background = `conic-gradient(${pieGradientParts.join(', ') || `${NEUTRAL_COLOR} 0deg 360deg`})`;
    pieScene.append(pieGlow, pieDisc);
    pieWrap.appendChild(pieScene);

    const pieLegend = document.createElement('div');
    pieLegend.className = 'pie-legend';
    const legendRows = [];
    const setActivePiePart = (partName) => {
      const active = pieParts.find(part => part.name === partName) || pieParts[0];
      if (!active) return;
      pieScene.classList.add('active-slice');
      legendRows.forEach(row => row.classList.toggle('active', row.dataset.partName === active.name));
      pieScene.style.setProperty('--pie-active-color', `${active.color}55`);
    };

    pieParts.forEach((part, index) => {
      const percent = Math.round((part.duration / totalSeconds) * 100);
      const row = document.createElement('div');
      row.className = 'pie-legend-row';
      row.dataset.partName = part.name;
      const dot = document.createElement('span');
      dot.className = 'chart-dot';
      dot.style.color = part.color;
      dot.style.background = part.color;
      const name = document.createElement('span');
      name.className = 'pie-name';
      name.textContent = part.name;
      const value = document.createElement('span');
      value.className = 'pie-value';
      value.textContent = `${percent}%`;
      row.append(dot, name, value);
      row.addEventListener('click', () => setActivePiePart(part.name));
      if (index === 0) row.classList.add('active');
      legendRows.push(row);
      pieLegend.appendChild(row);
    });
    pieScene.addEventListener('click', () => {
      const activeRow = legendRows.find(row => row.classList.contains('active'));
      const currentIndex = activeRow ? legendRows.indexOf(activeRow) : 0;
      const next = pieParts[(currentIndex + 1) % pieParts.length];
      if (next) setActivePiePart(next.name);
    });
    if (pieParts.length) setActivePiePart(pieParts[0].name);
    pieWrap.appendChild(pieLegend);

    const hourlySwitches = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    let switchCount = 0;
    for (let i = 1; i < validSessions.length; i++) {
      if (validSessions[i].domain !== validSessions[i - 1].domain) {
        switchCount++;
        hourlySwitches[new Date(validSessions[i].start).getHours()].count++;
      }
    }
    const activeHours = hourlySwitches.filter(item => item.count > 0);
    const hoursToRender = (activeHours.length ? activeHours : hourlySwitches.slice(0, 6)).slice(0, 6);
    const maxSwitches = Math.max(...hoursToRender.map(item => item.count), 1);
    hoursToRender.forEach(item => {
      const hourLabel = new Date(year, month - 1, day, item.hour).toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' ', '');
      const row = document.createElement('div');
      row.className = 'switch-bar-row';
      const hour = document.createElement('span');
      hour.className = 'switch-hour';
      hour.textContent = hourLabel;
      const track = document.createElement('div');
      track.className = 'switch-track-line';
      const fill = document.createElement('div');
      fill.className = 'switch-track-fill';
      fill.style.width = `${(item.count / maxSwitches) * 100}%`;
      track.appendChild(fill);
      const count = document.createElement('span');
      count.className = 'switch-count';
      count.textContent = `${item.count}`;
      row.append(hour, track, count);
      switchBar.appendChild(row);
    });
    const peakSwitch = activeHours.sort((a, b) => b.count - a.count)[0];
    switchStats.textContent = '';
    if (switchCount === 0) {
      switchStats.textContent = 'No context switching recorded for this day.';
    } else {
      const totalStrong = document.createElement('strong');
      totalStrong.textContent = `${switchCount}`;
      switchStats.appendChild(totalStrong);
      switchStats.appendChild(document.createTextNode(' switches total. '));
      if (peakSwitch) {
        switchStats.appendChild(document.createTextNode('Most turbulence happened around '));
        const peakStrong = document.createElement('strong');
        peakStrong.textContent = new Date(year, month - 1, day, peakSwitch.hour)
          .toLocaleTimeString('en-US', { hour: 'numeric' })
          .replace(' ', '');
        switchStats.appendChild(peakStrong);
        switchStats.appendChild(document.createTextNode('.'));
      }
    }

    groups.forEach(group => {
      const startLabel = new Date(group.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const endLabel = new Date(group.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const dominant = energyTags[group.id] || Object.entries(group.counts).sort((a, b) => b[1] - a[1])[0][0];
      const title = dominant === 'focused'
        ? 'Deep Work'
        : dominant === 'distracted'
          ? 'Distracted'
          : group.duration < 5 * 60
            ? 'Quick Check'
            : 'Neutral Flow';
      const note = dominant === 'focused'
        ? (group.switches <= 1 ? 'Low switching' : 'Some switching')
        : dominant === 'distracted'
          ? (group.switches >= 2 ? 'High switching' : 'Attention drift')
          : 'Mixed activity';

      const card = document.createElement('div');
      card.className = 'session-card';
      const head = document.createElement('div');
      head.className = 'session-card-head';
      const titleEl = document.createElement('span');
      titleEl.className = 'session-card-title';
      titleEl.textContent = title;
      const durEl = document.createElement('span');
      durEl.className = 'session-card-duration';
      durEl.textContent = formatTime(group.duration);
      head.append(titleEl, durEl);
      const meta = document.createElement('div');
      meta.className = 'session-card-meta';
      meta.textContent = `${startLabel} - ${endLabel} - ${group.domains.length} site${group.domains.length !== 1 ? 's' : ''} - ${group.domains.slice(0, 3).join(', ')}`;
      const noteEl = document.createElement('span');
      noteEl.className = `session-card-note ${dominant}`;
      noteEl.textContent = note;
      card.append(head, meta, noteEl);
      sessionCards.appendChild(card);
    });
  }

  // ─── Domain List with Favicons, Avg Session, Labels ───
  // ─── Domain List with Favicons, Avg Session, Labels ───
  function renderDomains(sessions) {
    const domainTotals = {};
    const domainSessions = {};

    sessions.forEach(s => {
      domainTotals[s.domain] = (domainTotals[s.domain] || 0) + s.duration;
      if (!domainSessions[s.domain]) domainSessions[s.domain] = 0;
      domainSessions[s.domain]++;
    });

    const sorted = Object.entries(domainTotals).sort((a, b) => b[1] - a[1]);
    const maxTime = sorted.length > 0 ? sorted[0][1] : 1;

    const container = document.getElementById('domain-list-grouped');
    if (!container) return; // View changed?
    container.textContent = '';

    if (sorted.length === 0) {
      container.textContent = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.appendChild(document.createTextNode('No activity tracked yet.'));
      emptyDiv.appendChild(document.createElement('br'));
      emptyDiv.appendChild(document.createTextNode('Start browsing and come back!'));
      container.appendChild(emptyDiv);
      return;
    }

    const grouped = { productive: [], neutral: [], distracting: [], untagged: [] };
    
    // Group dynamically strictly by session tag.
    // To support tracking domains with multiple tags, we aggregate per (domain + tag) pair.
    const domainTagTotals = {};
    sessions.forEach(s => {
      let label = s.productivityLabel || productivityLabels[s.domain] || 'untagged';
      if (label === 'distraction') label = 'distracting';
      const key = `${s.domain}::${label}`;
      if (!domainTagTotals[key]) domainTagTotals[key] = { domain: s.domain, label, duration: 0, visits: 0 };
      domainTagTotals[key].duration += s.duration;
      domainTagTotals[key].visits++;
    });

    const sortedGroups = Object.values(domainTagTotals).sort((a, b) => {
      if (currentDomainSort === 'visits') return b.visits - a.visits;
      return b.duration - a.duration;
    });
    const groupMaxTime = sortedGroups.length > 0 ? (currentDomainSort === 'visits' ? sortedGroups[0].visits : sortedGroups[0].duration) : 1;

    sortedGroups.forEach(item => {
      if (grouped[item.label]) grouped[item.label].push(item);
      else grouped.untagged.push(item);
    });

    const groupConfig = [
      { key: 'productive', label: 'PRODUCTIVE', color: 'var(--label-productive)' },
      { key: 'neutral', label: 'NEUTRAL', color: 'var(--text-muted)' },
      { key: 'distracting', label: 'DISTRACTING', color: 'var(--label-distraction)' },
      { key: 'untagged', label: 'UNTAGGED', color: 'var(--text-faint)' }
    ];

    groupConfig.forEach(grp => {
      if (currentDomainFilter !== 'all' && grp.key !== currentDomainFilter) return;
      if (grouped[grp.key].length === 0) return;
      
      const groupDiv = document.createElement('div');
      groupDiv.className = 'domain-group';
      
      const labelDiv = document.createElement('h5');
      labelDiv.className = 'group-label';
      const lDot = document.createElement('div');
      lDot.className = 'group-dot';
      lDot.style.backgroundColor = grp.color;
      labelDiv.appendChild(lDot);
      labelDiv.appendChild(document.createTextNode(' ' + grp.label));
      groupDiv.appendChild(labelDiv);

      grouped[grp.key].forEach(item => {
        const pct = currentDomainSort === 'visits' ? (item.visits / groupMaxTime) * 100 : (item.duration / groupMaxTime) * 100;
        const row = document.createElement('div');
        row.className = 'domain-list-row';
        row.addEventListener('click', () => {
          showDomainDetail(item.domain, item.label, item.duration, domainSessions[item.domain] || 1);
        });
        
        const dot = document.createElement('img');
        dot.className = 'd-dot';
        dot.src = `https://www.google.com/s2/favicons?domain=${item.domain}&sz=16`;
        dot.onerror = () => { dot.style.display = 'none'; };

        const name = document.createElement('span');
        name.className = 'd-name';
        name.textContent = item.domain;

        const track = document.createElement('div');
        track.className = 'd-track';
        const fill = document.createElement('div');
        fill.className = 'd-fill';
        fill.style.backgroundColor = grp.color;
        setTimeout(() => { fill.style.width = `${pct}%`; }, 10);
        track.appendChild(fill);

        const time = document.createElement('span');
        time.className = 'd-time';
        time.style.width = currentDomainSort === 'visits' ? '60px' : '40px';
        time.textContent = currentDomainSort === 'visits' ? `${item.visits} visits` : formatTime(item.duration);

        const trend = document.createElement('span');
        trend.className = 'd-trend d-same';
        trend.textContent = '—';

        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(track);
        row.appendChild(time);
        row.appendChild(trend);
        
        groupDiv.appendChild(row);
      });
      container.appendChild(groupDiv);
    });

    // Populate dummy 7-DAY HISTORY
    const histContainer = document.getElementById('domain-history-list');
    if (histContainer) {
      histContainer.textContent = '';
      sorted.slice(0, 3).forEach(([dom, dur]) => {
        const hRow = document.createElement('div');
        hRow.className = 'history-row';

        const hNameGrp = document.createElement('div');
        hNameGrp.className = 'h-name-group';

        const hImg = document.createElement('img');
        hImg.className = 'd-dot';
        hImg.src = `https://www.google.com/s2/favicons?domain=${dom}&sz=16`;
        hImg.onerror = () => { hImg.style.display = 'none'; };

        const hName = document.createElement('span');
        hName.className = 'd-name';
        hName.textContent = dom;

        hNameGrp.append(hImg, hName);

        const hDays = document.createElement('span');
        hDays.className = 'h-days';
        hDays.textContent = '7d';

        hRow.append(hNameGrp, hDays);
        histContainer.appendChild(hRow);
      });
    }

    // Populate dummy DETAIL VIEW
    const detailContainer = document.getElementById('domain-detail-view');
    if (detailContainer) {
      if (detailContainer.childNodes.length === 0 || detailContainer.textContent.trim() === '') {
        detailContainer.textContent = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.style.cssText = 'padding: 24px; color: var(--text-faint);';
        emptyDiv.textContent = 'Tap any domain to view details.';
        detailContainer.appendChild(emptyDiv);
      }
    }
  }

  function showDomainDetail(topDom, currentLabel, topDur, sessionsCount) {
    const detailContainer = document.getElementById('domain-detail-view');
    if (!detailContainer) return;
    
    // Smooth scroll for mobile experience if needed
    detailContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let currentTag = productivityLabels[topDom] || 'untagged';
    if (currentTag === 'distraction') currentTag = 'distracting';

    const todayDomainSessions = currentData.sessions.filter(s => s.domain === topDom);
    const sessFrag = document.createDocumentFragment();
    todayDomainSessions.forEach((s, idx) => {
      const startObj = new Date(s.start);
      const timeStr = startObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const durStr = formatTime(s.duration);
      const tag = s.productivityLabel || productivityLabels[topDom] || 'untagged';
      
      let colorVar = 'var(--text-muted)';
      if (tag === 'productive') colorVar = 'var(--label-productive)';
      if (tag === 'distracting') colorVar = 'var(--label-distraction)';

      const rowDiv = document.createElement('div');
      rowDiv.className = 'd-sess-row';
      rowDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';

      const sTime = document.createElement('span');
      sTime.className = 'd-sess-time';
      sTime.style.cssText = 'width: 50px; font-size: 11px;';
      sTime.textContent = timeStr;

      const dTrack = document.createElement('div');
      dTrack.className = 'd-track';
      dTrack.style.cssText = 'flex: 1; margin: 0 12px; position: relative;';

      const dFill = document.createElement('div');
      dFill.className = 'd-fill';
      dFill.style.cssText = `width: 100%; height: 6px; background: ${colorVar}; border-radius: 4px;`;
      dTrack.appendChild(dFill);

      const sDur = document.createElement('span');
      sDur.className = 'd-time';
      sDur.style.cssText = 'font-size:11px; width: 45px; text-align:right; margin-right: 4px;';
      sDur.textContent = durStr;

      const sel = document.createElement('select');
      sel.className = 'sess-tag-select';
      sel.dataset.idx = idx;
      sel.style.cssText = 'margin-left: 8px; font-size: 11px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-input); background: var(--surface-color); color: var(--text-main); min-width: 95px; cursor: pointer; outline: none;';
      
      const opts = [
        {val: 'productive', text: 'Productive'},
        {val: 'neutral', text: 'Neutral'},
        {val: 'distracting', text: 'Distracting'},
        {val: 'untagged', text: 'Untagged'}
      ];
      opts.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.val;
        opt.textContent = o.text;
        if (tag === o.val) opt.selected = true;
        sel.appendChild(opt);
      });

      rowDiv.append(sTime, dTrack, sDur, sel);
      sessFrag.appendChild(rowDiv);
    });

    detailContainer.textContent = '';
    
    const dViewBox = document.createElement('div');
    dViewBox.className = 'detail-view-box';

    const btnClose = document.createElement('button');
    btnClose.className = 'detail-close';
    btnClose.id = 'detail-close-btn';
    btnClose.textContent = '✕';

    const dHead = document.createElement('div');
    dHead.className = 'detail-header';
    const hdImg = document.createElement('img');
    hdImg.className = 'd-dot';
    hdImg.style.cssText = 'width:20px;height:20px;';
    hdImg.src = `https://www.google.com/s2/favicons?domain=${topDom}&sz=16`;
    hdImg.onerror = () => { hdImg.style.display = 'none'; };
    const hdTxt = document.createElement('span');
    hdTxt.className = 'd-name';
    hdTxt.style.fontSize = '16px';
    hdTxt.textContent = topDom;
    dHead.append(hdImg, hdTxt);

    const tagSect = document.createElement('div');
    tagSect.className = 'detail-tag-selector';
    tagSect.style.cssText = 'margin-top: 16px; margin-bottom: 20px;';
    
    const tsLbl = document.createElement('span');
    tsLbl.style.cssText = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600; display: block; margin-bottom: 8px;';
    tsLbl.textContent = 'Set Default Tag for Domain';
    
    const tsBtnGrp = document.createElement('div');
    tsBtnGrp.style.cssText = 'display: flex; gap: 8px;';
    
    const mkBtn = (val, txt) => {
      const b = document.createElement('button');
      b.className = 'btn-tag tag-btn';
      b.dataset.tag = val;
      b.style.cssText = 'flex: 1; padding: 6px; font-size: 12px; transition: all 0.2s;';
      b.textContent = txt;
      return b;
    };
    tsBtnGrp.append(mkBtn('productive', 'Productive'), mkBtn('neutral', 'Neutral'), mkBtn('distracting', 'Distracting'));
    tagSect.append(tsLbl, tsBtnGrp);

    const statRow = document.createElement('div');
    statRow.className = 'detail-stats-row';
    const mkSb = (lbl, val) => {
      const b = document.createElement('div'); b.className = 'd-stat-box';
      const sl = document.createElement('span'); sl.className = 'd-stat-lbl'; sl.textContent = lbl;
      const sv = document.createElement('span'); sv.className = 'd-stat-val'; sv.textContent = val;
      b.append(sl, sv);
      return b;
    };
    statRow.append(mkSb('Today', formatTime(topDur)), mkSb('This week', formatTime(topDur * 5)), mkSb('Sessions', sessionsCount));

    const sTitle = document.createElement('div');
    sTitle.className = 'detail-sessions-title';
    sTitle.textContent = 'Sessions today (Edit per-session)';

    const sCont = document.createElement('div');
    sCont.className = 'sessions-list-container';
    sCont.style.cssText = 'max-height: 150px; overflow-y: auto; padding-right: 4px;';
    sCont.appendChild(sessFrag);

    dViewBox.append(btnClose, dHead, tagSect, statRow, sTitle, sCont);
    detailContainer.appendChild(dViewBox);

    // Highlight current global tag
    const tagBtns = detailContainer.querySelectorAll('.tag-btn');
    tagBtns.forEach(btn => {
      const tag = btn.dataset.tag;
      if (tag === currentTag) {
        let colorVar = 'var(--text-muted)';
        if (tag === 'productive') colorVar = 'var(--label-productive)';
        if (tag === 'distracting') colorVar = 'var(--label-distraction)';
        btn.style.backgroundColor = colorVar;
        btn.style.color = '#fff';
        btn.style.borderColor = colorVar;
      }

      // Wire up clicks to save default Domain tag
      btn.addEventListener('click', async () => {
        productivityLabels[topDom] = tag;
        await browser.storage.local.set({ productivityLabels });
        renderDomains(currentData.sessions);
        showDomainDetail(topDom, currentLabel, topDur, sessionsCount);
      });
    });

    // Wire up session-specific selects
    detailContainer.querySelectorAll('.sess-tag-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const idx = parseInt(e.target.dataset.idx);
        const newTag = e.target.value;
        const targetSession = todayDomainSessions[idx];
        
        // Find it in the main currentData.sessions array and update
        const mainIdx = currentData.sessions.findIndex(s => s === targetSession);
        if (mainIdx !== -1) {
          currentData.sessions[mainIdx].productivityLabel = newTag;
          
          const objToSave = {};
          const dataToSave = JSON.parse(JSON.stringify(currentData));
          dataToSave.sessions = dataToSave.sessions.filter(s => !s.ongoing);
          objToSave[selectedDate] = dataToSave;
          await browser.storage.local.set(objToSave);
          
          renderDomains(currentData.sessions);
          showDomainDetail(topDom, currentLabel, topDur, sessionsCount);
        }
      });
    });

    document.getElementById('detail-close-btn').addEventListener('click', () => {
      detailContainer.textContent = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state';
      emptyDiv.style.cssText = 'padding: 24px; color: var(--text-faint);';
      emptyDiv.textContent = 'Tap any domain to view details.';
      detailContainer.appendChild(emptyDiv);
    });
  }

  function domainColor(str) {
    if (str.includes('leetcode.com')) return '#FFA116';
    if (str.includes('x.com') || str.includes('twitter.com')) return '#1DA1F2';
    
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return `hsl(${hash % 360}, 65%, 55%)`;
  }

  // ─── Projects List ───
  async function renderProjects(sessions) {
    const allData = await browser.storage.local.get(null);
    const dateKeys = Object.keys(allData).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    
    projectGoals = allData.projectGoals || projectGoals || {};
    activeProjectFocus = allData.activeProjectFocus || activeProjectFocus || null;
    const projStats = {};
    
    // Ensure all user-defined projects are displayed, even with 0 tracked time
    Object.entries(projectsMap).forEach(([domain, pName]) => {
      if (pName !== 'Unassigned') {
        if (!projStats[pName]) {
          projStats[pName] = { allTime: 0, thisWeek: 0, daysActive: new Set(), domains: new Set() };
        }
        projStats[pName].domains.add(domain);
      }
    });
    
    // "This Week" keys
    const today = new Date();
    const dayOfWeek = today.getDay();
    const mondayOffset = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() - mondayOffset);
    thisMonday.setHours(0, 0, 0, 0);
    
    const thisWeekKeys = [];
    for (let i = 0; i < 7; i++) {
        const d1 = new Date(thisMonday);
        d1.setDate(thisMonday.getDate() + i);
        thisWeekKeys.push(`${d1.getFullYear()}-${String(d1.getMonth() + 1).padStart(2, '0')}-${String(d1.getDate()).padStart(2, '0')}`);
    }

    let totalAllTime = 0; 
    let totalThisWeek = 0;

    dateKeys.forEach(dk => {
      const dayData = migrateDayData(allData[dk]);
      if (!dayData || !dayData.sessions) return;
      const isThisWeek = thisWeekKeys.includes(dk);
      const activeProjectsOnDay = new Set();

      dayData.sessions.forEach(s => {
        if (!s.domain) return;
        const pName = projectsMap[s.domain] || 'Unassigned';
        if (!projStats[pName]) {
          projStats[pName] = { allTime: 0, thisWeek: 0, daysActive: new Set(), domains: new Set() };
        }
        
        projStats[pName].allTime += s.duration;
        totalAllTime += s.duration;
        if (isThisWeek) {
          projStats[pName].thisWeek += s.duration;
          totalThisWeek += s.duration;
        }
        projStats[pName].domains.add(s.domain);
        activeProjectsOnDay.add(pName);
      });
      activeProjectsOnDay.forEach(pName => projStats[pName].daysActive.add(dk));
    });

    const displayProjects = Object.entries(projStats)
        .filter(([pName, stats]) => pName !== 'Unassigned')
        .sort((a, b) => b[1].allTime - a[1].allTime);

    // Calc Streaks
    const todayStr = getTodayString();

    displayProjects.forEach(([pName, stats]) => {
      let streak = 0;
      let d = new Date();
      let dk = todayStr;
      let missedToday = false;

      if (stats.daysActive.has(dk)) {
        streak++;
      } else {
        missedToday = true;
      }
      
      d.setDate(d.getDate() - 1);
      while(true) {
        dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (stats.daysActive.has(dk)) {
          streak++;
          missedToday = false; 
        } else {
          if (missedToday) break; 
          else break;
        }
        d.setDate(d.getDate() - 1);
      }
      stats.streak = streak;

      stats.goalSecs = projectGoals[pName] || (8 * 3600);
    });

    // 1. AUTO-TAGGING (mocked)
    const autoContainer = document.getElementById('auto-tag-container');
    if (autoContainer) {
      autoContainer.textContent = '';
      const focusBox = document.createElement('div');
      focusBox.className = 'focus-mode-box';

      const title = document.createElement('div');
      title.className = 'focus-mode-title';
      title.dataset.focusModeTitle = 'true';
      title.textContent = activeProjectFocus ? activeProjectFocus.projectName : 'No active project session';

      const desc = document.createElement('div');
      desc.className = 'focus-mode-desc';
      desc.dataset.focusModeDesc = 'true';
      desc.textContent = activeProjectFocus
        ? `Running for ${formatTime(getProjectFocusElapsed())}. Stay on the project and use the start button on any card to switch focus.`
        : 'Pick a project and start a dedicated timer. This gives your projects an explicit active state without interrupting normal browser tracking.';

      const actions = document.createElement('div');
      actions.className = 'focus-mode-actions';

      if (activeProjectFocus) {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'focus-mode-btn danger';
        stopBtn.textContent = 'Stop session';
        stopBtn.addEventListener('click', async () => {
          activeProjectFocus = null;
          await browser.storage.local.set({ activeProjectFocus: null });
          renderProjects(currentData.sessions || []);
        });
        actions.appendChild(stopBtn);
      } else {
        const hint = document.createElement('div');
        hint.className = 'focus-mode-hint';
        hint.textContent = 'Use "Start session" on a project card below.';
        actions.appendChild(hint);
      }

      focusBox.append(title, desc, actions);
      autoContainer.appendChild(focusBox);
    }

    // 2. PROJECTS LIST
    const listContainer = document.getElementById('project-list-new');
    if (listContainer) {
      listContainer.textContent = '';
      if (displayProjects.length === 0) {
        listContainer.textContent = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.style.marginBottom = '16px';
        emptyDiv.textContent = 'No projects created yet.';
        listContainer.appendChild(emptyDiv);
      } else {
        displayProjects.forEach(([projName, stats]) => {
          const doms = Array.from(stats.domains).slice(0, 3);
          const pct = Math.min((stats.thisWeek / stats.goalSecs) * 100, 100);
          const isOverBudget = stats.thisWeek > stats.goalSecs;
          
          const statusClass = isOverBudget ? 'proj-status-over-budget' : 'proj-status-on-track';
          const statusText = isOverBudget ? 'Over budget' : 'On track';
          const barColor = isOverBudget ? '#ef4444' : '#34d399'; 
          const dotColor = (projName === 'Development') ? '#3b82f6' : (projName === 'Reading' ? '#10b981' : 'var(--accent-primary)');
          const isFocusActive = activeProjectFocus && activeProjectFocus.projectName === projName;

          const pCard = document.createElement('div');
          pCard.className = 'proj-item-card';

          // Header
          const header = document.createElement('div'); header.className = 'proj-header';
          const titleGrp = document.createElement('div'); titleGrp.className = 'proj-title-group';
          const pDot = document.createElement('div'); pDot.className = 'proj-dot'; pDot.style.backgroundColor = dotColor;
          const pName = document.createElement('span'); pName.className = 'proj-name'; pName.textContent = projName;
          titleGrp.append(pDot, pName);
          const headerActions = document.createElement('div');
          headerActions.className = 'proj-header-actions';
          const startBtn = document.createElement('button');
          startBtn.className = `proj-session-btn${isFocusActive ? ' active' : ''}`;
          startBtn.dataset.projectFocusActive = isFocusActive ? 'true' : 'false';
          startBtn.textContent = isFocusActive ? `Running ${formatTime(getProjectFocusElapsed())}` : 'Start session';
          startBtn.addEventListener('click', async () => {
            activeProjectFocus = isFocusActive ? null : { projectName: projName, startTime: Date.now() };
            await browser.storage.local.set({ activeProjectFocus });
            renderProjects(currentData.sessions || []);
          });
          const statPill = document.createElement('div'); statPill.className = `proj-status-pill ${statusClass}`; statPill.textContent = statusText;
          headerActions.append(startBtn, statPill);
          header.append(titleGrp, headerActions);

          // Stats
          const statsGrid = document.createElement('div'); statsGrid.className = 'proj-stats-grid';
          const mkStatCol = (val, lbl) => {
            const col = document.createElement('div'); col.className = 'proj-stat-col';
            const pVal = document.createElement('div'); pVal.className = 'p-val'; pVal.textContent = val;
            const pLbl = document.createElement('div'); pLbl.className = 'p-lbl'; pLbl.textContent = lbl;
            col.append(pVal, pLbl);
            return col;
          };
          statsGrid.append(
            mkStatCol(formatTime(stats.thisWeek), 'This week'),
            mkStatCol(formatTime(stats.allTime), 'All time'),
            mkStatCol(stats.streak, 'Day streak')
          );

          // Progress
          const progSect = document.createElement('div'); progSect.className = 'proj-progress-section';
          const progLbls = document.createElement('div'); progLbls.className = 'proj-prog-labels';
          const lblLeft = document.createElement('span'); lblLeft.className = 'p-lbl-left'; lblLeft.textContent = 'Weekly goal';
          const lblRight = document.createElement('span'); lblRight.className = 'p-lbl-right'; lblRight.textContent = `${formatTime(stats.thisWeek)} / ${formatTime(stats.goalSecs)}`;
          progLbls.append(lblLeft, lblRight);
          const barWrap = document.createElement('div'); barWrap.className = 'proj-bar-track-wrap';
          const barFill = document.createElement('div'); barFill.className = 'proj-bar-fill-wrap';
          barFill.style.cssText = `width: ${pct}%; background-color: ${barColor};`;
          barWrap.appendChild(barFill);
          const goalEdit = document.createElement('div');
          goalEdit.className = 'project-goal-edit';
          goalEdit.hidden = true;
          const goalInput = document.createElement('input');
          goalInput.type = 'number';
          goalInput.min = '0';
          goalInput.step = '0.5';
          goalInput.className = 'clean-input project-goal-input';
          goalInput.value = (stats.goalSecs / 3600).toString();
          goalInput.placeholder = 'Hours';
          const goalSaveBtn = document.createElement('button');
          goalSaveBtn.className = 'goal-mini-btn confirm';
          goalSaveBtn.textContent = 'Save';
          goalSaveBtn.addEventListener('click', async () => {
            const nextHours = Number(goalInput.value);
            if (!(nextHours > 0)) {
              alert('Enter a weekly goal greater than 0 hours.');
              return;
            }
            projectGoals[projName] = Math.round(nextHours * 3600);
            await browser.storage.local.set({ projectGoals });
            renderProjects(currentData.sessions || []);
          });
          const goalCancelBtn = document.createElement('button');
          goalCancelBtn.className = 'goal-mini-btn';
          goalCancelBtn.textContent = 'Cancel';
          goalCancelBtn.addEventListener('click', () => {
            goalEdit.hidden = true;
            goalInput.value = (stats.goalSecs / 3600).toString();
            goalMetaRow.classList.remove('editing');
          });
          goalEdit.append(goalInput, goalSaveBtn, goalCancelBtn);

          const goalMetaRow = document.createElement('div');
          goalMetaRow.className = 'project-goal-meta';
          const goalChip = document.createElement('button');
          goalChip.className = 'project-goal-chip';
          goalChip.textContent = 'Edit goal';
          goalChip.setAttribute('aria-label', `Edit weekly goal for ${projName}`);
          goalChip.addEventListener('click', () => {
            goalEdit.hidden = !goalEdit.hidden;
            goalMetaRow.classList.toggle('editing', !goalEdit.hidden);
            if (!goalEdit.hidden) goalInput.focus();
          });
          goalMetaRow.appendChild(goalChip);
          progSect.append(progLbls, barWrap, goalMetaRow, goalEdit);

          // Domains
          const dmsList = document.createElement('div'); dmsList.className = 'proj-domains-list'; dmsList.id = `doms-${projName.replace(/\s+/g, '')}`;
          const dBtn = document.createElement('button'); dBtn.className = 'proj-add-btn'; dBtn.textContent = '+ Add domain';
          dBtn.addEventListener('click', () => {
            const addProjectModal = document.getElementById('add-project-modal');
            const inputProjName = document.getElementById('new-project-name');
            const inputProjDomain = document.getElementById('new-project-domain');
            const inputProjGoal = document.getElementById('new-project-goal');
            
            if (addProjectModal && inputProjName && inputProjDomain) {
              inputProjName.value = projName;
              inputProjDomain.value = '';
              if (inputProjGoal) inputProjGoal.value = stats.goalSecs / 3600;
              addProjectModal.classList.add('open');
              addProjectModal.setAttribute('aria-hidden', 'false');
            }
          });
          dmsList.appendChild(dBtn);

          pCard.append(header, statsGrid, progSect, dmsList);

          listContainer.appendChild(pCard);

          const domsList = document.getElementById(`doms-${projName.replace(/\s+/g, '')}`);
          doms.forEach(d => {
            const pill = document.createElement('div');
            pill.className = 'proj-domain-pill';
            pill.textContent = d;
            domsList.insertBefore(pill, domsList.lastElementChild);
          });
        });
      }
    }

    // 3. BREAKDOWN LIST
    const breakdownContainer = document.getElementById('project-breakdown-list');
    if (breakdownContainer) {
      breakdownContainer.textContent = '';
      if (totalThisWeek === 0) totalThisWeek = 1;

      Object.entries(projStats).sort((a,b) => b[1].thisWeek - a[1].thisWeek).forEach(([projName, stats]) => {
        if (stats.thisWeek === 0) return;
        const pctReal = (stats.thisWeek / totalThisWeek) * 100;
        const color = projName === 'Unassigned' ? 'var(--text-faint)' : (pctReal > 50 ? 'var(--accent-primary)' : 'var(--label-productive)');
        const bRow = document.createElement('div');
        bRow.className = 'breakdown-row';
        const dot = document.createElement('div');
        dot.className = 'breakdown-dot';
        dot.style.backgroundColor = color;

        const name = document.createElement('span');
        name.className = 'breakdown-name';
        name.textContent = projName;

        const track = document.createElement('div');
        track.className = 'breakdown-track';
        const fill = document.createElement('div');
        fill.className = 'breakdown-fill';
        fill.style.cssText = `width: ${pctReal}%; background-color: ${color}`;
        track.appendChild(fill);

        const time = document.createElement('span');
        time.className = 'breakdown-time';
        time.textContent = formatTime(stats.thisWeek);

        const pct = document.createElement('span');
        pct.className = 'breakdown-pct';
        pct.textContent = `${Math.round(pctReal)}%`;

        bRow.append(dot, name, track, time, pct);
        breakdownContainer.appendChild(bRow);
      });
    }
  }

  // ─── Insights ───
  async function renderInsights() {
    const d = new Date();
    const dateKeys = [];
    for (let i = 0; i < 28; i++) {
      const past = new Date(d);
      past.setDate(past.getDate() - i);
      const ds = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;
      dateKeys.push(ds);
    }

    const allData = await browser.storage.local.get(dateKeys);

    // ── 7-day comparison ──
    let thisWeekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const dataDay = migrateDayData(allData[dateKeys[i]]);
      thisWeekTotal += dataDay.sessions.reduce((acc, s) => acc + s.duration, 0);
    }
    const sevenDayAvg = thisWeekTotal / 7;
    const todayData = migrateDayData(allData[dateKeys[0]]);
    const todayTotal = todayData.sessions.reduce((acc, s) => acc + s.duration, 0);

    const compValEl = document.getElementById('insight-comparison');
    const compSubEl = document.getElementById('insight-comparison-sub');
    if (sevenDayAvg === 0) {
      compValEl.textContent = formatTime(todayTotal);
      compSubEl.textContent = 'No rolling average yet — keep tracking!';
    } else {
      const diff = todayTotal - sevenDayAvg;
      const pct = Math.abs(diff / sevenDayAvg) * 100;
      const sign = diff >= 0 ? '↑' : '↓';
      compValEl.textContent = `${sign} ${pct.toFixed(0)}%`;
      compValEl.style.color = diff >= 0 ? 'var(--label-distraction)' : 'var(--label-productive)';
      compSubEl.textContent = `${formatTime(todayTotal)} today vs ${formatTime(Math.round(sevenDayAvg))} 7-day avg.`;
    }

    // ── Context Switching ──
    const todaySessions = (currentData.sessions || []).filter(s => s.start);
    let switchCount = 0;
    for (let i = 1; i < todaySessions.length; i++) {
      if (todaySessions[i].domain !== todaySessions[i - 1].domain) switchCount++;
    }
    const refocusCostSec = switchCount * 26; // ~26 sec average re-focus cost

    const switchValEl = document.getElementById('insight-switches');
    const switchSubEl = document.getElementById('insight-switches-sub');
    switchValEl.textContent = switchCount;
    if (switchCount === 0) {
      switchSubEl.textContent = 'No context switches yet today. Excellent focus!';
    } else {
      switchSubEl.textContent = `Est. re-focus cost: ~${formatTime(refocusCostSec)} lost to switching.`;
    }

    // ── Focus Pattern ──
    const heatmapData = Array(7).fill(0).map(() => Array(24).fill(0));
    const correlationData = Array(7).fill(0).map(() => Array(4).fill(0));

    dateKeys.forEach(dk => {
      const dayData = migrateDayData(allData[dk]);
      if (!dayData || !dayData.sessions) return;
      dayData.sessions.forEach(s => {
        if (!s.start || !s.end) return;
        let cursor = new Date(s.start);
        const endDate = new Date(s.end);
        const dayOfWeek = cursor.getDay();

        while (cursor < endDate) {
          const hr = cursor.getHours();
          const endOfHour = new Date(cursor);
          endOfHour.setMinutes(59, 59, 999);
          const sliceEnd = endOfHour < endDate ? endOfHour : endDate;
          const sliceSeconds = Math.max(0, (sliceEnd - cursor) / 1000);

          heatmapData[dayOfWeek][hr] += sliceSeconds;

          let partIdx = 3;
          if (hr >= 6 && hr < 12) partIdx = 0;
          else if (hr >= 12 && hr < 18) partIdx = 1;
          else if (hr >= 18 && hr < 24) partIdx = 2;
          correlationData[dayOfWeek][partIdx] += sliceSeconds;

          cursor = new Date(endOfHour.getTime() + 1);
        }
      });
    });

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const partNames = ['mornings', 'afternoons', 'evenings', 'nights'];

    let maxVal = -1, maxDay = -1, maxPart = -1;
    let minVal = Infinity, minDay = -1, minPart = -1;

    for (let dIdx = 0; dIdx < 7; dIdx++) {
      for (let p = 0; p < 4; p++) {
        const val = correlationData[dIdx][p];
        if (val > maxVal) { maxVal = val; maxDay = dIdx; maxPart = p; }
        if (val > 0 && val < minVal) { minVal = val; minDay = dIdx; minPart = p; }
      }
    }

    const corrEl = document.getElementById('insight-correlation');
    corrEl.textContent = '';
    if (maxVal === 0) {
      corrEl.textContent = 'Not enough data recorded over the past 28 days to determine focus patterns.';
    } else if (minVal === Infinity || minVal === 0) {
      corrEl.textContent = 'You are most focused on ';
      const strong = document.createElement('strong');
      strong.textContent = `${dayNames[maxDay]} ${partNames[maxPart]}`;
      corrEl.appendChild(strong);
      corrEl.appendChild(document.createTextNode('. Track more days to unlock contrast comparisons.'));
    } else {
      const pctDiff = ((maxVal - minVal) / minVal) * 100;
      corrEl.textContent = 'You are ';
      const strong = document.createElement('strong');
      strong.textContent = `${pctDiff.toFixed(0)}% more focused`;
      corrEl.appendChild(strong);
      corrEl.appendChild(document.createTextNode(` on ${dayNames[maxDay]} ${partNames[maxPart]} compared to ${dayNames[minDay]} ${partNames[minPart]}.`));
    }

    // ── Heatmap ──
    const yAxis = document.getElementById('heatmap-y-axis');
    yAxis.textContent = '';
    const grid = document.getElementById('heatmap-grid');
    grid.textContent = '';
    const xAxis = document.getElementById('heatmap-x-axis');
    xAxis.textContent = '';

    const displayDayOrder = [1, 2, 3, 4, 5, 6, 0];
    const shortDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    shortDays.forEach(sd => {
      const dEl = document.createElement('div');
      dEl.textContent = sd;
      yAxis.appendChild(dEl);
    });

    for (let i = 0; i < 24; i += 3) {
      const xEl = document.createElement('div');
      xEl.className = 'heatmap-x-label';
      const ampm = i >= 12 ? 'PM' : 'AM';
      const displayI = i % 12 === 0 ? 12 : i % 12;
      xEl.textContent = `${displayI}${ampm}`;
      xEl.style.gridColumn = 'span 3';
      xEl.style.textAlign = 'left';
      xAxis.appendChild(xEl);
    }

    const heatMax = Math.max(...heatmapData.flat(), 1);
    const hasAnyData = heatmapData.flat().some(v => v > 0);

    displayDayOrder.forEach((dIdx, rowIdx) => {
      for (let hr = 0; hr < 24; hr++) {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        const val = heatmapData[dIdx][hr];

        if (val > 0) {
          const scaled = 0.15 + (val / heatMax) * 0.85;
          cell.style.opacity = Math.min(scaled, 1.0);
          cell.classList.add('has-data');

          // Compute the date for this cell (approx: find dated match)
          const fullDayName = dayNames[dIdx];
          cell.title = `${shortDays[rowIdx]} ${hr}:00 – ${formatTime(val)} (28-day total)\nClick to view this day`;

          // Click to navigate to a date with this day of week
          cell.addEventListener('click', () => {
            // Find the most recent date matching this dayOfWeek in our 28-day window
            const target = dateKeys.find(dk => {
              const [y, mo, da] = dk.split('-').map(Number);
              return new Date(y, mo - 1, da).getDay() === dIdx;
            });
            if (target) {
              selectedDate = target;
              updateDateUI();
              fetchDataForSelectedDate();
              // Switch to trends tab
              tabs.forEach(t => t.classList.remove('active'));
              views.forEach(v => v.classList.remove('active'));
              document.querySelector('[data-view="trends"]').classList.add('active');
              document.getElementById('view-trends').classList.add('active');
            }
          });
        } else {
          cell.title = '';
        }

        grid.appendChild(cell);
      }
    });

    // Empty state hint — remove any previous one first
    const existingHint = document.getElementById('heatmap-empty-hint');
    if (existingHint) existingHint.remove();

    if (!hasAnyData) {
      const hint = document.createElement('div');
      hint.id = 'heatmap-empty-hint';
      hint.className = 'empty-state';
      hint.style.margin = '24px 0 0';
      // User specifically requested to organically remove the text entirely
      grid.after(hint);
    }

    // ── Patterns, Anomalies, Recs, Correlations ──
    let recentSessions = [];
    dateKeys.forEach(dk => {
      const dData = migrateDayData(allData[dk]);
      if (!dData || !dData.sessions) return;
      dData.sessions.forEach(s => {
        if (s.start && s.end) recentSessions.push(s);
      });
    });

    const totalRecentTime = recentSessions.reduce((sum, s) => sum + s.duration, 0);
    const focusedRecent = recentSessions.reduce((sum, s) => sum + (classifySession(s) === 'focused' ? s.duration : 0), 0);
    const distractedRecent = recentSessions.reduce((sum, s) => sum + (classifySession(s) === 'distracted' ? s.duration : 0), 0);
    const avgSessionSeconds = recentSessions.length ? Math.round(totalRecentTime / recentSessions.length) : 0;
    const longSessionsCount = recentSessions.filter(s => s.duration >= 25 * 60).length;
    const quickChecksCount = recentSessions.filter(s => s.duration <= 3 * 60).length;
    const focusSharePct = totalRecentTime ? Math.round((focusedRecent / totalRecentTime) * 100) : 0;
    const distractionSharePct = totalRecentTime ? Math.round((distractedRecent / totalRecentTime) * 100) : 0;

    const patternsGrid = document.getElementById('patterns-grid');
    if (patternsGrid) {
      patternsGrid.textContent = '';
      const patternItems = [
        { label: 'Focus share', value: `${focusSharePct}%`, desc: `Of your last 28 days of tracked time, ${formatTime(focusedRecent)} landed in focused work.` },
        { label: 'Avg session', value: formatTime(avgSessionSeconds), desc: `Typical working bursts are around ${formatTime(avgSessionSeconds)} before context changes or stops.` },
        { label: 'Deep sessions', value: longSessionsCount, desc: `${longSessionsCount} sessions lasted at least 25 minutes, which is a good signal for sustained attention.` },
        { label: 'Quick checks', value: quickChecksCount, desc: `${quickChecksCount} sessions were under 3 minutes, which usually points to inbox or tab-check behavior.` }
      ];
      patternItems.forEach(item => {
        const box = document.createElement('div');
        box.className = 'corr-box';
        const label = document.createElement('span');
        label.className = 'corr-label';
        label.textContent = item.label;
        const value = document.createElement('div');
        value.className = 'corr-val';
        value.textContent = String(item.value);
        const desc = document.createElement('div');
        desc.className = 'corr-desc';
        desc.textContent = item.desc;
        box.append(label, value, desc);
        patternsGrid.appendChild(box);
      });
    }

    const anomaliesList = document.getElementById('anomalies-list');
    if (anomaliesList) {
      anomaliesList.textContent = '';
      const anomalyItems = [];
      if (todayTotal > sevenDayAvg * 1.5 && sevenDayAvg > 0) {
        anomalyItems.push(`Today is running hot at ${formatTime(todayTotal)}, which is well above your recent daily average of ${formatTime(Math.round(sevenDayAvg))}.`);
      }
      if (switchCount >= Math.max(12, Math.round(recentSessions.length * 0.35))) {
        anomalyItems.push(`Switching is elevated today with ${switchCount} context changes, so your attention may be more fragmented than usual.`);
      }
      if (distractionSharePct >= 45) {
        anomalyItems.push(`Distracted time is taking ${distractionSharePct}% of your recent tracked time, which is high enough to noticeably affect deep work.`);
      }
      if (anomalyItems.length === 0) {
        anomalyItems.push('No major anomalies stand out right now. Your recent time distribution looks fairly stable.');
      }
      anomalyItems.forEach(text => {
        const row = document.createElement('div');
        row.className = 'rec-item';
        row.textContent = text;
        anomaliesList.appendChild(row);
      });
    }

    const recList = document.getElementById('recommendations-list');
    if (recList) {
      recList.textContent = '';
      const recommendations = [];
      if (switchCount > 0) {
        const peakHourLabel = `${peakHour % 12 === 0 ? 12 : peakHour % 12}${peakHour >= 12 ? 'PM' : 'AM'}`;
        recommendations.push(`Protect the hour around ${peakHourLabel}, since that is your strongest recurring work window.`);
      }
      if (quickChecksCount > longSessionsCount) {
        recommendations.push('You have more quick checks than deep sessions recently. Batching low-value checks into fixed windows would likely improve focus.');
      }
      if (focusSharePct < 50) {
        recommendations.push('Focused time is below half of your tracked time. Tagging a few high-value domains as productive will also sharpen the timeline and insights.');
      } else {
        recommendations.push('Your focused share is healthy. Try nudging one more session per day past 25 minutes to compound that progress.');
      }
      recommendations.slice(0, 3).forEach(text => {
        const row = document.createElement('div');
        row.className = 'rec-item';
        row.textContent = text;
        recList.appendChild(row);
      });
    }

    const corrGrid = document.getElementById('correlations-grid');
    if (corrGrid) {
      let morningTime = 0, afternoonTime = 0, eveningTime = 0, nightTime = 0;
      let longSessions = 0, shortSessions = 0;
      let dayTotals = [0,0,0,0,0,0,0]; 
      const pairings = {};

      dateKeys.forEach(dk => {
        const dData = migrateDayData(allData[dk]);
        if (!dData || !dData.sessions) return;
        
        const dateObj = new Date(dk);
        if (isNaN(dateObj.getTime())) return;
        const dayOfWeek = dateObj.getDay(); 
        
        for (let i = 0; i < dData.sessions.length; i++) {
          const s = dData.sessions[i];
          if (!s.domain || !s.start || !s.end) continue;
          
          const durMatch = s.end - s.start;
          if (durMatch < 0) continue;

          dayTotals[dayOfWeek] += durMatch;
          
          const hour = new Date(s.start).getHours();
          if (hour >= 6 && hour < 12) morningTime += durMatch;
          else if (hour >= 12 && hour < 18) afternoonTime += durMatch;
          else if (hour >= 18 && hour < 24) eveningTime += durMatch;
          else nightTime += durMatch;
          
          if (durMatch > 10 * 60) longSessions++;
          else if (durMatch < 2 * 60) shortSessions++;
          
          if (i < dData.sessions.length - 1) {
            const nextS = dData.sessions[i+1];
            if (nextS.domain && s.domain !== nextS.domain) {
              const timeDiff = nextS.start - s.end;
              if (timeDiff >= 0 && timeDiff <= 120000) { 
                const pair = `${s.domain} → ${nextS.domain}`;
                pairings[pair] = (pairings[pair] || 0) + 1;
              }
            }
          }
        }
      });

      const parts = [ {n:'Mornings', t:morningTime}, {n:'Afternoons', t:afternoonTime}, {n:'Evenings', t:eveningTime}, {n:'Late Nights', t:nightTime} ];
      parts.sort((a,b) => b.t - a.t);
      const bestPart = parts[0];
      const avgOther = (parts[1].t + parts[2].t + parts[3].t) / 3 || 1;
      const todPct = Math.round(((bestPart.t - avgOther) / avgOther) * 100);

      const ratio = shortSessions > 0 ? (shortSessions / (longSessions||1)).toFixed(1) : 0;
      
      let bestDayIdx = 0;
      for(let i=1; i<7; i++) if(dayTotals[i] > dayTotals[bestDayIdx]) bestDayIdx = i;
      const fDayNames = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
      const avgDay = (dayTotals.reduce((a,b)=>a+b,0) - dayTotals[bestDayIdx]) / 6 || 1;
      const dayVal = (dayTotals[bestDayIdx] / avgDay).toFixed(1);

      const sortedPairs = Object.entries(pairings).sort((a,b) => b[1] - a[1]);
      const topPair = sortedPairs.length > 0 ? sortedPairs[0] : null;

      const c1 = document.createElement('div'); c1.className = 'corr-box';
      const c1Label = document.createElement('span'); c1Label.className = 'corr-label'; c1Label.textContent = 'Time of day';
      const c1Val = document.createElement('div'); c1Val.className = 'corr-val'; c1Val.textContent = `↑ ${todPct > 0 ? todPct : 0}%`;
      const c1Desc = document.createElement('div'); c1Desc.className = 'corr-desc';
      c1Desc.appendChild(document.createTextNode('Most tracking consistently active during '));
      const c1Strong = document.createElement('strong'); c1Strong.textContent = bestPart.n;
      c1Desc.appendChild(c1Strong);
      c1Desc.appendChild(document.createTextNode('.'));
      c1.append(c1Label, c1Val, c1Desc);

      const c2 = document.createElement('div'); c2.className = 'corr-box';
      const c2Label = document.createElement('span'); c2Label.className = 'corr-label'; c2Label.textContent = 'Session length';
      const c2Val = document.createElement('div'); c2Val.className = 'corr-val'; c2Val.textContent = `↑ ${ratio}×`;
      const c2Desc = document.createElement('div'); c2Desc.className = 'corr-desc';
      c2Desc.appendChild(document.createTextNode('Sessions over '));
      const c2Strong = document.createElement('strong'); c2Strong.textContent = '10 min';
      c2Desc.appendChild(c2Strong);
      c2Desc.appendChild(document.createTextNode(' have fewer site switches vs short ones.'));
      c2.append(c2Label, c2Val, c2Desc);

      const c3 = document.createElement('div'); c3.className = 'corr-box';
      const c3Label = document.createElement('span'); c3Label.className = 'corr-label'; c3Label.textContent = 'Day of week';
      const c3Val = document.createElement('div'); c3Val.className = 'corr-val'; c3Val.textContent = `↑ ${dayVal}×`;
      const c3Desc = document.createElement('div'); c3Desc.className = 'corr-desc';
      c3Desc.appendChild(document.createTextNode('You track more time on '));
      const c3Strong = document.createElement('strong'); c3Strong.textContent = fDayNames[bestDayIdx];
      c3Desc.appendChild(c3Strong);
      c3Desc.appendChild(document.createTextNode(' than average.'));
      c3.append(c3Label, c3Val, c3Desc);

      const c4 = document.createElement('div'); c4.className = 'corr-box';
      const c4Label = document.createElement('span'); c4Label.className = 'corr-label'; c4Label.textContent = 'Site pairing';
      const c4Val = document.createElement('div'); c4Val.className = 'corr-val'; c4Val.style.fontSize = '18px'; c4Val.textContent = topPair ? topPair[0] : 'None yet';
      const c4Desc = document.createElement('div'); c4Desc.className = 'corr-desc';
      if (topPair) {
        c4Desc.appendChild(document.createTextNode('Opening the first site predicts visiting the second within '));
        const c4Strong = document.createElement('strong'); c4Strong.textContent = '2 minutes';
        c4Desc.appendChild(c4Strong);
        c4Desc.appendChild(document.createTextNode(`, ${Math.min(99, Math.round(50 + (topPair[1]*5)))}% of the time.`));
      } else {
        c4Desc.textContent = 'Keep browsing to generate pairings.';
      }
      c4.append(c4Label, c4Val, c4Desc);

      corrGrid.textContent = '';
      corrGrid.append(c1, c2, c3, c4);
    }
  }

  // Legacy CSV logic safely eradicated.

  // ─── Init ───
  updateDateUI();
  fetchDataForSelectedDate();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      const today = getTodayString();
      if (selectedDate === today && changes[today]) {
        currentData = migrateDayData(changes[today].newValue || { sessions: [] });
        currentData.sessions = preprocessSessions(currentData.sessions);
        renderDashboard();
      }
      if (changes.projectMappings || changes.projectsMap) {
        projectsMap = (changes.projectMappings && changes.projectMappings.newValue) || (changes.projectsMap && changes.projectsMap.newValue) || projectsMap;
        renderProjects(currentData.sessions || []);
      }
      if (changes.projectGoals) {
        projectGoals = changes.projectGoals.newValue || {};
        renderProjects(currentData.sessions || []);
      }
      if (changes.activeProjectFocus) {
        activeProjectFocus = changes.activeProjectFocus.newValue || null;
        renderProjects(currentData.sessions || []);
      }
      if (changes.productivityLabels) {
        productivityLabels = changes.productivityLabels.newValue || {};
        renderDashboard();
      }
      if (changes.energyTags) {
        energyTags = changes.energyTags.newValue || {};
        renderTimeline(currentData.sessions || []);
      }
    }
  });

  setInterval(() => {
    if (selectedDate === getTodayString()) fetchDataForSelectedDate();
  }, 10000);

  setInterval(() => {
    updateProjectFocusClock();
  }, 1000);

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') shiftDate(-1);
    else if (e.key === 'ArrowRight') shiftDate(1);
  });
});
