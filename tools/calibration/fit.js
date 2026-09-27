// Fits the game-rating model shipped in server/gamerating.js. Usage: node tools/calibration/fit.js
const fs = require('fs');
const rows = fs.readFileSync(__dirname + '/samples-fast.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cpOf = (s) => (s.mate !== undefined ? (s.mate === 0 ? (s.winner === 'b' ? -1000 : 1000) : s.mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, s.cp)));
function side(r, c) {
  const mv = r.moves.map((m, i) => ({ ...m, i })).filter((m) => m.c === c);
  const n = mv.length;
  const pov = c === 'w' ? 1 : -1;
  const acpl = mv.reduce((a, m) => a + (m.best ? 0 : Math.max(0, pov * (cpOf(r.evals[m.i]) - cpOf(r.evals[m.i + 1])))), 0) / n;
  const cnt = (k) => mv.filter((m) => m.cls === k).length / n;
  return { n, acc: r.acc[c], lacpl: Math.log(acpl + 5), lwl: Math.log(mv.reduce((a, m) => a + m.loss, 0) / n + 0.5), bl: cnt('blunder') + cnt('miss'), mi: cnt('mistake'), in: cnt('inaccuracy'), best: cnt('best') };
}
const vec = (f) => [f.acc, (f.acc * f.acc) / 100, f.lacpl, f.lwl, f.bl, f.mi, f.in, f.best];
const data = [];
for (const r of rows) for (const c of ['w', 'b']) {
  const me = side(r, c), op = side(r, c === 'w' ? 'b' : 'w');
  if (me.n < 10 || me.acc == null || op.acc == null) continue;
  data.push({ me, op, tc: r.tc, n: me.n, y: c === 'w' ? r.wr : r.br, game: r.uuid });
}
function solve(A, y, ridge) {
  const k = A[0].length, M = Array.from({ length: k }, () => new Array(k).fill(0)), v = new Array(k).fill(0);
  for (let i = 0; i < A.length; i++) for (let a = 0; a < k; a++) { v[a] += A[i][a] * y[i]; for (let b = 0; b < k; b++) M[a][b] += A[i][a] * A[i][b]; }
  for (let a = 1; a < k; a++) M[a][a] += ridge * A.length;
  for (let i = 0; i < k; i++) { let p = i; for (let j = i + 1; j < k; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j; [M[i], M[p]] = [M[p], M[i]]; [v[i], v[p]] = [v[p], v[i]];
    for (let j = 0; j < k; j++) if (j !== i) { const f = M[j][i] / M[i][i]; for (let l = i; l < k; l++) M[j][l] -= f * M[i][l]; v[j] -= f * v[i]; } }
  return v.map((x, i) => x / M[i][i]);
}
const tcv = (d) => [d.tc === 'bullet' ? 1 : 0, d.tc === 'rapid' ? 1 : 0, Math.log(d.n)];
const MODELS = {
  mine: (d) => [1, ...vec(d.me), ...tcv(d)],
  'mine+opp': (d) => [1, ...vec(d.me), ...vec(d.op), ...tcv(d)],
};
// Split folds by game so both sides of a game land in the same fold.
const games = [...new Set(data.map((d) => d.game))];
const foldOf = new Map(games.map((g, i) => [g, i % 5]));
for (const [name, fx] of Object.entries(MODELS)) {
  for (const ridge of [1e-4, 1e-2]) {
    const P = [];
    for (let f = 0; f < 5; f++) {
      const tr = data.filter((d) => foldOf.get(d.game) !== f), te = data.filter((d) => foldOf.get(d.game) === f);
      const w = solve(tr.map(fx), tr.map((d) => d.y), ridge);
      for (const d of te) P.push([fx(d).reduce((a, x, i) => a + x * w[i], 0), d.y]);
    }
    const mae = P.reduce((a, [p, y]) => a + Math.abs(p - y), 0) / P.length;
    const my = P.reduce((a, [, y]) => a + y, 0) / P.length, mp = P.reduce((a, [p]) => a + p, 0) / P.length;
    const cov = P.reduce((a, [p, y]) => a + (p - mp) * (y - my), 0), vy = P.reduce((a, [, y]) => a + (y - my) ** 2, 0), vp = P.reduce((a, [p]) => a + (p - mp) ** 2, 0);
    const corr = cov / Math.sqrt(vy * vp);
    const b = cov / vy, a = mp - b * my;
    const inv = P.map(([p, y]) => [(p - a) / b, y]);
    const imae = inv.reduce((s, [p, y]) => s + Math.abs(p - y), 0) / P.length;
    console.log(name.padEnd(10), 'ridge', ridge, 'MAE', Math.round(mae), 'corr', corr.toFixed(3), '| inverse MAE', Math.round(imae));
  }
}
const w = solve(data.map(MODELS['mine+opp']), data.map((d) => d.y), 1e-4);
console.log('coef mine+opp', JSON.stringify(w.map((x) => +x.toFixed(4))));

// ---- Export the shipped model: mine+opp, inverse calibration, and residual spread. ----
{
  const fx = MODELS['mine+opp'];
  const P = [];
  for (let f = 0; f < 5; f++) {
    const tr = data.filter((d) => foldOf.get(d.game) !== f), te = data.filter((d) => foldOf.get(d.game) === f);
    const w = solve(tr.map(fx), tr.map((d) => d.y), 1e-4);
    for (const d of te) P.push([fx(d).reduce((a, x, i) => a + x * w[i], 0), d.y]);
  }
  const n = P.length, my = P.reduce((a, [, y]) => a + y, 0) / n, mp = P.reduce((a, [p]) => a + p, 0) / n;
  const b = P.reduce((a, [p, y]) => a + (p - mp) * (y - my), 0) / P.reduce((a, [, y]) => a + (y - my) ** 2, 0);
  const a = mp - b * my;
  const resid = P.map(([p, y]) => (p - a) / b - y);
  const sigma = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / n);
  const mae = P.reduce((s, [p, y]) => s + Math.abs(p - y), 0) / n;
  const coef = solve(data.map(fx), data.map((d) => d.y), 1e-4);
  const model = { features: 'mine+opp', coef: coef.map((x) => +x.toFixed(6)), inverse: { a: +a.toFixed(4), b: +b.toFixed(6) }, sigma: Math.round(sigma), mae: Math.round(mae), samples: n, games: games.length };
  fs.writeFileSync(__dirname + '/model.json', JSON.stringify(model, null, 1));
  console.log('\nexported model.json:', JSON.stringify({ ...model, coef: '[' + coef.length + ' values]' }));
  // One row for cross-checking the server implementation.
  const d0 = data[0];
  const s0 = fx(d0).reduce((acc, x, i) => acc + x * coef[i], 0);
  fs.writeFileSync(__dirname + '/check.json', JSON.stringify({ game: d0.game, y: d0.y, score: s0, inverse: (s0 - a) / b }));
  console.log('check row', d0.game, 'score', s0.toFixed(2), 'inverse', ((s0 - a) / b).toFixed(1));
}
