// Three placeholder strategies.
//
// Scaffolding for the panel, not researched edges. Every number that shapes
// behaviour sits at the top of its strategy so it can be changed without
// reading the logic, and all three share one hard rule: be flat before the
// bell, because bottles pay nothing there.
//
// A strategy is an object with `onEvent(event, ctx)` returning intents:
//   { kind: 'take', side: 'sell'|'buy', qty }            crosses the spread now
//   { kind: 'make', side, qty, price }                   rests in the book
//   { kind: 'cancel' }                                   pulls its resting orders
//
// ctx: { clock, total, best, last, vt, position, cash, resting, memory, cap }

// Be flat once this much of the session remains. Session 4's damage was done in
// the last stretch, when everyone tried to leave at once.
const FLAT_AT = 0.1;

const flatDeadline = (ctx) => (ctx.total ?? 3000) * FLAT_AT;
const elapsed = (ctx) => ((ctx.total ?? 3000) - (ctx.clock ?? 0)) / (ctx.total ?? 3000);

// Shared last resort: past the deadline, hit whatever bid is there.
function bailOut(ctx) {
  if (ctx.position <= 0) return [];
  if (ctx.clock === null || ctx.clock > flatDeadline(ctx)) return [];
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position }];
}

// 1 --------------------------------------------------------------------------
// Sells on a schedule and ignores price entirely. The control: any strategy
// worth using has to beat just leaving steadily.
const LADDER_CLIP_INTERVAL = 120; // game-clock units between clips

const ladderOut = {
  id: 'ladder-out',
  name: 'Ladder out',
  blurb: 'Sells a steady clip on a schedule, ignoring price. The control.',

  init({ position }) {
    return { start: position, lastClip: null };
  },

  onEvent(event, ctx) {
    if (event.t !== 'clock') return [];
    const bail = bailOut(ctx);
    if (bail.length) return bail;
    if (ctx.position <= 0 || ctx.clock === null) return [];

    if (ctx.memory.lastClip !== null && ctx.memory.lastClip - ctx.clock < LADDER_CLIP_INTERVAL) {
      return [];
    }
    ctx.memory.lastClip = ctx.clock;

    // Straight line from the open to the flat deadline: hold the position that
    // the schedule says you should hold by now, and sell off any excess.
    const deadline = flatDeadline(ctx);
    const span = (ctx.total ?? 3000) - deadline;
    const left = Math.max(0, ctx.clock - deadline);
    const target = Math.ceil((ctx.memory.start ?? ctx.position) * (left / span));
    const excess = ctx.position - target;
    return excess > 0 ? [{ kind: 'take', side: 'sell', qty: excess }] : [];
  },
};

// 2 --------------------------------------------------------------------------
// Holds everything for the top, then leaves in one go. Highest ceiling of the
// three, and the one most likely to be caught holding.
const CAP_PROXIMITY = 0.98; // "near the cap" means within 2% of it
const STALL_PRINTS = 12; // prints near the cap without a new high

const holdToCap = {
  id: 'hold-to-cap',
  name: 'Hold to cap',
  blurb: 'Holds for the top, then dumps once price stalls near the 25,000 cap.',

  init() {
    return { high: 0, stalled: 0, dumping: false };
  },

  onEvent(event, ctx) {
    const bail = bailOut(ctx);
    if (bail.length) return bail;
    if (event.t !== 'trade' || ctx.position <= 0) return [];

    const m = ctx.memory;
    if (event.price > m.high) {
      m.high = event.price;
      m.stalled = 0;
      return [];
    }

    // Only count a stall once the market is actually up near the cap. Flat
    // trading at a low price is not a top.
    if (event.price < ctx.cap * CAP_PROXIMITY) return [];
    m.stalled += 1;
    if (m.stalled < STALL_PRINTS || m.dumping) return [];

    m.dumping = true;
    return [{ kind: 'take', side: 'sell', qty: ctx.position }];
  },
};

// 3 --------------------------------------------------------------------------
// Rides the move and starts leaving on the first real reversal. Between the
// other two: gives up some of the top, but is not still holding when it breaks.
const REVERSAL_TICKS = 4; // consecutive downticks that count as a turn
const DRAWDOWN = 0.05; // or this far off the session high
const EXIT_CLIP = 0.34; // fraction of the remaining position per clip

const sellOnReversal = {
  id: 'sell-on-reversal',
  name: 'Sell on reversal',
  blurb: 'Rides the move, then unloads in clips on the first sustained turn.',

  init() {
    return { high: 0, downticks: 0, exiting: false };
  },

  onEvent(event, ctx) {
    const bail = bailOut(ctx);
    if (bail.length) return bail;
    if (event.t !== 'trade' || ctx.position <= 0) return [];

    const m = ctx.memory;
    if (event.price > m.high) m.high = event.price;
    m.downticks = event.tick < 0 ? m.downticks + 1 : 0;

    const brokeDown = m.downticks >= REVERSAL_TICKS;
    const fellFar = m.high > 0 && event.price < m.high * (1 - DRAWDOWN);
    if (!m.exiting && !(brokeDown || fellFar)) return [];

    // Wait for the market to have actually run before treating a dip as a top.
    if (!m.exiting && elapsed(ctx) < 0.2) return [];

    m.exiting = true;
    m.downticks = 0;
    const clip = Math.max(1, Math.ceil(ctx.position * EXIT_CLIP));
    return [{ kind: 'take', side: 'sell', qty: clip }];
  },
};

export const strategies = [ladderOut, holdToCap, sellOnReversal];
