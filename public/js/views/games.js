import { api, state, save, esc, fmtDate, TIME_CLASS, outcomeBadge, spinner, errorBox, needUser, rememberGames, pending, toast } from '../util.js';
import { runReview } from './review.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let batch = null; // background batch-review state survives navigation

export async function render(root, { query }) {
  if (needUser(root)) return;
  root.innerHTML = `
    <div class="card">
      <h2>Your games</h2>
      <div class="row" style="margin-bottom:12px">
        <select id="month" aria-label="Month"></select>
        <select id="tc" aria-label="Time control"><option value="">All time controls</option><option value="bullet">Bullet</option><option value="blitz">Blitz</option><option value="rapid">Rapid</option><option value="daily">Daily</option></select>
        <select id="res" aria-label="Result"><option value="">All results</option><option value="win">Wins</option><option value="loss">Losses</option><option value="draw">Draws</option></select>
        <select id="col" aria-label="Color"><option value="">Both colors</option><option value="white">As White</option><option value="black">As Black</option></select>
        <span style="flex:1"></span>
        <label class="small">Review depth</label>
        <div class="seg" id="mode">
          <button data-m="fast" title="About 10 seconds per game">Fast</button>
          <button data-m="standard" title="About 30 seconds per game">Standard</button>
          <button data-m="deep" title="A few minutes per game">Deep</button>
        </div>
      </div>
      <div id="batch"></div>
      <div id="list">${spinner('Loading games from Chess.com…')}</div>
    </div>
    <div class="card">
      <h2>Review any game from a PGN</h2>
      <p class="small muted">Paste a PGN from any site or an over-the-board game.</p>
      <textarea id="pgn" rows="5" placeholder='[White "..."]&#10;[Black "..."]&#10;&#10;1. e4 e5 2. Nf3 ...'></textarea>
      <div class="row" style="margin-top:8px"><button class="primary" id="reviewPgn">Review this PGN</button></div>
    </div>`;

  const modeEl = root.querySelector('#mode');
  const paintMode = () => modeEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === state.reviewMode));
  modeEl.onclick = (e) => {
    const m = e.target.dataset.m;
    if (!m) return;
    state.reviewMode = m;
    save('cat.reviewMode', m);
    paintMode();
  };
  paintMode();

  root.querySelector('#reviewPgn').onclick = () => {
    const pgn = root.querySelector('#pgn').value.trim();
    if (!pgn) return toast('Paste a PGN first.');
    pending.pgn = pgn;
    location.hash = '#/review/pgn';
  };

  let data = null;
  const load = async (year, month) => {
    root.querySelector('#list').innerHTML = spinner('Loading games from Chess.com…');
    try {
      const q = year ? `?year=${year}&month=${month}` : '';
      data = await api(`/api/player/${encodeURIComponent(state.user)}/games${q}`);
      rememberGames(data.games);
      const sel = root.querySelector('#month');
      sel.innerHTML = [...data.archives]
        .reverse()
        .map((a) => `<option value="${a.year}-${a.month}" ${a.year === data.year && a.month === data.month ? 'selected' : ''}>${MONTHS[a.month - 1]} ${a.year}</option>`)
        .join('');
      paint();
    } catch (e) {
      root.querySelector('#list').innerHTML = errorBox(e);
    }
  };

  const filtered = () => {
    const tc = root.querySelector('#tc').value;
    const res = root.querySelector('#res').value;
    const col = root.querySelector('#col').value;
    return data.games.filter((g) => g.rules === 'chess' && g.me && (!tc || g.timeClass === tc) && (!res || g.me.outcome === res) && (!col || g.me.color === col));
  };

  const paint = () => {
    if (!data) return;
    const list = filtered();
    const unreviewed = list.filter((g) => !g.reviewed);
    paintBatch(root, unreviewed);
    if (!list.length) {
      root.querySelector('#list').innerHTML = `<div class="empty">No standard games match in ${MONTHS[data.month - 1]} ${data.year}.</div>`;
      return;
    }
    root.querySelector('#list').innerHTML = list
      .map((g) => {
        const opp = g.me.color === 'white' ? g.black : g.white;
        const mine = g.me.color === 'white' ? g.white : g.black;
        const acc = g.accuracies ? g.accuracies[g.me.color] : null;
        return `<div class="gamerow">
          <div class="small">${fmtDate(g.end)}</div>
          <div class="small hide-sm">${TIME_CLASS[g.timeClass] || g.timeClass}${g.rated ? '' : ' · casual'}</div>
          <div><div class="row"><span class="dotc ${g.me.color}" title="You played ${g.me.color}"></span>${outcomeBadge(g.me.outcome)} <span>vs <b>${esc(opp.username)}</b> <span class="muted">(${opp.rating})</span></span></div>
            <div class="tiny">${esc(g.opening || '')} · ${esc(g.me.how)}${acc ? ` · Chess.com accuracy ${acc.toFixed(1)}%` : ''} · you ${mine.rating}</div></div>
          <div class="hide-sm">${g.reviewed ? '<span class="badge">Reviewed</span>' : ''}</div>
          <div class="row"><a class="btn small" href="${esc(g.url)}" target="_blank" rel="noopener" title="Open on Chess.com">↗</a><a class="btn small ${g.reviewed ? '' : 'primary'}" href="#/review/game/${encodeURIComponent(g.uuid)}">${g.reviewed ? 'Open' : 'Review'}</a></div>
        </div>`;
      })
      .join('');
  };

  root.querySelector('#month').onchange = (e) => {
    const [y, m] = e.target.value.split('-');
    load(+y, +m);
  };
  ['#tc', '#res', '#col'].forEach((s) => (root.querySelector(s).onchange = paint));
  root._repaint = paint;
  await load(+query.get('year') || null, +query.get('month') || null);
}

