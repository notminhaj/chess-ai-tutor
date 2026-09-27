# Chess AI Tutor

A personal chess study app that runs on your own computer. Link your Chess.com username and get game reviews, puzzles built from your own mistakes, rating and opening insights, a training plan, an analysis board, and practice games against Stockfish.

It is an independent tool. It does not unlock or bypass anything on Chess.com. It reads the same public data anyone can see on your profile through [Chess.com's official public API](https://www.chess.com/news/view/published-data-api), and does all analysis locally with the open-source [Stockfish](https://stockfishchess.org/) engine. It never asks for your password.

## Quick start

Requires [Node.js](https://nodejs.org/) 18 or newer.

**Windows:** double-click `start.bat`. The first run installs the packages and downloads Stockfish, then every run starts the server and opens the app in your browser. Keep the window open while you use it, and close it to stop.

**Any platform:**

```bash
npm install
npm run setup   # downloads Stockfish 19 (~80 MB) and the board piece images
npm start
```

Then open **http://127.0.0.1:3717** and enter your Chess.com username.

If port 3717 is taken, pick another one:

```bash
# PowerShell
$env:PORT = 3800; npm start
# macOS / Linux
PORT=3800 npm start
```

## Features

| Area | What you get |
|---|---|
| **Game review** | Every position analyzed by Stockfish. Accuracy per player (mapped to Chess.com's scale), a game rating for each side, move classifications (brilliant, great, best, excellent, good, inaccuracy, mistake, miss, blunder, forced), accuracy by game phase, an evaluation graph, best-move arrows, and a plain-English explanation of each move. Step through the engine's best line, or "retry" your mistakes to find the better move yourself. Three depths: fast, standard, deep. Works for Chess.com games or any pasted PGN. |
| **Batch review** | Review up to 10 unreviewed games in the background from the Games page. |
| **Puzzles from your games** | Every mistake, blunder or missed win in a reviewed game becomes a puzzle (only when there is one clearly best move). Multi-move solutions are verified by the engine. Failed puzzles come back on a spaced-repetition schedule (1, 3, 7, 21, 60 days). |
| **Rated puzzles** | Unlimited puzzles from the free Lichess puzzle database, matched to your tutor puzzle rating, with theme filters (forks, pins, mates in 2, endgames and more). Hints, solutions, streaks, and per-theme success rates. |
| **Daily and random puzzles** | Chess.com's public daily puzzle and random archive puzzles. |
| **Insights** | Rating history per time control, results by color and opening, a repertoire explorer (how each of your opening moves scores), time management (losses on time, score in time scrambles), how games end, score by hour and weekday, results against stronger and weaker players, tilt (score right after a loss), top opponents, and aggregate engine-review stats such as blunders per game and your most common error types. |
| **Coach** | A prioritized training plan built from your stats and reviews, with one-click links into the right drills. Optional AI chat coach (see below). |
| **Analysis board** | Free analysis with live multi-line Stockfish output, load any FEN or PGN, click a line to play it. |
| **Play** | Play Stockfish from about 400 to full strength, take backs, hints, then review the game in one click. Includes endgame drills (K+Q vs K, K+R vs K, two bishops, opposition, Lucena, Philidor, queen vs pawn). |

## Optional AI coach

The chat coach and the "Ask the coach" button in reviews use Claude to explain positions in plain language, grounded in the Stockfish data. Everything else works without it.

Get an API key from [console.anthropic.com](https://console.anthropic.com/), then start the server with it:

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; npm start
# macOS / Linux
ANTHROPIC_API_KEY=sk-ant-... npm start
```

The coach uses `claude-opus-5` by default. Set `COACH_MODEL` to use another model. API usage is billed to your Anthropic account. Requests use Anthropic's server-side refusal fallback, so if the primary model declines a request it is retried on a fallback model automatically.

## How the numbers are computed

- **Win chance** from an engine score uses the Lichess formula: `50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`, with mate scores capped at ±1000 centipawns.
- **Move accuracy** is Lichess's formula based on how much win chance the move gave up. **Game accuracy** averages a volatility-weighted mean and a harmonic mean of move accuracies, as Lichess does. It is then mapped onto Chess.com's scale, which squeezes accuracy toward the middle: low scores come out higher and very high scores a little lower. The mapping was fitted on 84 player-games that Chess.com had reviewed (`tools/calibration/accuracy.js`, then `accfit.js`).
- **Classifications** use the win chance lost by the move: under 2 points is excellent, under 5 good, under 10 inaccuracy, under 20 mistake, 20 or more blunder. "Best" is the engine's top move. "Great" is a best move where the next-best option was at least 20 points worse. "Brilliant" is a best or nearly best move that sacrifices material, keeps you at least equal, and is played when you were not already completely winning. A sacrifice means the move puts at least 2 points of material at risk beyond what was already at risk, net of anything it captured. The exchanges are played out with legal moves only, so a piece that can't really be taken, for example because the move gave check, doesn't count. "Miss" is a mistake or blunder right after your opponent erred.

Chess.com's formulas are private, so numbers will not match exactly. After the mapping, game accuracy is within about 5 points of Chess.com's for two games in three, and off by 4.5 points on average.

**Game rating** estimates the level each side played at in one game. Chess.com's formula is private, so this is our own model. It was fitted on 312 rated Chess.com games from 400 to 2800 using both players' accuracy, centipawn loss, error rates, time control and game length. A single game is a weak signal: the raw estimate misses the player's real rating by about 450 points on average. So when the player's rating is known, the number is anchored to it and moves up or down with how well they played for that level. Most games land within about 300 points of the rating. Without a known rating, as in a pasted PGN or a bot game, the unanchored estimate is shown and marked "rough". The model lives in `server/gamerating.js`. To rebuild it, run `node tools/calibration/collect.js` to download and review sample games, then `node tools/calibration/fit.js`.

## Your data

Everything is stored in the `data/` folder on your computer: cached API responses, your reviews, and puzzle progress. Delete that folder to start over. Nothing is sent anywhere except requests to the Chess.com and Lichess public APIs and, only if you enable it, the Anthropic API for coach chats.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3717` | Server port |
| `HOST` | `127.0.0.1` | Bind address. Keep it local unless you know you want LAN access. |
| `STOCKFISH_PATH` | auto | Use your own Stockfish binary instead of the downloaded one |
| `ANTHROPIC_API_KEY` | unset | Turns on the AI coach |
| `COACH_MODEL` | `claude-opus-5` | Model used by the AI coach |
| `CAT_DATA_DIR` | `./data` | Where reviews, puzzles and caches are stored |

## Project layout

```
server/
  index.js      HTTP server and API routes
  engine.js     Stockfish UCI wrapper
  chesscom.js   Chess.com public API client with disk cache
  review.js     Game review pipeline
  analysis.js   Win%, accuracy, classification and explanations
  puzzles.js    Puzzle mining, sources, rating and spaced repetition
  insights.js   Statistics over your game archive
  coach.js      Training plan and AI coach
  gamerating.js Per-game rating estimate
  store.js      Local JSON storage under data/
public/         Browser app (plain ES modules, no build step)
scripts/setup.js  Downloads Stockfish and piece images
tools/calibration/  Scripts and fitted models behind the accuracy and game-rating numbers
start.bat       One-click launcher for Windows
```

## Limits

- Chess.com's public API can lag a few minutes behind games you just finished.
- Bot strengths from 1320 up use Stockfish's calibrated `UCI_Elo`. Lower levels use reduced skill and depth, so treat them as approximate.
- Game ratings are not given for daily games. The model was fitted on bullet, blitz and rapid games only.
- Move explanations are rule-based (captures, forks, hanging pieces, mates, material swings) plus the engine line. The AI coach gives richer explanations if enabled.

## Credits

- [Stockfish](https://stockfishchess.org/) (GPL-3.0), downloaded at setup, not bundled.
- [chess.js](https://github.com/jhlywa/chess.js) for move generation.
- Piece images: the "cburnett" set by Colin M.L. Burnett (CC BY-SA 3.0), via Lichess.
- Puzzles from the [Lichess puzzle database](https://database.lichess.org/#puzzles) (CC0) and the Chess.com public API.
