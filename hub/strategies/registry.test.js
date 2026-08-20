import test from 'node:test';
import assert from 'node:assert/strict';
import { strategies } from './registry.js';
import { StrategyBoard } from './engine.js';

const CAP = 25000;
const byId = (id) => strategies.find((s) => s.id === id);

// Minimal context, shaped the way the engine builds it.
function ctx(over = {}) {
  return {
    clock: 2000,
    total: 3000,
    best: { bid: { price: 10000, qty: 500 }, ask: { price: 10010, qty: 5 } },
    last: 10000,
    vt: 2,
    position: 20,
    cash: 0,
    resting: 0,
    memory: {},
    cap: CAP,
    ...over,
  };
}

function withMemory(strategy, over = {}) {
  const c = ctx(over);
  c.memory = strategy.init ? strategy.init({ cash: c.cash, position: c.position }) ?? {} : {};
  return c;
}

const sells = (intents) => intents.filter((i) => i.kind === 'take' && i.side === 'sell');

// The rule every strategy shares ---------------------------------------------

for (const strategy of strategies) {
  test(`${strategy.id}: sells the lot once the bid reaches the cap`, () => {
    const c = withMemory(strategy, { best: { bid: { price: CAP, qty: 8000 }, ask: null } });
    const out = strategy.onEvent({ t: 'quote', side: 'bid', price: CAP, qty: 8000 }, c);
    const sold = sells(out);
    assert.equal(sold.length, 1, 'expected a market sell');
    assert.equal(sold[0].qty, 20, 'expected the whole position');
  });

  test(`${strategy.id}: is flat before the bell whatever the price`, () => {
    const c = withMemory(strategy, {
      clock: 100,
      best: { bid: { price: 900, qty: 50 }, ask: null },
    });
    const out = strategy.onEvent({ t: 'trade', price: 900, qty: 1, tick: -1 }, c);
    assert.equal(sells(out)[0].qty, 20);
  });

  test(`${strategy.id}: does nothing once flat`, () => {
    const c = withMemory(strategy, { position: 0, best: { bid: { price: CAP, qty: 99 }, ask: null } });
    const out = strategy.onEvent({ t: 'quote', side: 'bid', price: CAP, qty: 99 }, c);
    assert.deepEqual(sells(out), []);
  });

  test(`${strategy.id}: never buys`, () => {
    const c = withMemory(strategy);
    for (const event of [
      { t: 'trade', price: 5000, qty: 3, tick: 1 },
      { t: 'trade', price: 4000, qty: 3, tick: -1 },
      { t: 'quote', side: 'bid', price: 5000, qty: 10 },
      { t: 'clock', clock: 2000 },
    ]) {
      const out = strategy.onEvent(event, c) ?? [];
      assert.equal(out.some((i) => i.side === 'buy'), false);
    }
  });
}

// Cap strike ------------------------------------------------------------------

test('cap strike parks the whole position just under the cap', () => {
  const s = byId('cap-strike');
  const c = withMemory(s);
  const out = s.onEvent({ t: 'quote', side: 'bid', price: 10000, qty: 500 }, c);
  const rest = out.find((i) => i.kind === 'make');
  assert.equal(rest.price, CAP - 0.01);
  assert.equal(rest.qty, 20);
});

test('cap strike does not re-park an unchanged position every tick', () => {
  const s = byId('cap-strike');
  const c = withMemory(s);
  s.onEvent({ t: 'quote', side: 'bid', price: 10000, qty: 500 }, c);
  const again = s.onEvent({ t: 'quote', side: 'bid', price: 10500, qty: 500 }, c);
  assert.deepEqual(again, []);
});

// Ratchet ---------------------------------------------------------------------

test('ratchet refuses to sell below its floor', () => {
  const s = byId('ratchet');
  // 9,999 is under 40% of the 25,000 cap.
  const c = withMemory(s, { best: { bid: { price: 9999, qty: 99 }, ask: null } });
  const out = s.onEvent({ t: 'quote', side: 'bid', price: 9999, qty: 99 }, c);
  assert.deepEqual(sells(out), []);
});

