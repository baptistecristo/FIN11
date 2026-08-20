// Five strategies, and what measuring them changed.
//
// THE GAME
//
// The class trades one invented asset for 50 minutes. Bottles pay zero at the
// bell, so total gain is cash plus realized utility and nothing else, and the
// server enforces a hard price cap of 25,000 — no higher price can ever print.
// Those two facts do most of the work here. The first says finish flat. The
// second says that once the bid touches the ceiling, holding has no upside left
// and a retreating bid is a real risk.
//
// WHAT SESSION 1 SAID
//
// From the captured book: the market pinned at 25,000 from minute 19.6 onward
// and was still there nine minutes later, with a bid for 8,687 bottles at the
// cap. The realised average that day was 8,093 a bottle against 25,000
// available for ten minutes straight. So the mistake was not being late to the
// exit. It was selling cheap into a market pinned at its own maximum.
//
// The capture also contains one thing the first version of this file ignored.
// At minute 23.15 the best bid went 24,888 -> 23,000 -> 1,000 and stayed under
// 15,000 for about fifty seconds, while prints carried on at 25,000 because
// buyers were still lifting offers. A 387-lot bid had been eaten and the book
// underneath it was air. Any rule that answers "sell everything now" with a
// market order can land in that window and realise 4% of what it expected.
//
// WHAT MEASURING SAID
//
// Session 1 cannot rank these: it covers 23% of one session, all of it with the
// market already at the ceiling, and every strategy scores within 1% on it. So
// they are also run across seven synthetic session shapes (hub/sim/session.js,
// scripts/scenarios.js). That is not evidence about which strategy is best —
// six of the seven shapes are hypotheses, not observations. It is evidence
// about which strategies fall apart when the session is not shaped like Session
// 1, and on that it was blunt:
//
//   - waiting for a ceiling the market never reaches returned 11% of what was
//     available in `early-spike` and 15% in `pop`
//   - a floor price written as a share of the cap means "never sell" in a
//     session that tops out at 200
//   - a fixed 8% trailing stop is inside the ordinary noise of a market
//     climbing 500-fold, so it sold at 1,000 on the way to 25,000 and then
//     watched: 23% of what was on the table in the shape it was designed for
//   - buying the float with a budget set as a share of the cap can spend more
//     than the endowment is worth in any session that does not bubble
//
// All four are fixed below, and the shared rules in common.js — finish flat on
// a schedule, refuse a bid that has fallen out of the book, take the ceiling
// when it appears — are the part that carried most of the improvement.
//
// A strategy is an object with `onEvent(event, ctx)` returning intents:
//   { kind: 'take', side, qty }           crosses the spread now
//   { kind: 'make', side, qty, price }    rests in the book
//   { kind: 'cancel' }                    pulls its resting orders
// Add `urgent: true` to jump the routine rate limit.
//
// ctx: { clock, total, best, last, vt, position, cash, resting, memory, cap }

import {
  TICK,
  NEAR_CAP,
  baseMemory,
  observe,
  guards,
  sell,
  breakBand,
  bidPrice,
  askPrice,
  bidDepth,
  bidIsReal,
  bidReference,
  elapsed,
} from './common.js';

// 1 --------------------------------------------------------------------------
// Cap strike: wait for the ceiling, and hold an offer where it can be lifted.
//
// Two things changed. The parked ask used to sit at the cap all session, which
// in Session 1 meant an order at 24,999.99 that only a print at exactly 25,000
// could fill. Once the market is at the ceiling the offer now sits one tick
// inside the best ask instead, at the front of the queue for the stream of
// small prints that a pinned market produces — there were 1,112 of them in nine
// minutes, 79% of them a single bottle.
//
// Second, it used to wait for a ceiling that might never arrive. It now gives
// up on the cap once the market has clearly topped out below it.
//
// How far under the session's best bid counts as "the cap is not coming". A
// fixed 30% looked safe and was not: in a market that swings 10% either way on
// the ordinary noise of climbing 500-fold, a 30% retracement arrives regularly
// and is not a top. Written as a multiple of the largest pullback this market
// has already recovered from, it fires in `pop` and `early-spike`, where the
// market really has rolled over, and stays quiet in `slow-burn`, where it cost
// half the session's gain.
const GIVE_UP_BAND = { min: 0.25, max: 0.5, multiple: 2.5 };
const GIVE_UP_AFTER = 0.5; // and only once the session is half gone
// Half the position, then wait. Without the pause the rule re-fires on the next
// message and the "sell half" is a full liquidation inside two seconds, which
// is how a give-up meant to be gradual emptied the book into a single price.
const GIVE_UP_GAP = 60; // game-clock units between concessions

