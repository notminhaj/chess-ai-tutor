import { Chess } from '/vendor/chess.js';
import { Board } from '../board.js';
import { api, state, esc, pct, spinner, errorBox, numbered } from '../util.js';

const SOURCES = {
  mine: { label: 'From my games', desc: 'Positions where you went wrong in your reviewed games. Failed puzzles come back until you master them.' },
  lichess: { label: 'Rated', desc: 'Rated puzzles from the free Lichess puzzle database, matched to your puzzle rating.' },
  daily: { label: 'Daily', desc: "Chess.com's public daily puzzle." },
  random: { label: 'Random', desc: 'A random puzzle from the Chess.com public archive.' },
};
const THEMES = [
  ['', 'Any theme'], ['fork', 'Forks'], ['pin', 'Pins'], ['skewer', 'Skewers'], ['hangingPiece', 'Hanging pieces'],
  ['mateIn1', 'Mate in 1'], ['mateIn2', 'Mate in 2'], ['mateIn3', 'Mate in 3'], ['discoveredAttack', 'Discovered attacks'],
  ['sacrifice', 'Sacrifices'], ['deflection', 'Deflection'], ['attraction', 'Attraction'], ['defensiveMove', 'Defensive moves'],
  ['endgame', 'Endgames'], ['rookEndgame', 'Rook endgames'], ['opening', 'Opening traps'], ['middlegame', 'Middlegame'], ['short', 'Short (2 moves)'], ['long', 'Long (3+ moves)'],
];

let timers = [];
export function destroy() {
  timers.forEach(clearTimeout);
  timers = [];
}

