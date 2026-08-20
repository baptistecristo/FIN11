// Viewer wiring: consume the hub's event stream, keep local state, paint.

import { drawChart } from './chart.js';

const $ = (id) => document.getElementById(id);

const el = {
  feed: $('feed'), feedLabel: $('feed-label'), mode: $('mode'), security: $('security'),
  countdown: $('countdown'), bidWho: $('bid-who'), askWho: $('ask-who'),
  chart: $('chart'), chartEmpty: $('chart-empty'), lastReadout: $('last-readout'),
  gutterSpent: $('gutter-spent'), gutterFlat: $('gutter-flat'), gutterNote: $('gutter-note'),
  tape: $('tape'), tapeScroll: $('tape-scroll'), tapeHead: $('tape-head'), tapeEmpty: $('tape-empty'),
  hold: $('hold'), resume: $('resume'),
  cash: $('cash'), position: $('position'), vt: $('vt'), total: $('total'),
  fillCount: $('fill-count'),
  frames: $('frames'), notice: $('notice'),
};

// Liquidation horizon: be flat with this much of the session left. Bottles are
// worth zero at the bell, so the last minutes are where sellers get trapped.
const FLAT_BY_FRACTION = 0.1;
const MAX_ROWS = 400;
// A full session prints far fewer than this; the cap only guards against a
// runaway feed eating the window's memory.
const MAX_POINTS = 20000;

// One curve point per filled trade.
const pointOf = (trade) => ({ clock: trade.clock, price: trade.price, tick: trade.tick });

const state = {
  mode: 'live', connected: false, frames: 0,
  security: null, clock: null, total: 3000, session: 'unknown',
  cash: null, position: null, vt: null,
  best: { bid: null, ask: null },
  points: [], myfills: [],
  lastPrice: null, lastTick: 0,
};

let tab = 'market';
let held = false;
const buffered = { market: [], mine: [], raw: [] };
let pendingWhileHeld = 0;
let chartDirty = true;

// ---------------------------------------------------------------- formatting

const fmt = (v, dp = 2) =>
  v === null || v === undefined || Number.isNaN(v)
    ? '—'
    : v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

// Integer part at full weight, decimals stepped down. Applied to every figure.
function setFigure(node, value, dp = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    node.textContent = '—';
    return;
  }
  const text = fmt(value, dp);
  const dot = text.lastIndexOf('.');
  if (dot === -1 || dp === 0) {
    node.textContent = text;
    return;
  }
  node.textContent = '';
  node.append(text.slice(0, dot));
  const frac = document.createElement('span');
  frac.className = 'frac';
  frac.textContent = text.slice(dot);
  node.append(frac);
}

