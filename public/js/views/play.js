import { Chess } from '/vendor/chess.js';
import { Board } from '../board.js';
import { api, state, esc, numbered, pending, toast, save } from '../util.js';

function load(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

const LEVELS = [
  [400, 'Beginner'], [800, 'Novice'], [1100, 'Casual'], [1400, 'Club'], [1700, 'Strong club'], [2000, 'Expert'], [2400, 'Master'], [3190, 'Full strength'],
];

// Classic endgame drills. Goal is from the player's side.
const DRILLS = [
  { name: 'King and queen vs king', fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1', goal: 'Checkmate the lone king.', color: 'w' },
  { name: 'King and rook vs king', fen: '8/8/8/4k3/8/8/8/R3K3 w - - 0 1', goal: 'Checkmate with the rook.', color: 'w' },
  { name: 'Two bishops vs king', fen: '8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1', goal: 'Checkmate with the bishop pair.', color: 'w' },
  { name: 'King and pawn: opposition', fen: '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1', goal: 'Win: promote the pawn. Use the opposition.', color: 'w' },
  { name: 'King and pawn: defend', fen: '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1', goal: 'Draw as Black: keep the opposition.', color: 'b' },
  { name: 'Lucena position', fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1', goal: 'Win: build a bridge with the rook.', color: 'w' },
  { name: 'Philidor position', fen: '4k3/7r/8/3PK3/8/8/8/R7 b - - 0 1', goal: 'Draw as Black: hold the third rank, then check from behind.', color: 'b' },
  { name: 'Queen vs pawn on the 7th', fen: '8/8/8/8/8/1K6/3pk3/6Q1 w - - 0 1', goal: 'Win: stop the pawn, then bring your king over.', color: 'w' },
];

let timer = null;
export function destroy() {
  clearTimeout(timer);
}

export function render(root, { query }) {
  let elo = +load('cat.botElo') || 1400;
  let myColor = 'w';
  let game = null; // { chess, startFen, over }
  let drill = null;

  root.innerHTML = `
  <div class="split">
    <div>
      <div class="player-strip" id="top"></div>
      <div id="board"></div>
      <div class="player-strip" id="bottom"></div>
      <div class="board-controls">
        <button id="undo">Take back</button>
        <button id="hint">Hint</button>
        <button id="resign">Resign</button>
        <button class="icon" id="flip" title="Flip board">⇅</button>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <h2>Play the engine</h2>
        <label for="elo">Strength: <b id="eloLabel"></b></label>
        <input type="range" id="elo" min="400" max="3190" step="50" style="width:100%">
        <div class="row" style="margin-top:6px">${LEVELS.map(([e, n]) => `<button class="small" data-elo="${e}">${n}</button>`).join('')}</div>
        <div class="row" style="margin-top:12px">
          <div class="seg" id="color"><button data-c="w">White</button><button data-c="b">Black</button><button data-c="r">Random</button></div>
          <button class="primary" id="newGame">New game</button>
        </div>
        <p class="tiny" style="margin-top:8px">Strengths from 1320 up use Stockfish's calibrated rating limit. Lower levels use reduced skill and search depth, so treat them as approximate.</p>
      </div>
      <div class="card"><div class="feedback" id="status"></div><div id="moves" class="small" style="font-family:ui-monospace,Consolas,monospace;margin-top:6px"></div><div class="row" id="after" style="margin-top:10px"></div></div>
      <div class="card" id="drills">
        <h2>Endgame drills</h2>
        <p class="small muted">Practice must-know endgames against the full-strength engine.</p>
        ${DRILLS.map((d, i) => `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--grid)"><div><b>${esc(d.name)}</b><div class="tiny">${esc(d.goal)}</div></div><button class="small" data-drill="${i}">Start</button></div>`).join('')}
      </div>
    </div>
  </div>`;

  const board = new Board(root.querySelector('#board'), {});
  const status = root.querySelector('#status');
  const eloInput = root.querySelector('#elo');
  let colorChoice = 'w';

  const paintElo = () => {
    eloInput.value = elo;
    const name = [...LEVELS].reverse().find(([e]) => elo >= e);
    root.querySelector('#eloLabel').textContent = `${elo} ${name ? `(${name[1]})` : ''}`;
  };
  eloInput.oninput = () => {
    elo = +eloInput.value;
    save('cat.botElo', String(elo));
    paintElo();
  };
  root.querySelectorAll('[data-elo]').forEach((b) => (b.onclick = () => { elo = +b.dataset.elo; save('cat.botElo', String(elo)); paintElo(); }));
  const paintColor = () => root.querySelectorAll('#color button').forEach((b) => b.classList.toggle('on', b.dataset.c === colorChoice));
  root.querySelector('#color').onclick = (e) => { if (e.target.dataset.c) { colorChoice = e.target.dataset.c; paintColor(); } };

  function strips() {
    const bot = drill ? 'Stockfish (full strength)' : `Stockfish ${elo}`;
    const me = state.user || 'You';
    const topColor = board.orientation === 'white' ? 'b' : 'w';
    const label = (c) => `<span><span class="dotc ${c === 'w' ? 'white' : 'black'}"></span> ${esc(c === myColor ? me : bot)}</span>`;
    root.querySelector('#top').innerHTML = label(topColor);
    root.querySelector('#bottom').innerHTML = label(topColor === 'w' ? 'b' : 'w');
  }

  function paintMoves() {
    const h = game.chess.history();
    root.querySelector('#moves').textContent = h.length ? numbered(game.startFen, h) : '';
  }

  function start(fen, color, isDrill = null) {
    clearTimeout(timer);
    drill = isDrill;
    myColor = color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    game = { chess: new Chess(fen), startFen: fen, over: false };
    board.setOrientation(myColor === 'w' ? 'white' : 'black');
    board.setPosition(fen);
    board.setArrows([]);
    root.querySelector('#after').innerHTML = '';
    strips();
    paintMoves();
    status.className = 'feedback';
    status.textContent = drill ? drill.goal : 'Your move.';
    if (game.chess.turn() !== myColor) botMove();
    else board.setInteractive(myColor);
  }

  function checkOver() {
    const c = game.chess;
    if (!c.isGameOver()) return false;
    game.over = true;
    board.setInteractive(false);
    let msg;
    if (c.isCheckmate()) msg = c.turn() === myColor ? 'Checkmate. The engine wins.' : 'Checkmate! You win.';
    else if (c.isStalemate()) msg = 'Stalemate. Draw.';
    else if (c.isThreefoldRepetition()) msg = 'Draw by repetition.';
    else if (c.isInsufficientMaterial()) msg = 'Draw by insufficient material.';
    else msg = 'Draw.';
    finish(msg, c.isCheckmate() && c.turn() !== myColor ? 'good' : c.isCheckmate() ? 'bad' : '');
    return true;
  }

  function finish(msg, cls) {
    status.className = `feedback ${cls}`;
    status.textContent = msg;
    const after = root.querySelector('#after');
    after.innerHTML = '<button class="primary" id="reviewIt">Review this game</button><button id="again">Play again</button>';
    after.querySelector('#again').onclick = () => (drill ? start(drill.fen, drill.color, drill) : start(new Chess().fen(), colorChoice));
    after.querySelector('#reviewIt').onclick = () => {
      const c = new Chess(game.startFen);
      for (const m of game.chess.history()) c.move(m);
      c.setHeader('White', myColor === 'w' ? state.user || 'You' : `Stockfish ${elo}`);
      c.setHeader('Black', myColor === 'b' ? state.user || 'You' : `Stockfish ${elo}`);
      c.setHeader('Event', 'Practice game vs Stockfish');
      c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
      pending.pgn = c.pgn();
      location.hash = '#/review/pgn';
    };
  }

  async function botMove() {
    board.setInteractive(false);
    status.className = 'feedback';
    status.innerHTML = '<span class="spinner"></span> Engine is thinking…';
    const fen = game.chess.fen();
    try {
      const { uci } = await api('/api/engine/play', { method: 'POST', body: { fen, elo: drill ? 3190 : elo } });
      if (!game || game.chess.fen() !== fen || game.over) return;
      const mv = game.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      board.setPosition(game.chess.fen(), { lastMove: { from: mv.from, to: mv.to } });
      paintMoves();
      if (checkOver()) return;
      status.textContent = game.chess.inCheck() ? 'Check! Your move.' : 'Your move.';
      board.setInteractive(myColor);
    } catch (e) {
      status.className = 'feedback bad';
      status.textContent = e.message;
    }
  }

  board.onMove = (from, to, promotion) => {
    if (!game || game.over) return false;
    const mv = game.chess.move({ from, to, promotion });
    board.setArrows([]);
    board.setPosition(game.chess.fen(), { lastMove: { from: mv.from, to: mv.to } });
    paintMoves();
    if (checkOver()) return true;
    timer = setTimeout(botMove, 150);
    return true;
  };

  root.querySelector('#newGame').onclick = () => start(query.get('fen') && !game ? query.get('fen') : new Chess().fen(), colorChoice);
  root.querySelector('#flip').onclick = () => { board.flip(); strips(); };
  root.querySelector('#resign').onclick = () => {
    if (!game || game.over) return;
    game.over = true;
    board.setInteractive(false);
    finish('You resigned.', 'bad');
  };
  root.querySelector('#undo').onclick = () => {
    if (!game || game.chess.history().length === 0) return;
    clearTimeout(timer);
    game.over = false;
    game.chess.undo();
    if (game.chess.turn() !== myColor && game.chess.history().length) game.chess.undo();
    board.setPosition(game.chess.fen());
    board.setArrows([]);
    paintMoves();
    root.querySelector('#after').innerHTML = '';
    if (game.chess.turn() === myColor) {
      board.setInteractive(myColor);
      status.className = 'feedback';
      status.textContent = 'Move taken back. Your move.';
    } else botMove();
  };
  root.querySelector('#hint').onclick = async () => {
    if (!game || game.over || game.chess.turn() !== myColor) return;
    const fen = game.chess.fen();
    const res = await new Promise((resolve) => {
      const es = new EventSource(`/api/engine/stream?fen=${encodeURIComponent(fen)}&multipv=1&depth=16`);
      es.addEventListener('done', (e) => { es.close(); resolve(JSON.parse(e.data)); });
      es.addEventListener('error', () => { es.close(); resolve(null); });
    });
    if (res && res.bestmove && game.chess.fen() === fen) {
      board.setArrows([{ from: res.bestmove.slice(0, 2), to: res.bestmove.slice(2, 4), color: 'rgba(42,120,214,0.8)' }]);
      toast('The arrow shows the engine\'s suggestion.');
    }
  };
  root.querySelectorAll('[data-drill]').forEach((b) => {
    b.onclick = () => {
      const d = DRILLS[+b.dataset.drill];
      start(d.fen, d.color, d);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  });

  paintElo();
  paintColor();
  const fen = query.get('fen');
  if (fen) {
    const turn = new Chess(fen).turn();
    colorChoice = turn;
    paintColor();
    start(fen, turn);
  } else {
    game = { chess: new Chess(), startFen: new Chess().fen(), over: true };
    board.setPosition(game.startFen);
    strips();
    status.textContent = 'Pick a strength and color, then start a new game.';
  }
}
