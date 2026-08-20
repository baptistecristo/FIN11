// What every strategy shares: what it remembers about the session, and the
// three rules none of them is allowed to break.
//
// These came out of measuring the five strategies across seven session shapes
// (scripts/scenarios.js). Two things showed up that no amount of reasoning
// about Session 1 had suggested:
//
//   1. Every rule expressed as a share of the 25,000 cap fails in a session
//      that never bubbles. "Refuse to sell below 40% of the cap" means "refuse
//      to sell" when the market tops out at 200, and the strategy holds a pile
//      of things worth nothing at the bell. Levels are now read off the
//      session's own high, not off the ceiling.
//
//   2. Every rule that sells the whole position in one market order can hit an
//      empty book. This is not hypothetical: in Session 1 at minute 23.15 the
//      best bid went 24,888 -> 23,000 -> 1,000 and stayed under 15,000 for
//      about fifty seconds, while prints carried on at 25,000 because buyers
//      were lifting offers. A market sell of twenty bottles into that window
//      realises 20,000 instead of 500,000. Voluntary sales now refuse a bid
//      that has fallen away from its own recent level.
//
// The exception to (2) is the bell. Past the deadline a bad price beats a
// bottle, because a bottle is worth zero.

export const TICK = 0.01;

// "At the cap" needs slack: the book showed bids at both 24,999 and 25,000, and
// a tick below the ceiling is the ceiling for any decision that matters.
export const AT_CAP = 0.999;

// Near enough to the ceiling to act on. The gap between 24,250 and 25,000 is
// small next to the risk of the bid retreating while you hold out for it.
export const NEAR_CAP = 0.97;

// Be flat with this much of the session left. Session 1's damage was done when
// everyone tried to leave at once.
export const FLAT_AT = 0.08;

// Telling a hole in the book from a market that has genuinely fallen.
//
// This took two wrong answers to get right, and both are worth keeping.
//
// The first was to compare the bid against its own recent median. That fails on
// duration: once a hole has lasted longer than half the window, the hole IS the
// median, the check passes, and the strategy sells into the thing the check
// exists to prevent. It showed up as a cap-strike session realising 1,056 a
// bottle in a market that went on to 20,000.
//
// The second was to widen the window and take a high quantile of it. That
// survives duration but cannot tell a hole from a crash: four minutes of steady
// decline looks exactly like a bid that has fallen away, so the check blocks the
// one exit that actually needed to happen.
//
// The book itself separates them. In a hole the bid falls away from the offer —
// Session 1's went to 1,000 while the offer stayed at 25,000 and prints carried
// on up there. In a crash the offer comes down too and the spread stays
// ordinary. So the test is the spread, which needs no history at all, with the
// bid's own recent level kept only for the case where there is no offer quoted.
const HOLE_SPREAD = 0.5; // a bid under half the offer is a gap, not a price
const HOLE_FLOOR = 0.5; // same idea against recent bids, when there is no offer
const BID_WINDOW = 240; // game-clock units of bids behind that fallback
const REF_QUANTILE = 0.7;

// Past this point the check relaxes to nothing. A hole you cannot wait out is
// not a hole, it is the market, and a bottle held past the bell is worth zero.
const HOLE_CHECK_UNTIL = 0.6;

// The liquidation schedule. Not a view on price — an admission that we do not
// know which session this is. By `EXIT_FROM` the market has had most of the
// session to bubble; from there the share of the endowment that should already
// be sold rises to everything at the deadline.
//
// The curve is convex on purpose. A linear schedule sells a third of the book
// before the halfway point and gives up most of `slow-burn`, where the market
// peaks at the bell. This one barely sells until the last third.
const EXIT_FROM = 0.55;
const EXIT_SHAPE = 2;

export const bidPrice = (ctx) => (ctx.best.bid ? ctx.best.bid.price : null);
export const askPrice = (ctx) => (ctx.best.ask ? ctx.best.ask.price : null);
export const bidDepth = (ctx) => (ctx.best.bid && Number.isFinite(ctx.best.bid.qty) ? ctx.best.bid.qty : 0);
export const deadline = (ctx) => (ctx.total ?? 3000) * FLAT_AT;
export const elapsed = (ctx) => ((ctx.total ?? 3000) - (ctx.clock ?? 0)) / (ctx.total ?? 3000);