const capStrike = {
  id: 'cap-strike',
  name: 'Cap strike',
  blurb: 'Waits for the bid to reach the cap, then sells the lot. Gives up on it if the market tops out below.',

  init(seed) {
    return { ...baseMemory(seed), parked: null, conceded: null };
  },

  onEvent(event, ctx) {
    observe(event, ctx);
    const forced = guards(ctx);
    if (forced) return forced;
    if (ctx.position <= 0) return [];

    const bid = bidPrice(ctx);
    const m = ctx.memory;

    // Near the ceiling is worth taking outright.
    if (bid !== null && bid >= ctx.cap * NEAR_CAP && bidIsReal(ctx)) {
      return sell(ctx, ctx.position, { urgent: true });
    }

    // The cap is not coming. Stop waiting for it and take what the market is
    // paying, rather than riding the decline down to the deadline.
    if (
      elapsed(ctx) > GIVE_UP_AFTER &&
      m.bidHigh > 0 &&
      bid !== null &&
      m.drawdown > breakBand(ctx, GIVE_UP_BAND) &&
      (m.conceded === null || m.conceded - ctx.clock >= GIVE_UP_GAP) &&
      bidIsReal(ctx)
    ) {
      const orders = sell(ctx, Math.max(1, Math.ceil(ctx.position / 2)));
      if (orders.length) m.conceded = ctx.clock;
      return orders;
    }

    // Where to rest the offer. Far from the ceiling it sits at the ceiling,
    // costing nothing and catching a gap. Close to it, one tick inside the best
    // ask, where a pinned market's prints will actually reach it.
    const ask = askPrice(ctx);
    const atTheTop = bid !== null && bid >= ctx.cap * 0.9;
    const price =
      atTheTop && ask !== null && ask - TICK > 0
        ? Math.round((ask - TICK) * 100) / 100
        : ctx.cap - TICK;

    if (m.parked === null || m.parked.qty !== ctx.position || m.parked.price !== price) {
      m.parked = { qty: ctx.position, price };
      return [
        { kind: 'cancel' },
        { kind: 'make', side: 'sell', qty: ctx.position, price },
      ];
    }
    return [];
  },
};

// 2 --------------------------------------------------------------------------
// Ratchet: hold a target share sold, and let the price decide what it is.
//
// The original refused to sell below 40% of the cap, which in a session topping
// out at 200 means never selling at all. The obvious repair — rungs set as a
// share of the session's own running high — is worse, and worth recording
// because it looks so reasonable: the first bid of the session IS the running
// high, so the ladder fires on tick one and the whole endowment is gone by 165
// on a market heading for 25,000. It scored 0.4%.
//
// What is actually known here is the ceiling. No price above 25,000 can print,
// so how far the bid has travelled toward it is a real measure of how much of
// the move is already in hand. That is the first anchor, and it is squared so
// that the early part of the climb, where most of the upside is still ahead,
// sells almost nothing.
//
// The second anchor covers the sessions that never approach the ceiling. Late
// on, a bid within a few percent of the best this session has produced is as
// good as this market is going to offer, and waiting for the cap is waiting for
// nothing. It is off early and decisive late, so it cannot pre-empt a climb.
//
// Whichever anchor asks for more wins, and the ratchet is that the share sold
// never goes backwards.
const CAP_REACH_POWER = 2; // squared: at half the cap, a quarter sold
const HIGH_REACH_POWER = 8; // sharp: only a bid near the session's best counts
const HIGH_ANCHOR_FROM = 0.4; // and only once the session is this far gone

const ratchet = {
  id: 'ratchet',
  name: 'Ratchet',
  blurb: 'Keeps the share sold in step with how far the bid has come toward the cap, and never sells backwards.',

  init(seed) {
    return { ...baseMemory(seed), sold: 0 };
  },

  onEvent(event, ctx) {
    observe(event, ctx);
    const forced = guards(ctx);
    if (forced) return forced;
    if (ctx.position <= 0) return [];

    const bid = bidPrice(ctx);
    if (bid === null || !bidIsReal(ctx)) return [];

    const m = ctx.memory;
    const u = elapsed(ctx);

    const capReach = (Math.min(bid, ctx.cap) / ctx.cap) ** CAP_REACH_POWER;
    const lateness = Math.max(0, (u - HIGH_ANCHOR_FROM) / (1 - HIGH_ANCHOR_FROM));
    const highReach =
      m.bidHigh > 0 ? (Math.min(bid, m.bidHigh) / m.bidHigh) ** HIGH_REACH_POWER * lateness : 0;

    // Expressed, like the schedule, as a ceiling on what may still be held, so
    // that the share sold cannot go backwards and a purchase cannot be read as
    // falling behind.
    const allowed = Math.floor(m.peak * (1 - Math.max(capReach, highReach)));
    const owed = ctx.position - allowed;
    if (owed <= 0) return [];

    return sell(ctx, owed);
  },
};

