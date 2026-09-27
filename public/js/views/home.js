import { api, state, setUser, esc, fmtDate, TIME_CLASS, outcomeBadge, spinner, errorBox, rememberGames } from '../util.js';

export async function render(root) {
  if (!state.user) return renderLink(root);
  root.innerHTML = spinner('Loading your profile…');
  let data;
  try {
    data = await api(`/api/player/${encodeURIComponent(state.user)}`);
  } catch (e) {
    root.innerHTML = `${errorBox(e)}<p></p><button class="primary" id="relink">Use a different username</button>`;
    root.querySelector('#relink').onclick = () => setUser(null);
    return;
  }
  const { profile, stats, puzzles } = data;
  state.profile = profile;
  const title = profile.title ? `<span class="badge">${esc(profile.title)}</span> ` : '';
  const tiles = ['rapid', 'blitz', 'bullet', 'daily']
    .map((k) => ({ k, s: stats[`chess_${k}`] }))
    .filter((x) => x.s)
    .map(({ k, s }) => {
      const r = s.record || {};
      const games = (r.win || 0) + (r.loss || 0) + (r.draw || 0);
      return `<div class="tile"><div class="label">${TIME_CLASS[k]}</div><div class="value">${s.last ? s.last.rating : '—'}</div><div class="sub">Best ${s.best ? s.best.rating : '—'} · ${games.toLocaleString()} games · ${r.win || 0}W ${r.draw || 0}D ${r.loss || 0}L</div></div>`;
    })
    .join('');
  const tactics = stats.tactics && stats.tactics.highest ? `<div class="tile"><div class="label">Chess.com puzzles (best)</div><div class="value">${stats.tactics.highest.rating}</div><div class="sub">From your public stats</div></div>` : '';

  root.innerHTML = `
    <div class="card">
      <div class="row">
        ${profile.avatar ? `<img src="/api/avatar?url=${encodeURIComponent(profile.avatar)}" alt="" style="width:64px;height:64px;border-radius:12px;object-fit:cover">` : ''}
        <div>
          <h1 style="margin:0">${title}${esc(profile.username || state.user)}</h1>
          <div class="muted small">${profile.name ? esc(profile.name) + ' · ' : ''}Joined ${fmtDate(profile.joined * 1000)} · <a href="${esc(profile.url)}" target="_blank" rel="noopener">Profile on Chess.com</a></div>
        </div>
      </div>
    </div>
    <div class="grid cols-4" style="margin-top:16px">
      ${tiles || '<div class="tile"><div class="label">Ratings</div><div class="value">—</div><div class="sub">No rated standard games yet</div></div>'}
      <div class="tile"><div class="label">Tutor puzzle rating</div><div class="value">${puzzles.rating.value}</div><div class="sub">${puzzles.rating.games} rated puzzles · best streak ${puzzles.streak.best}</div></div>
      ${tactics}
      <div class="tile"><div class="label">Puzzles from your games</div><div class="value">${puzzles.mine.total}</div><div class="sub">${puzzles.mine.due} due for practice · ${puzzles.mine.mastered} mastered</div></div>
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      <div class="card"><h2>Today's focus <a class="small" href="#/coach">Full plan</a></h2><div id="plan">${spinner('Building your plan…')}</div></div>
      <div class="card"><h2>Recent games <a class="small" href="#/games">All games</a></h2><div id="recent">${spinner('Loading games…')}</div></div>
    </div>
    <p class="tiny" style="margin-top:16px">Data comes from Chess.com's public API using only your username. No password is ever needed or stored. Analysis runs on your computer with Stockfish.</p>
  `;

  api(`/api/coach/plan?user=${encodeURIComponent(state.user)}&months=3&tz=${new Date().getTimezoneOffset()}`)
    .then(({ plan }) => {
      const el = root.querySelector('#plan');
      if (!el) return;
      el.innerHTML = plan
        .slice(0, 3)
        .map((p) => `<div class="plan-item"><div class="pri pri-${p.priority}"></div><div><b>${esc(p.title)}</b><div class="small muted">${esc(p.detail)}</div></div><div></div></div>`)
        .join('');
    })
    .catch((e) => {
      const el = root.querySelector('#plan');
      if (el) el.innerHTML = errorBox(e);
    });

  api(`/api/player/${encodeURIComponent(state.user)}/games`)
    .then(({ games }) => {
      const el = root.querySelector('#recent');
      if (!el) return;
      const list = games.filter((g) => g.me).slice(0, 6);
      if (!list.length) {
        el.innerHTML = '<div class="empty">No games this month yet.</div>';
        return;
      }
      el.innerHTML = list
        .map((g) => {
          const opp = g.me.color === 'white' ? g.black : g.white;
          return `<div class="row between" style="padding:6px 0;border-bottom:1px solid var(--grid)">
            <div class="row"><span class="dotc ${g.me.color}"></span>${outcomeBadge(g.me.outcome)}<span>vs <b>${esc(opp.username)}</b> (${opp.rating})</span><span class="tiny">${TIME_CLASS[g.timeClass] || g.timeClass}</span></div>
            <a class="btn small" href="#/review/game/${encodeURIComponent(g.uuid)}">${g.reviewed ? 'Open review' : 'Review'}</a>
          </div>`;
        })
        .join('');
      rememberGames(games);
    })
    .catch((e) => {
      const el = root.querySelector('#recent');
      if (el) el.innerHTML = errorBox(e);
    });
}

function renderLink(root) {
  root.innerHTML = `
    <div class="hero">
      <img src="/logo.svg" alt="" style="width:56px;height:56px">
      <h1>Your personal chess tutor</h1>
      <p class="muted">Game reviews with move-by-move explanations, puzzles made from your own mistakes, rating and opening insights, a training plan, and engine analysis. Everything runs on your computer.</p>
      <form id="link" class="stack" style="margin-top:20px">
        <input id="u" placeholder="Your Chess.com username" autocomplete="off" autofocus required pattern="[A-Za-z0-9_\\-]{2,40}">
        <button class="primary" style="width:100%">Link account</button>
        <div id="err"></div>
      </form>
      <p class="tiny" style="margin-top:14px">Only your public username is used. The tutor reads the same public data anyone can see on your profile, through Chess.com's official public API. It never asks for your password.</p>
    </div>`;
  const form = root.querySelector('#link');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const u = root.querySelector('#u').value.trim();
    const err = root.querySelector('#err');
    err.innerHTML = spinner('Checking…');
    try {
      await api(`/api/player/${encodeURIComponent(u)}`);
      setUser(u);
    } catch (ex) {
      err.innerHTML = errorBox(ex.message === 'Not found on Chess.com' ? new Error(`No Chess.com player named "${u}" was found.`) : ex);
    }
  };
}
