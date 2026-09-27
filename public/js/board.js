// Interactive chessboard: click or drag to move, arrows, highlights, promotion picker.
import { Chess } from '/vendor/chess.js';

const FILES = 'abcdefgh';
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
let piecesOk = null;

// Check once whether the piece images were installed by "npm run setup".
async function piecesAvailable() {
  if (piecesOk === null) {
    piecesOk = fetch('/pieces/wK.svg', { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  }
  return piecesOk;
}

export class Board {
  // opts: { orientation, interactive: 'w'|'b'|'both'|false, onMove(from,to,promo) -> boolean|Promise<boolean> }
  constructor(el, opts = {}) {
    this.el = el;
    this.orientation = opts.orientation || 'white';
    this.interactive = opts.interactive ?? false;
    this.onMove = opts.onMove || null;
    this.fen = new Chess().fen();
    this.lastMove = null;
    this.arrows = [];
    this.marks = {};
    this.badge = null;
    this.selected = null;
    this.useImages = false;
    this.el.classList.add('board');
    this.el.setAttribute('role', 'grid');
    this.el.setAttribute('aria-label', 'Chess board');
    piecesAvailable().then((ok) => {
      this.useImages = ok;
      this.render();
    });
    this.bindPointer();
    this.render();
  }

  setPosition(fen, { lastMove = null, animate = false } = {}) {
    this.fen = fen;
    this.lastMove = lastMove;
    this.selected = null;
    this.render();
  }

  setOrientation(o) {
    this.orientation = o;
    this.render();
  }

  flip() {
    this.setOrientation(this.orientation === 'white' ? 'black' : 'white');
  }

  setInteractive(v) {
    this.interactive = v;
    this.selected = null;
    this.render();
  }

  // arrows: [{ from, to, color }]
  setArrows(arrows) {
    this.arrows = arrows || [];
    this.renderArrows();
  }

  // marks: { square: 'hint' | 'sel' }
  setMarks(marks) {
    this.marks = marks || {};
    this.render();
  }

  // badge: { square, text, cls } shows a move-classification icon on a square.
  setBadge(badge) {
    this.badge = badge;
    this.render();
  }

  chess() {
    return new Chess(this.fen);
  }

  squareAt(x, y) {
    const r = this.el.getBoundingClientRect();
    const col = Math.floor(((x - r.left) / r.width) * 8);
    const row = Math.floor(((y - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.orientation === 'white' ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
  }

  canMove(color) {
    if (!this.interactive) return false;
    if (this.interactive === 'both') return true;
    return this.interactive === color;
  }

  destsFrom(sq) {
    try {
      return this.chess().moves({ square: sq, verbose: true });
    } catch {
      return [];
    }
  }

  render() {
    const c = this.chess();
    const board = c.board();
    const inCheck = c.inCheck();
    const turn = c.turn();
    const dests = this.selected ? this.destsFrom(this.selected) : [];
    const destSet = new Map(dests.map((m) => [m.to, m]));
    const frag = document.createDocumentFragment();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = this.orientation === 'white' ? col : 7 - col;
        const rank = this.orientation === 'white' ? 7 - row : row;
        const sq = FILES[file] + (rank + 1);
        const p = board[7 - rank][file];
        const d = document.createElement('div');
        d.className = 'sq ' + ((file + rank) % 2 === 0 ? 'dark' : 'light');
        d.dataset.sq = sq;
        if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) d.classList.add('last');
        if (this.selected === sq) d.classList.add('sel');
        if (this.marks[sq]) d.classList.add(this.marks[sq]);
        if (inCheck && p && p.type === 'k' && p.color === turn) d.classList.add('check');
        if (row === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[file]}</span>`);
        if (col === 0) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank + 1}</span>`);
        if (p) d.appendChild(this.pieceEl(p));
        if (destSet.has(sq)) d.insertAdjacentHTML('beforeend', p ? '<span class="ring"></span>' : '<span class="dot"></span>');
        if (this.badge && this.badge.square === sq) {
          d.insertAdjacentHTML('beforeend', `<span class="badge-sq cls-${this.badge.cls}" title="${this.badge.label || ''}">${this.badge.text}</span>`);
        }
        frag.appendChild(d);
      }
    }
    this.el.replaceChildren(frag);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'arrows');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.el.appendChild(this.svg);
    this.renderArrows();
  }

  pieceEl(p) {
    if (this.useImages) {
      const img = document.createElement('img');
      img.className = 'piece';
      img.src = `/pieces/${p.color}${p.type.toUpperCase()}.svg`;
      img.alt = `${p.color === 'w' ? 'white' : 'black'} ${p.type}`;
      img.draggable = false;
      return img;
    }
    const s = document.createElement('span');
    s.className = 'piece text';
    s.textContent = GLYPH[p.type] + '︎';
    s.style.color = p.color === 'w' ? '#fff' : '#111';
    s.style.textShadow = p.color === 'w' ? '0 0 2px #000, 0 0 1px #000' : '0 0 2px #fff';
    return s;
  }

  center(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1] - 1;
    const x = this.orientation === 'white' ? f : 7 - f;
    const y = this.orientation === 'white' ? 7 - r : r;
    return [x + 0.5, y + 0.5];
  }

  renderArrows() {
    if (!this.svg) return;
    const parts = [];
    this.arrows.forEach((a, i) => {
      const [x1, y1] = this.center(a.from);
      const [x2, y2] = this.center(a.to);
      const color = a.color || 'rgba(40, 150, 70, 0.8)';
      const id = `ah${i}`;
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ex = x2 - ((x2 - x1) / len) * 0.3;
      const ey = y2 - ((y2 - y1) / len) * 0.3;
      parts.push(
        `<defs><marker id="${id}" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 z" fill="${color}"/></marker></defs>` +
          `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-width="${a.width || 0.16}" stroke-linecap="round" marker-end="url(#${id})" opacity="${a.opacity || 0.85}"/>`
      );
    });
    this.svg.innerHTML = parts.join('');
  }

  bindPointer() {
    let drag = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sq = this.squareAt(e.clientX, e.clientY);
      if (!sq) return;
      const c = this.chess();
      const p = c.get(sq);
      // Second click on a destination square completes a click-move.
      if (this.selected && this.selected !== sq) {
        const ok = this.destsFrom(this.selected).some((m) => m.to === sq);
        if (ok) {
          this.tryMove(this.selected, sq);
          return;
        }
      }
      if (p && p.color === c.turn() && this.canMove(p.color)) {
        this.selected = sq;
        this.render();
        const pieceNode = this.el.querySelector(`[data-sq="${sq}"] .piece`);
        if (pieceNode) {
          const ghost = pieceNode.cloneNode(true);
          const size = this.el.getBoundingClientRect().width / 8;
          ghost.classList.add('drag-ghost');
          ghost.style.width = ghost.style.height = size + 'px';
          ghost.style.left = e.clientX + 'px';
          ghost.style.top = e.clientY + 'px';
          ghost.style.display = 'none';
          document.body.appendChild(ghost);
          drag = { from: sq, ghost, node: pieceNode, moved: false, x: e.clientX, y: e.clientY };
          this.el.setPointerCapture(e.pointerId);
        }
      } else {
        this.selected = null;
        this.render();
      }
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.moved = true;
      drag.ghost.style.display = '';
      drag.node.classList.add('dragging');
      drag.ghost.style.left = e.clientX + 'px';
      drag.ghost.style.top = e.clientY + 'px';
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      d.ghost.remove();
      d.node.classList.remove('dragging');
      if (!d.moved) return; // plain click: keep the selection for click-to-move
      const to = this.squareAt(e.clientX, e.clientY);
      if (to && to !== d.from && this.destsFrom(d.from).some((m) => m.to === to)) this.tryMove(d.from, to);
      else {
        this.selected = null;
        this.render();
      }
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  async tryMove(from, to) {
    const moves = this.destsFrom(from).filter((m) => m.to === to);
    if (!moves.length) return;
    let promo;
    if (moves.some((m) => m.promotion)) promo = await this.pickPromotion(moves[0].color);
    if (moves.some((m) => m.promotion) && !promo) {
      this.selected = null;
      this.render();
      return;
    }
    this.selected = null;
    if (this.onMove) {
      const accepted = await this.onMove(from, to, promo);
      if (accepted === false) this.render();
    }
  }

  pickPromotion(color) {
    return new Promise((resolve) => {
      const div = document.createElement('div');
      div.className = 'promo';
      for (const t of ['q', 'r', 'b', 'n']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t];
        b.innerHTML = this.useImages ? `<img src="/pieces/${color}${t.toUpperCase()}.svg" alt="${b.title}">` : GLYPH[t];
        b.onclick = (e) => {
          e.stopPropagation();
          div.remove();
          resolve(t);
        };
        div.appendChild(b);
      }
      div.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.target === div) {
          div.remove();
          resolve(null);
        }
      });
      this.el.appendChild(div);
    });
  }
}

