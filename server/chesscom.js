// Client for Chess.com's official public API (https://www.chess.com/news/view/published-data-api).
// It is read-only and needs no password or login: it serves the same profile, stats and game
// archives anyone can see on a public profile. Responses are cached on disk to stay polite.
const store = require('./store');

const BASE = 'https://api.chess.com/pub';
const UA = 'chess-ai-tutor/1.0 (personal local study tool; uses the public PubAPI)';
const MIN = 60 * 1000;

// Chess.com asks clients to make requests serially. This chain enforces one at a time.
let chain = Promise.resolve();

async function rawGet(url, attempt = 0) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return rawGet(url, attempt + 1);
  }
  if (res.status === 404) {
    const err = new Error('Not found on Chess.com');
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Chess.com API returned ${res.status}`);
    err.status = 502;
    throw err;
  }
  return res.json();
}

function get(url, ttlMs) {
  const key = store.hash(url);
  const cached = store.readJson(['cache', key + '.json']);
  if (cached && (ttlMs === Infinity || Date.now() - cached.at < ttlMs)) return Promise.resolve(cached.body);
  const p = chain.then(() => rawGet(url));
  chain = p.catch(() => {});
  return p
    .then((body) => {
      store.writeJson(['cache', key + '.json'], { at: Date.now(), url, body });
      return body;
    })
    .catch((e) => {
      // Serve stale data rather than failing when the API hiccups.
      if (cached && e.status !== 404) return cached.body;
      throw e;
    });
}

const user = (u) => encodeURIComponent(String(u).trim().toLowerCase());

function profile(u) {
  return get(`${BASE}/player/${user(u)}`, 10 * MIN);
}

function stats(u) {
  return get(`${BASE}/player/${user(u)}/stats`, 10 * MIN);
}

async function archives(u) {
  const body = await get(`${BASE}/player/${user(u)}/games/archives`, 30 * MIN);
  return (body.archives || []).map((url) => {
    const m = url.match(/(\d{4})\/(\d{2})$/);
    return { url, year: +m[1], month: +m[2] };
  });
}

// A month that is fully in the past never changes, so cache it forever.
function month(u, year, mon) {
  const now = new Date();
  const isPast = year < now.getUTCFullYear() || (year === now.getUTCFullYear() && mon < now.getUTCMonth() + 1);
  const mm = String(mon).padStart(2, '0');
  return get(`${BASE}/player/${user(u)}/games/${year}/${mm}`, isPast ? Infinity : 5 * MIN).then((b) => b.games || []);
}

// Fetch the most recent `count` months of games, oldest first.
async function recentGames(u, count = 6) {
  const list = await archives(u);
  const pick = list.slice(-count);
  const out = [];
  for (const a of pick) out.push(...(await month(u, a.year, a.month)));
  return out;
}

function dailyPuzzle() {
  return get(`${BASE}/puzzle`, 60 * MIN);
}

function randomPuzzle() {
  // Random puzzles should not be cached, so go straight to the serial chain.
  const p = chain.then(() => rawGet(`${BASE}/puzzle/random`));
  chain = p.catch(() => {});
  return p;
}

module.exports = { profile, stats, archives, month, recentGames, dailyPuzzle, randomPuzzle };