function paintBatch(root, unreviewed) {
  const box = root.querySelector('#batch');
  if (!box) return;
  if (batch && batch.running) {
    box.innerHTML = `<div class="notice" style="margin-bottom:12px"><div class="row between"><span>Reviewing game ${batch.index + 1} of ${batch.games.length}… ${batch.progress}</span><button class="small" id="stopBatch">Stop after this game</button></div><div class="progress" style="margin-top:8px"><div style="width:${(batch.index / batch.games.length) * 100}%"></div></div></div>`;
    box.querySelector('#stopBatch').onclick = () => {
      batch.stop = true;
      toast('Stopping after the current game.');
    };
    return;
  }
  if (!unreviewed.length) {
    box.innerHTML = '';
    return;
  }
  const n = Math.min(10, unreviewed.length);
  box.innerHTML = `<div class="row" style="margin-bottom:12px"><button id="startBatch">Review ${n} unreviewed game${n > 1 ? 's' : ''} in the background</button><span class="tiny">Builds your puzzle set and mistake statistics.</span></div>`;
  box.querySelector('#startBatch').onclick = () => startBatch(root, unreviewed.slice(0, n));
}

async function startBatch(root, games) {
  batch = { running: true, games, index: 0, progress: '', stop: false, mined: 0 };
  const repaint = () => {
    const live = document.querySelector('#batch');
    if (live && live.closest('main') && root._repaint) root._repaint();
  };
  repaint();
  for (let i = 0; i < games.length && !batch.stop; i++) {
    batch.index = i;
    batch.progress = '';
    repaint();
    try {
      const r = await runReview({ pgn: games[i].pgn, id: games[i].uuid, username: state.user, mode: state.reviewMode }, (done, total) => {
        batch.progress = `${Math.round((done / total) * 100)}%`;
        const live = document.querySelector('#batch .notice span');
        if (live) live.textContent = `Reviewing game ${i + 1} of ${games.length}… ${batch.progress}`;
      });
      games[i].reviewed = true;
      batch.mined += r.newPuzzles || 0;
    } catch (e) {
      toast(`Review failed: ${e.message}`);
    }
  }
  batch.running = false;
  toast(`Batch review finished. ${batch.mined} new puzzle${batch.mined === 1 ? '' : 's'} from your mistakes.`, 4000);
  repaint();
}
