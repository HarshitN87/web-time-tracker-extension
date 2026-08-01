// A pause, not a wall.
//
// This runs only on sites the user explicitly opted in for, and only after
// granting host access to that site individually. It shows the number and the
// plan, then lets you through — every time, with no way to fail. Blocking is
// the intervention people reject, and it works by removing the choice; the
// point here is to restore a moment of choosing, not to take it away.

(async () => {
  // Top frame only. An ad iframe should never be able to raise this.
  if (window.top !== window) return;
  if (document.getElementById('flow-tracker-speed-bump')) return;

  const domain = location.hostname.replace(/^www\./, '');

  let context;
  try {
    context = await browser.runtime.sendMessage({ action: 'getSpeedBumpContext', domain });
  } catch (error) {
    return;
  }

  if (!context || !context.show) return;

  function formatTime(seconds) {
    const total = Math.max(0, Math.round(seconds || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return total > 0 ? 'under a minute' : 'nothing yet';
  }

  const host = document.createElement('div');
  host.id = 'flow-tracker-speed-bump';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }

    .scrim {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(15, 13, 11, 0.72);
      font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif;
      animation: fade 0.18s ease;
    }

    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .scrim { animation: none; } }

    .card {
      width: 100%;
      max-width: 420px;
      background: #F4F1EA;
      color: #191713;
      border: 1px solid #D6D0C2;
      border-radius: 2px;
      padding: 28px 30px 26px;
      box-sizing: border-box;
    }

    @media (prefers-color-scheme: dark) {
      .card { background: #171412; color: #E9DFCB; border-color: #2A241E; }
      .figure { color: #E9DFCB; }
      .plan { border-color: #2A241E; }
      .minutes { background: transparent; color: #E9DFCB; border-color: #2A241E; }
      .ghost { color: #8A7F6C; }
    }

    .eyebrow {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #6A6355;
      margin: 0 0 14px;
    }

    .figure {
      font-family: 'Sitka Banner', Constantia, 'Palatino Linotype', Georgia, serif;
      font-size: 28px;
      line-height: 1.15;
      margin: 0 0 8px;
    }

    .sub {
      font-size: 13.5px;
      line-height: 1.55;
      color: #4A463D;
      margin: 0 0 20px;
    }

    @media (prefers-color-scheme: dark) { .sub { color: #BCB09A; } }

    .plan {
      border-left: 2px solid #B03A2B;
      padding: 8px 0 8px 14px;
      margin: 0 0 20px;
      font-size: 13.5px;
      line-height: 1.5;
      font-style: italic;
    }

    .ask {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 13px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .minutes {
      width: 68px;
      font: inherit;
      font-size: 13px;
      padding: 6px 8px;
      border: 1px solid #D6D0C2;
      border-radius: 2px;
      background: transparent;
      color: inherit;
    }

    .actions { display: flex; gap: 10px; flex-wrap: wrap; }

    button {
      font: inherit;
      font-size: 13px;
      padding: 9px 18px;
      border-radius: 2px;
      cursor: pointer;
      border: 1px solid transparent;
    }

    .primary { background: #B03A2B; border-color: #B03A2B; color: #F4F1EA; }
    .primary:hover { background: #8F2E22; border-color: #8F2E22; }

    .ghost { background: transparent; border-color: #D6D0C2; color: #6A6355; }
    .ghost:hover { border-color: #6A6355; }

    button:focus-visible, .minutes:focus-visible {
      outline: 2px solid #B03A2B;
      outline-offset: 2px;
    }
  `;

  const scrim = document.createElement('div');
  scrim.className = 'scrim';

  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', `Speed bump for ${domain}`);

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Before you go in';

  const figure = document.createElement('p');
  figure.className = 'figure';
  figure.textContent = `${formatTime(context.secondsToday)} on ${domain} today`;

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'You asked to be shown this. Nothing is blocked — decide, then carry on.';

  card.append(eyebrow, figure, sub);

  if (context.plan) {
    const plan = document.createElement('p');
    plan.className = 'plan';
    plan.textContent = `Your plan: when I open ${domain}, I will ${context.plan}`;
    card.appendChild(plan);
  }

  const ask = document.createElement('div');
  ask.className = 'ask';
  const askLabel = document.createElement('label');
  askLabel.textContent = 'How long do you want here?';
  askLabel.setAttribute('for', 'ft-minutes');
  const minutes = document.createElement('input');
  minutes.className = 'minutes';
  minutes.id = 'ft-minutes';
  minutes.type = 'number';
  minutes.min = '1';
  minutes.placeholder = '10';
  const minutesSuffix = document.createElement('span');
  minutesSuffix.textContent = 'minutes';
  ask.append(askLabel, minutes, minutesSuffix);
  card.appendChild(ask);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const primary = document.createElement('button');
  primary.className = 'primary';
  primary.type = 'button';
  primary.textContent = 'Continue';

  const ghost = document.createElement('button');
  ghost.className = 'ghost';
  ghost.type = 'button';
  ghost.textContent = 'Actually, go back';

  actions.append(primary, ghost);
  card.appendChild(actions);

  scrim.appendChild(card);
  shadow.append(style, scrim);

  function dismiss() {
    document.removeEventListener('keydown', onKey, true);
    host.remove();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      dismiss();
    }
  }

  primary.addEventListener('click', dismiss);

  ghost.addEventListener('click', () => {
    dismiss();
    // Only go back if there is somewhere to go back to; otherwise leaving the
    // user on a blank tab would be worse than doing nothing.
    if (window.history.length > 1) window.history.back();
  });

  scrim.addEventListener('click', (event) => {
    if (event.target === scrim) dismiss();
  });

  document.addEventListener('keydown', onKey, true);

  (document.body || document.documentElement).appendChild(host);
  minutes.focus();
})();
