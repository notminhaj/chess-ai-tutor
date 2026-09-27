// Coaching: a rule-based training plan from your stats, plus an optional AI coach chat.
const fs = require('fs');
const os = require('os');
const path = require('path');

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

// ---------- rule-based training plan ----------

function trainingPlan(ins, puzzleSummary) {
  const items = [];
  const add = (priority, area, title, detail, action) => items.push({ priority, area, title, detail, action });
  const r = ins.reviews || { games: 0 };
  const total = ins.total;

  if (total.games < 10) {
    add(1, 'Getting started', 'Play a few more games', `Only ${total.games} standard games were found in the selected period. Insights get more reliable after 20 or more.`, null);
  }

  if (r.games < 5) {
    add(1, 'Game review', r.games ? `Review ${5 - r.games} more game(s)` : 'Review some of your games', `Engine reviews unlock personalized puzzles and tactical insights. ${r.games ? `You have ${r.games} reviewed so far.` : ''} Start with your most recent losses.`.replace('  ', ' '), { tab: 'games' });
  }

  // Tactics, from engine reviews.
  if (r.games) {
    const blunders = (r.perGame.blunder || 0) + (r.perGame.miss || 0);
    if (blunders >= 1) {
      add(1, 'Tactics', 'Cut down on blunders', `Your reviewed games average ${blunders.toFixed(1)} blunders or misses per game. Before every move, check which of your pieces are attacked and which checks, captures and threats your opponent has.`, { tab: 'puzzles', source: 'mine' });
    }
    const tags = r.tags || {};
    if ((tags['hangs-material'] || 0) >= 3) add(1, 'Tactics', 'Stop leaving pieces hanging', `${tags['hangs-material']} of your errors dropped material to a simple capture. Do a "blunder check" before you let go of the piece.`, { tab: 'puzzles', source: 'lichess', theme: 'hangingPiece' });
    if ((tags['allows-fork'] || 0) >= 2) add(2, 'Tactics', 'Watch out for forks', `You allowed ${tags['allows-fork']} forks. Practice spotting knight and queen forks.`, { tab: 'puzzles', source: 'lichess', theme: 'fork' });
    if ((tags['missed-mate'] || 0) >= 1) add(2, 'Tactics', 'Finish the game', `You missed a forced mate ${tags['missed-mate']} time(s). Mating-pattern puzzles build that instinct.`, { tab: 'puzzles', source: 'lichess', theme: 'mateIn2' });
    if ((tags['allows-mate'] || 0) >= 2) add(1, 'Defense', 'Mind your king', `You allowed a forced mate ${tags['allows-mate']} times. Look for your opponent's checks first on every move.`, { tab: 'puzzles', source: 'lichess', theme: 'defensiveMove' });
    const ph = r.phaseAccuracy || {};
    const phases = Object.entries(ph).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]);
    if (phases.length >= 2 && phases.at(-1)[1] - phases[0][1] >= 8) {
      const [weak, v] = phases[0];
      const tips = {
        opening: 'Learn the ideas behind your main openings, not only the moves. Use the repertoire explorer to find where your games go wrong.',
        middlegame: 'Work on planning and tactics. Solve puzzles from your own games and review your mistakes.',
        endgame: 'Practice the basic endgames in the Drills section until they feel automatic.',
      };
      add(2, 'Game phase', `Your ${weak} is your weakest phase`, `Average accuracy there is ${v.toFixed(0)}%, compared with ${phases.at(-1)[1].toFixed(0)}% in the ${phases.at(-1)[0]}. ${tips[weak]}`, weak === 'endgame' ? { tab: 'play', drills: true } : weak === 'opening' ? { tab: 'insights', section: 'repertoire' } : { tab: 'puzzles', source: 'mine' });
    }
  }

  // Time management.
  const t = ins.time;
  if (t.lossesTotal >= 5 && t.lossesOnTime / t.lossesTotal >= 0.2) {
    add(1, 'Time', 'Stop losing on time', `${t.lossesOnTime} of your ${t.lossesTotal} losses (${pct(t.lossesOnTime / t.lossesTotal)}) were on time. Spend less time on routine opening moves, and consider a longer time control or one with increment.`, null);
  }
  if (t.scrambleGames >= 5 && t.calmScore != null && t.scrambleScore != null && t.calmScore - t.scrambleScore >= 0.15) {
    add(2, 'Time', 'Avoid time scrambles', `You score ${pct(t.scrambleScore)} in games where your clock dropped under 10%, versus ${pct(t.calmScore)} otherwise.`, null);
  }

  // Openings.
  for (const color of ['white', 'black']) {
    const fams = (ins.openings[color] && ins.openings[color].families) || [];
    const weak = fams.filter((f) => f.games >= 5 && f.score <= 0.4).sort((a, b) => a.score - b.score)[0];
    const strong = fams.filter((f) => f.games >= 5 && f.score >= 0.6).sort((a, b) => b.score - a.score)[0];
    if (weak) add(2, 'Openings', `Fix the ${weak.name} as ${color}`, `You score ${pct(weak.score)} in ${weak.games} games. Explore where these games go wrong, or switch to a line you know better.`, { tab: 'insights', section: 'repertoire', color });
    if (strong) add(3, 'Openings', `Keep playing the ${strong.name} as ${color}`, `It is your best opening: ${pct(strong.score)} over ${strong.games} games.`, null);
  }

  // Tilt.
  const tl = ins.tilt;
  if (tl.afterLoss.games >= 8 && tl.afterWin.games >= 8 && tl.afterWin.score - tl.afterLoss.score >= 0.12) {
    add(2, 'Habits', 'Take a break after a loss', `Right after a loss you score ${pct(tl.afterLoss.score)}, compared with ${pct(tl.afterWin.score)} after a win. A short pause before the next game may help.`, null);
  }

  // Time of day.
  const hours = ins.byHour.map((h, i) => ({ h: i, ...h })).filter((h) => h.games >= 8);
  if (hours.length >= 3) {
    const sorted = [...hours].sort((a, b) => a.score - b.score);
    const worst = sorted[0];
    const bestH = sorted.at(-1);
    if (bestH.score - worst.score >= 0.2) {
      add(3, 'Habits', 'Play at your best times', `You score ${pct(bestH.score)} around ${fmtHour(bestH.h)} but only ${pct(worst.score)} around ${fmtHour(worst.h)}.`, null);
    }
  }

  if (puzzleSummary && puzzleSummary.mine.due > 0) {
    add(1, 'Tactics', `Replay ${puzzleSummary.mine.due} puzzle(s) from your own mistakes`, 'These positions come from your games. Solving them builds the exact patterns you missed.', { tab: 'puzzles', source: 'mine' });
  }

  add(3, 'Routine', 'A simple daily routine', '10 puzzles, 1 or 2 longer games, and a review of every loss. Consistency beats volume.', null);
  return items.sort((a, b) => a.priority - b.priority);
}

