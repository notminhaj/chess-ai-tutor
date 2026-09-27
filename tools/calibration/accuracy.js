// Pairs Chess.com's published accuracy with this app's per-move data for the same games,
// so the accuracy scale can be matched to Chess.com's.
// Usage: node tools/calibration/accuracy.js   (writes accuracy-pairs.jsonl here)
process.env.CAT_DATA_DIR = __dirname + '/data';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'server') + '/';
const chesscom = require(APP + 'chesscom');
const { Engine } = require(APP + 'engine');
const { runReview, PRESETS } = require(APP + 'review');

const OUT = __dirname + '/accuracy-pairs.jsonl';
const header = (pgn, k) => (pgn.match(new RegExp(`\\[${k} "([^"]*)"\\]`)) || [])[1];

async function withChessComAccuracy(list) {
  const out = [];
  let i = 0;
  for (const g of list) {
    i++;
    const white = header(g.pgn, 'White');
    const date = header(g.pgn, 'UTCDate') || header(g.pgn, 'Date');
    if (!white || !date) continue;
    const [y, m] = date.split('.').map(Number);
    try {
      const games = await chesscom.month(white, y, m);
      const hit = games.find((x) => x.uuid === g.uuid);
      if (hit && hit.accuracies) out.push({ ...g, cc: hit.accuracies });
    } catch {
      /* skip */
    }
    process.stdout.write(`\rlooked up ${i}/${list.length}, with Chess.com accuracy: ${out.length}   `);
  }
  console.log();
  return out;
}

(async () => {
  const list = JSON.parse(fs.readFileSync(__dirname + '/games.json', 'utf8'));
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).uuid) : []);
  const todo = (await withChessComAccuracy(list)).filter((g) => !done.has(g.uuid));
  console.log(`reviewing ${todo.length} games at the standard preset`);
  const engines = [0, 1, 2, 3].map((i) => new Engine('a' + i, { threads: 2, hash: 64 }));
  let n = 0;
  await Promise.all(
    engines.map(async (eng) => {
      while (todo.length) {
        const g = todo.shift();
        try {
          const r = await runReview(eng, { pgn: g.pgn, id: 'acc_' + g.uuid, ...PRESETS.standard });
          fs.appendFileSync(
            OUT,
            JSON.stringify({
              uuid: g.uuid, tc: g.tc, wr: g.wr, br: g.br, cc: g.cc,
              ours: { w: r.summary.w.accuracy, b: r.summary.b.accuracy },
              wins: r.whiteWins.map((x) => +x.toFixed(3)),
              colors: r.moves.map((m) => m.color).join(''),
              best: r.moves.map((m) => (m.isBest ? 1 : 0)).join(''),
            }) + '\n'
          );
        } catch (e) {
          console.log('\nfail', g.uuid, e.message);
        }
        process.stdout.write(`\rreviewed ${++n}, ${todo.length} left   `);
      }
      eng.quit();
    })
  );
  console.log('\ndone');
})();
