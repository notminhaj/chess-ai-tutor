import { Chess } from '/vendor/chess.js';
import { Board, EvalBar, scoreLabel } from '../board.js';
import { evalGraph } from '../charts.js';
import { api, state, esc, fix, accPct, CLASSES, clsBadge, spinner, errorBox, gameCache, pending, numbered, toast } from '../util.js';

// Start (or fetch a cached) review. Resolves with the finished review.
export async function runReview({ pgn, id, username, mode, force }, onProgress) {
  const start = await api('/api/review', { method: 'POST', body: { pgn, id, username, mode, force } });
  if (start.review) return start.review;
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/review/jobs/${start.jobId}`);
    es.addEventListener('progress', (e) => {
      const d = JSON.parse(e.data);
      if (onProgress) onProgress(d.done, d.total, d.stage);
    });
    es.addEventListener('done', (e) => {
      es.close();
      resolve(JSON.parse(e.data));
    });
    es.addEventListener('error', (e) => {
      es.close();
      if (e.data) reject(new Error(JSON.parse(e.data).error));
      else reject(new Error('Lost connection to the review job.'));
    });
  });
}

let cleanup = [];
export function destroy() {
  cleanup.forEach((f) => f());
  cleanup = [];
}

export async function render(root, { args }) {
  const [kind, ref] = args;
  if (!kind) return renderList(root);
  if (kind === 'key') {
    root.innerHTML = spinner('Loading review…');
    try {
      const { review } = await api(`/api/reviews/${encodeURIComponent(ref)}`);
      return renderReview(root, review);
    } catch (e) {
      root.innerHTML = errorBox(e);
      return;
    }
  }
  let job;
  if (kind === 'game') {
    const g = gameCache.get(ref);
    if (!g) {
      // Not in memory (page reload): fall back to a stored review for that game.
      try {
        const { review } = await api(`/api/reviews/r_${encodeURIComponent(ref.toLowerCase())}`);
        return renderReview(root, review);
      } catch {
        root.innerHTML = `<div class="card empty">Open this game from the <a href="#/games">Games</a> list to review it.</div>`;
        return;
      }
    }
    job = { pgn: g.pgn, id: g.uuid, username: state.user, mode: state.reviewMode };
  } else if (kind === 'pgn') {
    if (!pending.pgn) {
      root.innerHTML = `<div class="card empty">Paste a PGN on the <a href="#/games">Games</a> page.</div>`;
      return;
    }
    job = { pgn: pending.pgn, username: state.user, mode: state.reviewMode };
  }
  root.innerHTML = `<div class="card" style="max-width:560px;margin:40px auto">
    <h2>Reviewing your game</h2>
    <p class="muted small" id="stage">Stockfish is analyzing every position…</p>
    <div class="progress"><div id="bar" style="width:0%"></div></div>
    <p class="tiny" id="count" style="margin-top:8px"></p></div>`;
  try {
    const review = await runReview(job, (done, total, stage) => {
      const bar = root.querySelector('#bar');
      if (!bar) return;
      bar.style.width = `${total ? (done / total) * 100 : 0}%`;
      root.querySelector('#count').textContent = total ? `${done} of ${total} positions` : '';
      if (stage) root.querySelector('#stage').textContent = stage + '…';
    });
    if (review.newPuzzles) toast(`${review.newPuzzles} new puzzle${review.newPuzzles > 1 ? 's' : ''} created from your mistakes.`, 4000);
    renderReview(root, review);
  } catch (e) {
    root.innerHTML = errorBox(e);
  }
}

async function renderList(root) {
  root.innerHTML = spinner('Loading your reviews…');
  const q = state.user ? `?user=${encodeURIComponent(state.user)}` : '';
  const { reviews } = await api(`/api/reviews${q}`);
  if (!reviews.length) {
    root.innerHTML = `<div class="card empty"><p>No reviews yet.</p><a class="btn primary" href="#/games">Pick a game to review</a></div>`;
    return;
  }
  root.innerHTML = `<div class="card"><h2>Your reviews <a class="btn small" href="#/games">Review another game</a></h2><div class="table-scroll"><table>
    <thead><tr><th>Game</th><th>Result</th><th class="num">Your accuracy</th><th class="num">Game rating</th><th class="num">Mistakes</th><th class="num">Blunders</th><th>Reviewed</th></tr></thead><tbody>
    ${reviews
      .map((r) => {
        const h = r.headers;
        const acc = r.userColor ? r.accuracy[r.userColor] : null;
        return `<tr class="clickable" data-key="${esc(r.key)}"><td><b>${esc(h.White)}</b> vs <b>${esc(h.Black)}</b><div class="tiny">${esc(h.Opening || '')} · ${esc(h.Date || '')}</div></td><td>${esc(h.Result)}</td><td class="num">${accPct(acc)}</td><td class="num">${r.gameRating || '—'}</td><td class="num">${r.counts ? r.counts.mistake + r.counts.miss : '—'}</td><td class="num">${r.counts ? r.counts.blunder : '—'}</td><td class="small">${new Date(r.createdAt).toLocaleDateString()}</td></tr>`;
      })
      .join('')}
    </tbody></table></div></div>`;
  root.querySelectorAll('tr[data-key]').forEach((tr) => (tr.onclick = () => (location.hash = `#/review/key/${tr.dataset.key}`)));
}

