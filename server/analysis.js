// Pure chess-analysis helpers: win%, accuracy, move classification and rule-based explanations.
// Formulas follow Lichess's published open-source method (lila: WinPercent.scala, AccuracyPercent.scala).
const { Chess } = require('chess.js');

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

// ---------- evaluation math ----------

// Centipawns from White's view, with mate collapsed to a ceiling. Used for win% only.
function scoreToCp(score) {
  if (!score) return 0;
  if (score.mate !== undefined) {
    if (score.mate === 0) return score.winner === 'b' ? -1000 : 1000;
    return score.mate > 0 ? 1000 : -1000;
  }
  return Math.max(-1000, Math.min(1000, score.cp));
}

// Lichess win% (0..100) for White from a centipawn score.
function winPct(score) {
  const cp = scoreToCp(score);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

// Lichess per-move accuracy from win% before and after the move, both from the mover's view.
function moveAccuracy(before, after) {
  if (after >= before) return 100;
  const a = 103.1668 * Math.exp(-0.04354 * (before - after)) - 3.1669 + 1;
  return Math.max(0, Math.min(100, a));
}

function stdDev(xs) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
}

// Lichess game accuracy: mean of a volatility-weighted mean and a harmonic mean of move accuracies.
function gameAccuracy(whiteWins, moves) {
  const n = moves.length;
  if (!n) return { w: null, b: null };
  const ws = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const windows = [];
  for (let i = 0; i < ws - 2; i++) windows.push(whiteWins.slice(0, ws));
  for (let i = 0; i + ws <= whiteWins.length; i++) windows.push(whiteWins.slice(i, i + ws));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, stdDev(w))));
  const out = {};
  for (const color of ['w', 'b']) {
    let wsum = 0;
    let wtot = 0;
    let hsum = 0;
    let cnt = 0;
    moves.forEach((m, i) => {
      if (m.color !== color) return;
      const w = weights[i] ?? 1;
      wsum += m.accuracy * w;
      wtot += w;
      hsum += 1 / Math.max(m.accuracy, 1);
      cnt++;
    });
    out[color] = cnt ? (wsum / wtot + cnt / hsum) / 2 : null;
  }
  return out;
}

// ---------- board helpers ----------

function boardOf(fen) {
  const c = new Chess(fen);
  return c.board(); // [rank8..rank1][a..h]
}

function sq(file, rank) {
  return 'abcdefgh'[file] + (rank + 1);
}

function coords(square) {
  return { f: square.charCodeAt(0) - 97, r: +square[1] - 1 };
}

function pieceAt(board, square) {
  const { f, r } = coords(square);
  return board[7 - r][f];
}

// Squares a piece on `square` attacks (pseudo-legal, ignoring pins).
function attacksFrom(board, square) {
  const p = pieceAt(board, square);
  if (!p) return [];
  const { f, r } = coords(square);
  const out = [];
  const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
  const ray = (dx, dy) => {
    let x = f + dx;
    let y = r + dy;
    while (inside(x, y)) {
      out.push(sq(x, y));
      if (board[7 - y][x]) break;
      x += dx;
      y += dy;
    }
  };
  const step = (list) => list.forEach(([dx, dy]) => inside(f + dx, r + dy) && out.push(sq(f + dx, r + dy)));
  switch (p.type) {
    case 'p': {
      const dir = p.color === 'w' ? 1 : -1;
      step([[-1, dir], [1, dir]]);
      break;
    }
    case 'n':
      step([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
      break;
    case 'k':
      step([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
      break;
    case 'b':
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b]) => ray(a, b));
      break;
    case 'r':
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => ray(a, b));
      break;
    case 'q':
      [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([a, b]) => ray(a, b));
      break;
  }
  return out;
}

function attackersOf(board, square, color) {
  const res = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const p = board[7 - y][x];
      if (p && p.color === color && attacksFrom(board, sq(x, y)).includes(square)) res.push({ square: sq(x, y), type: p.type });
    }
  }
  return res;
}

function material(fen) {
  const b = boardOf(fen);
  const m = { w: 0, b: 0 };
  for (const row of b) for (const p of row) if (p) m[p.color] += VALUE[p.type];
  return m;
}

function pieceCount(fen) {
  // Non-pawn, non-king pieces on the board: used to detect the endgame.
  let n = 0;
  for (const row of boardOf(fen)) for (const p of row) if (p && p.type !== 'p' && p.type !== 'k') n++;
  return n;
}

function phaseOf(fen, ply) {
  if (pieceCount(fen) <= 6) return 'endgame';
  if (ply < 20) return 'opening';
  return 'middlegame';
}