// 3 --------------------------------------------------------------------------
// Trailing peak: ride the climb, leave on a real break.
//
// This one was the worst of the five and the most interesting to fix. A fixed
// 8% band sounds conservative until you notice that this market climbs from 50
// to 25,000: an 8% pullback is ordinary weather on the way up, so it sold at a
// thousand and watched the rest. Widening the band is not the fix either, since
// what counts as a real break in `damp` and in `pin` differ by an order of
// magnitude.
//
// So it measures instead. It tracks every pullback the market has recovered
// from, and refuses to call a top on anything smaller than the largest of them.
// A market that routinely gives back 9% has to give back appreciably more than
// 9% before the break means anything. That number is learned per session and
// needs no tuning.
const BREAK_BAND = { min: 0.06, max: 0.35, multiple: 1.5 };
const CONFIRM_PRINTS = 3; // a break has to survive a few prints to count
const RUN_MULTIPLE = 2; // and the market has to have gone somewhere first
const ARM_AFTER = 0.15;
const FIRST_TRANCHE = 0.5; // half on the first break, the rest on the next

const trailingPeak = {
  id: 'trailing-peak',
  name: 'Trailing peak',
  blurb: 'Rides the climb and leaves on a break bigger than any pullback this session has recovered from.',

  init(seed) {
    return { ...baseMemory(seed), below: 0, tranches: 0 };
  },

  onEvent(event, ctx) {
    observe(event, ctx);
    const forced = guards(ctx);
    if (forced) return forced;
    if (event.t !== 'trade' || ctx.position <= 0) return [];

    const m = ctx.memory;
    if (m.bidHigh <= 0) return [];
    if (elapsed(ctx) < ARM_AFTER) return [];
    if (m.openBid > 0 && m.bidHigh < m.openBid * RUN_MULTIPLE) return [];

    // The drawdown is measured on the bid rather than on prints, because the
    // bid is what a decision to leave actually sells into. Prints at the offer
    // carried on at 25,000 all through Session 1's minute-23 hole, when the bid
    // was the thing that had gone.
    const trigger = breakBand(ctx, BREAK_BAND) * (m.tranches === 0 ? 1 : 1.5);
    if (m.drawdown < trigger) {
      m.below = 0;
      return [];
    }
    m.below += 1;
    if (m.below < CONFIRM_PRINTS) return [];
    m.below = 0;

    const qty = m.tranches === 0 ? Math.ceil(ctx.position * FIRST_TRANCHE) : ctx.position;
    const orders = sell(ctx, qty, { urgent: true });
    if (orders.length) m.tranches += 1;
    return orders;
  },
};

// 4 --------------------------------------------------------------------------
// Corner: buy the float cheaply while the bubble is forming, then sell it into
// the bubble.
//
// The economics first, because they bound everything else. Cornering cannot
// create demand here: bottles pay zero at the bell and Vt is about 2, so nobody
// ever needs to buy them from you. Squeezing the supply just leaves you holding
// all of it. The reason to do it anyway is that Session 1 ran to the ceiling,
// and inventory bought cheaply beforehand is worth a great deal into that.
//
// So it is a directional bet on the bubble repeating, and the discipline is
// arithmetic. Three bounds, and the first two are new:
//
//   - a cash budget. The old version's only limit on what it could spend was a
//     share of the cap, which in a session that never bubbles is a licence to
//     spend several times what the endowment could ever be worth. The budget is
//     what this bet is allowed to lose.
//   - evidence. It will not start buying until the market has already tripled
//     off its opening bid. In a session that never bubbles that condition is
//     never met and the strategy quietly becomes an ordinary seller.
//   - never pay more than the highest bid the session has produced. You can
//     only sell to a bid, so paying under the best one that has already existed
//     is the arithmetic floor of the whole idea.
//
// And the trap it has always had to avoid: bid too aggressively and you become
// the only buyer, everyone dumps on you, and you finish holding a pile of
// worthless bottles with the cash gone. So the bid improves the market by one
// small step instead of leaping above it.
const BUY_CEILING = 0.3; // never pay more than this share of the cap
const PAY_UNDER_HIGH = 0.9; // nor more than this share of the best bid seen
// The market must have multiplied by this much before any buying starts. Eight
// rather than three because a quiet session drifts by a factor of three on its
// own — `damp` swings between 0.6x and 3.4x its own opening without anything
// resembling a bubble — and buying that drift is how the bet loses money in the
// one shape where there was never a bet to make. A real bubble here is an order
// of magnitude: Session 1 went from a 750 bid to 25,000 in under three minutes.
const RUN_EVIDENCE = 8;
const BUDGET = 120000; // the most this bet may spend
const ACCUMULATE_UNTIL = 0.35;
const MAX_INVENTORY = 70;
const BID_IMPROVE = 1.02;
const CLIP = 10;