function fmtClock(s) {
  if (s == null) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function renderReview(root, review) {
  destroy();
  const h = review.headers;
  const moves = review.moves;
  const N = moves.length;
  const userColor = review.userColor;
  const orientation = userColor === 'b' ? 'black' : 'white';
  let idx = 0;
  let mode = 'view'; // 'view' | 'line' | 'retry'
  let line = null;
  let showNext = false;

  const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];
  const sw = review.summary.w;
  const sb = review.summary.b;
  let tab = 'summary';
  // Both player cells reserve the "You" line so the names stay level.
  const you = (c) => `<span class="you" style="visibility:${userColor === c ? 'visible' : 'hidden'}">You</span>`;
  const playerCell = (c) => {
    const name = c === 'w' ? h.White : h.Black;
    const elo = c === 'w' ? h.WhiteElo : h.BlackElo;
    return `<div class="pl">${you(c)}<div class="nm"><span class="dotc ${c === 'w' ? 'white' : 'black'}"></span><span>${esc(name)}</span></div><div class="elo">${esc(elo || '?')}</div></div>`;
  };
  const ratingCell = (s) =>
    s.gameRating
      ? `<div class="rv-rating" title="${s.gameRatingRough ? 'Rough estimate: no rating in the game data to anchor to' : 'The level this side played at in this game, based on their rating and how well they played'}">${s.gameRating}${s.gameRatingRough ? '<small>rough estimate</small>' : ''}</div>`
      : `<div class="rv-rating muted" title="${s.gameRatingNote || 'Not estimated'}">—${s.gameRatingNote ? `<small>${s.gameRatingNote.replace('Not estimated for ', 'n/a for ').replace('Too few moves to estimate', 'too short')}</small>` : ''}</div>`;
  const count = (n) => `<td class="${n ? '' : 'zero'}">${n}</td>`;
  const phaseCell = (s, ph) => `<td class="${s.phases[ph] ? '' : 'zero'}">${s.phases[ph] ? accPct(s.phases[ph].accuracy) : '—'}</td>`;

  root.innerHTML = `
  <div class="rv-layout">
    <section class="rv-boardcol">
      <div class="rv-board">
        <div class="pstrip top" id="topP"></div>
        <div id="evalbar"></div>
        <div id="board"></div>
        <div class="pstrip bottom" id="botP"></div>
        <div class="rv-controls">
          <button data-nav="first" title="Start (Home)" aria-label="Start">⏮</button>
          <button data-nav="prev" title="Previous (←)" aria-label="Previous move">◀</button>
          <button data-nav="next" title="Next (→)" aria-label="Next move">▶</button>
          <button data-nav="last" title="End (End)" aria-label="End">⏭</button>
          <button id="showNext" title="Show the engine's best move in this position">Best move</button>
          <button id="flip" title="Flip board" aria-label="Flip board">⇅</button>
        </div>
      </div>
    </section>
    <aside class="card rv-panel">
      <div class="rv-head">
        <div class="rv-grid">
          ${playerCell('w')}<div class="lbl"><span class="badge">${esc(h.Result || '*')}</span></div>${playerCell('b')}
          <div class="rv-acc-box"><div class="rv-acc">${accPct(sw.accuracy)}</div></div><div class="lbl">Accuracy</div><div class="rv-acc-box"><div class="rv-acc">${accPct(sb.accuracy)}</div></div>
          ${ratingCell(sw)}<div class="lbl">Game rating</div>${ratingCell(sb)}
        </div>
        <div class="meta">${esc(h.Opening || h.ECO || '')}${h.Date ? ' · ' + esc(h.Date) : ''}${h.Link ? ` · <a href="${esc(h.Link)}" target="_blank" rel="noopener">View on Chess.com</a>` : ''}</div>
      </div>
      <div class="rv-graph"><div id="graph"></div></div>
      <div class="rv-tabs" role="tablist">
        <button role="tab" data-tab="summary">Summary</button>
        <button role="tab" data-tab="moves">Moves</button>
      </div>
      <div class="rv-body" id="tab-summary">
        <table class="rv-table"><tbody>
          ${order.map((c) => `<tr>${count(sw.counts[c])}<td class="lbl">${clsBadge(c)}${CLASSES[c].label}</td>${count(sb.counts[c])}</tr>`).join('')}
        </tbody></table>
        <div class="rv-section-title">Accuracy by phase</div>
        <table class="rv-table"><tbody>
          ${['opening', 'middlegame', 'endgame'].map((ph) => `<tr>${phaseCell(sw, ph)}<td class="lbl">${ph[0].toUpperCase() + ph.slice(1)}</td>${phaseCell(sb, ph)}</tr>`).join('')}
        </tbody></table>
        <div class="rv-actions" style="justify-content:center;margin-top:14px"><button class="primary" id="startReview">Start move-by-move review</button></div>
        <p class="tiny" style="text-align:center;margin:10px 0 0">Stockfish depth ${review.depth}. Game rating estimates the level each side played at in this game.</p>
      </div>
      <div class="rv-body hidden" id="tab-moves">
        <div id="movecard"></div>
        <div class="movelist" id="movelist"></div>
        <div class="row between" style="margin-top:8px"><span class="tiny">Keys: <kbd>←</kbd> <kbd>→</kbd> <kbd>Home</kbd> <kbd>End</kbd></span><button class="small" id="nextMistake">Next key moment ▸</button></div>
      </div>
    </aside>
  </div>`;

  const board = new Board(root.querySelector('#board'), { orientation });
  const bar = new EvalBar(root.querySelector('#evalbar'));
  bar.setOrientation(orientation);

  const panel = root.querySelector('.rv-panel');
  const boardCol = root.querySelector('.rv-board');
  const fit = () => {
    panel.style.maxHeight = innerWidth > 980 ? `${Math.max(boardCol.offsetHeight, 560)}px` : '';
  };
  window.addEventListener('resize', fit);
  cleanup.push(() => window.removeEventListener('resize', fit));
  requestAnimationFrame(fit);

  const setTab = (t) => {
    tab = t;
    root.querySelectorAll('.rv-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    root.querySelector('#tab-summary').classList.toggle('hidden', t !== 'summary');
    root.querySelector('#tab-moves').classList.toggle('hidden', t !== 'moves');
    if (t === 'moves') paintList();
  };
  root.querySelector('.rv-tabs').onclick = (e) => e.target.dataset.tab && setTab(e.target.dataset.tab);
  root.querySelector('#startReview').onclick = () => {
    setTab('moves');
    go(Math.max(1, idx));
  };

  const labels = review.evals.map((s, i) => {
    const m = moves[i - 1];
    return (m ? `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'}${m.san} ` : 'Start ') + scoreLabel(s);
  });
  const graph = evalGraph(root.querySelector('#graph'), review.whiteWins, {
    marks: moves.filter((m) => ['blunder', 'mistake', 'miss', 'brilliant', 'great'].includes(m.class)).map((m) => ({ ply: m.ply, cls: m.class })),
    onPick: (i) => go(i),
    labels,
  });

  // Move list
  const ml = root.querySelector('#movelist');
  let html = '';
  for (let i = 0; i < N; i += 2) {
    const w = moves[i];
    const b = moves[i + 1];
    const cell = (m) => (m ? `<div class="mv" data-i="${m.ply + 1}">${clsBadge(m.class)}<span>${esc(m.san)}</span></div>` : '<div></div>');
    html += `<div class="mrow"><div class="mnum">${i / 2 + 1}.</div>${cell(w)}${cell(b)}</div>`;
  }
  ml.innerHTML = html;
  ml.onclick = (e) => {
    const t = e.target.closest('.mv');
    if (t) go(+t.dataset.i);
  };

  const paintPlayers = () => {
    const top = board.orientation === 'white' ? 'b' : 'w';
    const toMove = idx % 2 === 0 ? 'w' : 'b';
    const strip = (c) => {
      // Clock after this side's last move; before their first move, show their starting clock.
      let clk = null;
      for (let i = idx - 1; i >= 0; i--) if (moves[i].color === c) { clk = moves[i].clock; break; }
      if (clk == null) {
        const first = moves.find((mv) => mv.color === c);
        if (first) clk = first.clock;
      }
      const name = c === 'w' ? h.White : h.Black;
      const elo = c === 'w' ? h.WhiteElo : h.BlackElo;
      return `<div class="who"><span class="dotc ${c === 'w' ? 'white' : 'black'}"></span><span class="name">${esc(name)}</span><span class="muted" style="font-weight:400">${esc(elo || '')}</span></div>${clk != null ? `<span class="clock ${idx > 0 && toMove === c ? 'active' : ''}">${fmtClock(clk)}</span>` : ''}`;
    };
    root.querySelector('#topP').innerHTML = strip(top);
    root.querySelector('#botP').innerHTML = strip(top === 'w' ? 'b' : 'w');
  };

  const paintBoard = () => {
    const m = moves[idx - 1];
    const fen = idx === 0 ? review.startFen : m.fenAfter;
    board.setInteractive(false);
    board.setMarks({});
    board.setPosition(fen, { lastMove: m ? { from: m.from, to: m.to } : null });
    board.setBadge(m ? { square: m.to, text: CLASSES[m.class].symbol, cls: m.class, label: CLASSES[m.class].label } : null);
    const arrows = [];
    if (m && !m.isBest && m.bestUci && ['inaccuracy', 'mistake', 'miss', 'blunder', 'good', 'excellent'].includes(m.class)) {
      arrows.push({ from: m.bestUci.slice(0, 2), to: m.bestUci.slice(2, 4), color: 'rgba(40,150,70,0.85)' });
    }
    if (showNext && moves[idx] && moves[idx].bestUci) {
      arrows.push({ from: moves[idx].bestUci.slice(0, 2), to: moves[idx].bestUci.slice(2, 4), color: 'rgba(42,120,214,0.8)' });
    }
    board.setArrows(arrows);
    bar.set(review.evals[idx]);
    paintPlayers();
  };

  const paintCard = () => {
    const card = root.querySelector('#movecard');
    const m = moves[idx - 1];
    if (!m) {
      card.innerHTML = `<div class="rv-move rv-empty-move"><b>Starting position</b><p class="muted">Step through with the arrows, or jump to one of the ${review.keyMoments.length} key moments.</p></div>`;
      return;
    }
    const num = `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'}`;
    const isMine = !userColor || m.color === userColor;
    const canRetry = isMine && ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(m.class) && m.bestUci;
    const ev = m.evalAfter;
    const whiteBetter = ev.mate !== undefined ? (ev.mate === 0 ? ev.winner === 'w' : ev.mate > 0) : ev.cp >= 0;
    const verdict = m.class === 'forced' ? 'forced' : m.class === 'miss' ? 'a miss' : CLASSES[m.class].label.toLowerCase();
    card.innerHTML = `
      <div class="rv-move" style="border-left:4px solid var(--c-${m.class})">
        <div class="top"><div class="t">${clsBadge(m.class)}<span>${num}${esc(m.san)} is ${verdict}</span></div><span class="evalpill ${whiteBetter ? 'w' : 'b'}" title="Evaluation after the move">${scoreLabel(ev)}</span></div>
        <p>${esc(m.explanation)}</p>
        ${m.isBest ? '' : `<div class="best"><b>Best line:</b> ${esc(numbered(m.fenBefore, m.bestLineSan.slice(0, 8)))}</div>`}
        <div class="rv-actions">
          ${canRetry ? '<button class="small primary" id="retryBtn">Retry this move</button>' : ''}
          ${m.isBest ? '' : '<button class="small" id="lineBtn">Show best line</button>'}
          <button class="small" id="analyzeBtn">Analyze</button>
          ${state.status.ai ? '<button class="small" id="askBtn">Ask the coach</button>' : ''}
        </div>
        <div id="extra"></div>
      </div>`;
    const lineBtn = card.querySelector('#lineBtn');
    if (lineBtn) lineBtn.onclick = () => startLine(m);
    const retryBtn = card.querySelector('#retryBtn');
    if (retryBtn) retryBtn.onclick = () => startRetry(m);
    card.querySelector('#analyzeBtn').onclick = () => (location.hash = `#/analyze?fen=${encodeURIComponent(m.fenBefore)}`);
    const askBtn = card.querySelector('#askBtn');
    if (askBtn) askBtn.onclick = () => askCoach(m, card.querySelector('#extra'));
  };

  const paintList = () => {
    ml.querySelectorAll('.mv').forEach((d) => d.classList.toggle('cur', +d.dataset.i === idx));
    const cur = ml.querySelector('.mv.cur');
    if (cur && ml.clientHeight) {
      const top = cur.offsetTop - ml.offsetTop;
      if (top < ml.scrollTop || top > ml.scrollTop + ml.clientHeight - 30) ml.scrollTop = top - ml.clientHeight / 2;
    }
  };

  function go(i) {
    mode = 'view';
    idx = Math.max(0, Math.min(N, i));
    if (idx > 0 && tab !== 'moves') setTab('moves');
    graph.setCurrent(idx);
    paintBoard();
    paintCard();
    paintList();
  }

  // Step through the engine's best line from the position before the move.
  function startLine(m) {
    mode = 'line';
    const c = new Chess(m.fenBefore);
    const fens = [{ fen: m.fenBefore, last: null }];
    for (const san of m.bestLineSan.slice(0, 10)) {
      try {
        const mv = c.move(san);
        fens.push({ fen: c.fen(), last: { from: mv.from, to: mv.to }, san });
      } catch {
        break;
      }
    }
    line = { fens, i: 1 };
    const extra = root.querySelector('#extra');
    const paint = () => {
      const f = line.fens[line.i];
      board.setBadge(null);
      board.setArrows([]);
      board.setPosition(f.fen, { lastMove: f.last });
      extra.innerHTML = `<div class="row" style="margin-top:10px"><span class="small">Best line, move ${line.i} of ${line.fens.length - 1}: <b>${esc(f.san || '')}</b></span>
        <button class="small" id="lp">◀</button><button class="small" id="ln">▶</button><button class="small" id="lx">Back to the game</button></div>`;
      extra.querySelector('#lp').onclick = () => { line.i = Math.max(1, line.i - 1); paint(); };
      extra.querySelector('#ln').onclick = () => { line.i = Math.min(line.fens.length - 1, line.i + 1); paint(); };
      extra.querySelector('#lx').onclick = () => go(idx);
    };
    paint();
  }

  // Let the player try to find the better move themselves.
  function startRetry(m) {
    mode = 'retry';
    const extra = root.querySelector('#extra');
    board.setBadge(null);
    board.setArrows([]);
    board.setPosition(m.fenBefore, { lastMove: idx > 1 ? { from: moves[idx - 2].from, to: moves[idx - 2].to } : null });
    board.setInteractive(m.color);
    bar.set(review.evals[idx - 1]);
    extra.innerHTML = `<p class="feedback" style="margin-top:10px">Find a better move for ${m.color === 'w' ? 'White' : 'Black'}.</p><div class="row"><button class="small" id="hint">Hint</button><button class="small" id="answer">Show answer</button><button class="small" id="exit">Back to the game</button></div>`;
    const fb = extra.querySelector('.feedback');
    extra.querySelector('#hint').onclick = () => board.setMarks({ [m.bestUci.slice(0, 2)]: 'hint' });
    extra.querySelector('#answer').onclick = () => {
      board.setInteractive(false);
      board.setArrows([{ from: m.bestUci.slice(0, 2), to: m.bestUci.slice(2, 4) }]);
      fb.className = 'feedback';
      fb.textContent = `The best move was ${m.bestSan}.`;
    };
    extra.querySelector('#exit').onclick = () => { board.setMarks({}); go(idx); };
    board.onMove = async (from, to, promo) => {
      const c = new Chess(m.fenBefore);
      const mv = c.move({ from, to, promotion: promo });
      const uci = from + to + (promo || '');
      board.setMarks({});
      board.setPosition(c.fen(), { lastMove: { from, to } });
      board.setInteractive(false);
      if (uci === m.bestUci) {
        fb.className = 'feedback good';
        fb.textContent = `Correct! ${mv.san} is the best move.`;
        return true;
      }
      fb.className = 'feedback';
      fb.innerHTML = '<span class="spinner"></span> Checking with the engine…';
      try {
        const r = await api('/api/puzzles/check', { method: 'POST', body: { fen: m.fenBefore, uci, expected: m.bestUci } });
        if (r.ok) {
          fb.className = 'feedback good';
          fb.textContent = `${mv.san} works too. The engine's top choice was ${m.bestSan}.`;
          return true;
        }
      } catch {
        /* fall through */
      }
      fb.className = 'feedback bad';
      fb.textContent = `${mv.san} is not the answer. Try again.`;
      setTimeout(() => {
        if (mode !== 'retry') return;
        board.setPosition(m.fenBefore);
        board.setInteractive(m.color);
      }, 900);
      return true;
    };
  }

  async function askCoach(m, extra) {
    const num = `${Math.floor(m.ply / 2) + 1}${m.color === 'w' ? '.' : '...'}${m.san}`;
    extra.innerHTML = `<div class="stack" style="margin-top:10px"><textarea id="q" rows="2">Explain ${num}. Why is it ${CLASSES[m.class].label.toLowerCase()}, and what idea should I take away from this position?</textarea><div class="row"><button class="small primary" id="send">Ask</button></div><div class="msg assistant hidden" id="ans"></div></div>`;
    extra.querySelector('#send').onclick = async () => {
      const ans = extra.querySelector('#ans');
      ans.classList.remove('hidden');
      ans.textContent = '';
      ans.innerHTML = '<span class="spinner"></span>';
      const res = await fetch('/api/coach/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: extra.querySelector('#q').value, reviewKey: review.key, ply: m.ply, user: state.user }) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      ans.textContent = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        ans.textContent += dec.decode(value, { stream: true });
      }
    };
  }

  root.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.nav;
      go(k === 'first' ? 0 : k === 'prev' ? idx - 1 : k === 'next' ? idx + 1 : N);
    };
  });
  root.querySelector('#flip').onclick = () => {
    board.flip();
    bar.setOrientation(board.orientation);
    paintPlayers();
  };
  root.querySelector('#showNext').onclick = (e) => {
    showNext = !showNext;
    e.currentTarget.classList.toggle('on', showNext);
    if (mode === 'view') paintBoard();
  };
  root.querySelector('#nextMistake').onclick = () => {
    const mine = review.keyMoments.filter((p) => !userColor || moves[p].color === userColor || ['brilliant', 'great'].includes(moves[p].class));
    const next = mine.find((p) => p + 1 > idx) ?? mine[0];
    if (next != null) go(next + 1);
    else toast('No key moments in this game.');
  };
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') go(idx - 1);
    else if (e.key === 'ArrowRight') go(idx + 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(N);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  cleanup.push(() => document.removeEventListener('keydown', onKey));
  go(0);
  setTab('summary');
}
