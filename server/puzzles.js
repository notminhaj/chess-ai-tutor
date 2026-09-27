// Puzzles: mined from your own reviewed games, plus public puzzles from Lichess and Chess.com.
const { Chess } = require('chess.js');
const A = require('./analysis');
const store = require('./store');
const chesscom = require('./chesscom');

const DAY = 24 * 3600 * 1000;
const INTERVALS = [1, 3, 7, 21, 60]; // spaced-repetition boxes, in days

function stateFor(user) {
  const s = store.readJson(['puzzles', `${user}.json`]) || {};
  s.puzzles = s.puzzles || {};
  s.progress = s.progress || {};
  s.rating = s.rating || { value: 1500, games: 0, history: [] };
  s.streak = s.streak || { current: 0, best: 0 };
  return s;
}

function saveState(user, s) {
  store.writeJson(['puzzles', `${user}.json`], s);
}

// ---------- mining puzzles from a finished review ----------

async function mineFromReview(engine, review, { depth = 16, maxTime = 1500 } = {}) {
  const user = review.username;
  const color = review.userColor;
  if (!user || !color || !review._full) return [];
  const s = stateFor(user);
  const found = [];
  for (const m of review._full) {
    if (m.color !== color) continue;
    if (!['mistake', 'blunder', 'miss'].includes(m.class)) continue;
    // A good puzzle has one clearly best move that leaves you better off.
    if (!m.bestUci || m.winBefore < 55) continue;
    if (m.secondWin !== null && m.winBefore - m.secondWin < 15) continue;
    const id = `${review.key}_${m.ply}`;
    if (s.puzzles[id]) continue;

    const solution = [m.bestUci];
    let fen = A.applyUci(m.fenBefore, m.bestUci).fen;
    // Extend to a multi-move puzzle while each of our follow-ups stays the only good move.
    for (let step = 0; step < 2; step++) {
      const c = new Chess(fen);
      if (c.isGameOver()) break;
      const replyAn = await engine.analyze(fen, { depth: Math.min(depth, 14), multipv: 1, maxTime });
      if (!replyAn.bestmove) break;
      const afterReply = A.applyUci(fen, replyAn.bestmove).fen;
      if (new Chess(afterReply).isGameOver()) break;
      const an = await engine.analyze(afterReply, { depth: Math.min(depth, 14), multipv: 2, maxTime });
      if (!an.lines[0]) break;
      const pov = (w) => (color === 'w' ? w : 100 - w);
      const top = pov(A.winPct(an.lines[0].score));
      const second = an.lines[1] ? pov(A.winPct(an.lines[1].score)) : 0;
      const isMateLine = A.mateFor(an.lines[0].score, color) > 0;
      if (!(top - second >= 15 || (isMateLine && !(A.mateFor(an.lines[1] && an.lines[1].score, color) > 0)))) break;
      solution.push(replyAn.bestmove, an.bestmove);
      fen = A.applyUci(afterReply, an.bestmove).fen;
    }

    const themes = new Set(m.tags.filter((t) => ['fork', 'mate', 'wins-material', 'sacrifice'].includes(t)));
    const mate = A.mateFor(m.bestScore, color);
    if (mate && mate > 0) themes.add(`mate in ${mate}`);
    if (m.class === 'miss') themes.add('punish the mistake');
    themes.add(m.phase);
    const puzzle = {
      id,
      source: 'mine',
      fen: m.fenBefore,
      solution,
      solutionSan: A.uciToSan(m.fenBefore, solution),
      color,
      themes: [...themes],
      played: m.san,
      playedClass: m.class,
      explanation: m.explanation,
      game: {
        reviewKey: review.key,
        ply: m.ply,
        white: review.headers.White,
        black: review.headers.Black,
        date: review.headers.Date,
        link: review.headers.Link,
      },
      createdAt: Date.now(),
    };
    s.puzzles[id] = puzzle;
    s.progress[id] = { attempts: 0, solved: 0, box: -1, due: Date.now() };
    found.push(puzzle);
  }
  if (found.length) saveState(user, s);
  return found;
}

// ---------- serving puzzles ----------

function nextMine(user) {
  const s = stateFor(user);
  const now = Date.now();
  const all = Object.values(s.puzzles);
  const due = all
    .filter((p) => (s.progress[p.id]?.due ?? 0) <= now)
    .sort((a, b) => (s.progress[a.id]?.due ?? 0) - (s.progress[b.id]?.due ?? 0));
  const p = due[0] || null;
  return {
    puzzle: p,
    total: all.length,
    due: due.length,
    nextDue: due.length ? null : Math.min(...all.map((x) => s.progress[x.id]?.due ?? Infinity)),
  };
}

function difficultyFor(rating) {
  if (rating < 1150) return 'easiest';
  if (rating < 1400) return 'easier';
  if (rating < 1650) return 'normal';
  if (rating < 1900) return 'harder';
  return 'hardest';
}

