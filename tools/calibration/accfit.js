// Fits a mapping from this app's accuracy to Chess.com's published accuracy.
// Usage: node tools/calibration/accfit.js   (reads accuracy-pairs.jsonl)
const fs = require('fs');
const rows = fs.readFileSync(__dirname + '/accuracy-pairs.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// One sample per player-game.
const S = [];
for (const r of rows) {
  for (const c of ['w', 'b']) {
    const cc = r.cc[c === 'w' ? 'white' : 'black'];
    if (cc == null || r.ours[c] == null) continue;
    const losses = [];
    for (let i = 0; i < r.colors.length; i++) {
      if (r.colors[i] !== c) continue;
      const pov = (w) => (c === 'w' ? w : 100 - w);
      let loss = pov(r.wins[i]) - pov(r.wins[i + 1]);
      if (r.best[i] === '1') loss = Math.min(loss, 0);
      losses.push(Math.max(0, loss));
    }
    S.push({ uuid: r.uuid, cc, ours: r.ours[c], losses });
  }
}
console.log(`${S.length} player-games from ${rows.length} games`);
const mae = (pred) => S.reduce((a, s, i) => a + Math.abs(pred[i] - s.cc), 0) / S.length;
const bias = (pred) => S.reduce((a, s, i) => a + (pred[i] - s.cc), 0) / S.length;
console.log('current (Lichess formula): MAE', mae(S.map((s) => s.ours)).toFixed(2), 'bias', bias(S.map((s) => s.ours)).toFixed(2));

// Folds by game.
const games = [...new Set(S.map((s) => s.uuid))];
const fold = new Map(games.map((g, i) => [g, i % 5]));

// A) Game-level map on our accuracy: cc = 100 - a * (100 - ours)^p, fitted by grid search.
function mapA(x, a, p) {
  return Math.max(0, Math.min(100, 100 - a * Math.pow(Math.max(0, 100 - x), p)));
}
function fitA(train) {
  let best = null;
  for (let p = 0.3; p <= 1.3; p += 0.02) {
    for (let a = 0.2; a <= 12; a += 0.02) {
      const e = train.reduce((s, t) => s + Math.abs(mapA(t.ours, a, p) - t.cc), 0);
      if (!best || e < best.e) best = { a, p, e };
    }
  }
  return best;
}

// B) Per-move curve acc = 100 * exp(-k * loss^q), averaged (plain mean).
function gameB(losses, k, q) {
  if (!losses.length) return 100;
  return losses.reduce((s, l) => s + 100 * Math.exp(-k * Math.pow(l, q)), 0) / losses.length;
}
function fitB(train) {
  let best = null;
  for (let q = 0.5; q <= 1.5; q += 0.05) {
    for (let k = 0.005; k <= 0.3; k *= 1.05) {
      const e = train.reduce((s, t) => s + Math.abs(gameB(t.losses, k, q) - t.cc), 0);
      if (!best || e < best.e) best = { k, q, e };
    }
  }
  return best;
}

function cv(fit, apply) {
  const pred = new Array(S.length);
  for (let f = 0; f < 5; f++) {
    const train = S.filter((s) => fold.get(s.uuid) !== f);
    const m = fit(train);
    S.forEach((s, i) => {
      if (fold.get(s.uuid) === f) pred[i] = apply(s, m);
    });
  }
  return pred;
}

const pA = cv(fitA, (s, m) => mapA(s.ours, m.a, m.p));
// C) Straight line: cc = u + v * ours.
function fitC(train) {
  const n = train.length, mx = train.reduce((a, t) => a + t.ours, 0) / n, my = train.reduce((a, t) => a + t.cc, 0) / n;
  const v = train.reduce((a, t) => a + (t.ours - mx) * (t.cc - my), 0) / train.reduce((a, t) => a + (t.ours - mx) ** 2, 0);
  return { u: my - v * mx, v };
}
const pC = cv(fitC, (s, m) => Math.max(0, Math.min(100, m.u + m.v * s.ours)));
console.log('C) straight line:        held-out MAE', mae(pC).toFixed(2), 'bias', bias(pC).toFixed(2));
const pB = cv(fitB, (s, m) => gameB(s.losses, m.k, m.q));
console.log('A) map on game accuracy: held-out MAE', mae(pA).toFixed(2), 'bias', bias(pA).toFixed(2));
console.log('B) new per-move curve:   held-out MAE', mae(pB).toFixed(2), 'bias', bias(pB).toFixed(2));

const within = (pred, d) => S.filter((s, i) => Math.abs(pred[i] - s.cc) <= d).length / S.length;
for (const [n, p] of [['current', S.map((s) => s.ours)], ['A', pA], ['B', pB], ['C', pC]]) {
  console.log(`${n.padEnd(8)} within 3 points: ${(within(p, 3) * 100).toFixed(0)}%  within 5: ${(within(p, 5) * 100).toFixed(0)}%`);
}

const allA = fitA(S);
const allB = fitB(S);
const allC = fitC(S);
const model = { C: { u: +allC.u.toFixed(3), v: +allC.v.toFixed(4) }, maeC: +mae(pC).toFixed(2), A: { a: +allA.a.toFixed(3), p: +allA.p.toFixed(3) }, B: { k: +allB.k.toFixed(5), q: +allB.q.toFixed(3) }, maeA: +mae(pA).toFixed(2), maeB: +mae(pB).toFixed(2), maeCurrent: +mae(S.map((s) => s.ours)).toFixed(2), samples: S.length };
fs.writeFileSync(__dirname + '/accuracy-model.json', JSON.stringify(model, null, 1));
console.log('fitted on all data:', JSON.stringify(model));
