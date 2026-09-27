// Aggregate statistics over a player's public game archive.
const store = require('./store');

const DRAWS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

function header(pgn, name) {
  const m = pgn && pgn.match(new RegExp(`\\[${name} "([^"]*)"\\]`));
  return m ? m[1] : null;
}

function openingFromPgn(pgn) {
  const url = header(pgn, 'ECOUrl');
  if (url) {
    const slug = decodeURIComponent(url.split('/openings/')[1] || '');
    // Drop trailing move text such as "4.g3 Nf6 5.Bg2" that some slugs carry.
    const name = slug.split('...')[0].replace(/-/g, ' ').replace(/\s+\d+\..*$/, '').replace(/\s+\d+$/, '').trim();
    if (name) return name;
  }
  return header(pgn, 'ECO') || 'Unknown';
}

// "Sicilian Defense Najdorf Variation" -> "Sicilian Defense"
function openingFamily(name) {
  const m = name.match(/^(.*?\b(Defense|Defence|Opening|Game|Gambit|Attack|System))\b/);
  return m ? m[1] : name.split(' ').slice(0, 2).join(' ');
}

// SAN moves from a PGN body, without comments, numbers or result.
function sanMoves(pgn, max = 30) {
  const body = pgn.replace(/\[[^\]]*\]\s*/g, '').replace(/\{[^}]*\}/g, ' ').replace(/\([^)]*\)/g, ' ');
  const out = [];
  for (const tok of body.split(/\s+/)) {
    if (!tok || /^\d+\.+$/.test(tok) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) continue;
    const t = tok.replace(/^\d+\.+/, '');
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function clocks(pgn) {
  const res = [];
  const re = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  let m;
  while ((m = re.exec(pgn))) res.push(+m[1] * 3600 + +m[2] * 60 + +m[3]);
  return res;
}

// Normalize a raw archive game from the player's point of view.
function normalize(g, username) {
  const u = username.toLowerCase();
  const isWhite = g.white.username.toLowerCase() === u;
  if (!isWhite && g.black.username.toLowerCase() !== u) return null;
  const me = isWhite ? g.white : g.black;
  const opp = isWhite ? g.black : g.white;
  const outcome = me.result === 'win' ? 'win' : DRAWS.has(me.result) ? 'draw' : 'loss';
  const how = outcome === 'win' ? opp.result : outcome === 'loss' ? me.result : me.result;
  const tc = String(g.time_control || '');
  const base = tc.includes('/') ? null : +tc.split('+')[0] || null;
  const inc = tc.includes('+') ? +tc.split('+')[1] : 0;
  const clk = g.pgn ? clocks(g.pgn) : [];
  const myClk = clk.filter((_, i) => (i % 2 === 0) === isWhite);
  const moves = Math.ceil(clk.length / 2) || (g.pgn ? Math.ceil(sanMoves(g.pgn, 400).length / 2) : 0);
  return {
    url: g.url,
    uuid: g.uuid,
    end: g.end_time * 1000,
    timeClass: g.time_class,
    timeControl: tc,
    base,
    inc,
    rated: g.rated,
    rules: g.rules,
    color: isWhite ? 'white' : 'black',
    outcome,
    how,
    myRating: me.rating,
    oppRating: opp.rating,
    opponent: opp.username,
    opening: g.pgn ? openingFromPgn(g.pgn) : 'Unknown',
    accuracy: g.accuracies ? g.accuracies[isWhite ? 'white' : 'black'] : null,
    moves,
    minClock: myClk.length ? Math.min(...myClk) : null,
    endClock: myClk.length ? myClk[myClk.length - 1] : null,
  };
}

function score(list) {
  if (!list.length) return null;
  return (list.filter((g) => g.outcome === 'win').length + 0.5 * list.filter((g) => g.outcome === 'draw').length) / list.length;
}

function wdl(list) {
  return {
    games: list.length,
    win: list.filter((g) => g.outcome === 'win').length,
    draw: list.filter((g) => g.outcome === 'draw').length,
    loss: list.filter((g) => g.outcome === 'loss').length,
    score: score(list),
  };
}

function groupBy(list, fn) {
  const m = new Map();
  for (const x of list) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function compute(rawGames, username, { tzOffsetMin = 0 } = {}) {
  const games = rawGames
    .filter((g) => g.rules === 'chess')
    .map((g) => normalize(g, username))
    .filter(Boolean)
    .sort((a, b) => a.end - b.end);

  const out = { username, total: wdl(games), from: games[0]?.end ?? null, to: games.at(-1)?.end ?? null };

  // Ratings over time, per time control (rated games only).
  out.timeClasses = {};
  for (const [tc, list] of groupBy(games, (g) => g.timeClass)) {
    const rated = list.filter((g) => g.rated);
    out.timeClasses[tc] = {
      ...wdl(list),
      current: rated.at(-1)?.myRating ?? null,
      peak: rated.length ? Math.max(...rated.map((g) => g.myRating)) : null,
      change: rated.length > 1 ? rated.at(-1).myRating - rated[0].myRating : 0,
      history: rated.map((g) => ({ t: g.end, r: g.myRating })),
    };
  }

  out.byColor = { white: wdl(games.filter((g) => g.color === 'white')), black: wdl(games.filter((g) => g.color === 'black')) };

  // Openings, per color, grouped by family and by full name.
  out.openings = {};
  for (const color of ['white', 'black']) {
    const mine = games.filter((g) => g.color === color);
    const fam = [...groupBy(mine, (g) => openingFamily(g.opening))].map(([name, l]) => ({ name, ...wdl(l), avgOpp: Math.round(l.reduce((s, g) => s + g.oppRating, 0) / l.length) }));
    const full = [...groupBy(mine, (g) => g.opening)].map(([name, l]) => ({ name, ...wdl(l) }));
    out.openings[color] = {
      families: fam.sort((a, b) => b.games - a.games).slice(0, 12),
      lines: full.sort((a, b) => b.games - a.games).slice(0, 15),
    };
  }

  // How games end.
  const ends = (list) => Object.fromEntries([...groupBy(list, (g) => g.how)].map(([k, l]) => [k, l.length]));
  out.endings = {
    wins: ends(games.filter((g) => g.outcome === 'win')),
    losses: ends(games.filter((g) => g.outcome === 'loss')),
    draws: ends(games.filter((g) => g.outcome === 'draw')),
  };

  // Time management for live games that carry clock data.
  const live = games.filter((g) => g.base && g.minClock !== null && g.timeClass !== 'daily');
  const scramble = live.filter((g) => g.minClock < Math.max(10, g.base * 0.1));
  const losses = games.filter((g) => g.outcome === 'loss');
  out.time = {
    liveGames: live.length,
    lossesOnTime: losses.filter((g) => g.how === 'timeout').length,
    lossesTotal: losses.length,
    winsOnTime: games.filter((g) => g.outcome === 'win' && g.how === 'timeout').length,
    scrambleGames: scramble.length,
    scrambleScore: score(scramble),
    calmScore: score(live.filter((g) => !scramble.includes(g))),
    avgEndClockPct: live.length ? live.reduce((s, g) => s + Math.min(1, g.endClock / g.base), 0) / live.length : null,
  };

  // When you play best.
  const local = (g) => new Date(g.end - tzOffsetMin * 60000);
  out.byHour = Array.from({ length: 24 }, (_, h) => wdl(games.filter((g) => local(g).getUTCHours() === h)));
  out.byWeekday = Array.from({ length: 7 }, (_, d) => wdl(games.filter((g) => local(g).getUTCDay() === d)));

  // Results against weaker and stronger opponents.
  const buckets = [
    ['200+ lower', (d) => d <= -200],
    ['50-200 lower', (d) => d > -200 && d <= -50],
    ['Within 50', (d) => d > -50 && d < 50],
    ['50-200 higher', (d) => d >= 50 && d < 200],
    ['200+ higher', (d) => d >= 200],
  ];
  out.byOppRating = buckets.map(([label, fn]) => ({ label, ...wdl(games.filter((g) => fn(g.oppRating - g.myRating))) }));

  // Tilt: how you do right after a loss versus right after a win (same session: within 1 hour).
  const afterLoss = [];
  const afterWin = [];
  for (let i = 1; i < games.length; i++) {
    if (games[i].end - games[i - 1].end > 3600 * 1000) continue;
    if (games[i - 1].outcome === 'loss') afterLoss.push(games[i]);
    if (games[i - 1].outcome === 'win') afterWin.push(games[i]);
  }
  out.tilt = { afterLoss: wdl(afterLoss), afterWin: wdl(afterWin) };

  // Streaks and highlights.
  let best = 0;
  let cur = 0;
  for (const g of games) {
    cur = g.outcome === 'win' ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  const ratedWins = games.filter((g) => g.outcome === 'win' && g.rated);
  const bestWin = ratedWins.sort((a, b) => b.oppRating - a.oppRating)[0] || null;
  out.highlights = {
    longestWinStreak: best,
    currentWinStreak: cur,
    bestWin: bestWin && { opponent: bestWin.opponent, rating: bestWin.oppRating, url: bestWin.url, timeClass: bestWin.timeClass },
    topOpponents: [...groupBy(games, (g) => g.opponent)]
      .map(([name, l]) => ({ name, ...wdl(l) }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 5),
    avgMovesWin: avg(games.filter((g) => g.outcome === 'win').map((g) => g.moves)),
    avgMovesLoss: avg(games.filter((g) => g.outcome === 'loss').map((g) => g.moves)),
  };

  const withAcc = games.filter((g) => g.accuracy != null);
  out.accuracy = { games: withAcc.length, avg: avg(withAcc.map((g) => g.accuracy)) };

  out.monthly = [...groupBy(games, (g) => new Date(g.end).toISOString().slice(0, 7))].map(([month, l]) => ({ month, ...wdl(l) }));
  out.reviews = reviewStats(username);
  return out;
}

function avg(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

// Aggregate the engine reviews stored on disk for this player.
function reviewStats(username) {
  const u = username.toLowerCase();
  const reviews = store.listJson('reviews').filter((r) => r.username && r.username.toLowerCase() === u && r.userColor);
  if (!reviews.length) return { games: 0 };
  const tags = {};
  const phases = { opening: [], middlegame: [], endgame: [] };
  const errors = { inaccuracy: 0, mistake: 0, blunder: 0, miss: 0 };
  let moves = 0;
  const acc = [];
  for (const r of reviews) {
    const s = r.summary[r.userColor];
    if (s.accuracy != null) acc.push(s.accuracy);
    for (const k of Object.keys(errors)) errors[k] += s.counts[k] || 0;
    for (const ph of Object.keys(phases)) if (s.phases[ph]) phases[ph].push(s.phases[ph].accuracy);
    for (const m of r.moves) {
      if (m.color !== r.userColor) continue;
      moves++;
      if (['mistake', 'blunder', 'miss', 'inaccuracy'].includes(m.class)) for (const t of m.tags || []) tags[t] = (tags[t] || 0) + 1;
    }
  }
  return {
    games: reviews.length,
    moves,
    avgAccuracy: avg(acc),
    perGame: Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v / reviews.length])),
    phaseAccuracy: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, avg(v)])),
    tags,
  };
}

// Your opening repertoire as a move tree: what you (and opponents) play from a given line.
function repertoire(rawGames, username, color, path) {
  const games = rawGames
    .filter((g) => g.rules === 'chess')
    .map((g) => ({ n: normalize(g, username), pgn: g.pgn }))
    .filter((x) => x.n && x.n.color === color && x.pgn);
  const prefix = path ? path.split(' ').filter(Boolean) : [];
  const children = new Map();
  let reached = 0;
  for (const { n, pgn } of games) {
    const sans = sanMoves(pgn, prefix.length + 1);
    if (prefix.some((m, i) => sans[i] !== m)) continue;
    reached++;
    const next = sans[prefix.length];
    if (!next) continue;
    if (!children.has(next)) children.set(next, []);
    children.get(next).push(n);
  }
  return {
    color,
    path: prefix,
    games: reached,
    moves: [...children].map(([san, l]) => ({ san, ...wdl(l) })).sort((a, b) => b.games - a.games),
  };
}

module.exports = { compute, repertoire, normalize, openingFromPgn, sanMoves, reviewStats };