// Convert a UCI line to SAN from a position. Stops at the first illegal move.
function uciToSan(fen, uciMoves, max = 99) {
  const c = new Chess(fen);
  const out = [];
  for (const u of uciMoves.slice(0, max)) {
    try {
      const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(mv.san);
    } catch {
      break;
    }
  }
  return out;
}

function applyUci(fen, u) {
  const c = new Chess(fen);
  const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return { fen: c.fen(), move: mv, chess: c };
}

// Material change for `color` after playing up to `plies` moves of a line.
function materialSwing(fen, line, color, plies = 6) {
  const opp = color === 'w' ? 'b' : 'w';
  const start = material(fen);
  let cur = fen;
  const c = new Chess(fen);
  for (const u of line.slice(0, plies)) {
    try {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch {
      break;
    }
    cur = c.fen();
  }
  const end = material(cur);
  return end[color] - end[opp] - (start[color] - start[opp]);
}

function materialWord(n) {
  const a = Math.abs(n);
  if (a >= 8) return "about a queen's worth of material";
  if (a >= 5) return "about a rook's worth of material";
  if (a >= 3) return 'a piece';
  if (a === 2) return 'two pawns';
  if (a === 1) return 'a pawn';
  return 'material';
}

// Pieces of `color` that are attacked and either undefended or attacked by something cheaper.
function enPrise(fen, color) {
  const b = boardOf(fen);
  const opp = color === 'w' ? 'b' : 'w';
  const res = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const p = b[7 - y][x];
      if (!p || p.color !== color || p.type === 'k' || p.type === 'p') continue;
      const s = sq(x, y);
      const atk = attackersOf(b, s, opp);
      if (!atk.length) continue;
      const def = attackersOf(b, s, color);
      const cheaper = atk.some((a) => VALUE[a.type] < VALUE[p.type]);
      if (cheaper || !def.length) res.push({ square: s, type: p.type });
    }
  }
  return res;
}

// Enemy pieces (or the king) that the piece on `square` attacks after a move: fork detection.
function forkTargets(fen, square) {
  const b = boardOf(fen);
  const me = pieceAt(b, square);
  if (!me) return [];
  const opp = me.color === 'w' ? 'b' : 'w';
  return attacksFrom(b, square)
    .map((s) => ({ s, p: pieceAt(b, s) }))
    .filter(({ s, p }) => {
      if (!p || p.color !== opp) return false;
      if (p.type === 'k') return true;
      if (VALUE[p.type] > VALUE[me.type]) return true;
      return !attackersOf(b, s, opp).length && VALUE[p.type] >= 3;
    })
    .map(({ s, p }) => ({ square: s, type: p.type }));
}

// ---------- sacrifice detection (static exchange evaluation over legal moves) ----------

const SEE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

// Material the side to move wins by capturing on `square`, playing out the exchange with the
// cheapest legal attacker each time. Legal moves only, so pins and checks are respected.
function see(chess, square) {
  const target = chess.get(square);
  if (!target) return 0;
  const caps = chess.moves({ verbose: true }).filter((m) => m.to === square && m.captured && !m.flags.includes('e'));
  if (!caps.length) return 0;
  caps.sort((a, b) => SEE_VALUE[a.piece] - SEE_VALUE[b.piece]);
  chess.move(caps[0]);
  const gain = SEE_VALUE[target.type] - see(chess, square);
  chess.undo();
  return Math.max(0, gain);
}

// Most material the side to move can win by capturing one of `color`'s pieces (knight or better).
function maxThreat(chess, color) {
  let best = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== color || p.type === 'p' || p.type === 'k') continue;
      best = Math.max(best, see(chess, p.square));
    }
  }
  return best;
}

// Same position with the other side to move, as if the mover passed.
function withTurnFlipped(fen) {
  const f = fen.split(' ');
  f[1] = f[1] === 'w' ? 'b' : 'w';
  f[3] = '-';
  try {
    return new Chess(f.join(' '));
  } catch {
    return null;
  }
}

// How much material a move puts at risk beyond what was already at risk, net of what it captured.
// A queen taking a safe pawn scores 0; a bishop that was about to be taken grabbing a pawn with
// check scores below 0; a piece left en prise to set up a tactic scores its value.
function sacrificeAmount(fenBefore, fenAfter, move) {
  const after = new Chess(fenAfter);
  if (after.isGameOver()) return 0;
  const offered = maxThreat(after, move.color);
  if (!offered) return 0;
  const flipped = withTurnFlipped(fenBefore);
  const alreadyAtRisk = flipped ? maxThreat(flipped, move.color) : 0;
  const gained = move.captured ? SEE_VALUE[move.captured] : 0;
  return offered - gained - alreadyAtRisk;
}

function isSacrifice(fenBefore, fenAfter, move) {
  return sacrificeAmount(fenBefore, fenAfter, move) >= 2;
}

