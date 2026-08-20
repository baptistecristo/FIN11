// Price curve, built from filled trades.
//
// One point per fill, in the order they printed. The line between points is
// step-after because a traded price holds until the next trade actually happens
// — drawing a slope there would invent prices the market never made.
//
// The x-axis is the game clock, which counts DOWN from the session length, so
// left is the open and right is the bell.

const CAP = 25000; // Server-enforced price cap.

const COLOR = {
  grid: '#1f2434',
  gridText: '#6d7690',
  line: '#e8ebf4',
  dot: '#aeb6c9',
  up: '#3fbf7f',
  down: '#ef5b64',
  amber: '#f0a03c',
  ground: '#10131c',
};

const PAD = { top: 12, right: 66, bottom: 22, left: 10 };

function niceTicks(min, max, count) {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return [min];
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  // A zero or non-finite step would spin this loop forever and freeze the
  // window. Nothing about a chart is worth that risk mid-session.
  if (!Number.isFinite(step) || step <= 0) return [min, max];
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max && ticks.length < 40; v += step) ticks.push(v);
  return ticks;
}

function formatTick(v) {
  // Rounding can land on -0, which reads as a negative price.
  const n = Object.is(v, -0) ? 0 : v;
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function drawChart(canvas, state) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;

  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const points = state.points;
  if (!points || points.length === 0) return;

  const total = state.total || 3000;
  const plotW = cssW - PAD.left - PAD.right;
  const plotH = cssH - PAD.top - PAD.bottom;
  if (plotW <= 0 || plotH <= 0) return;

  // Domain from traded prices and your own fills — the only two things drawn.
  //
  // Set by the bulk of prints rather than by min/max: a market pinned near the
  // cap with two stray prints far below would otherwise squash all the real
  // action into the top sliver of the pane. Prints outside the domain still
  // draw, clipped, which reads correctly as "off the scale".
  const prices = [];
  for (const p of points) if (Number.isFinite(p.price)) prices.push(p.price);
  if (prices.length === 0) return;
  const sorted = [...prices].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

  let lo = at(0.01);
  let hi = at(0.99);
  const consider = (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  // The latest price and your own fills are always in view, whatever the spread
  // of the rest — those are the two things you are actually looking for.
  consider(points[points.length - 1].price);
  for (const f of state.myfills || []) consider(f.price);
  if (!(hi > lo)) {
    // Every print at one price: give the line somewhere to sit.
    const centre = hi;
    lo = centre - Math.max(centre * 0.002, 0.5);
    hi = centre + Math.max(centre * 0.002, 0.5);
  }

  // The cap only enters the scale once the market is trading near it, so it
  // does not squash the curve for the whole session.
  const showCap = hi > CAP * 0.75;
  if (showCap) hi = Math.max(hi, CAP);
  const pad = (hi - lo) * 0.1 || Math.max(hi * 0.01, 1);
  lo -= pad;
  hi += pad;

  const x = (clock) => PAD.left + (plotW * Math.min(Math.max(total - clock, 0), total)) / total;
  const y = (price) => PAD.top + plotH * (1 - (price - lo) / (hi - lo));

  // --- grid and price axis -------------------------------------------------
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const v of niceTicks(lo, hi, 5)) {
    const py = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = COLOR.grid;
    ctx.beginPath();
    ctx.moveTo(PAD.left, py);
    ctx.lineTo(PAD.left + plotW, py);
    ctx.stroke();
    ctx.fillStyle = COLOR.gridText;
    ctx.textAlign = 'left';
    ctx.fillText(formatTick(v), PAD.left + plotW + 8, py);
  }

  const perMinute = total / 50;
  ctx.textAlign = 'center';
  for (let minute = 10; minute < 50; minute += 10) {
    const px = Math.round(x(total - minute * perMinute)) + 0.5;
    ctx.strokeStyle = COLOR.grid;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, PAD.top + plotH);
    ctx.stroke();
    ctx.fillStyle = COLOR.gridText;
    ctx.fillText(`${minute}m`, px, cssH - PAD.bottom / 2);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, plotW, plotH);
  ctx.clip();

  // --- price cap -----------------------------------------------------------
  if (showCap) {
    const py = Math.round(y(CAP)) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLOR.amber;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(PAD.left, py);
    ctx.lineTo(PAD.left + plotW, py);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = COLOR.amber;
    ctx.textAlign = 'left';
    ctx.fillText('cap', PAD.left + 4, py + 9);
  }

  // --- the curve -----------------------------------------------------------
  ctx.beginPath();
  let prevY = null;
  points.forEach((p, i) => {
    const px = x(p.clock);
    const py = y(p.price);
    if (i === 0) ctx.moveTo(px, py);
    else {
      ctx.lineTo(px, prevY);
      ctx.lineTo(px, py);
    }
    prevY = py;
  });
  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // One dot per fill, so the curve visibly assembles print by print.
  //
  // Over the whole series the dots merge into a smear once prints get dense, so
  // they are drawn everywhere only while the series is sparse. The newest prints
  // always get dots regardless: the growing tip is the part you watch, and it
  // should always read as discrete trades rather than as a line.
  const spacing = plotW / Math.max(1, points.length);
  const from = spacing > 3.2 ? 0 : Math.max(0, points.length - 40);
  for (let i = from; i < points.length; i += 1) {
    const p = points[i];
    ctx.beginPath();
    ctx.arc(x(p.clock), y(p.price), 2.1, 0, Math.PI * 2);
    ctx.fillStyle = p.tick > 0 ? COLOR.up : p.tick < 0 ? COLOR.down : COLOR.dot;
    ctx.fill();
  }

  // --- your fills ----------------------------------------------------------
  // Drawn last and loudest: a full-height stem so the moment is findable at a
  // glance, then a marker on the price, then the size. These are the only
  // events on the chart you actually did.
  for (const fill of state.myfills || []) {
    if (fill.price === null || fill.price === undefined || fill.clock === null) continue;
    const px = Math.round(x(fill.clock)) + 0.5;
    const py = y(fill.price);

    ctx.save();
    ctx.strokeStyle = COLOR.amber;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, PAD.top);
    ctx.lineTo(px, PAD.top + plotH);
    ctx.stroke();
    ctx.restore();

    const r = 6.5;
    ctx.beginPath();
    // Buys point up, sells point down.
    if (fill.side === 'buy') {
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py + r * 0.8);
      ctx.lineTo(px - r, py + r * 0.8);
    } else {
      ctx.moveTo(px, py + r);
      ctx.lineTo(px + r, py - r * 0.8);
      ctx.lineTo(px - r, py - r * 0.8);
    }
    ctx.closePath();
    ctx.fillStyle = COLOR.amber;
    ctx.fill();
    ctx.strokeStyle = COLOR.ground;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    ctx.font = 'bold 10px ui-monospace, Consolas, monospace';
    ctx.fillStyle = COLOR.amber;
    ctx.textAlign = 'center';
    const label = `${fill.side === 'buy' ? '+' : '−'}${fill.qty}`;
    ctx.fillText(label, px, fill.side === 'buy' ? py - r - 7 : py + r + 12);
    ctx.font = '11px ui-monospace, Consolas, monospace';
  }

  ctx.restore();

  // --- leading edge --------------------------------------------------------
  // The newest print, held out to the current clock, so the curve visibly has a
  // growing tip rather than just ending somewhere in the pane.
  const latest = points[points.length - 1];
  if (latest && state.clock !== null && state.clock !== undefined) {
    const py = y(latest.price);
    const from = x(latest.clock);
    const to = x(state.clock);
    if (to > from) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(232, 235, 244, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from, py);
      ctx.lineTo(to, py);
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(to, py, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.line;
    ctx.fill();
  }
}
