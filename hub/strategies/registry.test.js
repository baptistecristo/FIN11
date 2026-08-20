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

  test(`${strategy.id}: never pays more than a bottle can be worth`, () => {
    // Corner and Sniper buy; the others do not. What binds all five is that
    // nothing may be bought above what it can be sold for, since no price
    // above the cap can ever print and the bottle pays zero at the bell.
    const c = withMemory(strategy, { position: 5 });
    c.best = { bid: { price: 24500, qty: 99 }, ask: { price: 24000, qty: 99 } };
    for (const event of [
      { t: 'trade', price: 24000, qty: 3, tick: 1 },
      { t: 'quote', side: 'ask', price: 24000, qty: 99 },
      { t: 'quote', side: 'bid', price: 24500, qty: 99 },
      { t: 'clock', clock: 2000 },
    ]) {
      for (const intent of strategy.onEvent(event, c) ?? []) {
        if (intent.side !== 'buy') continue;
        const price = intent.kind === 'make' ? intent.price : c.best.ask.price;
        assert.ok(price < CAP, `${strategy.id} would pay ${price} for something worth zero at the bell`);
      }
    }
  });
}

// Only these three are pure sellers. Stated explicitly so that adding a buying
// strategy later cannot quietly slip past the check.
for (const id of ['cap-strike', 'ratchet', 'trailing-peak']) {
  test(`${id}: never buys at all`, () => {
    const strategy = byId(id);
    const c = withMemory(strategy);
    c.best = { bid: { price: 9000, qty: 99 }, ask: { price: 500, qty: 99 } };
    for (const event of [
      { t: 'trade', price: 5000, qty: 3, tick: 1 },
      { t: 'quote', side: 'ask', price: 500, qty: 99 },
      { t: 'quote', side: 'bid', price: 9000, qty: 99 },
      { t: 'clock', clock: 2000 },
    ]) {
      const out = strategy.onEvent(event, c) ?? [];
      assert.equal(out.some((i) => i.side === 'buy'), false, `${id} tried to buy`);
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

test('ratchet parts with almost nothing early in a climb', () => {
  const s = byId('ratchet');
  // A tenth of the way to the ceiling: nearly all of the move is still ahead.
  const c = withMemory(s, { best: { bid: { price: 2500, qty: 99 }, ask: null } });
  const out = sells(s.onEvent({ t: 'quote', side: 'bid', price: 2500, qty: 99 }, c));
  const qty = out.reduce((n, i) => n + i.qty, 0);
  assert.ok(qty <= 1, `sold ${qty} of 20 at a tenth of the cap`);
});

test('ratchet sells more as the bid closes on the cap', () => {
  const s = byId('ratchet');
  const c = withMemory(s, { best: { bid: { price: 17500, qty: 99 }, ask: null } });
  // 70% of the way to the ceiling, squared, is about half the endowment.
  const qty = sells(s.onEvent({ t: 'quote', side: 'bid', price: 17500, qty: 99 }, c))
    .reduce((n, i) => n + i.qty, 0);
  assert.ok(qty >= 8 && qty <= 12, `sold ${qty} at 70% of the cap`);
});

test('ratchet never sells backwards when the bid falls', () => {
  const s = byId('ratchet');
  const c = withMemory(s, { best: { bid: { price: 17500, qty: 99 }, ask: null } });
  const first = sells(s.onEvent({ t: 'quote', side: 'bid', price: 17500, qty: 99 }, c))
    .reduce((n, i) => n + i.qty, 0);
  c.position = 20 - first;
  c.best.bid = { price: 10000, qty: 99 };
  assert.deepEqual(sells(s.onEvent({ t: 'quote', side: 'bid', price: 10000, qty: 99 }, c)), []);
});

test('ratchet still sells near the session high when the cap never comes', () => {
  const s = byId('ratchet');
  // Half the session gone, the market topped out at 200, and the cap-relative
  // anchor is therefore worthless. This is the case the old 40%-of-cap floor
  // sat out entirely.
  const c = withMemory(s, { clock: 1500, best: { bid: { price: 200, qty: 99 }, ask: null } });
  const qty = sells(s.onEvent({ t: 'quote', side: 'bid', price: 200, qty: 99 }, c))
    .reduce((n, i) => n + i.qty, 0);
  assert.ok(qty > 0, 'expected the session-relative anchor to sell something');
});

// Trailing peak ---------------------------------------------------------------

test('trailing peak holds while the market makes new highs', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 1500 });
  for (const price of [10000, 12000, 14000, 16000]) {
    assert.deepEqual(sells(s.onEvent({ t: 'trade', price, qty: 5, tick: 1 }, c)), []);
  }
  assert.equal(c.memory.sessionHigh, 16000);
});

test('trailing peak needs the break confirmed before it leaves', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 1500 });
  // The break is measured on the bid, which is what leaving actually sells
  // into, so the book moves with the prints.
  const at = (price) => {
    c.best.bid = { price, qty: 99 };
    return sells(s.onEvent({ t: 'trade', price, qty: 5, tick: price >= 20000 ? 1 : -1 }, c));
  };
  at(10000);
  at(20000);

  assert.deepEqual(at(19600), [], 'a 2% dip is noise');
  assert.deepEqual(at(18000), [], 'one print past the band is not a break');
  assert.deepEqual(at(18000), [], 'nor is two');
  // Third confirms it, and it leaves in tranches rather than all at once.
  assert.equal(at(18000)[0].qty, 10);
});

