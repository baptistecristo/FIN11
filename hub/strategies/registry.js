// Four strategies, built around what Session 1 actually did.
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
// market pinned at its own hard maximum. That gives one rule that needs no
// market reading at all: 25,000 is enforced by the server, so no higher price
// can ever print. Once the best bid touches it, holding has no upside left.
// Every strategy here shares that rule, plus a reservation price that decays to
// zero as the bell approaches, because bottles pay nothing when it rings.
//
// A strategy is an object with `onEvent(event, ctx)` returning intents:
//   { kind: 'take', side, qty }           crosses the spread now
//   { kind: 'make', side, qty, price }    rests in the book
//   { kind: 'cancel' }                    pulls its resting orders
// Add `urgent: true` to jump the routine rate limit.
//
// ctx: { clock, total, best, last, vt, position, cash, resting, memory, cap }

const TICK = 0.01;

// "At the cap" needs slack: the book showed bids at both 24,999 and 25,000, and
// a tick below the ceiling is the ceiling for any decision that matters.
const AT_CAP = 0.999;

// Near enough to the ceiling to act on. Set tight: Session 1's bid sat at the
// cap for ten minutes, so a loose band gives away real money for protection
// against a retreat that did not happen. 0.97 still exits at 24,250 without
// waiting on the exact number.
const NEAR_CAP = 0.97;

// Be flat with this much of the session left. Session 1's damage was done when
// everyone tried to leave at once.
const FLAT_AT = 0.08;

const deadline = (ctx) => (ctx.total ?? 3000) * FLAT_AT;
const elapsed = (ctx) => ((ctx.total ?? 3000) - (ctx.clock ?? 0)) / (ctx.total ?? 3000);
const bidPrice = (ctx) => (ctx.best.bid ? ctx.best.bid.price : null);
const askPrice = (ctx) => (ctx.best.ask ? ctx.best.ask.price : null);

// Last resort: past the deadline, hit whatever bid is there.
function bellGuard(ctx) {
  if (ctx.position <= 0 || ctx.clock === null) return null;
  if (ctx.clock > deadline(ctx)) return null;
  // Urgent: nothing routine may delay beating the bell.
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
}

// The dominance rule. Once the bid is at the ceiling there is nothing above it
// left to wait for.
function capGuard(ctx) {
  if (ctx.position <= 0) return null;
  const bid = bidPrice(ctx);
  if (bid === null || bid < ctx.cap * AT_CAP) return null;
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
}

// Fallback for a session that never reaches the cap.
//
// Session 1 reached the cap at minute 19.6, with 61% of the clock still to run.
// Conceding from halfway would have sold into that climb for no reason, so this
// stays quiet until well past it, and only speaks when the cap looks genuinely
// out of reach.
const DECAY_FROM = 0.3; // hold until 70% of the session has gone
const CAP_IN_REACH = 0.85; // a high this close means the cap rule owns it
const DECAY_CLIP = 0.34;

function noteHigh(ctx, price) {
  if (price > (ctx.memory.sessionHigh ?? 0)) ctx.memory.sessionHigh = price;
}

function reservePrice(ctx) {
  const high = ctx.memory.sessionHigh ?? 0;
  if (high <= 0 || ctx.clock === null) return null;
  const total = ctx.total ?? 3000;
  const start = total * DECAY_FROM;
  const end = deadline(ctx);
  // Silent until the concession window opens. A reserve equal to the high would
  // fire on every touch of a new high, hijacking the strategy it backs up.
  if (ctx.clock >= start) return null;
  if (ctx.clock <= end) return 0;
  return high * ((ctx.clock - end) / (start - end));
}

function decayGuard(ctx) {
  if (ctx.position <= 0) return null;
  // A market already near the ceiling does not need a fallback; the cap rule
  // will take it, at a better price than any concession.
  if ((ctx.memory.sessionHigh ?? 0) >= ctx.cap * CAP_IN_REACH) return null;
  const bid = bidPrice(ctx);
  const reserve = reservePrice(ctx);
  if (bid === null || reserve === null || bid < reserve) return null;
  if (ctx.memory.lastConcession === bid) return null;
  ctx.memory.lastConcession = bid;
  const clip = Math.max(1, Math.ceil(ctx.position * DECAY_CLIP));
  // Pull resting orders first: a parked ask commits the position, and a sell
  // that would exceed what is left is refused outright as a short.
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: clip }];
}

// Order matters: the bell is absolute, the cap is the ceiling, and the decay
// only speaks once neither of those has.
const guards = (ctx) => bellGuard(ctx) ?? capGuard(ctx) ?? decayGuard(ctx);

const baseMemory = () => ({ sessionHigh: 0, lastConcession: null });

