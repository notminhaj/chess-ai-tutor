import { api, state, esc, spinner, errorBox, needUser } from '../util.js';

const history = []; // chat turns kept for the session

export async function render(root) {
  if (needUser(root)) return;
  root.innerHTML = `
    <div class="grid cols-2">
      <div class="card"><h2>Your training plan</h2><p class="small muted">Built from your last 3 months of games and your engine reviews. It updates as you play and review.</p><div id="plan">${spinner('Analyzing your games…')}</div></div>
      <div class="card" id="chatCard"></div>
    </div>`;

  api(`/api/coach/plan?user=${encodeURIComponent(state.user)}&months=3&tz=${new Date().getTimezoneOffset()}`)
    .then(({ plan }) => {
      root.querySelector('#plan').innerHTML = plan
        .map((p) => {
          const href = actionHref(p.action);
          return `<div class="plan-item"><div class="pri pri-${p.priority}" title="${['', 'High', 'Medium', 'Low'][p.priority]} priority"></div>
            <div><div class="tiny">${esc(p.area)}</div><b>${esc(p.title)}</b><div class="small muted">${esc(p.detail)}</div></div>
            <div>${href ? `<a class="btn small" href="${href}">Start</a>` : ''}</div></div>`;
        })
        .join('');
    })
    .catch((e) => (root.querySelector('#plan').innerHTML = errorBox(e)));

  renderChat(root.querySelector('#chatCard'));
}

function actionHref(a) {
  if (!a) return null;
  if (a.tab === 'puzzles') return `#/puzzles?source=${a.source || 'mine'}${a.theme ? `&theme=${a.theme}` : ''}`;
  if (a.tab === 'insights') return `#/insights${a.color ? `?color=${a.color}` : ''}`;
  if (a.tab === 'play') return '#/play';
  if (a.tab === 'games') return '#/games';
  return null;
}

async function renderChat(card) {
  if (!state.status.ai) {
    card.innerHTML = `<h2>Ask the AI coach</h2>
      <p>The chat coach uses Claude to answer questions about your games in plain language, grounded in the Stockfish analysis. It is optional. Everything else in the app works without it.</p>
      <p class="small">To turn it on, get an API key from <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>, then restart the server with it set:</p>
      <pre class="small" style="background:var(--surface-2);padding:10px;border-radius:8px;overflow:auto"># PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start

# macOS / Linux
ANTHROPIC_API_KEY=sk-ant-... npm start</pre>
      <p class="tiny">API usage is billed by Anthropic to your account.</p>`;
    return;
  }
  let reviews = [];
  try {
    reviews = (await api(`/api/reviews?user=${encodeURIComponent(state.user)}`)).reviews;
  } catch {
    /* optional */
  }
  card.innerHTML = `<h2>Ask the AI coach</h2>
    <div class="row" style="margin-bottom:8px">
      <select id="game" aria-label="Game to discuss"><option value="">No specific game</option>${reviews.map((r) => `<option value="${esc(r.key)}">${esc(r.headers.White)} vs ${esc(r.headers.Black)} · ${esc(r.headers.Date || '')}</option>`).join('')}</select>
      <label class="small row" style="gap:4px"><input type="checkbox" id="stats" checked> Include my stats</label>
    </div>
    <div class="chat" id="chat">${history.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join('') || '<p class="muted small">Try: "What should I work on this week?", "Why do I keep losing with the Sicilian?", or pick a reviewed game and ask "What was the turning point?"</p>'}</div>
    <form id="ask" class="row" style="margin-top:10px"><input id="q" style="flex:1" placeholder="Ask about your games, openings, or a plan…" autocomplete="off"><button class="primary">Send</button></form>`;
  const chat = card.querySelector('#chat');
  card.querySelector('#ask').onsubmit = async (e) => {
    e.preventDefault();
    const input = card.querySelector('#q');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    if (!history.length) chat.innerHTML = '';
    chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(question)}</div>`);
    const ans = document.createElement('div');
    ans.className = 'msg assistant';
    ans.innerHTML = '<span class="spinner"></span>';
    chat.appendChild(ans);
    chat.scrollTop = chat.scrollHeight;
    const prior = history.slice();
    history.push({ role: 'user', content: question });
    try {
      const res = await fetch('/api/coach/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: prior, reviewKey: card.querySelector('#game').value || null, user: state.user, includeStats: card.querySelector('#stats').checked }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        ans.textContent = text;
        chat.scrollTop = chat.scrollHeight;
      }
      history.push({ role: 'assistant', content: text });
    } catch (err) {
      ans.textContent = `Could not reach the coach: ${err.message}`;
      history.pop();
    }
  };
}
