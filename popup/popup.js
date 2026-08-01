const LABEL_NAMES = {
  productive: 'Productive',
  neutral: 'Neutral',
  distracting: 'Distracting'
};

const nowEl = document.getElementById('now');
const taggerEl = document.getElementById('tagger');
const segmentedEl = document.getElementById('segmented');
const alwaysBtn = document.getElementById('always');
const noteEl = document.getElementById('note');
const totalEl = document.getElementById('total');
const focusEl = document.getElementById('focus');
const focusBodyEl = document.getElementById('focus-body');

let context = null;
let projects = [];
let activeFocus = null;
let tick = null;

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return total > 0 ? '< 1m' : '0m';
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Drawn locally rather than fetched: asking a favicon service for an icon would
// tell it every domain you visit.
function domainColor(domain) {
  const palette = ['#4A6552', '#7D776B', '#8C6A3F', '#5A6B7D', '#7A5468', '#5F6B4A'];
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderIdle(message) {
  nowEl.textContent = '';
  nowEl.appendChild(el('div', 'now-empty', message));
  taggerEl.hidden = true;
}

function renderNow() {
  nowEl.textContent = '';

  const head = el('div', 'now-head');
  const badge = el('span', 'site-badge', context.domain.replace(/^www\./, '').charAt(0).toUpperCase());
  badge.style.backgroundColor = domainColor(context.domain);
  const name = el('span', 'site-name', context.domain);
  name.title = context.domain;
  head.append(badge, name);

  const figure = el('div', 'now-figure');
  figure.id = 'now-figure';
  figure.textContent = formatTime(context.domainSeconds);

  const meta = el('div', 'now-meta');
  meta.append(el('span', null, 'here today'));
  if (context.sessionStartTime) {
    const live = el('span', 'now-live');
    live.id = 'now-live';
    live.textContent = formatClock((Date.now() - context.sessionStartTime) / 1000);
    meta.append(el('span', 'meta-dot', '·'), live, el('span', null, 'this visit'));
  }

  nowEl.append(head, figure, meta);
  taggerEl.hidden = false;
}

function renderTagger() {
  const active = context.effectiveLabel;

  segmentedEl.querySelectorAll('.seg').forEach((btn) => {
    const isActive = btn.dataset.label === active;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // The pin is its own explicit control. Clearing the visit tag no longer
  // silently deletes the site's saved default — that was a destructive side
  // effect on a button that reads like an undo.
  if (active) {
    alwaysBtn.hidden = false;
    const pinned = context.ruleLabel === active && !context.ruleIsConditional;
    alwaysBtn.textContent = pinned
      ? `Always ${LABEL_NAMES[active].toLowerCase()} — on`
      : `Always count ${context.domain} as ${LABEL_NAMES[active].toLowerCase()}`;
    alwaysBtn.classList.toggle('is-on', pinned);
  } else {
    alwaysBtn.hidden = true;
  }

  if (context.sessionLabel) {
    noteEl.textContent = 'Applies to this visit, and to the rest of it as it continues.';
  } else if (context.ruleLabel && context.ruleIsConditional) {
    noteEl.textContent = `From a rule that only applies right now. Set in the dashboard.`;
  } else if (context.ruleLabel) {
    noteEl.textContent = `Inherited from your default for ${context.domain}.`;
  } else {
    noteEl.textContent = 'Untagged time still counts — it just lands in neither column.';
  }
}

function renderFocus() {
  focusBodyEl.textContent = '';

  if (activeFocus) {
    focusEl.hidden = false;
    const row = el('div', 'focus-row');
    const info = el('div', 'focus-info');
    info.append(el('span', 'focus-name', activeFocus.projectName));
    const elapsed = el('span', 'focus-elapsed');
    elapsed.id = 'focus-elapsed';
    elapsed.textContent = `Running ${formatTime((Date.now() - activeFocus.startTime) / 1000)}`;
    info.append(elapsed);

    const stop = el('button', 'focus-btn stop', 'Stop');
    stop.addEventListener('click', async () => {
      activeFocus = null;
      await browser.storage.local.set({ activeProjectFocus: null });
      await browser.runtime.sendMessage({ action: 'syncProjectFocusBoundary' });
      renderFocus();
    });

    row.append(info, stop);
    focusBodyEl.appendChild(row);
    return;
  }

  if (!projects.length) {
    focusEl.hidden = true;
    return;
  }

  focusEl.hidden = false;
  const list = el('div', 'focus-list');
  projects.slice(0, 4).forEach((name) => {
    const button = el('button', 'focus-btn', name);
    button.addEventListener('click', async () => {
      activeFocus = { projectName: name, startTime: Date.now() };
      await browser.storage.local.set({ activeProjectFocus: activeFocus });
      await browser.runtime.sendMessage({ action: 'syncProjectFocusBoundary' });
      renderFocus();
    });
    list.appendChild(button);
  });
  focusBodyEl.appendChild(list);
}

function startTicking() {
  if (tick) clearInterval(tick);
  tick = setInterval(() => {
    if (!context) return;
    const since = (Date.now() - context.loadedAt) / 1000;

    if (context.sessionStartTime) {
      const live = document.getElementById('now-live');
      if (live) live.textContent = formatClock((Date.now() - context.sessionStartTime) / 1000);
      const figure = document.getElementById('now-figure');
      if (figure) figure.textContent = formatTime(context.domainSeconds + since);
    }

    totalEl.textContent = formatTime(context.totalSeconds + since);

    const elapsed = document.getElementById('focus-elapsed');
    if (elapsed && activeFocus) {
      elapsed.textContent = `Running ${formatTime((Date.now() - activeFocus.startTime) / 1000)}`;
    }
  }, 1000);
}

async function load() {
  try {
    const result = await browser.runtime.sendMessage({ action: 'getPopupContext' });
    context = result || {};
    context.loadedAt = Date.now();
    activeFocus = context.projectFocus || null;
  } catch (error) {
    console.warn('Could not read tracking state:', error);
    renderIdle('Tracking state is unavailable right now.');
    return;
  }

  totalEl.textContent = formatTime(context.totalSeconds);
  renderFocus();

  if (!context.domain) {
    renderIdle(context.isIdle ? 'Paused — no activity detected.' : 'This page is not tracked.');
    startTicking();
    return;
  }

  renderNow();
  renderTagger();
  startTicking();
}

segmentedEl.addEventListener('click', async (event) => {
  const btn = event.target.closest('.seg');
  if (!btn || !context || !context.domain) return;

  // Pressing the active tag again clears it, so the control is its own undo.
  const next = context.effectiveLabel === btn.dataset.label ? null : btn.dataset.label;

  const result = await browser.runtime.sendMessage({ action: 'setSessionLabel', label: next });
  if (!result || !result.ok) return;

  context.sessionLabel = next;
  context.effectiveLabel = next || context.ruleLabel || null;
  renderTagger();
});

alwaysBtn.addEventListener('click', async () => {
  if (!context || !context.effectiveLabel) return;
  const pinned = context.ruleLabel === context.effectiveLabel && !context.ruleIsConditional;
  const nextLabel = pinned ? null : context.effectiveLabel;

  const result = await browser.runtime.sendMessage({
    action: 'setDomainLabel',
    domain: context.domain,
    label: nextLabel
  });
  if (!result || !result.ok) return;

  context.ruleLabel = nextLabel;
  context.ruleIsConditional = false;
  context.effectiveLabel = context.sessionLabel || nextLabel || null;
  renderTagger();
});

document.getElementById('open-dashboard').addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});

(async () => {
  const stored = await browser.storage.local.get(['darkMode', 'projectMappings', 'projectGoals']);
  if (stored.darkMode) document.documentElement.classList.add('dark-theme');

  projects = [...new Set([
    ...Object.values(stored.projectMappings || {}),
    ...Object.keys(stored.projectGoals || {})
  ])].filter(Boolean).sort();

  await load();
})();
