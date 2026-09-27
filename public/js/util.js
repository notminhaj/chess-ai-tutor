// Shared helpers: API calls, app state, formatting.

export async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.body && typeof opts.body !== 'string') {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---------- state ----------

const listeners = new Set();
export const state = {
  user: load('cat.user'),
  profile: null,
  status: { stockfish: true, ai: false },
  reviewMode: load('cat.reviewMode') || 'standard',
};

function load(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export function save(k, v) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage may be unavailable */
  }
}

export function setUser(u) {
  state.user = u ? u.toLowerCase() : null;
  state.profile = null;
  save('cat.user', state.user);
  listeners.forEach((f) => f());
}

export function onUserChange(f) {
  listeners.add(f);
}

// ---------- formatting ----------

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const pct = (x, digits = 0) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(digits)}%`);
export const fix = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));
export const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const TIME_CLASS = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', daily: 'Daily' };
export const SERIES = { rapid: 'var(--series-1)', blitz: 'var(--series-2)', bullet: 'var(--series-3)', daily: 'var(--series-4)' };

export const CLASSES = {
  brilliant: { symbol: '!!', label: 'Brilliant' },
  great: { symbol: '!', label: 'Great' },
  best: { symbol: '★', label: 'Best' },
  excellent: { symbol: '✓', label: 'Excellent' },
  good: { symbol: '·', label: 'Good' },
  book: { symbol: 'B', label: 'Book' },
  forced: { symbol: '□', label: 'Forced' },
  inaccuracy: { symbol: '?!', label: 'Inaccuracy' },
  mistake: { symbol: '?', label: 'Mistake' },
  miss: { symbol: '✗', label: 'Miss' },
  blunder: { symbol: '??', label: 'Blunder' },
};

export function clsBadge(cls) {
  const c = CLASSES[cls];
  return c ? `<span class="cls cls-${cls}" title="${c.label}">${c.symbol}</span>` : '';
}

export function wdlBar(w) {
  if (!w || !w.games) return '<div class="wdl"></div>';
  const f = (n) => `${((n / w.games) * 100).toFixed(1)}%`;
  return `<div class="wdl" title="${w.win} won, ${w.draw} drawn, ${w.loss} lost"><span class="w" style="width:${f(w.win)}"></span><span class="d" style="width:${f(w.draw)}"></span><span class="l" style="width:${f(w.loss)}"></span></div>`;
}

export function outcomeBadge(outcome) {
  const t = { win: 'Won', loss: 'Lost', draw: 'Draw' }[outcome] || '—';
  return `<span class="badge ${outcome}">${t}</span>`;
}

export function toast(msg, ms = 2600) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms);
}

export function spinner(text = 'Loading…') {
  return `<div class="empty"><span class="spinner"></span> ${esc(text)}</div>`;
}

export function errorBox(e) {
  return `<div class="notice bad">${esc(e.message || e)}</div>`;
}

export function needUser(root) {
  if (state.user) return false;
  root.innerHTML = `<div class="card empty"><p>Link your Chess.com username first.</p><a class="btn primary" href="#/home">Link account</a></div>`;
  return true;
}

// Replay a UCI move list from a FEN, returning SAN (or null if illegal).
export function sanLine(Chess, fen, ucis, max = 12) {
  const c = new Chess(fen);
  const out = [];
  for (const u of ucis.slice(0, max)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

// Number SAN moves starting from a FEN's move number and side, e.g. "12...Nf6 13.Bxf6".
export function numbered(fen, sans) {
  const parts = fen.split(' ');
  let n = +parts[5] || 1;
  let white = parts[1] === 'w';
  const out = [];
  sans.forEach((s, i) => {
    if (white) out.push(`${n}.${s}`);
    else out.push(i === 0 ? `${n}...${s}` : s);
    if (!white) n++;
    white = !white;
  });
  return out.join(' ');
}

// Games seen in lists, by uuid, so the review page can open them without refetching.
export const gameCache = new Map();
export function rememberGames(games) {
  for (const g of games) gameCache.set(g.uuid, g);
}
// A PGN pasted by the user, waiting to be reviewed.
export const pending = { pgn: null };

// Accuracy with one decimal and a percent sign, e.g. "87.4%".
export const accPct = (x) => (x == null || Number.isNaN(x) ? '—' : `${Number(x).toFixed(1)}%`);