test('ratchet requires each clip to beat the last sale by a wide margin', () => {
  const s = byId('ratchet');
  const c = withMemory(s, { best: { bid: { price: 10000, qty: 99 }, ask: null } });
  assert.equal(sells(s.onEvent({ t: 'quote', side: 'bid', price: 10000, qty: 99 }, c)).length, 1);

  // A new high, but only 10% better: not enough to give up more inventory.
  c.best.bid = { price: 11000, qty: 99 };
  assert.deepEqual(sells(s.onEvent({ t: 'quote', side: 'bid', price: 11000, qty: 99 }, c)), []);

  // 40% better clears the bar.
  c.best.bid = { price: 14000, qty: 99 };
  assert.equal(sells(s.onEvent({ t: 'quote', side: 'bid', price: 14000, qty: 99 }, c)).length, 1);
});

test('ratchet does not sell into weakness', () => {
  const s = byId('ratchet');
  const c = withMemory(s, { best: { bid: { price: 12000, qty: 99 }, ask: null } });
  s.onEvent({ t: 'quote', side: 'bid', price: 12000, qty: 99 }, c);
  c.best.bid = { price: 11000, qty: 99 };
  assert.deepEqual(sells(s.onEvent({ t: 'quote', side: 'bid', price: 11000, qty: 99 }, c)), []);
});

// Trailing peak ---------------------------------------------------------------

test('trailing peak holds while the market makes new highs', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 1500 });
  for (const price of [10000, 12000, 14000, 16000]) {
    assert.deepEqual(sells(s.onEvent({ t: 'trade', price, qty: 5, tick: 1 }, c)), []);
  }
  assert.equal(c.memory.high, 16000);
});

test('trailing peak dumps once price breaks off the high', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 1500 });
  s.onEvent({ t: 'trade', price: 20000, qty: 5, tick: 1 }, c);
  // A 2% dip is noise and must not trigger.
  assert.deepEqual(sells(s.onEvent({ t: 'trade', price: 19600, qty: 5, tick: -1 }, c)), []);
  // A 5% break does.
  const out = s.onEvent({ t: 'trade', price: 19000, qty: 5, tick: -1 }, c);
  assert.equal(sells(out)[0].qty, 20);
});

test('trailing peak ignores an early dip', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 2900 });
  s.onEvent({ t: 'trade', price: 5000, qty: 5, tick: 1 }, c);
  assert.deepEqual(sells(s.onEvent({ t: 'trade', price: 4000, qty: 5, tick: -1 }, c)), []);
});

// End to end against a Session 1 shaped market --------------------------------

test('a market that pins at the cap gets every strategy out near the maximum', () => {
  const board = new StrategyBoard(strategies);
  board.handle({ t: 'session', state: 'start', total: 3000 });
  board.handle({ t: 'info', vt: 2 });
  board.handle({ t: 'account', cash: 0, position: 20, vt: 2 });

  // Climb, then pin at the cap the way Session 1 did from minute 19.6.
  let price = 1000;
  for (let clock = 2980; clock > 1200; clock -= 20) {
    price = Math.min(CAP, Math.round(price * 1.06));
    board.handle({ t: 'clock', clock, total: 3000 });
    board.handle({ t: 'quote', side: 'bid', price: price - 1, qty: 8000, depth: [] });
    board.handle({ t: 'quote', side: 'ask', price, qty: 500, depth: [] });
    board.handle({ t: 'trade', clock, price, qty: 40, tick: 1 });
  }

  for (const s of board.summaries) {
    assert.equal(s.position, 0, `${s.id} should be flat`);
    const avg = s.cash / 20;
    // The whole point: beat the 8,093 a bottle that Session 1 realised.
    assert.ok(avg > 8093, `${s.id} averaged ${avg.toFixed(0)}, no better than Session 1`);
  }
});