export function baseMemory(seed = {}) {
  return {
    start: seed.position ?? 20,
    peak: seed.position ?? 20, // most ever held; the schedule liquidates this
    sessionHigh: 0, // highest print
    bidHigh: 0, // highest bid, which is what you can actually sell into
    openBid: 0, // first bid seen, for measuring how far the market has run
    bids: [], // recent best bids, one per clock unit, for the hole check
    refClock: null, // memo for bidReference()
    refValue: null,
    drawdown: 0, // how far the bid is under its high, right now
    wobble: 0, // the largest drawdown this market has recovered from
    vol: 0, // EWMA of |log return| between prints
    lastPrint: null,
  };
}

const VOL_ALPHA = 0.03;

// Called first by every strategy. Everything downstream reads these.
export function observe(event, ctx) {
  const m = ctx.memory;
  if (ctx.position > m.peak) m.peak = ctx.position;

  if (event.t === 'trade' && event.price > 0) {
    if (event.price > m.sessionHigh) m.sessionHigh = event.price;
    if (m.lastPrint > 0) {
      const r = Math.abs(Math.log(event.price / m.lastPrint));
      m.vol = m.vol === 0 ? r : m.vol * (1 - VOL_ALPHA) + r * VOL_ALPHA;
    }
    m.lastPrint = event.price;
  }

  const bid = bidPrice(ctx);
  if (bid !== null && bid > 0 && ctx.clock !== null) {
    if (m.openBid === 0) m.openBid = bid;

    // How much this market pulls back and then recovers from. A pullback that
    // ends in a new high was, by definition, not a top — so remembering the
    // biggest of them gives every "has it broken?" rule a threshold measured
    // from this session instead of guessed in advance. A market that routinely
    // gives back 9% has to give back appreciably more than 9% to mean anything.
    if (bid >= m.bidHigh) {
      if (m.drawdown > m.wobble) m.wobble = m.drawdown;
      m.drawdown = 0;
      m.bidHigh = bid;
    } else if (m.bidHigh > 0) {
      // A hole in the book is not a pullback; it is the absence of a book.
      const dd = (m.bidHigh - bid) / m.bidHigh;
      if (dd > m.drawdown && bidIsReal(ctx)) m.drawdown = dd;
    }

    // One entry per game-clock unit, so the reference below stays cheap to
    // compute however many messages arrive in a second.
    const head = m.bids[m.bids.length - 1];
    if (head && head.clock === ctx.clock) head.price = bid;
    else m.bids.push({ clock: ctx.clock, price: bid });
    // The clock counts down, so anything with a larger clock is older.
    const cutoff = ctx.clock + BID_WINDOW;
    while (m.bids.length && m.bids[0].clock > cutoff) m.bids.shift();
    m.refClock = null;
  }
}

// A break worth acting on: bigger than any pullback this market has already
// shrugged off, and never outside sane bounds.
export function breakBand(ctx, { min = 0.06, max = 0.35, multiple = 1.5 } = {}) {
  return Math.min(max, Math.max(min, (ctx.memory.wobble ?? 0) * multiple));
}

// What the bid has recently been worth: a high quantile of the last few
// minutes, cached per game-clock unit because every strategy asks on every
// message.
export function bidReference(ctx) {
  const m = ctx.memory;
  const xs = m.bids;
  if (!xs || xs.length === 0) return null;
  if (m.refClock === ctx.clock && m.refValue != null) return m.refValue;
  const prices = xs.map((x) => x.price).sort((a, b) => a - b);
  m.refClock = ctx.clock;
  m.refValue = prices[Math.min(prices.length - 1, Math.floor(REF_QUANTILE * prices.length))];
  return m.refValue;
}

