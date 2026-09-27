// Small SVG charts with hover tooltips. Colors come from CSS tokens so light and dark both work.
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function tipFor(container) {
  let tip = container.querySelector('.tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tip hidden';
    container.appendChild(tip);
  }
  return tip;
}

// Evaluation graph for a game review. wins: White win% per position (0..100).
// marks: [{ ply, cls }] draws a dot on notable moves. onPick(positionIndex).
export function evalGraph(container, wins, { current = 0, marks = [], onPick, labels = [] } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  const W = 600;
  const H = 120;
  const n = wins.length;
  const x = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (w) => H - (w / 100) * H;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Evaluation graph: White advantage over the game' });
  svg.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: 'var(--eval-black)', rx: 6 }));
  let d = `M0,${H} `;
  wins.forEach((w, i) => (d += `L${x(i).toFixed(1)},${y(w).toFixed(1)} `));
  d += `L${W},${H} Z`;
  svg.appendChild(el('path', { d, fill: 'var(--eval-white)' }));
  svg.appendChild(el('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, stroke: 'var(--text-3)', 'stroke-width': 1, opacity: 0.6 }));
  for (const m of marks) {
    const i = m.ply + 1;
    svg.appendChild(el('circle', { cx: x(i), cy: y(wins[i]), r: 4.5, fill: `var(--c-${m.cls})`, stroke: 'var(--surface)', 'stroke-width': 2 }));
  }
  const cur = el('line', { x1: x(current), x2: x(current), y1: 0, y2: H, stroke: 'var(--accent)', 'stroke-width': 2 });
  svg.appendChild(cur);
  const hover = el('line', { y1: 0, y2: H, stroke: 'var(--text-2)', 'stroke-width': 1, opacity: 0 });
  svg.appendChild(hover);
  container.appendChild(svg);
  const tip = tipFor(container);

  const idxAt = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1))));
  };
  svg.addEventListener('mousemove', (e) => {
    const i = idxAt(e);
    hover.setAttribute('x1', x(i));
    hover.setAttribute('x2', x(i));
    hover.setAttribute('opacity', 0.8);
    const r = svg.getBoundingClientRect();
    tip.classList.remove('hidden');
    tip.style.left = `${(x(i) / W) * r.width}px`;
    tip.style.top = `${(y(wins[i]) / H) * r.height}px`;
    tip.textContent = labels[i] || `White ${Math.round(wins[i])}%`;
  });
  svg.addEventListener('mouseleave', () => {
    hover.setAttribute('opacity', 0);
    tip.classList.add('hidden');
  });
  svg.addEventListener('click', (e) => onPick && onPick(idxAt(e)));
  svg.style.cursor = onPick ? 'pointer' : 'default';
  return {
    setCurrent(i) {
      cur.setAttribute('x1', x(i));
      cur.setAttribute('x2', x(i));
    },
  };
}