// Game clock to minutes:seconds. One clock unit is one second of real time.
function asTime(units) {
  if (units === null || units === undefined) return '—';
  const s = Math.max(0, Math.round(units));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- tape

// Cells are built as nodes and filled with textContent. Trader names and raw
// message bodies come off the wire, so nothing from the feed is ever parsed
// as markup.
function cell(className, text) {
  const span = document.createElement('span');
  span.className = className;
  if (text !== undefined) span.textContent = text;
  return span;
}

function rowMarket(trade) {
  if (trade.mine) return rowMine(trade);
  const li = document.createElement('li');
  li.className = trade.tick > 0 ? 'up is-new' : trade.tick < 0 ? 'down is-new' : 'is-new';
  if (!trade.qtyKnown) li.classList.add('est');
  const px = cell('px');
  setFigure(px, trade.price);
  // The server never names the parties to a trade. This is whoever was resting
  // at the price, so it is shown dimmed and prefixed to read as an inference.
  const who = cell('who', trade.restingTrader ? `~${trade.restingTrader}` : '');
  if (trade.restingSide) who.classList.add(`who-${trade.restingSide}`);
  li.append(
    cell('clk', trade.clock ?? '—'),
    who,
    px,
    // A qty the server did not send is shown as a guess, not as fact.
    cell('qty', trade.qtyKnown ? String(trade.qty) : `${trade.qty}?`),
    cell('dir', trade.tick > 0 ? '▲' : trade.tick < 0 ? '▼' : '·'),
  );
  return li;
}

function rowMine(fill) {
  const li = document.createElement('li');
  li.className = `mine mine-${fill.side} is-new`;
  const px = cell('px');
  if (fill.price === null) px.textContent = 'unpriced';
  else setFigure(px, fill.price);
  li.append(
    // The clock stays: knowing when you filled is the point of the row. The
    // "you" badge is drawn by CSS so it costs no column width.
    cell('clk', fill.clock ?? '—'),
    cell('who', ''),
    px,
    cell('qty', String(fill.qty)),
    cell('dir', fill.side === 'buy' ? '▲' : '▼'),
  );
  return li;
}

function rowRaw(entry) {
  const li = document.createElement('li');
  li.className = 'raw is-new';
  const body = JSON.stringify(entry.msg);
  li.append(
    cell('hdr', entry.header),
    cell('body', body.length > 160 ? `${body.slice(0, 160)}…` : body),
  );
  return li;
}

const builders = { market: rowMarket, mine: rowMine, raw: rowRaw };

function push(kind, item) {
  buffered[kind].push(item);
  if (buffered[kind].length > MAX_ROWS) buffered[kind].shift();
  if (kind !== tab) return;
  if (held) {
    pendingWhileHeld += 1;
    el.resume.textContent = `${pendingWhileHeld} new — release hold`;
    el.resume.hidden = false;
    return;
  }
  prepend(builders[kind](item));
}

function prepend(node) {
  el.tape.prepend(node);
  el.tapeEmpty.hidden = true;
  while (el.tape.children.length > MAX_ROWS) el.tape.lastElementChild.remove();
}

function repaintTape() {
  el.tape.replaceChildren();
  const items = buffered[tab];
  // Newest first, so the row you care about is always at the top.
  for (const item of items.slice(-MAX_ROWS)) {
    const node = builders[tab](item);
    node.classList.remove('is-new');
    el.tape.prepend(node);
  }
  el.tapeEmpty.hidden = items.length > 0;
  el.tapeEmpty.textContent =
    tab === 'mine'
      ? 'No fills of your own yet. These are derived from your cash and position as they change.'
      : tab === 'raw'
        ? 'No frames yet.'
        : 'No trades yet.';
  el.tapeHead.style.display = tab === 'raw' ? 'none' : '';
  el.tapeScroll.scrollTop = 0;
}

el.hold.addEventListener('click', () => {
  held = !held;
  el.hold.setAttribute('aria-pressed', String(held));
  el.hold.textContent = held ? 'Held' : 'Hold';
  if (!held) {
    pendingWhileHeld = 0;
    el.resume.hidden = true;
    repaintTape();
  }
});

el.resume.addEventListener('click', () => {
  held = false;
  el.hold.setAttribute('aria-pressed', 'false');
  el.hold.textContent = 'Hold';
  pendingWhileHeld = 0;
  el.resume.hidden = true;
  repaintTape();
});

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('is-on', other === button);
      other.setAttribute('aria-selected', String(other === button));
    }
    tab = button.dataset.tape;
    pendingWhileHeld = 0;
    el.resume.hidden = true;
    repaintTape();
  });
}

// ---------------------------------------------------------------- panels

function paintStatus() {
  const replay = state.mode === 'replay';
  // Never say "live" over replayed data — the whole point of the badge is to
  // tell you at a glance whether what you are watching is really happening.
  if (state.connected) {
    el.feed.dataset.state = replay ? 'replay' : 'live';
    el.feedLabel.textContent = replay ? 'Replay' : 'Live';
  } else {
    el.feed.dataset.state = state.frames > 0 ? 'stale' : 'waiting';
    el.feedLabel.textContent = state.frames > 0 ? 'Stale' : 'Waiting';
  }
  el.mode.hidden = !replay;
  el.mode.textContent = 'not a live market';
  el.frames.textContent = `${state.frames.toLocaleString('en-US')} frames`;
  if (state.security) el.security.textContent = state.security;
}

function paintClock() {
  el.countdown.textContent = asTime(state.clock);

  const flatAt = state.total * FLAT_BY_FRACTION;
  const urgent = state.clock !== null && state.clock <= flatAt;
  el.countdown.classList.toggle('is-urgent', urgent);

  const spent = state.clock === null ? 0 : Math.min(100, Math.max(0, ((state.total - state.clock) / state.total) * 100));
  el.gutterSpent.style.width = `${spent}%`;
  el.gutterFlat.style.left = `${(1 - FLAT_BY_FRACTION) * 100}%`;

  if (state.session === 'end') el.gutterNote.textContent = 'Session closed — bottles are worth zero';
  else if (urgent && state.position) el.gutterNote.textContent = `Past the flat marker with ${state.position} bottles left`;
  else el.gutterNote.textContent = 'Bottles expire worthless at the bell';
}

function paintAccount() {
  setFigure(el.cash, state.cash);
  setFigure(el.position, state.position, 0);
  setFigure(el.vt, state.vt);
  el.fillCount.textContent = state.myfills.length ? String(state.myfills.length) : '—';
  // Ranking formula: cash + accrued realized utility + 0 x bottles. Utility is
  // private and never reaches the wire, so this shows the cash side alone.
  setFigure(el.total, state.cash);
}

function paintTopOfBook() {
  const name = (q) => (q && q.trader ? q.trader : q ? 'unnamed' : '—');
  el.bidWho.textContent = name(state.best.bid);
  el.askWho.textContent = name(state.best.ask);
}