// Is the bid a price, or is it the hole where a price used to be?
export function bidIsReal(ctx) {
  const bid = bidPrice(ctx);
  if (bid === null || bid <= 0) return false;

  // The check fades out as the bell approaches. A hole you cannot wait out is
  // not a hole, it is the market, and a bottle held past the bell is worth zero.
  const end = 1 - FLAT_AT;
  const u = elapsed(ctx);
  const slack =
    u <= HOLE_CHECK_UNTIL ? 1 : Math.max(0, 1 - (u - HOLE_CHECK_UNTIL) / (end - HOLE_CHECK_UNTIL));
  if (slack <= 0) return true;

  const ask = askPrice(ctx);
  if (ask !== null && ask > 0) return bid >= ask * HOLE_SPREAD * slack;

  const ref = bidReference(ctx);
  if (ref === null) return true;
  return bid >= ref * HOLE_FLOOR * slack;
}

// How much of the endowment should be gone by now, whatever the market has
// done. 0 for the first half of the session, everything by the deadline.
export function scheduleTarget(ctx) {
  const total = ctx.total ?? 3000;
  const end = 1 - FLAT_AT;
  const u = elapsed(ctx);
  if (u <= EXIT_FROM) return 0;
  if (u >= end) return 1;
  return ((u - EXIT_FROM) / (end - EXIT_FROM)) ** EXIT_SHAPE;
}

// Last resort: past the deadline, hit whatever bid is there. No hole check —
// a bottle held past the bell is worth zero, so any price beats holding.
export function bellGuard(ctx) {
  if (ctx.position <= 0 || ctx.clock === null) return null;
  if (ctx.clock > deadline(ctx)) return null;
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
}

// The dominance rule. Once the bid is at the ceiling there is nothing above it
// left to wait for, because the server will not print a higher price.
export function capGuard(ctx) {
  if (ctx.position <= 0) return null;
  const bid = bidPrice(ctx);
  if (bid === null || bid < ctx.cap * AT_CAP) return null;
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
}

// The backstop. Sells whatever the schedule says is overdue, and nothing more,
// so a strategy with a working signal never notices it is there.
//
// It is written as a ceiling on what may still be held, not as a count of what
// should already have been sold. Those are the same thing right up until a
// strategy buys: expressed as cumulative sales, a corner that adds ten bottles
// is instantly ten bottles behind schedule, and sells them straight back into
// the spread it just paid. That churn cost the corner about a fifth of its
// gain before anyone noticed it was happening.
export function scheduleGuard(ctx) {
  if (ctx.position <= 0 || ctx.clock === null) return null;
  const m = ctx.memory;
  const allowed = Math.floor(m.peak * (1 - scheduleTarget(ctx)));
  const owed = ctx.position - allowed;
  if (owed <= 0) return null;
  if (!bidIsReal(ctx)) return null;
  const qty = Math.min(owed, ctx.position);
  if (qty <= 0) return null;
  return [{ kind: 'cancel' }, { kind: 'take', side: 'sell', qty }];
}

// Order matters: the bell is absolute, the cap is the ceiling, and the schedule
// only speaks when neither of those has.
export const guards = (ctx) => bellGuard(ctx) ?? capGuard(ctx) ?? scheduleGuard(ctx);

// A voluntary sale — one the strategy chose rather than one the clock forced.
// Refuses a book that has fallen away, which is the whole lesson of minute 23.
// The cancel is unconditional rather than sent only when something is known to
// be resting, because live the hub reports `resting: 0` whatever is actually in
// the book. A parked ask commits the position, and a sell that would exceed
// what is left is refused outright as a short — so the one place that count is
// unreliable is the one place a missing cancel would block the exit. Cancels
// are exempt from the order budget and the trade rate limit, so one that turns
// out to be unnecessary costs nothing.
export function sell(ctx, qty, { urgent = false } = {}) {
  if (qty <= 0 || !bidIsReal(ctx)) return [];
  return [
    { kind: 'cancel' },
    { kind: 'take', side: 'sell', qty: Math.min(qty, ctx.position), urgent },
  ];
}