// 1 --------------------------------------------------------------------------
// Waits for the ceiling and parks an ask under it so a buyer lifting into the
// cap fills it on the way.
const capStrike = {
  id: 'cap-strike',
  name: 'Cap strike',
  blurb: 'Waits for the bid to reach the cap, then sells the lot. Concedes on a decaying reserve if the cap never comes.',

  init() {
    return { ...baseMemory(), parked: 0 };
  },

  onEvent(event, ctx) {
    if (event.t === 'trade') noteHigh(ctx, event.price);
    const forced = guards(ctx);
    if (forced) return forced;
    if (ctx.position <= 0) return [];

    // Near the ceiling is worth taking. The gap between 23,500 and 25,000 is
    // small next to the risk of the bid retreating while you hold out for it.
    const bid = bidPrice(ctx);
    if (bid !== null && bid >= ctx.cap * NEAR_CAP) {
      return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
    }

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
// Sells on a rising price ladder. Selling on every new high is the Session 1
// mistake in disguise, since in a climbing market every tick is a new high, so
// the bar is a price step: each clip must beat the last sale by a wide margin,
// and nothing goes below a floor.
const RATCHET_FLOOR = 0.4; // refuse to sell below this share of the cap
const RATCHET_STEP = 0.35; // each clip must beat the last sale by this much

const ratchet = {
  id: 'ratchet',
  name: 'Ratchet',
  blurb: 'Refuses to sell below 40% of the cap, and every clip must beat the last sale by 35%.',

  init() {
    return { ...baseMemory(), lastSale: 0, clips: 0 };
  },

  onEvent(event, ctx) {
    if (event.t === 'trade') noteHigh(ctx, event.price);
    const forced = guards(ctx);
    if (forced) return forced;
    if (event.t !== 'quote' || event.side !== 'bid' || ctx.position <= 0) return [];

    const bid = bidPrice(ctx);
    if (bid === null) return [];

    const bar = ctx.memory.lastSale > 0
      ? ctx.memory.lastSale * (1 + RATCHET_STEP)
      : ctx.cap * RATCHET_FLOOR;
    if (bid < bar) return [];

    ctx.memory.lastSale = bid;
    ctx.memory.clips += 1;
    // Small clips early, larger later. Each rung up is better information about
    // how far this market will run, so commit more once it has proved itself
    // rather than guessing at the first step.
    const share = Math.min(0.5, 0.15 + 0.1 * ctx.memory.clips);
    const clip = Math.max(1, Math.ceil(ctx.position * share));
    return [{ kind: 'take', side: 'sell', qty: clip }];
  },
};

// 3 --------------------------------------------------------------------------
// Rides the climb and leaves on a genuine break. The first version used a 4%
// band with no confirmation and got shaken out by ordinary noise on the way up,
// finishing far behind the others. It now needs a wider break, several prints
// to confirm it, and evidence the market actually ran first.
const DRAWDOWN = 0.08; // how far off the session high counts as a break
const CONFIRM_PRINTS = 3; // consecutive prints below the trigger
const RUN_MULTIPLE = 1.5; // the market must have moved this much off its open
const ARM_AFTER = 0.2;

const trailingPeak = {
  id: 'trailing-peak',
  name: 'Trailing peak',
  blurb: 'Rides the climb, then sells everything once price breaks 8% off its high, confirmed over three prints.',

  init() {
    return { ...baseMemory(), open: 0, below: 0 };
  },

  onEvent(event, ctx) {
    if (event.t === 'trade') noteHigh(ctx, event.price);
    const forced = guards(ctx);
    if (forced) return forced;
    if (event.t !== 'trade' || ctx.position <= 0) return [];

    const m = ctx.memory;
    if (m.open === 0) m.open = event.price;
    if (event.price >= m.sessionHigh) {
      m.below = 0;
      return [];
    }
    if (elapsed(ctx) < ARM_AFTER) return [];
    // Do not treat a wobble as a top before the market has gone anywhere.
    if (m.sessionHigh < m.open * RUN_MULTIPLE) return [];

    if (event.price >= m.sessionHigh * (1 - DRAWDOWN)) {
      m.below = 0;
      return [];
    }
    m.below += 1;
    if (m.below < CONFIRM_PRINTS) return [];

    return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
  },
};

// 4 --------------------------------------------------------------------------
// Corner: buy the float cheaply in the opening minutes, then sell it into the
// bubble.
//
// The economics first, because they bound everything else. Cornering cannot
// create demand here: bottles pay zero at the bell and Vt is about 2, so nobody
// ever needs to buy them from you. Squeezing the supply just leaves you holding
// all of it. The reason to do it anyway is that Session 1's market ran to the
// 25,000 ceiling, and inventory bought cheaply beforehand is worth a great deal
// into that.
//
// So this is a directional bet on the bubble repeating rather than a squeeze,
// and its discipline is arithmetic rather than taste: a bid at X only pays if
// you can sell above X, and no price above 25,000 can ever print. Buying near
// the ceiling is buying with no upside left, which is where the price ceiling
// below comes from.
//
// The other half is the trap. Bid too aggressively and you become the only
// buyer, everyone dumps on you, and you finish holding a pile of worthless
// bottles with the cash gone. So the bid improves the market by one small step
// instead of leaping above it, and both the price paid and the total position
// are capped.
const BUY_CEILING = 0.3; // never pay more than this share of the cap
const ACCUMULATE_UNTIL = 0.3; // stop buying once this much of the session has gone
const MAX_INVENTORY = 70; // hard ceiling on bottles held
const BID_IMPROVE = 1.02; // sit a step above the best bid, not miles above it
const CLIP = 10; // bottles per resting bid

const corner = {
  id: 'corner',
  name: 'Corner',
  blurb: 'Buys the float cheaply in the opening minutes, then sells into the bubble. The high-risk one.',

  init() {
    return { ...baseMemory(), bidAt: 0 };
  },

  onEvent(event, ctx) {
    if (event.t === 'trade') noteHigh(ctx, event.price);

    // The exit rules apply to the accumulated pile exactly as to the opening
    // endowment. This is the half that stops a failed corner being a total loss.
    const forced = guards(ctx);
    if (forced) return forced;

    const accumulating = elapsed(ctx) < ACCUMULATE_UNTIL && ctx.position < MAX_INVENTORY;

    if (!accumulating) {
      // Switch sides: pull the bid, then behave like cap strike.
      if (ctx.memory.bidAt !== 0) {
        ctx.memory.bidAt = 0;
        return [{ kind: 'cancel' }];
      }
      const bid = bidPrice(ctx);
      if (ctx.position > 0 && bid !== null && bid >= ctx.cap * NEAR_CAP) {
        return [
          { kind: 'cancel' },
          { kind: 'take', side: 'sell', qty: Math.min(ctx.position, 40), urgent: true },
        ];
      }
      return [];
    }

    if (event.t !== 'quote') return [];

    const ceiling = ctx.cap * BUY_CEILING;
    const bid = bidPrice(ctx);
    const ask = askPrice(ctx);

    // An offer already below the ceiling beats advertising a bid for it: take
    // it quietly and leave no signal.
    if (ask !== null && ask <= ceiling) {
      const room = MAX_INVENTORY - ctx.position;
      if (room > 0) return [{ kind: 'take', side: 'buy', qty: Math.min(CLIP, room) }];
    }

    // Otherwise post the best bid, one small step above the market so selling
    // into it looks attractive, and never above the ceiling.
    const target = Math.min(ceiling, bid === null ? ceiling * 0.5 : bid * BID_IMPROVE);
    if (!(target > 0)) return [];
    // Only re-post on a real move, or the book fills with churn.
    if (Math.abs(target - ctx.memory.bidAt) < Math.max(TICK, ctx.memory.bidAt * 0.01)) return [];

    ctx.memory.bidAt = target;
    const room = MAX_INVENTORY - ctx.position;
    return [
      { kind: 'cancel' },
      { kind: 'make', side: 'buy', qty: Math.min(CLIP, room), price: Math.round(target * 100) / 100 },
    ];
  },
};


// 5 --------------------------------------------------------------------------
// Sniper: take a genuinely crossed book, buying the offer and selling the bid
// in the same instant.
//
// Measured against the captured session before it was written, because the
// answer matters more than the idea. Across 1,403 book states there were five
// strictly crossed moments, worth 794 in total, and the largest single edge was
// one currency unit. There were no offers more than 10% below the last trade
// and no bids more than 10% above it. The median spread was zero: with the
// market pinned at the ceiling and a tick of 0.01, there is simply no room left
// to be wrong in.
//
// The risk is the other half. The profit is 1 a bottle when both legs fill; the
// loss is the full 24,999 if the sell leg misses, because what you are left
// holding pays nothing at the bell. That needs a 99.996% fill rate to break
// even, and the two legs are separate messages over a network.
//
// So the size is deliberately small and the minimum edge is a real threshold
// rather than one tick. It is here to be measured, and to catch a genuinely
// fat mistake if session 2 is more volatile than session 1 was.
const MIN_EDGE = 1; // currency units per bottle, not ticks
const SNIPE_MAX = 10; // bottles per attempt

const sniper = {
  id: 'sniper',
  name: 'Sniper',
  blurb: 'Takes crossed books: buys the offer and sells the bid at once. Rare, and thin when it happens.',

  init() {
    return { ...baseMemory(), taken: 0 };
  },

  onEvent(event, ctx) {
    if (event.t === 'trade') noteHigh(ctx, event.price);
    const forced = guards(ctx);
    if (forced) return forced;
    if (event.t !== 'quote') return [];

    const bid = ctx.best.bid;
    const ask = ctx.best.ask;
    if (!bid || !ask) return [];
    if (!Number.isFinite(bid.price) || !Number.isFinite(ask.price)) return [];

    const edge = bid.price - ask.price;
    if (edge < MIN_EDGE) return [];
    // Buying above the ceiling is never worth it, crossed or not: what you are
    // buying still pays zero at the bell.
    if (ask.price > ctx.cap) return [];

    const qty = Math.max(1, Math.min(SNIPE_MAX, bid.qty ?? SNIPE_MAX, ask.qty ?? SNIPE_MAX));
    ctx.memory.taken += 1;
    // Both legs urgent: a cross that is not taken in the same instant is not a
    // cross any more, it is an unhedged position in something worth nothing.
    return [
      { kind: 'take', side: 'buy', qty, urgent: true },
      { kind: 'take', side: 'sell', qty, urgent: true },
    ];
  },
};

export const strategies = [capStrike, ratchet, trailingPeak, corner, sniper];