export async function render(root, { query }) {
  let source = query.get('source') || (state.user ? 'mine' : 'lichess');
  let theme = query.get('theme') || '';
  root.innerHTML = `
  <div class="split">
    <div>
      <div class="player-strip"><span id="toMove"></span><span id="pinfo" class="small muted"></span></div>
      <div id="board"></div>
      <div class="board-controls">
        <button id="hint">Hint</button>
        <button id="solution">Show solution</button>
        <button id="retry" class="hidden">Try again</button>
        <button id="next" class="primary">Next puzzle</button>
        <button class="icon" id="flip" title="Flip board">⇅</button>
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <div class="seg" id="src">${Object.entries(SOURCES).map(([k, v]) => `<button data-s="${k}">${v.label}</button>`).join('')}</div>
        <p class="small muted" id="srcDesc" style="margin:10px 0 0"></p>
        <div class="row" id="themeRow" style="margin-top:10px"><label for="theme">Theme</label><select id="theme">${THEMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      </div>
      <div class="card"><p class="feedback" id="fb"></p><div id="detail" class="small"></div></div>
      <div class="grid cols-3" id="stats"></div>
    </div>
  </div>`;

  const board = new Board(root.querySelector('#board'), {});
  const fb = root.querySelector('#fb');
  const detail = root.querySelector('#detail');
  root.querySelector('#theme').value = theme;
  let p = null; // current puzzle
  let step = 0; // index into p.solution for the player's next move
  let failed = false;
  let finished = false;
  let usedHint = false;
  let chess = null;

  const paintSource = () => {
    root.querySelectorAll('#src button').forEach((b) => b.classList.toggle('on', b.dataset.s === source));
    root.querySelector('#srcDesc').textContent = SOURCES[source].desc;
    root.querySelector('#themeRow').classList.toggle('hidden', source !== 'lichess');
  };

  const paintStats = async () => {
    const box = root.querySelector('#stats');
    try {
      const s = await api(`/api/puzzles/summary?user=${encodeURIComponent(state.user || 'guest')}`);
      const themes = Object.entries(s.themeStats || {})
        .filter(([, v]) => v.tried >= 3)
        .map(([k, v]) => ({ k, rate: v.solved / v.tried, tried: v.tried }))
        .sort((a, b) => a.rate - b.rate)
        .slice(0, 4);
      box.innerHTML = `
        <div class="tile"><div class="label">Puzzle rating</div><div class="value">${s.rating.value}</div><div class="sub">${s.rating.games} rated puzzles</div></div>
        <div class="tile"><div class="label">Streak</div><div class="value">${s.streak.current}</div><div class="sub">Best ${s.streak.best} · today ${s.today.solved}/${s.today.tried}</div></div>
        <div class="tile"><div class="label">From your games</div><div class="value">${s.mine.total}</div><div class="sub">${s.mine.due} due · ${s.mine.mastered} mastered</div></div>
        ${themes.length ? `<div class="tile" style="grid-column:1/-1"><div class="label">Weakest themes</div>${themes.map((t) => `<div class="row between small"><span>${esc(t.k)}</span><span class="num">${pct(t.rate)} of ${t.tried}</span></div>`).join('')}</div>` : ''}`;
    } catch (e) {
      box.innerHTML = errorBox(e);
    }
  };

  const setButtons = () => {
    root.querySelector('#retry').classList.toggle('hidden', !finished);
    root.querySelector('#hint').disabled = finished || !p;
    root.querySelector('#solution').disabled = !p;
  };

  const load = async () => {
    destroy();
    p = null;
    finished = false;
    failed = false;
    usedHint = false;
    step = 0;
    board.setInteractive(false);
    board.setArrows([]);
    board.setMarks({});
    fb.className = 'feedback';
    fb.innerHTML = '<span class="spinner"></span> Loading puzzle…';
    detail.innerHTML = '';
    setButtons();
    try {
      const q = new URLSearchParams({ source });
      if (state.user) q.set('user', state.user);
      if (source === 'lichess' && theme) q.set('theme', theme);
      const res = await api(`/api/puzzles/next?${q}`);
      if (!res.puzzle) {
        fb.textContent = '';
        const when = res.nextDue ? new Date(res.nextDue).toLocaleString() : null;
        detail.innerHTML = res.total
          ? `<p>You have practiced every puzzle that is due. ${when ? `The next one is due ${esc(when)}.` : ''}</p><p><button class="small" data-go="lichess">Try rated puzzles</button> <a class="btn small" href="#/games">Review more games</a></p>`
          : `<p>No puzzles from your games yet. Review a few games and every mistake becomes a puzzle here.</p><p><a class="btn small primary" href="#/games">Review games</a> <button class="small" data-go="lichess">Try rated puzzles</button></p>`;
        detail.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { source = b.dataset.go; paintSource(); load(); }));
        root.querySelector('#toMove').textContent = '';
        return;
      }
      start(res.puzzle);
    } catch (e) {
      fb.textContent = '';
      detail.innerHTML = errorBox(e);
    }
  };

  function start(puzzle) {
    p = puzzle;
    chess = new Chess(p.fen);
    step = 0;
    board.setOrientation(p.color === 'w' ? 'white' : 'black');
    board.setPosition(p.fen, { lastMove: p.lastMove ? { from: p.lastMove.slice(0, 2), to: p.lastMove.slice(2, 4) } : null });
    board.setInteractive(p.color);
    root.querySelector('#toMove').innerHTML = `<span class="dotc ${p.color === 'w' ? 'white' : 'black'}"></span> ${p.color === 'w' ? 'White' : 'Black'} to move`;
    root.querySelector('#pinfo').textContent = p.rating ? `Rating ${p.rating}` : p.title || '';
    fb.className = 'feedback';
    fb.textContent = source === 'mine' ? `Find the move you missed. You played ${p.played} here.` : 'Find the best move.';
    detail.innerHTML = source === 'mine' && p.game ? `<div class="tiny">From ${esc(p.game.white)} vs ${esc(p.game.black)}, ${esc(p.game.date || '')}</div>` : '';
    setButtons();
  }

  const opponentReply = () => {
    const u = p.solution[step];
    const mv = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    step++;
    board.setPosition(chess.fen(), { lastMove: { from: mv.from, to: mv.to } });
    board.setInteractive(p.color);
  };

  const complete = async (solved, note) => {
    finished = true;
    board.setInteractive(false);
    fb.className = `feedback ${solved ? 'good' : 'bad'}`;
    fb.textContent = note;
    setButtons();
    const result = p.source === 'practice' ? null : await api('/api/puzzles/result', {
      method: 'POST',
      body: { user: state.user || 'guest', id: p.id, source: p.source, solved: solved && !usedHint, puzzleRating: p.rating, themes: p.themes },
    }).catch(() => null);
    if (result && p.source === 'lichess') {
      const sign = result.delta >= 0 ? '+' : '';
      fb.textContent += ` Rating ${result.rating} (${sign}${result.delta}).`;
    }
    const sol = numbered(p.fen, p.solutionSan || []);
    detail.innerHTML =
      `<p><b>Solution:</b> ${esc(sol)}</p>` +
      (p.explanation ? `<p class="muted">${esc(p.explanation)}</p>` : '') +
      (p.themes && p.themes.length ? `<p class="tiny">Themes: ${p.themes.map(esc).join(', ')}</p>` : '') +
      (p.game && p.game.reviewKey ? `<p><a href="#/review/key/${esc(p.game.reviewKey)}">Open the game review</a></p>` : '') +
      (p.link ? `<p class="tiny"><a href="${esc(p.link)}" target="_blank" rel="noopener">Puzzle source</a></p>` : '');
    paintStats();
  };

  board.onMove = async (from, to, promo) => {
    if (!p || finished) return false;
    const uci = from + to + (promo || '');
    const expected = p.solution[step];
    const trial = new Chess(chess.fen());
    const mv = trial.move({ from, to, promotion: promo });
    // Any checkmate is accepted, as are exact matches.
    const correct = uci === expected || (expected && uci.slice(0, 4) === expected.slice(0, 4) && !expected[4]) || trial.isCheckmate();
    if (correct) {
      chess.move({ from, to, promotion: promo });
      step++;
      board.setPosition(chess.fen(), { lastMove: { from, to } });
      board.setMarks({});
      if (step >= p.solution.length || trial.isCheckmate()) {
        complete(!failed, failed ? 'Solved, after a retry.' : 'Correct! Puzzle solved.');
        return true;
      }
      fb.className = 'feedback good';
      fb.textContent = `${mv.san} is right. Keep going.`;
      board.setInteractive(false);
      timers.push(setTimeout(opponentReply, 450));
      return true;
    }
    // For your own puzzles, the engine may accept an equally good alternative on the first move.
    if (source === 'mine' && step === 0) {
      fb.className = 'feedback';
      fb.innerHTML = '<span class="spinner"></span> Checking…';
      try {
        const r = await api('/api/puzzles/check', { method: 'POST', body: { fen: chess.fen(), uci, expected } });
        if (r.ok) {
          board.setPosition(trial.fen(), { lastMove: { from, to } });
          complete(!failed, `${mv.san} also wins. Puzzle solved.`);
          return true;
        }
      } catch {
        /* treat as wrong */
      }
    }
    failed = true;
    board.setPosition(trial.fen(), { lastMove: { from, to } });
    board.setInteractive(false);
    fb.className = 'feedback bad';
    fb.textContent = `${mv.san} is not it.`;
    if (!finished && step === 0 && p.source !== 'daily' && p.source !== 'random') {
      // Record the miss once, then let the player keep trying for practice.
      api('/api/puzzles/result', { method: 'POST', body: { user: state.user || 'guest', id: p.id, source: p.source, solved: false, puzzleRating: p.rating, themes: p.themes } })
        .then((r) => {
          if (r && p.source === 'lichess') fb.textContent += ` Rating ${r.rating} (${r.delta}).`;
          paintStats();
        })
        .catch(() => {});
      p = { ...p, source: 'practice' }; // no further rating changes for this puzzle
    }
    timers.push(
      setTimeout(() => {
        if (finished) return;
        board.setPosition(chess.fen(), { lastMove: null });
        board.setInteractive(p.color);
        fb.className = 'feedback';
        fb.textContent = 'Try again.';
      }, 900)
    );
    setButtons();
    return true;
  };

  root.querySelector('#src').onclick = (e) => {
    const s = e.target.dataset.s;
    if (!s) return;
    source = s;
    paintSource();
    load();
  };
  root.querySelector('#theme').onchange = (e) => {
    theme = e.target.value;
    load();
  };
  root.querySelector('#next').onclick = load;
  root.querySelector('#flip').onclick = () => board.flip();
  root.querySelector('#hint').onclick = () => {
    if (!p || finished) return;
    usedHint = true;
    board.setMarks({ [p.solution[step].slice(0, 2)]: 'hint' });
    fb.className = 'feedback';
    fb.textContent = 'The highlighted piece moves next. (A hint counts as a miss for your rating.)';
  };
  root.querySelector('#solution').onclick = () => {
    if (!p) return;
    if (!finished) complete(false, 'Here is the solution.');
    // Animate the remaining solution moves.
    const c = new Chess(chess.fen());
    const rest = p.solution.slice(step);
    rest.forEach((u, i) =>
      timers.push(
        setTimeout(() => {
          try {
            const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
            board.setPosition(c.fen(), { lastMove: { from: mv.from, to: mv.to } });
          } catch {
            /* ignore */
          }
        }, 500 * (i + 1))
      )
    );
  };
  root.querySelector('#retry').onclick = () => start({ ...p, source: 'practice' });

  paintSource();
  paintStats();
  load();
}