// Vertical evaluation bar. Call set(scoreWhitePOV).
export class EvalBar {
  constructor(el) {
    this.el = el;
    el.className = 'evalbar';
    el.innerHTML = '<div class="fill"></div><div class="txt top"></div><div class="txt bottom"></div>';
    this.fill = el.querySelector('.fill');
    this.top = el.querySelector('.txt.top');
    this.bottom = el.querySelector('.txt.bottom');
    this.set({ cp: 0 });
  }

  setOrientation(o) {
    this.el.classList.toggle('flipped', o === 'black');
  }

  set(score) {
    const w = winPct(score);
    this.fill.style.height = `${w}%`;
    const label = scoreLabel(score, true);
    const whiteAhead = w >= 50;
    this.top.textContent = whiteAhead ? '' : label;
    this.bottom.textContent = whiteAhead ? label : '';
  }
}

export function winPct(score) {
  if (!score) return 50;
  let cp;
  if (score.mate !== undefined) cp = score.mate === 0 ? (score.winner === 'b' ? -1000 : 1000) : score.mate > 0 ? 1000 : -1000;
  else cp = Math.max(-1000, Math.min(1000, score.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

// "+1.25", "-0.40", "M3", "#". `abs` drops the sign (used on the eval bar).
export function scoreLabel(score, abs = false) {
  if (!score) return '';
  if (score.mate !== undefined) {
    if (score.mate === 0) return '#';
    return (abs ? '' : score.mate < 0 ? '-' : '') + 'M' + Math.abs(score.mate);
  }
  const v = score.cp / 100;
  if (abs) return Math.abs(v).toFixed(1);
  return (v > 0 ? '+' : '') + v.toFixed(2);
}
