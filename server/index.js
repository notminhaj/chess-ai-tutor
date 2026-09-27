// Local web server for Chess AI Tutor. Run with: npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { Engine } = require('./engine');
const chesscom = require('./chesscom');
const review = require('./review');
const puzzles = require('./puzzles');
const insights = require('./insights');
const coach = require('./coach');
const store = require('./store');
const { addGameRatings } = require('./gamerating');

const PORT = +process.env.PORT || 3717;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');
const CHESSJS = path.join(__dirname, '..', 'node_modules', 'chess.js', 'dist', 'esm', 'chess.js');

// Separate engines so a long review never blocks the analysis board or a game against the engine.
const engines = {
  review: new Engine('review', { threads: 4, hash: 128 }),
  live: new Engine('live', { threads: 2, hash: 64 }),
  play: new Engine('play', { threads: 1, hash: 16 }),
};

// ---------- helpers ----------

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function fail(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(e);
  send(res, status, { error: e.message || String(e) });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2e6) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function validUser(u) {
  if (!u || !/^[A-Za-z0-9_-]{2,40}$/.test(u)) throw Object.assign(new Error('Enter a valid Chess.com username.'), { status: 400 });
  return u.toLowerCase();
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Strip heavy fields before sending a review to the browser.
function publicReview(r) {
  const { _full, ...rest } = r;
  rest.moves = (rest.moves || []).map(({ bestLine, replyLine, ...m }) => m);
  return addGameRatings(rest);
}

// Slim archive games down to what the games list needs.
function slimGame(g, username) {
  const n = insights.normalize(g, username);
  return {
    url: g.url,
    uuid: g.uuid,
    pgn: g.pgn,
    end: g.end_time * 1000,
    timeClass: g.time_class,
    timeControl: g.time_control,
    rated: g.rated,
    rules: g.rules,
    white: { username: g.white.username, rating: g.white.rating, result: g.white.result },
    black: { username: g.black.username, rating: g.black.rating, result: g.black.result },
    accuracies: g.accuracies || null,
    opening: g.pgn ? insights.openingFromPgn(g.pgn) : null,
    me: n ? { color: n.color, outcome: n.outcome, how: n.how } : null,
    reviewed: !!store.readJson(['reviews', review.reviewKey(g.uuid, g.pgn) + '.json']),
  };
}

// ---------- review jobs ----------

const jobs = new Map();
let jobSeq = 0;

function startReviewJob({ pgn, id, username, mode }) {
  const preset = review.PRESETS[mode] || review.PRESETS.standard;
  const job = { id: String(++jobSeq), done: 0, total: 0, status: 'queued', listeners: new Set(), result: null, error: null };
  jobs.set(job.id, job);
  const emit = (event, data) => job.listeners.forEach((l) => l(event, data));
  review
    .runReview(engines.review, {
      pgn,
      id,
      username,
      ...preset,
      onProgress: (done, total) => {
        job.status = 'running';
        job.done = done;
        job.total = total;
        emit('progress', { done, total });
      },
    })
    .then(async (r) => {
      job.status = 'mining';
      emit('progress', { done: job.total, total: job.total, stage: 'Creating puzzles from your mistakes' });
      let mined = [];
      try {
        mined = await puzzles.mineFromReview(engines.review, r, preset);
      } catch (e) {
        console.error('Puzzle mining failed:', e.message);
      }
      job.status = 'done';
      job.result = { ...publicReview(r), newPuzzles: mined.length };
      emit('done', job.result);
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e.message;
      emit('error', { error: e.message });
    })
    .finally(() => setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000));
  return job;
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/status', (req, res) => {
  send(res, 200, { stockfish: Engine.available(), ai: coach.aiConfigured(), aiModel: coach.MODEL });
});

route('GET', '/api/player/:user', async (req, res, { user }) => {
  const u = validUser(user);
  const [profile, stats] = await Promise.all([chesscom.profile(u), chesscom.stats(u)]);
  send(res, 200, { profile, stats, puzzles: puzzles.summary(u) });
});

// Chess.com serves avatars with a same-origin resource policy, so the browser cannot embed
// them directly. Proxy them, restricted to Chess.com's image host.
const avatarCache = new Map();
route('GET', '/api/avatar', async (req, res, _p, q) => {
  const url = q.get('url') || '';
  if (!/^https:\/\/images\.chesscomfiles\.com\/[\w./-]+$/.test(url)) throw Object.assign(new Error('Unsupported avatar URL'), { status: 400 });
  let hit = avatarCache.get(url);
  if (!hit) {
    const r = await fetch(url);
    if (!r.ok) throw Object.assign(new Error('Avatar not available'), { status: 404 });
    hit = { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
    if (avatarCache.size > 200) avatarCache.clear();
    avatarCache.set(url, hit);
  }
  res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'max-age=86400' });
  res.end(hit.body);
});

