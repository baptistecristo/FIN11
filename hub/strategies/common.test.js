import test from 'node:test';
import assert from 'node:assert/strict';

import { strategies } from './registry.js';
import {
  observe,
  bidIsReal,
  bidReference,
  scheduleTarget,
  scheduleGuard,
  breakBand,
  baseMemory,
} from './common.js';

const CAP = 25000;
const TOTAL = 3000;

function ctx(over = {}) {
  return {
    clock: 1500,
    total: TOTAL,
    best: { bid: { price: 10000, qty: 500 }, ask: { price: 10010, qty: 5 } },
    last: 10000,
    vt: 2,
    position: 20,
    cash: 0,
    resting: 0,
    memory: baseMemory({ position: 20 }),
    cap: CAP,
    ...over,
  };
}

// Feeds a run of clock units at a given bid, the way a live session would.
// `spread` is how far the offer sits above the bid, in relative terms.
function feed(c, price, units, from = c.clock, spread = 0.001) {
  for (let i = 0; i < units; i += 1) {
    c.clock = from - i;
    c.best.bid = { price, qty: 500 };
    c.best.ask = { price: Math.round(price * (1 + spread)) + 1, qty: 500 };
    observe({ t: 'quote', side: 'bid', price, qty: 500 }, c);
  }
  return c;
}

const sells = (intents) => (intents ?? []).filter((i) => i.kind === 'take' && i.side === 'sell');

// The hole in the book ---------------------------------------------------------

test('a bid that has fallen out of the book is not a price', () => {
  const c = ctx({ clock: 2000 });
  feed(c, 24000, 200, 2000);
  c.clock = 1800;
  c.best.bid = { price: 1000, qty: 100 };
  assert.equal(bidIsReal(c), false, 'Session 1 minute 23: 24,888 -> 1,000 in seconds');
});

test('a market that has genuinely fallen is still a market', () => {
  const c = ctx({ clock: 2000 });
  feed(c, 24000, 60, 2000);
  // Four minutes of steady decline, not a fifty-second hole: the offer comes
  // down with the bid, so the spread never widens and the exit is not blocked.
  for (let i = 0; i < 240; i += 1) {
    const price = Math.round(24000 * 0.99 ** i);
    feed(c, price, 1, 1940 - i);
  }
  assert.equal(bidIsReal(c), true, 'blocked the one exit that needed to happen');
});

test('the hole check stops blocking as the bell approaches', () => {
  const c = ctx({ clock: 2000 });
  feed(c, 24000, 200, 2000);
  c.best.bid = { price: 1000, qty: 100 };
  c.clock = 1800;
  assert.equal(bidIsReal(c), false);
  // A hole you cannot wait out is just the market, and a bottle is worth zero.
  c.clock = 300;
  assert.equal(bidIsReal(c), true);
});

test('the reference is a high quantile, not a median a long hole can move', () => {
  const c = ctx({ clock: 2000 });
  feed(c, 24000, 100, 2000);
  // A hole longer than half the window: a median would now BE the hole, and
  // this is exactly the bug that sold a session at 1,056 a bottle.
  feed(c, 900, 120, 1900);
  assert.ok(bidReference(c) > 5000, `reference collapsed to ${bidReference(c)}`);
});

for (const strategy of strategies) {
  test(`${strategy.id}: makes no voluntary sale into a hole`, () => {
    const c = ctx({ clock: 2000 });
    c.memory = strategy.init ? strategy.init({ cash: 0, position: 20 }) : {};
    feed(c, 24000, 300, 2000);
    // 55% elapsed: past every arming threshold, before the schedule speaks.
    c.clock = 1350;
    c.best.bid = { price: 900, qty: 200 };
    const out = strategy.onEvent({ t: 'quote', side: 'bid', price: 900, qty: 200 }, c);
    assert.deepEqual(sells(out), [], 'sold into an empty book');
  });
}

// The liquidation schedule -----------------------------------------------------

