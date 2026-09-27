import { Chess } from '/vendor/chess.js';
import { Board } from '../board.js';
import { lineChart, columnChart } from '../charts.js';
import { api, state, esc, pct, fix, accPct, TIME_CLASS, SERIES, wdlBar, spinner, errorBox, needUser } from '../util.js';

const HOW = {
  resigned: 'Resignation', checkmated: 'Checkmate', timeout: 'Time', abandoned: 'Abandoned', agreed: 'Agreement', repetition: 'Repetition',
  stalemate: 'Stalemate', insufficient: 'Insufficient material', '50move': '50-move rule', timevsinsufficient: 'Time vs insufficient material', lose: 'Other', kingofthehill: 'Other', threecheck: 'Other', bughousepartnerlose: 'Other',
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function render(root, { query }) {
  if (needUser(root)) return;
  let months = +query.get('months') || 6;
  root.innerHTML = `
    <div class="row between" style="margin-bottom:12px">
      <h1 style="margin:0">Insights</h1>
      <div class="seg" id="period">${[1, 3, 6, 12, 24].map((m) => `<button data-m="${m}">${m < 12 ? m + ' mo' : m / 12 + ' yr'}</button>`).join('')}</div>
    </div>
    <div id="body">${spinner('Crunching your games…')}</div>`;
  const paintPeriod = () => root.querySelectorAll('#period button').forEach((b) => b.classList.toggle('on', +b.dataset.m === months));
  root.querySelector('#period').onclick = (e) => {
    if (!e.target.dataset.m) return;
    months = +e.target.dataset.m;
    paintPeriod();
    load();
  };
  paintPeriod();

  async function load() {
    const body = root.querySelector('#body');
    body.innerHTML = spinner(months > 6 ? 'Fetching your archive from Chess.com (first time can take a minute)…' : 'Crunching your games…');
    try {
      const ins = await api(`/api/player/${encodeURIComponent(state.user)}/insights?months=${months}&tz=${new Date().getTimezoneOffset()}`);
      paint(body, ins, months, query);
    } catch (e) {
      body.innerHTML = errorBox(e);
    }
  }
  load();
}

function paint(body, ins, months, query) {
  const t = ins.total;
  if (!t.games) {
    body.innerHTML = '<div class="card empty">No standard chess games in this period.</div>';
    return;
  }
  const tcs = Object.entries(ins.timeClasses).sort((a, b) => b[1].games - a[1].games);
  const r = ins.reviews || { games: 0 };
  body.innerHTML = `
    <div class="grid cols-4">
      <div class="tile"><div class="label">Games</div><div class="value">${t.games.toLocaleString()}</div><div class="sub">${t.win}W · ${t.draw}D · ${t.loss}L</div></div>
      <div class="tile"><div class="label">Score</div><div class="value">${pct(t.score)}</div><div class="sub">Points won per game</div></div>
      <div class="tile"><div class="label">Best win</div><div class="value">${ins.highlights.bestWin ? ins.highlights.bestWin.rating : '—'}</div><div class="sub">${ins.highlights.bestWin ? `vs <a href="${esc(ins.highlights.bestWin.url)}" target="_blank" rel="noopener">${esc(ins.highlights.bestWin.opponent)}</a> (${TIME_CLASS[ins.highlights.bestWin.timeClass] || ''})` : 'No rated wins'}</div></div>
      <div class="tile"><div class="label">Longest win streak</div><div class="value">${ins.highlights.longestWinStreak}</div><div class="sub">Current ${ins.highlights.currentWinStreak}</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>Rating history</h2>
      <div id="ratingChart"></div>
      <div class="table-scroll" style="margin-top:10px"><table><thead><tr><th>Time control</th><th class="num">Games</th><th>Results</th><th class="num">Score</th><th class="num">Current</th><th class="num">Peak</th><th class="num">Change</th></tr></thead><tbody>
      ${tcs.map(([k, v]) => `<tr><td><span class="dotc" style="background:${SERIES[k] || 'var(--text-3)'};border:0"></span> ${TIME_CLASS[k] || k}</td><td class="num">${v.games}</td><td>${wdlBar(v)}</td><td class="num">${pct(v.score)}</td><td class="num">${v.current ?? '—'}</td><td class="num">${v.peak ?? '—'}</td><td class="num ${v.change > 0 ? 'delta up' : v.change < 0 ? 'delta down' : ''}">${v.change > 0 ? '+' : ''}${v.change}</td></tr>`).join('')}
      </tbody></table></div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      ${['white', 'black'].map((c) => `
      <div class="card"><h2>Openings as ${c} <span class="small muted">${pct(ins.byColor[c].score)} over ${ins.byColor[c].games} games</span></h2>
        <div class="table-scroll"><table><thead><tr><th>Opening</th><th class="num">Games</th><th>Results</th><th class="num">Score</th></tr></thead><tbody>
        ${ins.openings[c].families.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${f.games}</td><td>${wdlBar(f)}</td><td class="num">${pct(f.score)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No games</td></tr>'}
        </tbody></table></div>
      </div>`).join('')}
    </div>

    <div class="card" id="repertoire" style="margin-top:16px">
      <h2>Repertoire explorer <div class="seg" id="repColor"><button data-c="white">As White</button><button data-c="black">As Black</button></div></h2>
      <p class="small muted">Walk through the first moves of your games and see how each choice scores. Click a move to go deeper.</p>
      <div class="split" style="grid-template-columns:minmax(240px,360px) 1fr">
        <div><div id="repBoard"></div></div>
        <div><div class="breadcrumb" id="repPath"></div><div id="repMoves" style="margin-top:8px"></div></div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Time management</h2>${timeCard(ins)}</div>
      <div class="card"><h2>How your games end</h2>${endingsCard(ins)}</div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Score by hour of day</h2><div id="hourChart"></div><p class="tiny">Your local time. Faded bars have fewer than 5 games.</p></div>
      <div class="card"><h2>Score by day of week</h2><div id="dayChart"></div></div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Against stronger and weaker players</h2>
        <table><thead><tr><th>Opponent rating</th><th class="num">Games</th><th>Results</th><th class="num">Score</th></tr></thead><tbody>
        ${ins.byOppRating.map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${b.games}</td><td>${wdlBar(b)}</td><td class="num">${pct(b.score)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card"><h2>Habits</h2>
        <table><tbody>
          <tr><td>Score in the game right after a win</td><td class="num">${pct(ins.tilt.afterWin.score)} <span class="tiny">(${ins.tilt.afterWin.games})</span></td></tr>
          <tr><td>Score in the game right after a loss</td><td class="num">${pct(ins.tilt.afterLoss.score)} <span class="tiny">(${ins.tilt.afterLoss.games})</span></td></tr>
          <tr><td>Average length of your wins</td><td class="num">${fix(ins.highlights.avgMovesWin, 0)} moves</td></tr>
          <tr><td>Average length of your losses</td><td class="num">${fix(ins.highlights.avgMovesLoss, 0)} moves</td></tr>
          ${ins.accuracy.games ? `<tr><td>Average Chess.com accuracy (${ins.accuracy.games} games)</td><td class="num">${accPct(ins.accuracy.avg)}</td></tr>` : ''}
        </tbody></table>
        <h3 style="margin-top:14px">Most played opponents</h3>
        <table><tbody>${ins.highlights.topOpponents.map((o) => `<tr><td>${esc(o.name)}</td><td class="num">${o.games}</td><td>${wdlBar(o)}</td><td class="num">${pct(o.score)}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h2>From your engine reviews</h2>${reviewCard(r)}</div>
  `;

  lineChart(body.querySelector('#ratingChart'), tcs.map(([k, v]) => ({ name: TIME_CLASS[k] || k, color: SERIES[k] || 'var(--text-3)', points: v.history })), { yLabel: 'Rating' });
  columnChart(
    body.querySelector('#hourChart'),
    ins.byHour.map((h, i) => ({ label: `${i}:00`, short: String(i), value: h.games ? h.score : null, dim: h.games < 5, sub: `${h.games} games` }))
  );
  columnChart(
    body.querySelector('#dayChart'),
    ins.byWeekday.map((d, i) => ({ label: DAYS[i], value: d.games ? d.score : null, dim: d.games < 5, sub: `${d.games} games` }))
  );
  repertoire(body, months, query.get('color') || 'white');
}

function timeCard(ins) {
  const t = ins.time;
  if (!t.liveGames) return '<p class="muted">Only daily games in this period, so there is no clock data.</p>';
  return `<table><tbody>
    <tr><td>Losses on time</td><td class="num">${t.lossesOnTime} of ${t.lossesTotal} (${pct(t.lossesTotal ? t.lossesOnTime / t.lossesTotal : null)})</td></tr>
    <tr><td>Wins on time</td><td class="num">${t.winsOnTime}</td></tr>
    <tr><td>Games where your clock fell under 10%</td><td class="num">${t.scrambleGames} of ${t.liveGames}</td></tr>
    <tr><td>Score in those time scrambles</td><td class="num">${pct(t.scrambleScore)}</td></tr>
    <tr><td>Score in the other games</td><td class="num">${pct(t.calmScore)}</td></tr>
    <tr><td>Clock left at the end, on average</td><td class="num">${pct(t.avgEndClockPct)}</td></tr>
  </tbody></table>`;
}

function endingsCard(ins) {
  const rows = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<tr><td>${HOW[k] || esc(k)}</td><td class="num">${v}</td></tr>`)
      .join('') || '<tr><td class="muted">None</td><td></td></tr>';
  return `<div class="grid cols-3" style="gap:10px">
    <div><h3>Wins</h3><table><tbody>${rows(ins.endings.wins)}</tbody></table></div>
    <div><h3>Losses</h3><table><tbody>${rows(ins.endings.losses)}</tbody></table></div>
    <div><h3>Draws</h3><table><tbody>${rows(ins.endings.draws)}</tbody></table></div></div>`;
}

function reviewCard(r) {
  if (!r.games) return '<p class="muted">No reviewed games yet. <a href="#/games">Review a few games</a> to see accuracy by game phase and your most common mistake types.</p>';
  const tagNames = { 'hangs-material': 'Left material hanging', 'allows-fork': 'Allowed a fork', 'allows-mate': 'Allowed a forced mate', 'missed-mate': 'Missed a forced mate', fork: 'Missed a fork', 'wins-material': 'Missed winning material', sacrifice: 'Missed a sacrifice' };
  const tags = Object.entries(r.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `<div class="grid cols-4">
      <div class="tile"><div class="label">Reviewed games</div><div class="value">${r.games}</div></div>
      <div class="tile"><div class="label">Average accuracy</div><div class="value">${accPct(r.avgAccuracy)}</div></div>
      <div class="tile"><div class="label">Blunders per game</div><div class="value">${fix(r.perGame.blunder, 2)}</div><div class="sub">Misses ${fix(r.perGame.miss, 2)}</div></div>
      <div class="tile"><div class="label">Mistakes per game</div><div class="value">${fix(r.perGame.mistake, 2)}</div><div class="sub">Inaccuracies ${fix(r.perGame.inaccuracy, 2)}</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:12px">
      <div><h3>Accuracy by game phase</h3><table><tbody>${['opening', 'middlegame', 'endgame'].map((p) => `<tr><td>${p[0].toUpperCase() + p.slice(1)}</td><td class="num">${accPct(r.phaseAccuracy[p])}</td></tr>`).join('')}</tbody></table></div>
      <div><h3>Most common error types</h3><table><tbody>${tags.map(([k, v]) => `<tr><td>${tagNames[k] || esc(k)}</td><td class="num">${v}</td></tr>`).join('') || '<tr><td class="muted">Not enough data</td></tr>'}</tbody></table></div>
    </div>`;
}

function repertoire(body, months, initialColor) {
  let color = initialColor;
  let path = [];
  const board = new Board(body.querySelector('#repBoard'), { orientation: color });
  const paintColor = () => body.querySelectorAll('#repColor button').forEach((b) => b.classList.toggle('on', b.dataset.c === color));
  body.querySelector('#repColor').onclick = (e) => {
    if (!e.target.dataset.c) return;
    color = e.target.dataset.c;
    path = [];
    board.setOrientation(color);
    paintColor();
    load();
  };
  async function load() {
    const c = new Chess();
    let last = null;
    for (const s of path) {
      const mv = c.move(s);
      last = { from: mv.from, to: mv.to };
    }
    board.setPosition(c.fen(), { lastMove: last });
    const crumbs = body.querySelector('#repPath');
    crumbs.innerHTML = `<button class="small" data-d="0">Start</button>` + path.map((s, i) => `<button class="small" data-d="${i + 1}">${i % 2 === 0 ? Math.floor(i / 2) + 1 + '.' : ''}${esc(s)}</button>`).join('');
    crumbs.onclick = (e) => {
      if (e.target.dataset.d == null) return;
      path = path.slice(0, +e.target.dataset.d);
      load();
    };
    const box = body.querySelector('#repMoves');
    box.innerHTML = spinner();
    try {
      const rep = await api(`/api/player/${encodeURIComponent(state.user)}/repertoire?months=${months}&color=${color}&path=${encodeURIComponent(path.join(' '))}`);
      const yourTurn = (path.length % 2 === 0) === (color === 'white');
      if (!rep.moves.length) {
        box.innerHTML = `<p class="muted">No games continue from here.</p>`;
        return;
      }
      box.innerHTML = `<p class="small">${rep.games} game${rep.games === 1 ? '' : 's'} reached this position. ${yourTurn ? '<b>Your move.</b>' : "Your opponents' replies:"}</p>
        <table><thead><tr><th>Move</th><th class="num">Games</th><th>Results</th><th class="num">Your score</th></tr></thead><tbody>
        ${rep.moves.slice(0, 12).map((m) => `<tr class="clickable" data-san="${esc(m.san)}"><td><b>${esc(m.san)}</b></td><td class="num">${m.games}</td><td>${wdlBar(m)}</td><td class="num">${pct(m.score)}</td></tr>`).join('')}
        </tbody></table>
        <p class="row" style="margin-top:8px"><a class="btn small" href="#/analyze?fen=${encodeURIComponent(board.fen)}">Analyze this position</a></p>`;
      box.querySelectorAll('tr[data-san]').forEach((tr) => (tr.onclick = () => { path.push(tr.dataset.san); load(); }));
    } catch (e) {
      box.innerHTML = errorBox(e);
    }
  }
  paintColor();
  load();
}
