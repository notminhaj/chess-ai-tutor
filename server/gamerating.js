// "Game rating": an estimate of the rating level each side played at in a single game.
//
// Chess.com's formula is private, so this is our own model, fitted by tools/calibration on
// 312 real rated Chess.com games (624 player-games) spread across ratings 400-2800, each
// reviewed by this app's engine pipeline at the "fast" preset.
//
// How it works:
// 1. A linear model scores each side from both sides' play (accuracy, centipawn loss,
//    error rates, share of best moves), the time control and the game length. Using the
//    opponent's play too accounts for how hard the game was.
// 2. The score is inverted through its calibration line (score = a + b * rating, measured on
//    held-out games) so estimates are not squeezed toward the average rating.
// 3. One game is a noisy signal (the raw estimate misses by ~940 points RMS), so when the
//    player's rating is known the result is anchored to it: shown = R + k * (estimate - R).
//    The number then moves up or down with how well they played relative to that level.

const MODEL = {
  version: 3,
  // Held-out error of the plain regression, for reference: mean absolute error in points.
  mae: 453,
  coef: [
    2389.923596, -9.839189, 9.179095, -482.309392, 449.348048, -914.13669, 292.306227, 30.023728, 1305.774426, -10.612122,
    11.571943, -510.082531, 602.939659, -777.129526, 234.946248, -23.827648, 1371.400807, -4.339867, -228.939005, 403.504069,
  ],
  inverse: { a: 990.1891, b: 0.380032 },
  // RMS error of the inverted single-game estimate on held-out games.
  sigma: 938,
};

// Design choice: how far one game is allowed to move the number away from the player's
// rating. k = TAU^2 / (TAU^2 + SIGMA^2) is about 0.26, so a typical game lands within a
// couple of hundred points of the rating and an exceptional one several hundred away.
const TAU = 550;
const K = (TAU * TAU) / (TAU * TAU + MODEL.sigma * MODEL.sigma);

const MIN_MOVES = 10;

function cpOf(s) {
  if (!s) return 0;
  if (s.mate !== undefined) return s.mate === 0 ? (s.winner === 'b' ? -1000 : 1000) : s.mate > 0 ? 1000 : -1000;
  return Math.max(-1000, Math.min(1000, s.cp));
}

// Chess.com's buckets use estimated duration = base + 40 * increment.
function timeClass(tc) {
  if (!tc || tc === '-' || tc === '?') return 'blitz';
  if (tc.includes('/')) return 'daily';
  const [base, inc = 0] = tc.split('+').map(Number);
  const est = base + 40 * inc;
  if (est < 180) return 'bullet';
  if (est < 600) return 'blitz';
  return 'rapid';
}

function sideFeatures(review, color) {
  const moves = review.moves.filter((m) => m.color === color);
  const n = moves.length;
  if (!n) return null;
  const pov = color === 'w' ? 1 : -1;
  let lossSum = 0;
  for (const m of moves) {
    if (m.isBest) continue;
    lossSum += Math.max(0, pov * (cpOf(review.evals[m.ply]) - cpOf(review.evals[m.ply + 1])));
  }
  const rate = (k) => moves.filter((m) => m.class === k).length / n;
  return {
    n,
    // The model was fitted on the unscaled (Lichess-formula) accuracy.
    acc: review.summary[color].rawAccuracy ?? review.summary[color].accuracy,
    acpl: lossSum / n,
    wl: moves.reduce((a, m) => a + m.loss, 0) / n,
    bestRate: rate('best'),
    blunder: rate('blunder') + rate('miss'),
    mistake: rate('mistake'),
    inacc: rate('inaccuracy'),
  };
}

// Must match the vector order in tools/calibration/fit.js exactly.
function vec(f) {
  return [f.acc, (f.acc * f.acc) / 100, Math.log(f.acpl + 5), Math.log(f.wl + 0.5), f.blunder, f.mistake, f.inacc, f.bestRate];
}

// Unanchored single-game estimate for one side.
function rawEstimate(me, opp, tc) {
  if (!me || !opp || me.n < MIN_MOVES || me.acc == null || opp.acc == null) return null;
  const x = [1, ...vec(me), ...vec(opp), tc === 'bullet' ? 1 : 0, tc === 'rapid' ? 1 : 0, Math.log(me.n)];
  const score = x.reduce((a, v, i) => a + v * MODEL.coef[i], 0);
  return (score - MODEL.inverse.a) / MODEL.inverse.b;
}

const round25 = (r) => Math.round(Math.max(100, Math.min(3300, r)) / 25) * 25;

// Adds summary.<color>.gameRating (and gameRatingRough when no rating was available to anchor to).
function addGameRatings(review) {
  if (!review || !review.summary || !review.moves) return review;
  if (review.gameRatingVersion === MODEL.version) return review;
  const h = review.headers || {};
  const tc = timeClass(h.TimeControl);
  const f = { w: sideFeatures(review, 'w'), b: sideFeatures(review, 'b') };
  for (const c of ['w', 'b']) {
    // Daily games were not in the calibration set, and days per move make accuracy far higher
    // than a player's rating suggests, so no estimate is given for them.
    const raw = tc === 'daily' ? null : rawEstimate(f[c], f[c === 'w' ? 'b' : 'w'], tc);
    const elo = parseInt(c === 'w' ? h.WhiteElo : h.BlackElo, 10);
    const s = review.summary[c];
    if (raw == null) {
      s.gameRating = null;
      s.gameRatingRough = false;
      s.gameRatingNote = tc === 'daily' ? 'Not estimated for daily games' : 'Too few moves to estimate';
    } else if (elo > 0) {
      s.gameRating = round25(elo + K * (raw - elo));
      s.gameRatingRough = false;
    } else {
      // Unanchored: keep it inside the 400-2800 range the model was calibrated on.
      s.gameRating = round25(Math.max(400, Math.min(2800, raw)));
      s.gameRatingRough = true;
    }
  }
  review.gameRatingVersion = MODEL.version;
  return review;
}

module.exports = { addGameRatings, sideFeatures, rawEstimate, timeClass, MODEL, K };