function fmtScore(score, povColor = 'w') {
  if (!score) return '?';
  if (score.mate !== undefined) {
    if (score.mate === 0) return score.winner === povColor ? 'mate' : 'mated';
    const m = povColor === 'w' ? score.mate : -score.mate;
    return (m > 0 ? '' : '-') + 'M' + Math.abs(m);
  }
  const cp = povColor === 'w' ? score.cp : -score.cp;
  return (cp > 0 ? '+' : '') + (cp / 100).toFixed(2);
}

function mateFor(score, color) {
  // Positive N when `color` mates in N, negative when `color` gets mated, null otherwise.
  if (!score || score.mate === undefined || score.mate === 0) return null;
  return color === 'w' ? score.mate : -score.mate;
}

// ---------- classification ----------

const CLASSES = {
  brilliant: { symbol: '!!', label: 'Brilliant' },
  great: { symbol: '!', label: 'Great' },
  best: { symbol: '★', label: 'Best' },
  excellent: { symbol: '✓', label: 'Excellent' },
  good: { symbol: '·', label: 'Good' },
  book: { symbol: '📖', label: 'Book' },
  forced: { symbol: '□', label: 'Forced' },
  inaccuracy: { symbol: '?!', label: 'Inaccuracy' },
  mistake: { symbol: '?', label: 'Mistake' },
  miss: { symbol: '✗', label: 'Miss' },
  blunder: { symbol: '??', label: 'Blunder' },
};

function classify(m, prev) {
  if (m.legalCount === 1) return 'forced';
  const loss = m.loss;
  let cls;
  if (m.isBest) cls = 'best';
  else if (loss < 2) cls = 'excellent';
  else if (loss < 5) cls = 'good';
  else if (loss < 10) cls = 'inaccuracy';
  else if (loss < 20) cls = 'mistake';
  else cls = 'blunder';

  // Miss: the opponent just erred and this move let the advantage go.
  if ((cls === 'mistake' || cls === 'blunder') && prev && ['mistake', 'blunder', 'miss'].includes(prev.class) && m.winBefore >= 60) {
    cls = 'miss';
  }
  // Brilliant: a sound sacrifice (best or nearly best) that keeps you at least equal, played when
  // you were not already completely winning.
  if ((cls === 'best' || cls === 'excellent') && m.sacrifice && m.winAfter >= 50 && m.winBefore < 90) {
    return 'brilliant';
  }
  // Great: the only good move, when the next-best alternative is far worse.
  if (cls === 'best' && m.secondWin !== null && m.winBefore - m.secondWin >= 20 && m.winBefore > 25 && !m.recapture) {
    return 'great';
  }
  return cls;
}

// ---------- explanations ----------

function explain(m) {
  const color = m.color;
  const parts = [];
  const tags = [];
  const bestSan = m.bestSan;
  const mateBefore = mateFor(m.bestScore, color);
  const mateAfter = mateFor(m.evalAfter, color);

  if (m.class === 'forced') return { text: 'The only legal move.', tags };
  if (m.class === 'book') return { text: 'A standard opening move.', tags };

  if (m.isBest || m.class === 'brilliant' || m.class === 'great') {
    if (m.isMate) return { text: 'Checkmate. Well done.', tags: ['mate'] };
    const facts = describeMove(m.fenBefore, m.uci, color);
    const what = facts.phrase ? ' It ' + facts.phrase + '.' : '';
    if (m.class === 'brilliant') {
      parts.push('A strong sacrifice.' + what + ' The engine confirms that giving up material here works.');
      tags.push('sacrifice');
    } else if (m.class === 'great') {
      parts.push('The only good move here.' + what);
      if (m.secondSan) parts.push('The next best try, ' + m.secondSan + ', was much worse (' + fmtScore(m.secondScore, color) + ').');
    } else {
      parts.push('The best move.' + what);
    }
    if (mateBefore && mateBefore > 0) parts.push('It keeps a forced mate in ' + mateBefore + '.');
    return { text: parts.join(' '), tags: tags.concat(facts.tags) };
  }

  // The played move was not the engine's top choice.
  const facts = describeMove(m.fenBefore, m.bestUci, color);
  if (mateBefore && mateBefore > 0 && !(mateAfter && mateAfter > 0)) {
    parts.push('There was a forced mate in ' + mateBefore + ': ' + m.bestLineSan.slice(0, mateBefore * 2 - 1).join(' ') + '.');
    tags.push('missed-mate');
  } else if (mateAfter && mateAfter < 0 && !(mateBefore && mateBefore < 0)) {
    const n = Math.abs(mateAfter);
    parts.push('This allows a forced mate in ' + n + ': ' + m.replyLineSan.slice(0, Math.min(7, n * 2 - 1)).join(' ') + '.');
    tags.push('allows-mate');
  } else {
    // Compare material after the played line with material after the best line.
    const played = materialSwing(m.fenBefore, [m.uci, ...m.replyLine], color, 7);
    const best = materialSwing(m.fenBefore, m.bestLine, color, 7);
    const diff = played - best;
    let saidWhy = false;
    if (m.loss >= 5 && diff <= -2 && m.replyLineSan.length) {
      saidWhy = true;
      const reply = applyUci(m.fenAfter, m.replyLine[0]);
      const forks = forkTargets(reply.fen, reply.move.to);
      if (!reply.move.captured && forks.length >= 2) {
        parts.push('It allows ' + m.replyLineSan[0] + ', forking the ' + forks.map((x) => NAME[x.type]).join(' and ') + '. That loses ' + materialWord(diff) + '.');
        tags.push('allows-fork');
      } else {
        parts.push('It loses ' + materialWord(diff) + ' after ' + m.replyLineSan.slice(0, 4).join(' ') + '.');
        tags.push('hangs-material');
      }
    }
    if (!saidWhy && m.loss >= 5 && m.replyLineSan.length) {
      parts.push('The opponent can answer with ' + m.replyLineSan[0] + ' (' + m.replyLineSan.slice(0, 5).join(' ') + ').');
    }
    if (facts.phrase) parts.push('Better was ' + bestSan + ', which ' + facts.phrase + '.');
    else if (saidWhy) parts.push('Better was ' + bestSan + '.');
    else parts.push('Better was ' + bestSan + ' (' + m.bestLineSan.slice(0, 5).join(' ') + ').');
    tags.push(...facts.tags);
  }

  parts.push('Evaluation for ' + (color === 'w' ? 'White' : 'Black') + ': ' + fmtScore(m.bestScore, color) + ' before, ' + fmtScore(m.evalAfter, color) + ' after.');
  if (m.phase === 'opening' && m.class === 'inaccuracy') parts.push('In the opening, prioritize developing pieces, castling, and controlling the center.');
  return { text: parts.join(' '), tags: [...new Set(tags)] };
}