const corner = {
  id: 'corner',
  name: 'Corner',
  blurb: 'Buys the float once a bubble is visibly forming, on a fixed budget, then sells into it. The high-risk one.',

  init(seed) {
    return { ...baseMemory(seed), bidAt: 0, spent: 0 };
  },

  onEvent(event, ctx) {
    observe(event, ctx);

    // The exit rules apply to the accumulated pile exactly as to the opening
    // endowment. This is the half that stops a failed corner being a total loss.
    const forced = guards(ctx);
    if (forced) return forced;

    const m = ctx.memory;
    const run = m.openBid > 0 ? m.bidHigh / m.openBid : 0;
    const accumulating =
      elapsed(ctx) < ACCUMULATE_UNTIL &&
      ctx.position < MAX_INVENTORY &&
      m.spent < BUDGET &&
      run >= RUN_EVIDENCE;

    if (!accumulating) {
      // Switch sides: pull the bid, then behave like cap strike.
      if (m.bidAt !== 0) {
        m.bidAt = 0;
        return [{ kind: 'cancel' }];
      }
      const bid = bidPrice(ctx);
      if (ctx.position > 0 && bid !== null && bid >= ctx.cap * NEAR_CAP && bidIsReal(ctx)) {
        return sell(ctx, Math.min(ctx.position, 40), { urgent: true });
      }
      return [];
    }

    if (event.t !== 'quote') return [];

    const ceiling = Math.min(ctx.cap * BUY_CEILING, m.bidHigh * PAY_UNDER_HIGH);
    const bid = bidPrice(ctx);
    const ask = askPrice(ctx);
    const room = Math.min(MAX_INVENTORY - ctx.position, Math.floor((BUDGET - m.spent) / Math.max(ceiling, 1)));
    if (room <= 0) return [];

    // An offer already below the ceiling beats advertising a bid for it: take
    // it quietly and leave no signal.
    if (ask !== null && ask <= ceiling) {
      const qty = Math.min(CLIP, room);
      m.spent += qty * ask;
      return [{ kind: 'take', side: 'buy', qty }];
    }

    // Otherwise post the best bid, one small step above the market so selling
    // into it looks attractive, and never above the ceiling.
    const target = Math.min(ceiling, bid === null ? ceiling * 0.5 : bid * BID_IMPROVE);
    if (!(target > 0)) return [];
    // Only re-post on a real move, or the book fills with churn.
    if (Math.abs(target - m.bidAt) < Math.max(TICK, m.bidAt * 0.01)) return [];

    m.bidAt = target;
    const qty = Math.min(CLIP, room);
    m.spent += qty * target;
    return [
      { kind: 'cancel' },
      { kind: 'make', side: 'buy', qty, price: Math.round(target * 100) / 100 },
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
// market pinned at the ceiling and a tick of 0.01, there is no room left to be
// wrong in.
//
// The risk is the other half. The profit is 1 a bottle when both legs fill; the
// loss is the full 24,999 if the sell leg misses, because what you are left
// holding pays nothing at the bell. That needs a 99.996% fill rate to break
// even, and the two legs are separate messages over a network. So the added
// rule here is that it will not lift an offer unless the bid it intends to sell
// into is quoted for at least as much size — buying into a bid of one bottle
// and hoping is how the 24,999 gets lost.
//
// It is here to be measured, and to catch a genuinely fat mistake if a later
// session is more volatile. Across seven simulated shapes it earns what the
// real capture said it would: nothing worth having.
const MIN_EDGE = 1; // currency units per bottle, not ticks
const SNIPE_MAX = 10;

const sniper = {
  id: 'sniper',
  name: 'Sniper',
  blurb: 'Takes crossed books: buys the offer and sells the bid at once, only when both sides are quoted for the size.',

  init(seed) {
    return { ...baseMemory(seed), taken: 0 };
  },

  onEvent(event, ctx) {
    observe(event, ctx);
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
    // And a bid quoted for one bottle cannot take ten off your hands.
    const depth = Math.min(bidDepth(ctx), Number.isFinite(ask.qty) ? ask.qty : SNIPE_MAX);
    const qty = Math.max(1, Math.min(SNIPE_MAX, depth));
    if (qty < 1) return [];

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
export { bidReference };
