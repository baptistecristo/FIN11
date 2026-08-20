// Three strategies, built around what Session 1 actually did.
//
// The evidence, from the captured book (genie_orderbook_full.json):
//
//   - the market pinned at the 25,000 cap from minute 19.6 onward, and was
//     still there when the capture ended nine minutes later
//   - there was a bid for 8,687 bottles sitting at the cap; 20 bottles was a
//     rounding error against it, so liquidity was never the constraint
//   - the realised average that session was 8,093 a bottle, against 25,000
//     available for ten minutes straight
//
// So the mistake was not being late to the exit. It was selling cheap into a
// market that was pinned at its own hard maximum.
//
// That gives one rule that does not depend on reading the market at all:
// 25,000 is enforced by the server, so no higher price can ever print. The
// moment the best bid touches it, holding has no upside left and a retreating
// bid is a real risk. Sell. All three strategies share that rule; they differ
// only in what they do on the way up.
//
// None of them buy. Buying pays Vt (about 2) against a price in the thousands,
// so every purchase destroys value. The only exception would be buying below
// the cap to resell at it, and the book crossed just 5 times in 1,403 quote
// updates. Not worth the risk of being caught long at the bell.
//
// A strategy is an object with `onEvent(event, ctx)` returning intents:
//   { kind: 'take', side, qty }           crosses the spread now
//   { kind: 'make', side, qty, price }    rests in the book
//   { kind: 'cancel' }                    pulls its resting orders

const TICK = 0.01;

// "At the cap" needs slack: the book showed bids at both 24,999 and 25,000, and
// a tick below the ceiling is the ceiling for any decision that matters.
const AT_CAP = 0.999;

// Be flat with this much of the session left. Session 1's damage was done when
// everyone tried to leave at once.
const FLAT_AT = 0.08;

const deadline = (ctx) => (ctx.total ?? 3000) * FLAT_AT;
const elapsed = (ctx) => ((ctx.total ?? 3000) - (ctx.clock ?? 0)) / (ctx.total ?? 3000);
const bidPrice = (ctx) => (ctx.best.bid ? ctx.best.bid.price : null);

// Last resort: past the deadline, hit whatever bid is there.
function bellGuard(ctx) {
  if (ctx.position <= 0 || ctx.clock === null) return null;
  if (ctx.clock > deadline(ctx)) return null;
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position }];
}

// The dominance rule. Once the bid is at the ceiling, there is nothing above it
// left to wait for.
function capGuard(ctx) {
  if (ctx.position <= 0) return null;
  const bid = bidPrice(ctx);
  if (bid === null || bid < ctx.cap * AT_CAP) return null;
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position }];
}

const guards = (ctx) => bellGuard(ctx) ?? capGuard(ctx);

// 1 --------------------------------------------------------------------------
// Does nothing but wait for the ceiling, and parks an ask just under it so a
// buyer lifting into the cap fills it on the way.
const capStrike = {
  id: 'cap-strike',
  name: 'Cap strike',
  blurb: 'Waits for the bid to reach 25,000, then sells the lot. Rests an ask under the cap meanwhile.',

  init() {
    return { parked: 0 };
  },

  onEvent(event, ctx) {
    const forced = guards(ctx);
    if (forced) return forced;
    if (ctx.position <= 0) return [];

    // Keep the whole position resting a tick under the cap. Anyone paying the
    // cap lifts it, which is the best fill the game allows.
    if (ctx.memory.parked !== ctx.position) {
      ctx.memory.parked = ctx.position;
      return [
        { kind: 'cancel' },
        { kind: 'make', side: 'sell', qty: ctx.position, price: ctx.cap - TICK },
      ];
    }
    return [];
  },
};

// 2 --------------------------------------------------------------------------
// Sells only into strength: a clip goes out when the bid sets a new session
// high, never otherwise. Its average price can only improve over the session,
// which is the direct fix for what went wrong in Session 1.
const RATCHET_CLIP = 0.25; // fraction of the remaining position per step
const RATCHET_FLOOR = 0.4; // refuse to sell below this share of the cap
const RATCHET_STEP = 0.35; // each clip must beat the last sale by this much

const ratchet = {
  id: 'ratchet',
  name: 'Ratchet',
  blurb: 'Refuses to sell below 40% of the cap, and every clip must beat the last sale by 35%.',

  init() {
    return { lastSale: 0 };
  },

  onEvent(event, ctx) {
    const forced = guards(ctx);
    if (forced) return forced;
    if (event.t !== 'quote' || event.side !== 'bid' || ctx.position <= 0) return [];

    const bid = bidPrice(ctx);
    if (bid === null) return [];

    // Selling on every new high is the Session 1 mistake in disguise: in a
    // market that climbs steadily, every tick is a new high, so the position
    // leaves early and cheap. The bar is a price ladder instead, so each clip
    // is materially better than the one before it.
    const bar = ctx.memory.lastSale > 0
      ? ctx.memory.lastSale * (1 + RATCHET_STEP)
      : ctx.cap * RATCHET_FLOOR;
    if (bid < bar) return [];

    ctx.memory.lastSale = bid;
    const clip = Math.max(1, Math.ceil(ctx.position * RATCHET_CLIP));
    return [{ kind: 'take', side: 'sell', qty: clip }];
  },
};

// 3 --------------------------------------------------------------------------
// Holds through the whole climb and leaves in one move when the market breaks
// far enough off its high. Highest ceiling of the three, and the only one that
// can be badly wrong if the break never comes cleanly.
const DRAWDOWN = 0.04; // how far off the session high counts as a break
const ARM_AFTER = 0.2; // do not treat an early dip as a top

const trailingPeak = {
  id: 'trailing-peak',
  name: 'Trailing peak',
  blurb: 'Holds through the climb, sells everything once price breaks 4% off its session high.',

  init() {
    return { high: 0 };
  },

  onEvent(event, ctx) {
    const forced = guards(ctx);
    if (forced) return forced;
    if (event.t !== 'trade' || ctx.position <= 0) return [];

    if (event.price > ctx.memory.high) {
      ctx.memory.high = event.price;
      return [];
    }
    if (elapsed(ctx) < ARM_AFTER) return [];
    if (event.price >= ctx.memory.high * (1 - DRAWDOWN)) return [];

    return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position }];
  },
};

export const strategies = [capStrike, ratchet, trailingPeak];