// Multi-series line chart over time. series: [{ name, color, points: [{ t, r }] }]
export function lineChart(container, series, { height = 240, yLabel = '' } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  const shown = series.filter((s) => s.points.length);
  if (!shown.length) {
    container.innerHTML = '<div class="empty">No rated games in this period.</div>';
    return;
  }
  if (shown.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = shown.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
    container.appendChild(legend);
  }
  const W = 720;
  const H = height;
  const pad = { l: 44, r: 70, t: 10, b: 24 };
  const all = shown.flatMap((s) => s.points);
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t));
  let r0 = Math.min(...all.map((p) => p.r));
  let r1 = Math.max(...all.map((p) => p.r));
  const step = niceStep((r1 - r0) / 4 || 50);
  r0 = Math.floor(r0 / step) * step;
  r1 = Math.ceil(r1 / step) * step;
  if (r1 === r0) r1 = r0 + step;
  const x = (t) => pad.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (r) => pad.t + (1 - (r - r0) / (r1 - r0)) * (H - pad.t - pad.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${yLabel} over time` });
  for (let v = r0; v <= r1; v += step) {
    svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const t = el('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-3)' });
    t.textContent = v.toLocaleString();
    svg.appendChild(t);
  }
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    const lab = el('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle', 'font-size': 11, fill: 'var(--text-3)' });
    lab.textContent = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.appendChild(lab);
  }
  for (const s of shown) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.r).toFixed(1)}`).join(' ');
    svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = s.points.at(-1);
    svg.appendChild(el('circle', { cx: x(last.t), cy: y(last.r), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
    const lab = el('text', { x: x(last.t) + 8, y: y(last.r) + 4, 'font-size': 12, fill: 'var(--text-2)', 'font-weight': 600 });
    lab.textContent = `${last.r}`;
    svg.appendChild(lab);
  }
  const hover = el('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--text-3)', 'stroke-width': 1, opacity: 0 });
  svg.appendChild(hover);
  container.appendChild(svg);
  const tip = tipFor(container);
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((vx - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    const rows = shown
      .map((s) => {
        let best = s.points[0];
        for (const p of s.points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        return { s, p: best };
      })
      .filter((o) => Math.abs(o.p.t - t) < (t1 - t0) / 20 + 1);
    if (!rows.length) {
      tip.classList.add('hidden');
      hover.setAttribute('opacity', 0);
      return;
    }
    const px = x(rows[0].p.t);
    hover.setAttribute('x1', px);
    hover.setAttribute('x2', px);
    hover.setAttribute('opacity', 0.7);
    tip.classList.remove('hidden');
    tip.style.left = `${(px / W) * r.width}px`;
    tip.style.top = `${(y(rows[0].p.r) / H) * r.height}px`;
    tip.innerHTML = `<div class="tiny">${new Date(rows[0].p.t).toLocaleDateString()}</div>` + rows.map((o) => `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${o.s.color};margin-right:6px"></span>${o.s.name}: <b>${o.p.r}</b></div>`).join('');
  });
  svg.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    hover.setAttribute('opacity', 0);
  });
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

// Columns for a single measure. items: [{ label, value (0..1), sub }]
export function columnChart(container, items, { height = 160, format = (v) => `${Math.round(v * 100)}%`, color = 'var(--series-1)' } = {}) {
  container.classList.add('chart');
  container.innerHTML = '';
  const W = 720;
  const H = height;
  const pad = { l: 36, r: 6, t: 8, b: 22 };
  const n = items.length;
  const band = (W - pad.l - pad.r) / n;
  const bw = Math.min(24, band - 2);
  const y = (v) => pad.t + (1 - v) * (H - pad.t - pad.b);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (const v of [0, 0.5, 1]) {
    svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: 'var(--grid)' }));
    const t = el('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--text-3)' });
    t.textContent = format(v);
    svg.appendChild(t);
  }
  const tip = tipFor(container);
  items.forEach((it, i) => {
    const cx = pad.l + band * i + band / 2;
    if (it.value != null) {
      const top = y(it.value);
      const h = y(0) - top;
      const r = Math.min(4, h / 2);
      const x0 = cx - bw / 2;
      const d = `M${x0},${y(0)} L${x0},${top + r} Q${x0},${top} ${x0 + r},${top} L${x0 + bw - r},${top} Q${x0 + bw},${top} ${x0 + bw},${top + r} L${x0 + bw},${y(0)} Z`;
      const bar = el('path', { d, fill: color, opacity: it.dim ? 0.35 : 1 });
      svg.appendChild(bar);
    }
    const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: H - pad.t - pad.b, fill: 'transparent' });
    hit.addEventListener('mousemove', () => {
      const r = svg.getBoundingClientRect();
      tip.classList.remove('hidden');
      tip.style.left = `${(cx / W) * r.width}px`;
      tip.style.top = `${(y(it.value ?? 0) / H) * r.height}px`;
      tip.innerHTML = `<b>${it.label}</b>: ${it.value == null ? 'no games' : format(it.value)}${it.sub ? `<div class="tiny">${it.sub}</div>` : ''}`;
    });
    hit.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    svg.appendChild(hit);
    if (n <= 12 || i % 3 === 0) {
      const t = el('text', { x: cx, y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--text-3)' });
      t.textContent = it.short ?? it.label;
      svg.appendChild(t);
    }
  });
  container.appendChild(svg);
}
