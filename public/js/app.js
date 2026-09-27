// App shell: navigation, routing and the linked account chip.
import { api, state, setUser, onUserChange, esc } from './util.js';
import * as home from './views/home.js';
import * as games from './views/games.js';
import * as review from './views/review.js';
import * as puzzles from './views/puzzles.js';
import * as insights from './views/insights.js';
import * as analyze from './views/analyze.js';
import * as play from './views/play.js';
import * as coach from './views/coach.js';

const VIEWS = { home, games, review, puzzles, insights, analyze, play, coach };
const main = document.getElementById('main');
let current = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const [name, ...rest] = pathPart.split('/');
  return { name: VIEWS[name] ? name : 'home', args: rest.map(decodeURIComponent), query: new URLSearchParams(query) };
}

async function route() {
  const { name, args, query } = parseHash();
  if (current && current.destroy) {
    try {
      current.destroy();
    } catch (e) {
      console.error(e);
    }
  }
  current = VIEWS[name];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  main.innerHTML = '';
  const root = document.createElement('div');
  main.appendChild(root);
  window.scrollTo(0, 0);
  try {
    await current.render(root, { args, query });
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="notice bad">Something went wrong: ${esc(e.message)}</div>`;
  }
}

function renderUserChip() {
  const chip = document.getElementById('userchip');
  if (!state.user) {
    chip.innerHTML = '<a class="btn small primary" href="#/home">Link account</a>';
    return;
  }
  const p = state.profile;
  chip.innerHTML = `${p && p.avatar ? `<img src="/api/avatar?url=${encodeURIComponent(p.avatar)}" alt="">` : ''}<span class="small"><b>${esc(p ? p.username : state.user)}</b></span><button class="small ghost" id="unlink" title="Use a different username">Change</button>`;
  chip.querySelector('#unlink').onclick = () => {
    setUser(null);
    location.hash = '#/home';
  };
}

async function loadProfile() {
  renderUserChip();
  if (!state.user) return;
  try {
    const data = await api(`/api/player/${encodeURIComponent(state.user)}`);
    state.profile = data.profile;
    state.stats = data.stats;
    renderUserChip();
  } catch {
    /* the home view shows the error */
  }
}

async function init() {
  try {
    state.status = await api('/api/status');
  } catch {
    /* server may be starting */
  }
  if (!state.status.stockfish) {
    document.getElementById('banner').innerHTML = '<div class="notice warn" style="margin:12px 20px 0">Stockfish is not installed, so reviews and analysis are off. Stop the server, run <kbd>npm run setup</kbd>, then start it again.</div>';
  }
  onUserChange(() => {
    loadProfile();
    route();
  });
  window.addEventListener('hashchange', route);
  loadProfile();
  route();
}

init();