route('GET', '/api/player/:user/archives', async (req, res, { user }) => {
  send(res, 200, { archives: await chesscom.archives(validUser(user)) });
});

route('GET', '/api/player/:user/games', async (req, res, { user }, q) => {
  const u = validUser(user);
  const list = await chesscom.archives(u);
  if (!list.length) return send(res, 200, { games: [], year: null, month: null, archives: [] });
  const year = +q.get('year') || list.at(-1).year;
  const month = +q.get('month') || list.at(-1).month;
  const games = await chesscom.month(u, year, month);
  send(res, 200, {
    year,
    month,
    archives: list.map((a) => ({ year: a.year, month: a.month })),
    games: games.map((g) => slimGame(g, u)).sort((a, b) => b.end - a.end),
  });
});

async function gamesFor(u, q) {
  const months = Math.max(1, Math.min(36, +q.get('months') || 6));
  return chesscom.recentGames(u, months);
}

route('GET', '/api/player/:user/insights', async (req, res, { user }, q) => {
  const u = validUser(user);
  const games = await gamesFor(u, q);
  send(res, 200, insights.compute(games, u, { tzOffsetMin: +q.get('tz') || 0 }));
});

route('GET', '/api/player/:user/repertoire', async (req, res, { user }, q) => {
  const u = validUser(user);
  const games = await gamesFor(u, q);
  send(res, 200, insights.repertoire(games, u, q.get('color') === 'black' ? 'black' : 'white', q.get('path') || ''));
});

route('POST', '/api/review', async (req, res) => {
  const body = await readBody(req);
  if (!body.pgn || typeof body.pgn !== 'string') throw Object.assign(new Error('Missing PGN'), { status: 400 });
  review.parseGame(body.pgn); // validate early for a clear error
  const mode = review.PRESETS[body.mode] ? body.mode : 'standard';
  const username = body.username ? validUser(body.username) : null;
  if (!body.force) {
    const cached = review.getCached(body.id, body.pgn, review.PRESETS[mode].depth);
    if (cached) return send(res, 200, { review: publicReview(cached) });
  }
  if (!Engine.available()) throw Object.assign(new Error('Stockfish is not installed. Run "npm run setup".'), { status: 503 });
  const job = startReviewJob({ pgn: body.pgn, id: body.id, username, mode });
  send(res, 202, { jobId: job.id });
});

route('GET', '/api/review/jobs/:id', (req, res, { id }) => {
  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: 'Review job not found' });
  const emit = sse(res);
  if (job.status === 'done') return emit('done', job.result), res.end();
  if (job.status === 'error') return emit('error', { error: job.error }), res.end();
  emit('progress', { done: job.done, total: job.total });
  const l = (event, data) => {
    emit(event, data);
    if (event === 'done' || event === 'error') res.end();
  };
  job.listeners.add(l);
  req.on('close', () => job.listeners.delete(l));
});

route('GET', '/api/reviews', (req, res, _p, q) => {
  const u = (q.get('user') || '').toLowerCase();
  const list = store
    .listJson('reviews')
    .filter((r) => !u || (r.username || '').toLowerCase() === u)
    .map((r) => addGameRatings(r))
    .map((r) => ({ gameRating: r.userColor ? r.summary[r.userColor].gameRating : null, key: r.key, id: r.id, headers: r.headers, userColor: r.userColor, createdAt: r.createdAt, accuracy: { w: r.summary.w.accuracy, b: r.summary.b.accuracy }, counts: r.userColor ? r.summary[r.userColor].counts : null }))
    .sort((a, b) => b.createdAt - a.createdAt);
  send(res, 200, { reviews: list });
});

route('GET', '/api/reviews/:key', (req, res, { key }) => {
  const r = store.readJson(['reviews', key + '.json']);
  if (!r) return send(res, 404, { error: 'Review not found' });
  review.upgradeReview(r);
  send(res, 200, { review: publicReview(addGameRatings(r)) });
});

// Live engine analysis for the analysis board, streamed as it deepens.
route('GET', '/api/engine/stream', async (req, res, _p, q) => {
  const fen = q.get('fen');
  if (!fen) throw Object.assign(new Error('Missing fen'), { status: 400 });
  const multipv = Math.max(1, Math.min(5, +q.get('multipv') || 3));
  const depth = Math.max(8, Math.min(30, +q.get('depth') || 22));
  const emit = sse(res);
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());
  let last = 0;
  try {
    const r = await engines.live.analyze(fen, {
      depth,
      multipv,
      maxTime: 20000,
      signal: ctrl.signal,
      onInfo: (lines) => {
        const now = Date.now();
        if (now - last < 150) return;
        last = now;
        emit('info', { lines });
      },
    });
    if (!ctrl.signal.aborted) emit('done', r);
  } catch (e) {
    emit('error', { error: e.message });
  }
  res.end();
});