function fmtHour(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}${ampm}`;
}

// ---------- AI coach (Claude API) ----------

let client = null;
let clientError = null;

function aiConfigured() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  // `ant auth login` stores a profile the SDK can use without an env var.
  const dir = path.join(os.homedir(), '.config', 'anthropic');
  return fs.existsSync(dir);
}

function getClient() {
  if (client || clientError) return client;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new (Anthropic.default || Anthropic)();
  } catch (e) {
    clientError = e;
  }
  return client;
}

const MODEL = process.env.COACH_MODEL || 'claude-opus-5';

const SYSTEM = `You are a friendly, practical chess coach inside a personal study app.
The app gives you engine data from Stockfish: evaluations, best moves, move classifications and the player's statistics.
Treat that engine data as ground truth. Never invent evaluations, variations or statistics that are not in the context, and never claim a move is legal or wins material unless the engine line shows it.
When you explain a move, give the idea in plain language first (threats, weak squares, piece activity, king safety, pawn structure), then the concrete line.
Keep answers focused: a few short paragraphs or a short list. Use standard algebraic notation for moves.
Tailor advice to the player's rating when it is known.`;

function reviewContext(review, ply) {
  if (!review) return '';
  const h = review.headers;
  const me = review.userColor ? (review.userColor === 'w' ? 'White' : 'Black') : null;
  const lines = [];
  lines.push(`Game: ${h.White} (${h.WhiteElo || '?'}) vs ${h.Black} (${h.BlackElo || '?'}), result ${h.Result}, ${h.Opening || h.ECO || 'unknown opening'}, time control ${h.TimeControl || '?'}.`);
  if (me) lines.push(`The player you are coaching played ${me}.`);
  lines.push(`Accuracy: White ${fmt(review.summary.w.accuracy)}, Black ${fmt(review.summary.b.accuracy)}.`);
  lines.push('Moves with engine classification and evaluation after the move (White\'s view):');
  const compact = review.moves.map((m) => {
    const num = Math.floor(m.ply / 2) + 1;
    const ev = m.evalAfter.mate !== undefined ? (m.evalAfter.mate === 0 ? '#' : `M${m.evalAfter.mate}`) : (m.evalAfter.cp / 100).toFixed(1);
    return `${num}${m.color === 'w' ? '.' : '...'}${m.san} [${m.class}, ${ev}]`;
  });
  lines.push(compact.join(' '));
  lines.push('Key moments:');
  for (const k of review.keyMoments.slice(0, 12)) lines.push(momentLine(review.moves[k]));
  if (ply != null && review.moves[ply]) {
    const m = review.moves[ply];
    lines.push('');
    lines.push(`The player is currently looking at this move:`);
    lines.push(momentLine(m));
    lines.push(`Position before the move (FEN): ${m.fenBefore}`);
  }
  return lines.join('\n');
}

