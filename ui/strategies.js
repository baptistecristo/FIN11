// Strategy panel.
//
// Paper portfolios, computed by the hub and drawn here. Selecting one changes
// what this panel shows and nothing else: no order leaves the machine, and the
// viewer has no code path that could send one.

const cards = new Map();
let onSelect = () => {};

export function initStrategies(handler) {
  onSelect = handler;
}

function sparkline(canvas, series, colour) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  // Measure the parent, never the canvas. A canvas sized from its own
  // clientWidth feeds its bitmap back into layout and grows without bound,
  // which pins the compositor and freezes the window.
  // Hard ceiling as well as measuring the parent: belt and braces, because the
  // failure mode here is a frozen window rather than an ugly chart.
  const MAX_W = 400;
  const w = Math.min(MAX_W, Math.max(0, (canvas.parentElement?.clientWidth ?? 0) - 24));
  const h = Math.min(40, canvas.clientHeight || 26);
  if (!w || !h) return;
  const bitmapW = Math.round(w * dpr);
  if (canvas.width !== bitmapW) {
    canvas.width = bitmapW;
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!series || series.length < 2) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of series) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const x = (i) => (w * i) / (series.length - 1);
  const y = (v) => h - 2 - ((v - lo) / span) * (h - 4);

  ctx.beginPath();
  series.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.lineTo(x(series.length - 1), h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function buildCard(summary, currentSelected) {
  const card = document.createElement('article');
  card.className = 'strat';
  card.dataset.id = summary.id;

  const top = document.createElement('div');
  top.className = 'strat-top';
  const title = document.createElement('h3');
  title.textContent = summary.name;
  const rank = document.createElement('span');
  rank.className = 'rank';
  top.append(title, rank);

  const blurb = document.createElement('p');
  blurb.className = 'blurb';
  blurb.textContent = summary.blurb;

  const figures = document.createElement('div');
  const gain = document.createElement('span');
  gain.className = 'gain';
  const delta = document.createElement('span');
  delta.className = 'delta';
  figures.append(gain, delta);

  const spark = document.createElement('canvas');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const fills = document.createElement('span');
  const pos = document.createElement('span');
  const resting = document.createElement('span');
  meta.append(fills, pos, resting);

  const use = document.createElement('button');
  use.className = 'use';
  use.type = 'button';

  const intents = document.createElement('div');
  intents.className = 'intents';
  intents.hidden = true;

  card.append(top, blurb, figures, spark, meta, use, intents);

  const toggle = () => onSelect(currentSelected() === summary.id ? null : summary.id);
  card.addEventListener('click', toggle);
  use.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  cards.set(summary.id, { card, rank, gain, delta, spark, fills, pos, resting, use, intents });
  return card;
}

function describe(intent, fmt) {
  if (intent.kind === 'cancel') return `${intent.clock ?? '—'}  cancel resting`;
  const where = intent.kind === 'make' ? `at ${fmt(intent.price)}` : 'at market';
  return `${intent.clock ?? '—'}  ${intent.side} ${intent.qty} ${where}`;
}

function paintIntents(node, summary, fmt) {
  node.replaceChildren();

  const head = document.createElement('div');
  head.className = 'intents-head';
  head.textContent = 'WOULD DO — NOT SENT';

  const list = document.createElement('ul');
  const recent = summary.intents.slice().reverse();
  if (recent.length === 0) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Nothing so far this session.';
    list.append(li);
  }
  for (const intent of recent) {
    const li = document.createElement('li');
    li.textContent = describe(intent, fmt);
    list.append(li);
  }
  node.append(head, list);
}

export function paintStrategies(state, els, fmt) {
  const list = state.strategies;
  if (!list || list.length === 0) return;

  if (cards.size === 0) {
    els.list.replaceChildren(...list.map((s) => buildCard(s, () => state.selected)));
  }

  const best = list.reduce((a, b) => (b.gain > a.gain ? b : a), list[0]);
  const yours = state.cash;
  els.you.textContent = yours === null ? '—' : fmt(yours);

  for (const summary of list) {
    const c = cards.get(summary.id);
    if (!c) continue;
    const on = state.selected === summary.id;

    c.card.classList.toggle('is-on', on);
    // Only badge a leader once something has actually happened.
    const leading = summary.id === best.id && summary.seeded && summary.fills > 0;
    c.rank.textContent = leading ? 'AHEAD' : '';
    c.rank.classList.toggle('is-best', leading);

    c.gain.textContent = summary.seeded ? fmt(summary.gain) : '—';

    if (summary.seeded && yours !== null) {
      const diff = summary.gain - yours;
      c.delta.textContent = `${diff >= 0 ? '+' : ''}${fmt(diff)} vs you`;
      c.delta.classList.toggle('is-up', diff > 0);
      c.delta.classList.toggle('is-down', diff < 0);
    } else {
      c.delta.textContent = '';
    }

    sparkline(c.spark, summary.series, on ? '#0a5ed7' : '#5a636f');

    c.fills.textContent = `${summary.fills} fills`;
    c.pos.textContent = `${summary.position} left`;
    c.resting.textContent = summary.resting ? `${summary.resting} resting` : '';
    c.use.textContent = on ? 'Selected — not trading' : 'Use this';

    c.intents.hidden = !on;
    if (on) paintIntents(c.intents, summary, fmt);
  }
}