// Lichess puzzle API (public, no account needed): https://lichess.org/api#tag/Puzzles
async function nextLichess(user, theme) {
  const s = stateFor(user || 'guest');
  const params = new URLSearchParams({ difficulty: difficultyFor(s.rating.value) });
  if (theme) params.set('angle', theme);
  const res = await fetch(`https://lichess.org/api/puzzle/next?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'chess-ai-tutor/1.0 (personal local study tool)' },
  });
  if (!res.ok) throw Object.assign(new Error(`Lichess puzzle API returned ${res.status}`), { status: 502 });
  const j = await res.json();
  const c = new Chess();
  c.loadPgn(j.game.pgn);
  const hist = c.history({ verbose: true });
  const last = hist[hist.length - 1];
  return {
    id: `lichess_${j.puzzle.id}`,
    source: 'lichess',
    fen: c.fen(),
    lastMove: last ? last.from + last.to : null,
    solution: j.puzzle.solution,
    solutionSan: A.uciToSan(c.fen(), j.puzzle.solution),
    color: c.turn(),
    rating: j.puzzle.rating,
    themes: j.puzzle.themes,
    link: `https://lichess.org/training/${j.puzzle.id}`,
  };
}

// Chess.com public daily puzzle (PubAPI). The PGN holds the full solution from the FEN.
function fromChessComPuzzle(p, source) {
  const c = new Chess();
  c.loadPgn(p.pgn.replace(/\r/g, ''));
  const hist = c.history({ verbose: true });
  const fen = hist.length ? hist[0].before : p.fen;
  return {
    id: `chesscom_${source}_${p.publish_time}`,
    source,
    title: p.title,
    fen,
    solution: hist.map((m) => m.from + m.to + (m.promotion || '')),
    solutionSan: hist.map((m) => m.san),
    color: new Chess(fen).turn(),
    themes: [],
    link: p.url,
  };
}

async function nextDaily() {
  return fromChessComPuzzle(await chesscom.dailyPuzzle(), 'daily');
}

async function nextRandom() {
  return fromChessComPuzzle(await chesscom.randomPuzzle(), 'random');
}

// ---------- results, rating and spaced repetition ----------

function recordResult(user, { id, source, solved, puzzleRating, themes }) {
  const s = stateFor(user);
  const now = Date.now();
  if (source === 'mine' && s.puzzles[id]) {
    const pr = s.progress[id] || { attempts: 0, solved: 0, box: -1 };
    pr.attempts++;
    if (solved) {
      pr.solved++;
      pr.box = Math.min(INTERVALS.length - 1, pr.box + 1);
    } else {
      pr.box = -1;
    }
    pr.due = now + (pr.box < 0 ? 0.5 * DAY : INTERVALS[pr.box] * DAY);
    pr.last = now;
    s.progress[id] = pr;
  }
  let delta = 0;
  if (source === 'lichess' && puzzleRating) {
    // Plain Elo with a larger K for the first games, so a new rating settles quickly.
    const r = s.rating.value;
    const expected = 1 / (1 + 10 ** ((puzzleRating - r) / 400));
    const k = s.rating.games < 20 ? 48 : 24;
    delta = Math.round(k * ((solved ? 1 : 0) - expected));
    s.rating.value = r + delta;
    s.rating.games++;
    s.rating.history.push({ t: now, r: s.rating.value });
    if (s.rating.history.length > 1000) s.rating.history.shift();
  }
  s.streak.current = solved ? s.streak.current + 1 : 0;
  s.streak.best = Math.max(s.streak.best, s.streak.current);
  s.themeStats = s.themeStats || {};
  for (const t of themes || []) {
    const ts = (s.themeStats[t] = s.themeStats[t] || { tried: 0, solved: 0 });
    ts.tried++;
    if (solved) ts.solved++;
  }
  s.log = s.log || [];
  s.log.push({ t: now, id, source, solved });
  if (s.log.length > 2000) s.log.shift();
  saveState(user, s);
  return { rating: s.rating.value, delta, streak: s.streak };
}

function summary(user) {
  const s = stateFor(user);
  const mine = Object.values(s.puzzles);
  const now = Date.now();
  const today = (s.log || []).filter((l) => now - l.t < DAY);
  return {
    rating: s.rating,
    streak: s.streak,
    mine: {
      total: mine.length,
      due: mine.filter((p) => (s.progress[p.id]?.due ?? 0) <= now).length,
      mastered: mine.filter((p) => (s.progress[p.id]?.box ?? -1) >= 2).length,
    },
    today: { tried: today.length, solved: today.filter((l) => l.solved).length },
    themeStats: s.themeStats || {},
  };
}

// Accept a different move if the engine rates it as good as the intended solution.
async function checkAlternative(engine, { fen, uci, expected }) {
  const c = new Chess(fen);
  let after;
  try {
    c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
    after = c.fen();
  } catch {
    return { ok: false, reason: 'illegal' };
  }
  if (c.isCheckmate()) return { ok: true, reason: 'mate' };
  const color = new Chess(fen).turn();
  const pov = (w) => (color === 'w' ? w : 100 - w);
  const mine = await engine.analyze(after, { depth: 14, maxTime: 1500 });
  const best = await engine.analyze(A.applyUci(fen, expected).fen, { depth: 14, maxTime: 1500 });
  const wMine = pov(A.winPct(mine.lines[0] && mine.lines[0].score));
  const wBest = pov(A.winPct(best.lines[0] && best.lines[0].score));
  return { ok: wMine >= wBest - 3 && wMine >= 60, mine: wMine, best: wBest };
}

module.exports = { mineFromReview, nextMine, nextLichess, nextDaily, nextRandom, recordResult, summary, checkAlternative, stateFor };