function momentLine(m) {
  const num = Math.floor(m.ply / 2) + 1;
  return `- ${num}${m.color === 'w' ? '.' : '...'}${m.san} (${m.class}, ${m.phase}). Engine best: ${m.bestSan}; best line: ${m.bestLineSan.slice(0, 8).join(' ')}. Opponent's best reply after the played move: ${m.replyLineSan.slice(0, 6).join(' ')}. Note: ${m.explanation}`;
}

function insightsContext(ins) {
  if (!ins) return '';
  const tc = Object.entries(ins.timeClasses)
    .map(([k, v]) => `${k}: rating ${v.current ?? '?'} (peak ${v.peak ?? '?'}), ${v.games} games, score ${pct(v.score)}`)
    .join('; ');
  const op = ['white', 'black']
    .map((c) => `${c}: ` + (ins.openings[c].families || []).slice(0, 5).map((f) => `${f.name} ${f.games}g ${pct(f.score)}`).join(', '))
    .join(' | ');
  const r = ins.reviews || {};
  return [
    `Player ${ins.username}. ${ins.total.games} games in the period, overall score ${pct(ins.total.score)}.`,
    `By time control: ${tc}.`,
    `Openings (games, score): ${op}.`,
    `Losses on time: ${ins.time.lossesOnTime} of ${ins.time.lossesTotal}. Score in time scrambles ${pct(ins.time.scrambleScore)} vs ${pct(ins.time.calmScore)} otherwise.`,
    `Score right after a loss ${pct(ins.tilt.afterLoss.score)}, after a win ${pct(ins.tilt.afterWin.score)}.`,
    r.games ? `Engine-reviewed games: ${r.games}, average accuracy ${fmt(r.avgAccuracy)}, blunders per game ${(r.perGame.blunder || 0).toFixed(2)}, mistakes per game ${(r.perGame.mistake || 0).toFixed(2)}. Phase accuracy: opening ${fmt(r.phaseAccuracy.opening)}, middlegame ${fmt(r.phaseAccuracy.middlegame)}, endgame ${fmt(r.phaseAccuracy.endgame)}. Error tags: ${JSON.stringify(r.tags)}.` : 'No engine-reviewed games yet.',
  ].join('\n');
}

function fmt(x) {
  return x == null ? '?' : x.toFixed(1);
}

// Stream an AI coach answer. `write(text)` receives text deltas.
async function chat({ question, history = [], review, ply, insights }, write) {
  const c = aiConfigured() ? getClient() : null;
  if (!c) {
    throw Object.assign(new Error('AI coach is not configured. Set the ANTHROPIC_API_KEY environment variable and restart the server.'), { status: 503 });
  }
  const context = [reviewContext(review, ply), insightsContext(insights)].filter(Boolean).join('\n\n');
  const messages = [];
  // Earlier turns of this chat, oldest first. Only plain text is kept.
  for (const turn of history.slice(-10)) {
    if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string' && turn.content) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  messages.push({
    role: 'user',
    content: context ? `<context>\n${context}\n</context>\n\n${question}` : question,
  });

  const Anthropic = require('@anthropic-ai/sdk');
  const AnthropicClass = Anthropic.default || Anthropic;
  try {
    // Server-side fallbacks re-run a declined request on another model instead of returning a refusal.
    const stream = c.beta.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages,
    });
    stream.on('text', (t) => write(t));
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
      write('\n\n(The coach could not answer that request.)');
    } else if (final.stop_reason === 'max_tokens') {
      write('\n\n(Answer was cut off because it hit the length limit.)');
    }
  } catch (e) {
    if (e instanceof AnthropicClass.AuthenticationError) {
      throw Object.assign(new Error('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.'), { status: 401 });
    }
    if (e instanceof AnthropicClass.RateLimitError) {
      throw Object.assign(new Error('The AI coach is rate limited right now. Try again in a minute.'), { status: 429 });
    }
    if (e instanceof AnthropicClass.APIError) {
      throw Object.assign(new Error(`AI coach error (${e.status}): ${e.message}`), { status: 502 });
    }
    throw e;
  }
}

module.exports = { trainingPlan, chat, aiConfigured, MODEL };
