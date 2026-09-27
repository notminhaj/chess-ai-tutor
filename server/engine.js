// Thin UCI wrapper around a local Stockfish process.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function findStockfish() {
  if (process.env.STOCKFISH_PATH) return process.env.STOCKFISH_PATH;
  const dir = path.join(__dirname, '..', 'bin', 'stockfish');
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^stockfish/i.test(e.name) && !/\.(zip|gz|md|txt|sh|cpp|h|cff)$/i.test(e.name)) return full;
    }
  }
  return null;
}

// Parse one UCI "info" line. Only lines that carry both a score and a pv are returned.
function parseInfo(line) {
  const t = line.split(' ');
  const out = {};
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'depth') out.depth = +t[++i];
    else if (k === 'seldepth') out.seldepth = +t[++i];
    else if (k === 'multipv') out.multipv = +t[++i];
    else if (k === 'nodes') out.nodes = +t[++i];
    else if (k === 'nps') out.nps = +t[++i];
    else if (k === 'time') out.time = +t[++i];
    else if (k === 'score') {
      const type = t[++i];
      const val = +t[++i];
      out.score = type === 'mate' ? { mate: val } : { cp: val };
      if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') out.bound = t[++i];
    } else if (k === 'pv') {
      out.pv = t.slice(i + 1);
      break;
    }
  }
  return out.score && out.pv ? out : null;
}

// UCI scores are from the side to move. Convert to White's point of view.
function toWhite(score, sideToMove) {
  if (sideToMove === 'w') return { ...score };
  return score.mate !== undefined ? { mate: -score.mate } : { cp: -score.cp };
}

class Engine {
  constructor(name, { threads, hash } = {}) {
    this.name = name;
    this.threads = threads || Math.max(1, Math.min(4, os.cpus().length - 1));
    this.hash = hash || 64;
    this.proc = null;
    this.listeners = new Set();
    this.pending = new Set();
    this.queue = Promise.resolve();
    this.buffer = '';
    this.options = {};
  }

  static available() {
    return !!findStockfish();
  }

  async start() {
    if (this.proc) return;
    const exe = findStockfish();
    if (!exe) throw new Error('Stockfish not found. Run "npm run setup" or set STOCKFISH_PATH.');
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.on('exit', () => {
      this.proc = null;
      this.options = {};
      this.buffer = '';
      // Fail any search still waiting, so the queue moves on and the next call restarts the engine.
      const pending = [...this.pending];
      this.pending.clear();
      this.listeners.clear();
      pending.forEach((reject) => reject(new Error('The Stockfish process stopped unexpectedly.')));
    });
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) for (const l of [...this.listeners]) l(line);
      }
    });
    this.send('uci');
    await this.waitFor((l) => l === 'uciok');
    this.send(`setoption name Threads value ${this.threads}`);
    this.send(`setoption name Hash value ${this.hash}`);
    await this.ready();
  }

  send(cmd) {
    if (this.proc) this.proc.stdin.write(cmd + '\n');
  }

  waitFor(pred, onLine) {
    return new Promise((resolve, reject) => {
      const fn = (line) => {
        if (onLine) onLine(line);
        if (pred(line)) {
          this.listeners.delete(fn);
          this.pending.delete(reject);
          resolve(line);
        }
      };
      this.listeners.add(fn);
      this.pending.add(reject);
    });
  }

  async ready() {
    this.send('isready');
    await this.waitFor((l) => l === 'readyok');
  }

  setOption(name, value) {
    if (this.options[name] === value) return;
    this.options[name] = value;
    this.send(`setoption name ${name} value ${value}`);
  }

  // Serialize work on this engine so requests never interleave.
  run(task) {
    const p = this.queue.then(() => this.start()).then(task);
    this.queue = p.catch(() => {});
    return p;
  }

  // Analyze one position. Returns lines sorted by multipv, with scores from White's view.
  analyze(fen, { depth = 16, multipv = 1, movetime, maxTime, onInfo, signal, fresh = true } = {}) {
    return this.run(async () => {
      this.setOption('UCI_LimitStrength', 'false');
      this.setOption('Skill Level', 20);
      this.setOption('MultiPV', multipv);
      // Reusing the hash table across unrelated searches can make some positions search
      // 10x+ slower (measured on this build), so each analysis starts from a clean table.
      if (fresh) this.send('ucinewgame');
      await this.ready();
      const side = fen.split(' ')[1] || 'w';
      const lines = new Map();
      if (signal && signal.aborted) return { fen, bestmove: null, lines: [], aborted: true };
      this.send(`position fen ${fen}`);
      // maxTime caps a depth search: whichever limit is hit first ends it.
      this.send(movetime ? `go movetime ${movetime}` : `go depth ${depth}${maxTime ? ` movetime ${maxTime}` : ''}`);
      const abort = () => this.send('stop');
      if (signal) signal.addEventListener('abort', abort, { once: true });
      const best = await this.waitFor(
        (l) => l.startsWith('bestmove'),
        (l) => {
          if (!l.startsWith('info ') || l.includes(' currmove ')) return;
          const info = parseInfo(l);
          if (!info || info.bound) return;
          const mpv = info.multipv || 1;
          lines.set(mpv, {
            multipv: mpv,
            depth: info.depth,
            score: toWhite(info.score, side),
            pv: info.pv,
            nodes: info.nodes,
            nps: info.nps,
          });
          if (onInfo && mpv === Math.min(multipv, lines.size)) {
            onInfo([...lines.values()].sort((a, b) => a.multipv - b.multipv));
          }
        }
      );
      if (signal) signal.removeEventListener('abort', abort);
      const bestmove = best.split(' ')[1];
      return {
        fen,
        bestmove: bestmove === '(none)' ? null : bestmove,
        lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv),
      };
    });
  }

  // Pick a move at limited strength, for playing against the engine.
  // 1320..3190 uses Stockfish's calibrated UCI_Elo. Below that we lower Skill Level and depth.
  playMove(fen, elo) {
    return this.run(async () => {
      this.setOption('MultiPV', 1);
      if (elo >= 1320) {
        this.setOption('Skill Level', 20);
        this.setOption('UCI_LimitStrength', 'true');
        this.setOption('UCI_Elo', Math.min(3190, elo));
      } else {
        this.setOption('UCI_LimitStrength', 'false');
        this.setOption('Skill Level', Math.max(0, Math.min(20, Math.round((elo - 700) / 40))));
      }
      await this.ready();
      this.send(`position fen ${fen}`);
      if (elo < 1320) {
        const depth = Math.max(1, Math.min(8, Math.round((elo - 300) / 130)));
        this.send(`go depth ${depth}`);
      } else {
        this.send(`go movetime ${elo < 2000 ? 400 : 800}`);
      }
      const best = await this.waitFor((l) => l.startsWith('bestmove'));
      const mv = best.split(' ')[1];
      return mv === '(none)' ? null : mv;
    });
  }

  quit() {
    if (this.proc) {
      this.send('quit');
      this.proc = null;
    }
  }
}

module.exports = { Engine, parseInfo, toWhite, findStockfish };