// Plain-English facts about one move, phrased to follow "It ..." or "which ...".
function describeMove(fen, uci, color) {
  if (!uci) return { phrase: '', tags: [] };
  let res;
  try {
    res = applyUci(fen, uci);
  } catch {
    return { phrase: '', tags: [] };
  }
  const { move, chess } = res;
  const bits = [];
  const tags = [];
  if (chess.isCheckmate()) return { phrase: 'is checkmate', tags: ['mate'] };
  if (move.captured) bits.push('captures the ' + NAME[move.captured] + ' on ' + move.to);
  if (move.promotion) bits.push('promotes to a ' + NAME[move.promotion]);
  const forks = forkTargets(res.fen, move.to);
  if (forks.length >= 2) {
    bits.push('forks the ' + forks.map((x) => NAME[x.type]).join(' and '));
    tags.push('fork');
  } else if (chess.inCheck()) {
    bits.push('gives check');
  }
  if (move.flags.includes('k') || move.flags.includes('q')) bits.push('castles the king to safety');
  if (!bits.length && move.piece !== 'p' && move.piece !== 'k') {
    const b = boardOf(res.fen);
    const targets = attacksFrom(b, move.to).filter((s) => {
      const p = pieceAt(b, s);
      return p && p.color !== color && p.type !== 'p';
    });
    if (targets.length) bits.push('attacks the ' + targets.map((s) => NAME[pieceAt(b, s).type] + ' on ' + s).join(' and the '));
  }
  if (!bits.length && move.piece === 'p' && 'de'.includes(move.to[0]) && ['4', '5'].includes(move.to[1])) bits.push('claims space in the center');
  if (move.captured && VALUE[move.captured] >= 3) tags.push('wins-material');
  return { phrase: bits.join(', and '), tags };
}

// Maps Lichess-formula accuracy onto Chess.com's scale. Chess.com squeezes accuracy toward the
// middle: low scores come out higher and very high scores a little lower. Fitted with
// tools/calibration/accuracy.js + accfit.js on 84 player-games that Chess.com had reviewed:
// held-out mean error 4.5 points (5.8 with the plain Lichess number).
function scaleAccuracy(x) {
  if (x == null) return x;
  return Math.max(0, Math.min(100, 100 - 3.62 * Math.pow(Math.max(0, 100 - x), 0.6)));
}

module.exports = {
  scaleAccuracy,
  VALUE,
  NAME,
  CLASSES,
  winPct,
  moveAccuracy,
  gameAccuracy,
  classify,
  explain,
  describeMove,
  uciToSan,
  applyUci,
  materialSwing,
  isSacrifice,
  sacrificeAmount,
  see,
  enPrise,
  forkTargets,
  phaseOf,
  fmtScore,
  mateFor,
  material,
  scoreToCp,
};
