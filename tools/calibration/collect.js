// Calibration data: rated games across the rating range, reviewed by the app's own pipeline.
// Usage: node tools/calibration/collect.js   (PRESET=fast by default; writes games.json and samples-<preset>.jsonl here)
process.env.CAT_DATA_DIR = __dirname + '/data';
const fs = require('fs');
const APP = require('path').join(__dirname, '..', '..', 'server') + '/';
const chesscom = require(APP + 'chesscom');
const { Engine } = require(APP + 'engine');
const { runReview, PRESETS } = require(APP + 'review');

const BUCKETS = [];
for (let r = 400; r < 2800; r += 200) BUCKETS.push(r);
const PER_BUCKET = +process.env.PER_BUCKET || 26;
const TCS = new Set(['blitz', 'rapid', 'bullet']);
const bucketOf = (r) => BUCKETS.find((b) => r >= b && r < b + 200);

async function crawl() {
  const gamesFile = __dirname + '/games.json';
  if (fs.existsSync(gamesFile)) return JSON.parse(fs.readFileSync(gamesFile));
  const picked = new Map(); // uuid -> game
  const count = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const seen = new Set();
  const pool = new Map([['erik', 1500], ['hikaru', 3000]]);
  let fetched = 0;
  while (fetched < 220) {
    const deficits = BUCKETS.filter((b) => count[b] < PER_BUCKET);
    if (!deficits.length) break;
    // Pick an unvisited player closest to the most under-filled bucket.
    const target = deficits.sort((a, b) => count[a] - count[b])[0] + 100;
    let best = null;
    for (const [u, r] of pool) if (!seen.has(u) && (!best || Math.abs(r - target) < Math.abs(best[1] - target))) best = [u, r];
    if (!best) break;
    const [user] = best;
    seen.add(user);
    fetched++;
    let games = [];
    try {
      const arch = await chesscom.archives(user);
      if (!arch.length) continue;
      const last = arch.at(-1);
      games = await chesscom.month(user, last.year, last.month);
      if (games.length < 10 && arch.length > 1) games = games.concat(await chesscom.month(user, arch.at(-2).year, arch.at(-2).month));
    } catch (e) {
      continue;
    }
    for (const g of games) {
      if (g.rules !== 'chess' || !g.rated || !TCS.has(g.time_class) || !g.pgn) continue;
      for (const side of [g.white, g.black]) {
        const u = side.username.toLowerCase();
        if (!seen.has(u)) pool.set(u, side.rating);
      }
      if (picked.has(g.uuid)) continue;
      const plies = (g.pgn.match(/\{\[%clk/g) || []).length;
      if (plies < 30) continue;
      if (Math.abs(g.white.rating - g.black.rating) > 250) continue;
      if ([g.white.result, g.black.result].includes('abandoned')) continue;
      const b = bucketOf((g.white.rating + g.black.rating) / 2);
      if (b === undefined || count[b] >= PER_BUCKET) continue;
      // Spread samples over many players: at most 3 games per crawled player per bucket.
      const key = `${user}:${b}`;
      picked.set(key + ':' + g.uuid, true);
      if ([...picked.keys()].filter((k) => k.startsWith(key + ':')).length > 3) continue;
      picked.set(g.uuid, { uuid: g.uuid, pgn: g.pgn, tc: g.time_class, wr: g.white.rating, br: g.black.rating, bucket: b });
      count[b]++;
    }
    process.stdout.write(`\rplayers ${fetched} | ` + BUCKETS.map((b) => `${b}:${count[b]}`).join(' '));
  }
  const list = [...picked.values()].filter((v) => v && v.uuid);
  fs.writeFileSync(gamesFile, JSON.stringify(list));
  console.log(`\ncollected ${list.length} games`);
  return list;
}

async function review(list) {
  const out = __dirname + '/samples-' + (process.env.PRESET || 'fast') + '.jsonl';
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).uuid) : []);
  const todo = list.filter((g) => !done.has(g.uuid));
  console.log(`reviewing ${todo.length} games (${done.size} already done)`);
  const engines = [0, 1, 2, 3].map((i) => new Engine('c' + i, { threads: 2, hash: 64 }));
  const preset = PRESETS[process.env.PRESET || 'fast'];
  let n = 0;
  const t0 = Date.now();
  await Promise.all(
    engines.map(async (eng) => {
      while (todo.length) {
        const g = todo.shift();
        try {
          const r = await runReview(eng, { pgn: g.pgn, id: 'calib_' + g.uuid, ...preset });
          const rec = {
            uuid: g.uuid, tc: g.tc, wr: g.wr, br: g.br,
            evals: r.evals,
            moves: r.moves.map((m) => ({ c: m.color, loss: +m.loss.toFixed(2), acc: +m.accuracy.toFixed(2), cls: m.class, best: m.isBest ? 1 : 0, lc: m.legalCount })),
            acc: { w: r.summary.w.accuracy, b: r.summary.b.accuracy },
          };
          fs.appendFileSync(out, JSON.stringify(rec) + '\n');
        } catch (e) {
          console.log('\nfail', g.uuid, e.message);
        }
        n++;
        const rate = (Date.now() - t0) / n / 1000;
        process.stdout.write(`\rreviewed ${n}, ${rate.toFixed(1)}s per game, ~${Math.round((todo.length * rate) / 60)} min left   `);
      }
      eng.quit();
    })
  );
  console.log('\ndone');
}

(async () => {
  const list = await crawl();
  await review(list);
})();