test('trailing peak widens its band in a market that wobbles', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 1500 });
  const at = (price, tick = 1) => {
    c.best.bid = { price, qty: 99 };
    return sells(s.onEvent({ t: 'trade', price, qty: 5, tick }, c));
  };
  at(10000);
  at(20000);
  // A 15% pullback that recovers to a new high: this market's ordinary weather.
  at(17000, -1);
  at(21000);
  // The same 15% again is now inside the learned band, so it is not a top.
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(at(17850, -1), [], 'a pullback it has already survived is not a break');
  }
});

test('trailing peak ignores a dip before the market has actually run', () => {
  const s = byId('trailing-peak');
  const c = withMemory(s, { clock: 1500 });
  // Opens at 10,000 and never gets to 1.5x, so a fall is not a top.
  s.onEvent({ t: 'trade', price: 10000, qty: 5, tick: 1 }, c);
  s.onEvent({ t: 'trade', price: 11000, qty: 5, tick: 1 }, c);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(sells(s.onEvent({ t: 'trade', price: 9000, qty: 5, tick: -1 }, c)), []);
  }
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

// The fallback for a session that never reaches the cap ----------------------

test('the reserve holds at the session high before halfway', () => {
  const s = byId('cap-strike');
  const c = withMemory(s, { clock: 1700, best: { bid: { price: 9000, qty: 99 }, ask: null } });
  s.onEvent({ t: 'trade', price: 10000, qty: 5, tick: 1 }, c);
  // 9,000 is below the 10,000 high, and it is not yet halfway.
  const out = s.onEvent({ t: 'quote', side: 'bid', price: 9000, qty: 99 }, c);
  assert.deepEqual(sells(out), []);
});

test('the reserve concedes as the clock runs down', () => {
  const s = byId('cap-strike');
  const c = withMemory(s, { clock: 1500, best: { bid: { price: 10000, qty: 99 }, ask: null } });
  s.onEvent({ t: 'trade', price: 10000, qty: 5, tick: 1 }, c);

  // At the halfway mark the bar is still the full high.
  c.best.bid = { price: 7000, qty: 99 };
  assert.deepEqual(sells(s.onEvent({ t: 'quote', side: 'bid', price: 7000, qty: 99 }, c)), []);

  // Two thirds of the way from halfway to the deadline, the bar has fallen far
  // enough that 7,000 clears it.
  c.clock = 700;
  assert.equal(sells(s.onEvent({ t: 'quote', side: 'bid', price: 7000, qty: 99 }, c)).length, 1);
});

test('a session that never approaches the cap still gets sold down', () => {
  const board = new StrategyBoard(strategies);
  board.handle({ t: 'session', state: 'start', total: 3000 });
  board.handle({ t: 'info', vt: 2 });
  board.handle({ t: 'account', cash: 0, position: 20, vt: 2 });

  // A market that drifts around 900 and never goes near 25,000.
  let price = 900;
  for (let clock = 2980; clock > 100; clock -= 20) {
    price = Math.max(500, Math.round(price * (clock % 120 === 0 ? 1.02 : 0.995)));
    board.handle({ t: 'clock', clock, total: 3000 });
    board.handle({ t: 'quote', side: 'bid', price: price - 1, qty: 500, depth: [] });
    board.handle({ t: 'quote', side: 'ask', price, qty: 500, depth: [] });
    board.handle({ t: 'trade', clock, price, qty: 20, tick: 1 });
  }

  for (const s of board.summaries) {
    assert.equal(s.position, 0, `${s.id} must not be left holding`);
    assert.ok(s.fills > 0, `${s.id} made no trades at all`);
    // Selling into a drifting market should still beat dumping everything at
    // the bell into whatever bid happened to be left.
    assert.ok(s.cash > 0, `${s.id} realised nothing`);
  }
});

test('cap strike does not wait for a cap that never arrives', () => {
  const board = new StrategyBoard([strategies.find((x) => x.id === 'cap-strike')]);
  board.handle({ t: 'session', state: 'start', total: 3000 });
  board.handle({ t: 'account', cash: 0, position: 20, vt: 2 });

  for (let clock = 2980; clock > 400; clock -= 20) {
    board.handle({ t: 'clock', clock, total: 3000 });
    board.handle({ t: 'quote', side: 'bid', price: 1000, qty: 500, depth: [] });
    board.handle({ t: 'trade', clock, price: 1000, qty: 20, tick: 0 });
  }

  const [summary] = board.summaries;
  // It should have started conceding well before the bell guard would fire.
  assert.ok(summary.fills > 0, 'cap strike sat on its hands with no cap in sight');
  assert.ok(summary.position < 20, 'cap strike never reduced its position');
});

// Corner ----------------------------------------------------------------------

test('corner never bids above its ceiling, whatever the market does', () => {
  const s = byId('corner');
  const c = withMemory(s, { clock: 2900, position: 0 });
  // Market already trading at 20,000: far above what is worth paying for
  // something that expires worthless.
  c.best = { bid: { price: 20000, qty: 99 }, ask: { price: 20100, qty: 99 } };
  const out = s.onEvent({ t: 'quote', side: 'bid', price: 20000, qty: 99 }, c) ?? [];
  const bids = out.filter((i) => i.side === 'buy');
  for (const b of bids) {
    if (b.kind === 'make') assert.ok(b.price <= CAP * 0.3, `bid ${b.price} above ceiling`);
  }
  // Taking a 20,100 offer would be worse still.
  assert.equal(out.some((i) => i.kind === 'take' && i.side === 'buy'), false);
});

// Corner only buys once a bubble is visibly under way, so its tests have to
// hand it a market that has already run.
const bubbling = (c, { openBid = 100, bidHigh = 5000 } = {}) => {
  c.memory.openBid = openBid;
  c.memory.bidHigh = bidHigh;
  return c;
};

test('corner improves the bid by a step rather than leaping above it', () => {
  const s = byId('corner');
  const c = bubbling(withMemory(s, { clock: 2900, position: 0 }));
  // The offer is above the buy ceiling, so there is nothing cheap to take and
  // it has to post a bid instead.
  c.best = { bid: { price: 1000, qty: 50 }, ask: { price: 9000, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'bid', price: 1000, qty: 50 }, c);
  const bid = out.find((i) => i.kind === 'make');
  assert.ok(bid, 'expected a resting bid');
  assert.ok(bid.price > 1000, 'should better the market');
  // Leaping miles above makes you the only buyer and everyone dumps on you.
  assert.ok(bid.price < 1200, `bid ${bid.price} is far above the market`);
});

test('corner takes an offer that is already cheap instead of advertising', () => {
  const s = byId('corner');
  const c = bubbling(withMemory(s, { clock: 2900, position: 0 }));
  c.best = { bid: { price: 500, qty: 50 }, ask: { price: 3000, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 3000, qty: 50 }, c);
  const take = out.find((i) => i.kind === 'take');
  assert.equal(take.side, 'buy');
});

test('corner will not buy in a market that has not bubbled', () => {
  const s = byId('corner');
  // Opened at 100 and has never been above 150: no bubble, no bet. This is the
  // session where the old version spent its way through the endowment.
  const c = bubbling(withMemory(s, { clock: 2900, position: 0 }), { openBid: 100, bidHigh: 150 });
  c.best = { bid: { price: 120, qty: 50 }, ask: { price: 130, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 130, qty: 50 }, c) ?? [];
  assert.equal(out.some((i) => i.side === 'buy'), false);
});

test('corner never pays more than a bid this session has already shown', () => {
  const s = byId('corner');
  // The ceiling is a share of the cap OR a share of the best bid seen,
  // whichever is lower. Here the market has only ever bid 1,000.
  const c = bubbling(withMemory(s, { clock: 2900, position: 0 }), { openBid: 100, bidHigh: 1000 });
  c.best = { bid: { price: 900, qty: 50 }, ask: { price: 950, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 950, qty: 50 }, c) ?? [];
  assert.equal(out.some((i) => i.kind === 'take' && i.side === 'buy'), false,
    'a 950 offer is above 90% of the best bid ever seen');
});

test('corner stops buying once the accumulation window closes', () => {
  const s = byId('corner');
  // 60% elapsed: well past the window.
  const c = withMemory(s, { clock: 1200, position: 40 });
  c.best = { bid: { price: 1000, qty: 50 }, ask: { price: 1100, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 1100, qty: 50 }, c) ?? [];
  assert.equal(out.some((i) => i.side === 'buy'), false);
});

test('corner stops buying at its inventory ceiling', () => {
  const s = byId('corner');
  const c = withMemory(s, { clock: 2900, position: 70 });
  c.best = { bid: { price: 500, qty: 50 }, ask: { price: 1000, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 1000, qty: 50 }, c) ?? [];
  assert.equal(out.some((i) => i.side === 'buy'), false);
});

test('corner sells the accumulated pile into the cap like everything else', () => {
  const s = byId('corner');
  const c = withMemory(s, { clock: 1500, position: 65 });
  c.best = { bid: { price: CAP, qty: 8000 }, ask: null };
  const out = s.onEvent({ t: 'quote', side: 'bid', price: CAP, qty: 8000 }, c);
  assert.equal(sells(out)[0].qty, 65);
});

test('corner does not get caught holding at the bell', () => {
  const board = new StrategyBoard([byId('corner')]);
  board.handle({ t: 'session', state: 'start', total: 3000 });
  board.handle({ t: 'info', vt: 2 });

  // A market that stays cheap all session and never bubbles: the bad case.
  for (let clock = 2980; clock > 60; clock -= 20) {
    board.handle({ t: 'clock', clock, total: 3000 });
    board.handle({ t: 'quote', side: 'bid', price: 900, qty: 200, depth: [] });
    board.handle({ t: 'quote', side: 'ask', price: 1000, qty: 200, depth: [] });
    board.handle({ t: 'trade', clock, price: 950, qty: 30, tick: 0 });
  }
  const [summary] = board.summaries;
  assert.equal(summary.position, 0, 'corner must not be left holding worthless bottles');
});

// Sniper ----------------------------------------------------------------------

test('sniper takes both legs of a crossed book at once', () => {
  const s = byId('sniper');
  const c = withMemory(s, { position: 20 });
  c.best = { bid: { price: 24000, qty: 50 }, ask: { price: 23000, qty: 30 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 23000, qty: 30 }, c);
  const buy = out.find((i) => i.side === 'buy');
  const sell = out.find((i) => i.side === 'sell');
  assert.ok(buy && sell, 'both legs must go together');
  assert.equal(buy.qty, sell.qty, 'an unmatched leg is a naked position');
  assert.equal(buy.urgent, true);
  assert.equal(sell.urgent, true);
});

test('sniper ignores an uncrossed book', () => {
  const s = byId('sniper');
  const c = withMemory(s, { position: 20 });
  c.best = { bid: { price: 24000, qty: 50 }, ask: { price: 24001, qty: 30 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 24001, qty: 30 }, c) ?? [];
  assert.equal(out.some((i) => i.side === 'buy'), false);
});

test('sniper ignores a locked book, where the edge is zero', () => {
  const s = byId('sniper');
  const c = withMemory(s, { position: 20 });
  // 986 of the 1,403 captured book states looked exactly like this.
  c.best = { bid: { price: 25000, qty: 8000 }, ask: { price: 25000, qty: 500 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 25000, qty: 500 }, c) ?? [];
  assert.equal(out.some((i) => i.side === 'buy'), false);
});

test('sniper never takes more than either side is showing', () => {
  const s = byId('sniper');
  const c = withMemory(s, { position: 20 });
  c.best = { bid: { price: 24000, qty: 3 }, ask: { price: 20000, qty: 50 } };
  const out = s.onEvent({ t: 'quote', side: 'ask', price: 20000, qty: 50 }, c);
  assert.equal(out.find((i) => i.side === 'buy').qty, 3);
});
