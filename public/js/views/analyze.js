import { Chess } from '/vendor/chess.js';
import { Board, EvalBar, scoreLabel } from '../board.js';
import { esc, sanLine, numbered, toast } from '../util.js';

let es = null;
let cleanup = [];
export function destroy() {
  if (es) es.close();
  es = null;
  cleanup.forEach((f) => f());
  cleanup = [];
}

export function render(root, { query }) {
  const startFen = query.get('fen') || new Chess().fen();
  let history = [{ fen: startFen, san: null, last: null }];
  let cur = 0;
  let engineOn = true;
  let multipv = 3;

  root.innerHTML = `
  <div class="split">
    <div>
      <div class="board-wrap"><div id="evalbar"></div><div id="board"></div></div>
      <div class="board-controls">
        <button class="icon" id="back" title="Back (←)">◀</button>
        <button class="icon" id="fwd" title="Forward (→)">▶</button>
        <button class="icon" id="flip" title="Flip board">⇅</button>
        <button id="reset">Reset</button>
        <button id="playFrom">Play the engine from here</button>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <div class="row between"><h2 style="margin:0">Engine</h2>
          <div class="row"><label class="small row" style="gap:4px"><input type="checkbox" id="engineOn" checked> On</label>
          <select id="mpv" aria-label="Lines"><option value="1">1 line</option><option value="2">2 lines</option><option value="3" selected>3 lines</option><option value="5">5 lines</option></select></div></div>
        <div class="tiny" id="depth"></div>
        <div id="lines" style="margin-top:8px"></div>
      </div>
      <div class="card"><h3>Moves</h3><div id="moves" class="small" style="font-family:ui-monospace,Consolas,monospace"></div></div>
      <div class="card">
        <h3>Load a position</h3>
        <input id="fen" style="width:100%" placeholder="Paste a FEN or a PGN">
        <div class="row" style="margin-top:8px"><button id="load">Load</button><button id="copy">Copy FEN</button></div>
      </div>
    </div>
  </div>`;

  const board = new Board(root.querySelector('#board'), { interactive: 'both' });
  const bar = new EvalBar(root.querySelector('#evalbar'));

  board.onMove = (from, to, promotion) => {
    const c = new Chess(history[cur].fen);
    const mv = c.move({ from, to, promotion });
    history = history.slice(0, cur + 1);
    history.push({ fen: c.fen(), san: mv.san, last: { from, to } });
    cur++;
    show();
    return true;
  };

  function show() {
    const h = history[cur];
    board.setPosition(h.fen, { lastMove: h.last });
    board.setArrows([]);
    const moves = history.slice(1).map((x) => x.san);
    root.querySelector('#moves').textContent = moves.length ? numbered(history[0].fen, moves) : 'Make moves on the board.';
    root.querySelector('#fen').placeholder = h.fen;
    analyze();
  }

  function analyze() {
    if (es) es.close();
    es = null;
    const lines = root.querySelector('#lines');
    const fen = history[cur].fen;
    const c = new Chess(fen);
    if (c.isGameOver()) {
      lines.innerHTML = `<p class="muted">${c.isCheckmate() ? 'Checkmate.' : 'Draw.'}</p>`;
      bar.set(c.isCheckmate() ? { mate: 0, winner: c.turn() === 'w' ? 'b' : 'w' } : { cp: 0 });
      return;
    }
    if (!engineOn) {
      lines.innerHTML = '<p class="muted">Engine is off.</p>';
      root.querySelector('#depth').textContent = '';
      return;
    }
    lines.innerHTML = '<span class="spinner"></span>';
    es = new EventSource(`/api/engine/stream?fen=${encodeURIComponent(fen)}&multipv=${multipv}&depth=24`);
    const paint = (data, final) => {
      const ls = data.lines || [];
      if (!ls.length) return;
      bar.set(ls[0].score);
      root.querySelector('#depth').textContent = `Depth ${ls[0].depth}${final ? ' (done)' : ''} · ${ls[0].nps ? Math.round(ls[0].nps / 1000).toLocaleString() + 'k nodes/s' : ''}`;
      lines.innerHTML = ls
        .map((l, i) => {
          const sans = sanLine(Chess, fen, l.pv, 10);
          return `<div class="pv" data-i="${i}"><span class="sc num">${scoreLabel(l.score)}</span><span>${esc(numbered(fen, sans))}</span></div>`;
        })
        .join('');
      lines.querySelectorAll('.pv').forEach((d) => {
        d.onclick = () => {
          const l = ls[+d.dataset.i];
          board.onMove(l.pv[0].slice(0, 2), l.pv[0].slice(2, 4), l.pv[0][4]);
        };
      });
      const best = ls[0].pv[0];
      if (best) board.setArrows([{ from: best.slice(0, 2), to: best.slice(2, 4), color: 'rgba(42,120,214,0.75)' }]);
    };
    es.addEventListener('info', (e) => paint(JSON.parse(e.data), false));
    es.addEventListener('done', (e) => {
      paint(JSON.parse(e.data), true);
      es.close();
      es = null;
    });
    es.addEventListener('error', () => {
      if (es) es.close();
      es = null;
    });
  }

  root.querySelector('#back').onclick = () => { if (cur > 0) { cur--; show(); } };
  root.querySelector('#fwd').onclick = () => { if (cur < history.length - 1) { cur++; show(); } };
  root.querySelector('#flip').onclick = () => { board.flip(); bar.setOrientation(board.orientation); };
  root.querySelector('#reset').onclick = () => { history = [{ fen: startFen, san: null, last: null }]; cur = 0; show(); };
  root.querySelector('#playFrom').onclick = () => (location.hash = `#/play?fen=${encodeURIComponent(history[cur].fen)}`);
  root.querySelector('#engineOn').onchange = (e) => { engineOn = e.target.checked; analyze(); };
  root.querySelector('#mpv').onchange = (e) => { multipv = +e.target.value; analyze(); };
  root.querySelector('#copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(history[cur].fen);
      toast('FEN copied.');
    } catch {
      toast(history[cur].fen, 6000);
    }
  };
  root.querySelector('#load').onclick = () => {
    const v = root.querySelector('#fen').value.trim();
    if (!v) return;
    try {
      const c = new Chess();
      if (/^\s*([rnbqkpRNBQKP1-8]+\/){7}/.test(v)) {
        c.load(v);
        history = [{ fen: c.fen(), san: null, last: null }];
      } else {
        c.loadPgn(v);
        const hist = c.history({ verbose: true });
        history = [{ fen: hist.length ? hist[0].before : c.fen(), san: null, last: null }, ...hist.map((m) => ({ fen: m.after, san: m.san, last: { from: m.from, to: m.to } }))];
      }
      cur = history.length - 1;
      show();
    } catch (e) {
      toast(`Could not load that: ${e.message}`, 4000);
    }
  };
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') root.querySelector('#back').click();
    else if (e.key === 'ArrowRight') root.querySelector('#fwd').click();
  };
  document.addEventListener('keydown', onKey);
  cleanup.push(() => document.removeEventListener('keydown', onKey));
  if (new Chess(startFen).turn() === 'b') {
    board.setOrientation('black');
    bar.setOrientation('black');
  }
  show();
}