function paintLast() {
  if (state.lastPrice === null) {
    el.lastReadout.textContent = '—';
    return;
  }
  setFigure(el.lastReadout, state.lastPrice);
  el.lastReadout.classList.toggle('is-up', state.lastTick > 0);
  el.lastReadout.classList.toggle('is-down', state.lastTick < 0);
}

// One paint per frame regardless of how many events landed, so a burst cannot
// stall the window.
function frame() {
  if (chartDirty) {
    chartDirty = false;
    el.chartEmpty.hidden = state.points.length > 0;
    drawChart(el.chart, state);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let panelsQueued = false;
function schedulePanels() {
  if (panelsQueued) return;
  panelsQueued = true;
  requestAnimationFrame(() => {
    panelsQueued = false;
    paintStatus();
    paintClock();
    paintAccount();
    paintTopOfBook();
    paintLast();
  });
}

window.addEventListener('resize', () => {
  chartDirty = true;
});

// ---------------------------------------------------------------- events

function applySnapshot(snap) {
  Object.assign(state, {
    mode: snap.mode, connected: snap.connected, frames: snap.frames,
    security: snap.security, clock: snap.clock, total: snap.total || 3000,
    session: snap.session, cash: snap.cash, position: snap.position, vt: snap.vt,
    best: snap.best || { bid: null, ask: null },
    myfills: snap.myfills || [],
  });
  // The curve is the fills, so it rebuilds straight from the trade history.
  state.points = (snap.trades || []).map(pointOf);
  // Rebuild the combined stream in session order: the clock counts down, so a
  // lower clock is later.
  buffered.market = [...(snap.trades || []), ...(snap.myfills || []).map((f) => ({ ...f, mine: true }))]
    .sort((a, b) => (b.clock ?? 0) - (a.clock ?? 0))
    .slice(-MAX_ROWS);
  buffered.mine = (snap.myfills || []).slice(-MAX_ROWS);
  const lastTrade = buffered.market.at(-1);
  if (lastTrade) {
    state.lastPrice = lastTrade.price;
    state.lastTick = lastTrade.tick;
  }
  repaintTape();
  chartDirty = true;
  schedulePanels();
}

function apply(event) {
  switch (event.t) {
    case 'snapshot':
      applySnapshot(event.state);
      return;
    case 'status':
      state.connected = event.connected;
      state.frames = event.frames;
      state.mode = event.mode;
      if (Object.keys(event.unknownHeaders || {}).length) {
        el.notice.textContent = `Unrecognised message types: ${Object.keys(event.unknownHeaders).join(', ')} — check the raw feed`;
      }
      break;
    case 'meta':
      state.security = event.security;
      break;
    case 'clock':
      state.clock = event.clock;
      if (event.total) state.total = event.total;
      break;
    case 'session':
      state.session = event.state;
      if (event.total) state.total = event.total;
      if (event.state === 'start') {
        state.points = [];
        state.myfills = [];
        buffered.market = [];
        buffered.mine = [];
        repaintTape();
      }
      chartDirty = true;
      break;
    case 'trade':
      state.lastPrice = event.price;
      state.lastTick = event.tick;
      // Every fill extends the curve by exactly one point.
      state.points.push(pointOf(event));
      if (state.points.length > MAX_POINTS) state.points.shift();
      push('market', event);
      chartDirty = true;
      break;
    // The depth ladder is not shown, but the name on the quote is the only
    // place the server ever tells you who is who, so that part is kept.
    case 'quote':
      state.best[event.side] = event.price === null
        ? null
        : { price: event.price, qty: event.qty, trader: event.trader };
      break;
    case 'curve':
      return;
    case 'account':
      state.cash = event.cash;
      state.position = event.position;
      if (event.vt !== null && event.vt !== undefined) state.vt = event.vt;
      break;
    case 'myfill':
      state.myfills.push(event);
      push('mine', event);
      // Also into the main stream: a fill of yours is the most important row
      // that will ever appear there, and it should not need a tab switch.
      push('market', { ...event, mine: true });
      chartDirty = true;
      break;
    case 'info':
      if (event.vt !== null && event.vt !== undefined) state.vt = event.vt;
      break;
    case 'error':
      el.notice.textContent = event.text;
      break;
    case 'raw':
      push('raw', event);
      return;
    default:
      return;
  }
  schedulePanels();
}

function connect() {
  const source = new EventSource('/events');
  source.onmessage = (e) => {
    try {
      apply(JSON.parse(e.data));
    } catch {
      /* a malformed line must not stop the stream */
    }
  };
  source.onerror = () => {
    // EventSource reconnects on its own; surface the gap without tearing down.
    state.connected = false;
    el.notice.textContent = 'Lost the hub — retrying. Is the hub still running?';
    schedulePanels();
  };
  source.onopen = () => {
    el.notice.textContent = '';
  };
}

repaintTape();
schedulePanels();
connect();
