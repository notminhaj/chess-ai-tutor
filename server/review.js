// Full game review: engine-analyzes every position, then classifies and explains each move.
const { Chess } = require('chess.js');
const A = require('./analysis');
const store = require('./store');
const { openingFromPgn } = require('./insights');
const { addGameRatings } = require('./gamerating');

// Bump when classification or accuracy logic changes; saved reviews are upgraded on read.
const REVIEW_VERSION = 5;

// Review strength presets. The time cap keeps one sharp position from stalling a review.
const PRESETS = {
  fast: { depth: 12, maxTime: 500 },
  standard: { depth: 16, maxTime: 1500 },
  deep: { depth: 20, maxTime: 4000 },
};

function parseClock(comment) {
  const m = comment && comment.match(/\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

// Parse a PGN into positions and moves. Throws a friendly error on bad input.
function parseGame(pgn) {
  const c = new Chess();
  try {
    c.loadPgn(pgn);
  } catch (e) {
    throw Object.assign(new Error(`Could not read that PGN: ${e.message}`), { status: 400 });
  }
  const headers = c.getHeaders();
  const comments = new Map(c.getComments().map((x) => [x.fen, x.comment]));
  const history = c.history({ verbose: true });
  if (!history.length) throw Object.assign(new Error('That game has no moves to review.'), { status: 400 });
  const startFen = history[0].before;
  const moves = history.map((mv, i) => ({
    ply: i,
    san: mv.san,
    uci: mv.from + mv.to + (mv.promotion || ''),
    color: mv.color,
    piece: mv.piece,
    from: mv.from,
    to: mv.to,
    captured: mv.captured || null,
    fenBefore: mv.before,
    fenAfter: mv.after,
    clock: parseClock(comments.get(mv.after)),
  }));
  return { headers, startFen, moves };
}

function terminalScore(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { mate: 0, winner: c.turn() === 'w' ? 'b' : 'w' };
  if (c.isGameOver()) return { cp: 0 };
  return null;
}

function openingName(headers) {
  if (headers.Opening) return headers.Opening;
  if (!headers.ECOUrl) return headers.ECO || null;
  return openingFromPgn(`[ECOUrl "${headers.ECOUrl}"]`);
}

function reviewKey(id, pgn) {
  return 'r_' + (id ? store.safe(id) : store.hash(pgn));
}

function getCached(id, pgn, depth) {
  const r = store.readJson(['reviews', reviewKey(id, pgn) + '.json']);
  if (r) upgradeReview(r);
  if (r && r.version === REVIEW_VERSION && r.depth >= depth) return r;
  return null;
}

// Run the review. `onProgress(done, total)` is called after each analyzed position.
async function runReview(engine, { pgn, id, depth = 16, maxTime = 1500, username, onProgress, signal }) {
  const game = parseGame(pgn);
  const positions = [game.startFen, ...game.moves.map((m) => m.fenAfter)];
  const evals = [];
  for (let i = 0; i < positions.length; i++) {
    if (signal && signal.aborted) throw new Error('Review cancelled');
    const fen = positions[i];
    const term = terminalScore(fen);
    if (term) {
      evals.push({ score: term, lines: [], bestmove: null });
    } else {
      const r = await engine.analyze(fen, { depth, multipv: 2, maxTime });
      evals.push({ score: r.lines[0] ? r.lines[0].score : { cp: 0 }, lines: r.lines, bestmove: r.bestmove });
    }
    if (onProgress) onProgress(i + 1, positions.length);
  }

  const whiteWins = evals.map((e) => A.winPct(e.score));
  const moves = [];
  game.moves.forEach((mv, i) => {
    const before = evals[i];
    const after = evals[i + 1];
    const pov = (w) => (mv.color === 'w' ? w : 100 - w);
    const best = before.lines[0];
    const second = before.lines[1] || null;
    const isBest = !!before.bestmove && before.bestmove === mv.uci;
    const winBefore = pov(whiteWins[i]);
    let winAfter = pov(whiteWins[i + 1]);
    // The top move can score a hair lower after the next search. Do not penalize search noise.
    if (isBest) winAfter = Math.max(winAfter, winBefore);
    const legalCount = new Chess(mv.fenBefore).moves().length;
    const afterChess = new Chess(mv.fenAfter);
    const prevMove = moves[i - 1];
    const m = {
      ...mv,
      legalCount,
      isBest,
      isMate: afterChess.isCheckmate(),
      bestUci: before.bestmove,
      bestSan: before.bestmove ? A.uciToSan(mv.fenBefore, [before.bestmove])[0] : null,
      bestLine: best ? best.pv.slice(0, 12) : [],
      bestLineSan: best ? A.uciToSan(mv.fenBefore, best.pv, 12) : [],
      bestScore: before.score,
      secondSan: second ? A.uciToSan(mv.fenBefore, [second.pv[0]])[0] : null,
      secondScore: second ? second.score : null,
      secondWin: second ? pov(A.winPct(second.score)) : null,
      evalBefore: before.score,
      evalAfter: after.score,
      replyLine: after.lines[0] ? after.lines[0].pv.slice(0, 10) : [],
      replyLineSan: after.lines[0] ? A.uciToSan(mv.fenAfter, after.lines[0].pv, 10) : [],
      winBefore,
      winAfter,
      loss: Math.max(0, winBefore - winAfter),
      recapture: !!(prevMove && prevMove.captured && mv.captured && prevMove.to === mv.to),
      phase: A.phaseOf(mv.fenBefore, i),
    };
    moves.push(m);
  });

  const h = game.headers;
  const userColor = username
    ? (h.White || '').toLowerCase() === username.toLowerCase()
      ? 'w'
      : (h.Black || '').toLowerCase() === username.toLowerCase()
        ? 'b'
        : null
    : null;

  const review = {
    version: REVIEW_VERSION,
    key: reviewKey(id, pgn),
    id: id || null,
    depth,
    createdAt: Date.now(),
    username: username || null,
    userColor,
    headers: {
      White: h.White,
      Black: h.Black,
      WhiteElo: h.WhiteElo,
      BlackElo: h.BlackElo,
      Result: h.Result,
      Date: h.Date || h.UTCDate,
      TimeControl: h.TimeControl,
      Termination: h.Termination,
      Link: h.Link,
      ECO: h.ECO,
      Opening: openingName(h),
    },
    startFen: game.startFen,
    evals: evals.map((e) => e.score),
    whiteWins,
    moves,
    pgn,
  };
  finalize(review);
  addGameRatings(review);
  store.writeJson(['reviews', review.key + '.json'], review);
  // Puzzle mining reads the engine lines from here.
  review._full = review.moves;
  return review;
}

// Judge every move and build the summary from the engine data stored on each move.
// Shared by new reviews and by upgradeReview(), so saved reviews can be re-judged without the engine.
function finalize(review) {
  const moves = review.moves;
  moves.forEach((m, i) => {
    const prev = moves[i - 1];
    m.accuracy = A.moveAccuracy(m.winBefore, m.winAfter);
    m.sacrifice = A.isSacrifice(m.fenBefore, m.fenAfter, { color: m.color, captured: m.captured, piece: m.piece, to: m.to });
    m.class = A.classify(m, prev);
    const ex = A.explain(m);
    m.explanation = ex.text;
    m.tags = ex.tags;
  });
  const acc = A.gameAccuracy(review.whiteWins, moves);
  const summary = {};
  for (const color of ['w', 'b']) {
    const mine = moves.filter((m) => m.color === color);
    const counts = {};
    for (const k of Object.keys(A.CLASSES)) counts[k] = 0;
    mine.forEach((m) => counts[m.class]++);
    const phases = {};
    for (const ph of ['opening', 'middlegame', 'endgame']) {
      const pm = mine.filter((m) => m.phase === ph);
      phases[ph] = pm.length ? { accuracy: A.scaleAccuracy(pm.reduce((s2, m) => s2 + m.accuracy, 0) / pm.length), moves: pm.length, errors: pm.filter((m) => ['mistake', 'blunder', 'miss'].includes(m.class)).length } : null;
    }
    summary[color] = { accuracy: acc[color] == null ? null : A.scaleAccuracy(acc[color]), rawAccuracy: acc[color], counts, phases, avgLoss: mine.length ? mine.reduce((s2, m) => s2 + m.loss, 0) / mine.length : 0 };
  }
  review.summary = summary;
  review.keyMoments = moves.filter((m) => ['brilliant', 'great', 'mistake', 'blunder', 'miss'].includes(m.class)).map((m) => m.ply);
  review.version = REVIEW_VERSION;
  delete review.gameRatingVersion; // game rating depends on the summary, so recompute it
  return review;
}

// SAN line back to UCI, for reviews saved before engine lines were kept.
function sanToUci(fen, sans) {
  const c = new Chess(fen);
  const out = [];
  for (const san of sans || []) {
    try {
      const mv = c.move(san);
      out.push(mv.from + mv.to + (mv.promotion || ''));
    } catch {
      break;
    }
  }
  return out;
}

// Bring a saved review up to the current rules. Returns true when it changed.
function upgradeReview(review) {
  if (!review || !Array.isArray(review.moves) || review.version === REVIEW_VERSION) return false;
  for (const m of review.moves) {
    if (!m.bestLine) m.bestLine = sanToUci(m.fenBefore, m.bestLineSan);
    if (!m.replyLine) m.replyLine = sanToUci(m.fenAfter, m.replyLineSan);
  }
  finalize(review);
  addGameRatings(review);
  store.writeJson(['reviews', review.key + '.json'], review);
  return true;
}

module.exports = { PRESETS, runReview, finalize, upgradeReview, getCached, parseGame, reviewKey, openingName, parseClock, REVIEW_VERSION };