test('the schedule holds off through the first half and finishes by the deadline', () => {
  const at = (u) => scheduleTarget(ctx({ clock: TOTAL * (1 - u) }));
  assert.equal(at(0), 0);
  assert.equal(at(0.5), 0, 'nothing sold on the clock alone before the halfway point');
  assert.ok(at(0.75) > 0 && at(0.75) < 0.5, `${at(0.75)} at three quarters`);
  assert.equal(at(0.92), 1, 'everything by the deadline');
  // Monotone, so the target can never ask for inventory back.
  let previous = -1;
  for (let u = 0; u <= 1; u += 0.02) {
    const now = at(u);
    assert.ok(now >= previous, `target fell at u=${u}`);
    previous = now;
  }
});

test('the schedule liquidates what is held, not what was dealt', () => {
  // A corner holding 70 has to sell 70, not the 20 it started with.
  const c = ctx({ clock: 600, position: 70 });
  feed(c, 10000, 30, 600);
  c.memory.peak = 70;
  const out = scheduleGuard(c);
  const qty = sells(out).reduce((n, i) => n + i.qty, 0);
  assert.ok(qty > 20, `only asked for ${qty} of a 70 position`);
});

test('the schedule asks for nothing while a strategy is buying', () => {
  // Buying used to read as falling behind, so the schedule sold the purchase
  // straight back into the spread it had just paid.
  const c = ctx({ clock: 2600, position: 30 });
  feed(c, 200, 30, 2600);
  c.memory.peak = 30;
  assert.equal(scheduleGuard(c), null);
});

// The learned band -------------------------------------------------------------

test('the break band is the market’s own worst survived pullback', () => {
  const c = ctx();
  assert.equal(breakBand(c, { min: 0.06, max: 0.35, multiple: 1.5 }), 0.06, 'floor with no history');
  c.memory.wobble = 0.15;
  assert.ok(Math.abs(breakBand(c, { min: 0.06, max: 0.35, multiple: 1.5 }) - 0.225) < 1e-9);
  c.memory.wobble = 0.9;
  assert.equal(breakBand(c, { min: 0.06, max: 0.35, multiple: 1.5 }), 0.35, 'and a ceiling');
});

test('a pullback that recovers to a new high is recorded as weather', () => {
  const c = ctx({ clock: 2000 });
  feed(c, 10000, 5, 2000);
  feed(c, 8500, 5, 1995); // 15% down
  feed(c, 11000, 5, 1990); // and back to a new high
  assert.ok(c.memory.wobble >= 0.14, `wobble was ${c.memory.wobble}`);
});

test('every sell pulls resting orders first, even when none are reported', () => {
  // Live, the hub passes resting: 0 whatever is actually in the book. A parked
  // ask commits the position and the server refuses the sell as a short, so a
  // cancel that depends on that count would go missing exactly when it matters.
  for (const strategy of strategies) {
    const c = ctx({ clock: 200, resting: 0 });
    c.memory = strategy.init ? strategy.init({ cash: 0, position: 20 }) : {};
    c.best = { bid: { price: 24000, qty: 900 }, ask: { price: 24010, qty: 5 } };
    const out = strategy.onEvent({ t: 'quote', side: 'bid', price: 24000, qty: 900 }, c) ?? [];
    const sell = out.findIndex((i) => i.kind === 'take' && i.side === 'sell');
    assert.ok(sell >= 0, `${strategy.id}: expected a sell past the deadline`);
    const cancel = out.findIndex((i) => i.kind === 'cancel');
    assert.ok(cancel >= 0 && cancel < sell, `${strategy.id}: sold without cancelling first`);
  }
});

// Sniper -----------------------------------------------------------------------

test('sniper will not lift an offer it cannot immediately sell into', () => {
  const sniper = strategies.find((s) => s.id === 'sniper');
  const c = ctx({ clock: 2000 });
  c.memory = sniper.init({ cash: 0, position: 20 });
  // Crossed by 5, but the bid is quoted for one bottle. Buying ten and hoping
  // is how the whole 24,999 gets lost.
  c.best = { bid: { price: 20005, qty: 1 }, ask: { price: 20000, qty: 50 } };
  const out = sniper.onEvent({ t: 'quote', side: 'bid', price: 20005, qty: 1 }, c);
  const buys = out.filter((i) => i.side === 'buy');
  assert.ok(buys.every((b) => b.qty <= 1), `bought ${buys[0]?.qty} against a bid for 1`);
});