route('POST', '/api/engine/play', async (req, res) => {
  const { fen, elo } = await readBody(req);
  if (!fen) throw Object.assign(new Error('Missing fen'), { status: 400 });
  const uci = await engines.play.playMove(fen, Math.max(400, Math.min(3190, +elo || 1500)));
  send(res, 200, { uci });
});

route('GET', '/api/puzzles/next', async (req, res, _p, q) => {
  const source = q.get('source') || 'mine';
  const user = q.get('user') ? validUser(q.get('user')) : null;
  if (source === 'mine') {
    if (!user) throw Object.assign(new Error('Link your account to get puzzles from your games.'), { status: 400 });
    return send(res, 200, puzzles.nextMine(user));
  }
  if (source === 'lichess') return send(res, 200, { puzzle: await puzzles.nextLichess(user, q.get('theme')) });
  if (source === 'daily') return send(res, 200, { puzzle: await puzzles.nextDaily() });
  if (source === 'random') return send(res, 200, { puzzle: await puzzles.nextRandom() });
  throw Object.assign(new Error('Unknown puzzle source'), { status: 400 });
});

route('POST', '/api/puzzles/result', async (req, res) => {
  const body = await readBody(req);
  const user = validUser(body.user || 'guest');
  send(res, 200, puzzles.recordResult(user, body));
});

route('POST', '/api/puzzles/check', async (req, res) => {
  const body = await readBody(req);
  send(res, 200, await puzzles.checkAlternative(engines.play, body));
});

route('GET', '/api/puzzles/summary', (req, res, _p, q) => {
  send(res, 200, puzzles.summary(validUser(q.get('user') || 'guest')));
});

route('GET', '/api/coach/plan', async (req, res, _p, q) => {
  const u = validUser(q.get('user'));
  const games = await gamesFor(u, q);
  const ins = insights.compute(games, u, { tzOffsetMin: +q.get('tz') || 0 });
  send(res, 200, { plan: coach.trainingPlan(ins, puzzles.summary(u)), ai: coach.aiConfigured() });
});

route('POST', '/api/coach/chat', async (req, res) => {
  const body = await readBody(req);
  const question = String(body.question || '').slice(0, 4000);
  if (!question) throw Object.assign(new Error('Ask a question first.'), { status: 400 });
  const r = body.reviewKey ? store.readJson(['reviews', body.reviewKey + '.json']) : null;
  let ins = null;
  if (body.user && body.includeStats) {
    const u = validUser(body.user);
    ins = insights.compute(await chesscom.recentGames(u, 6), u);
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  try {
    await coach.chat({ question, history: body.history, review: r, ply: body.ply, insights: ins }, (t) => res.write(t));
  } catch (e) {
    const msg = e.status ? e.message : `The AI coach could not be reached: ${e.message}. Set ANTHROPIC_API_KEY and restart the server.`;
    res.write(`\n[coach error] ${msg}`);
  }
  res.end();
});

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (p.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (m) return await r.handler(req, res, m.groups || {}, url.searchParams);
      }
      return send(res, 404, { error: 'Unknown API route' });
    }
    if (p === '/vendor/chess.js') return serveStatic(res, CHESSJS);
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
    serveStatic(res, file);
  } catch (e) {
    if (!res.headersSent) fail(res, e);
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start on another port, for example: PORT=3800 npm start`);
    process.exit(1);
  }
  throw e;
});

// Re-judge saved reviews with the current rules (no engine needed).
function upgradeSavedReviews() {
  let n = 0;
  for (const r of store.listJson('reviews')) {
    try {
      if (review.upgradeReview(r)) n++;
    } catch (e) {
      console.error(`Could not upgrade review ${r.key}: ${e.message}`);
    }
  }
  if (n) console.log(`Updated ${n} saved review(s) to the latest scoring.`);
}

server.listen(PORT, HOST, () => {
  upgradeSavedReviews();
  console.log(`Chess AI Tutor running at http://${HOST}:${PORT}`);
  if (!Engine.available()) console.log('Warning: Stockfish not found. Run "npm run setup" first.');
  if (!coach.aiConfigured()) console.log('AI coach chat is off (no ANTHROPIC_API_KEY). Everything else works without it.');
});

function shutdown() {
  Object.values(engines).forEach((e) => e.quit());
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
