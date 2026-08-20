import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyBoard, StrategyRunner, Portfolio } from './engine.js';

// A strategy that emits whatever the test hands it, once.
function scripted(intents, id = 'test') {
  let done = false;
  return {
    id,
    name: id,
    blurb: '',
    init: () => ({}),
    onEvent: () => {
      if (done) return [];
      done = true;
      return intents;
    },
  };
}

function runnerWith(intents) {
  const runner = new StrategyRunner(scripted(intents));
  runner.seed(0, 20);
  return runner;
}

const market = (over = {}) => ({
  clock: 2000,
  total: 3000,
  best: { bid: { price: 24000, qty: 10 }, ask: { price: 24100, qty: 8 } },
  last: 24000,
  vt: 5,
  ...over,
});

test('gain counts cash and realized utility, never bottles', () => {
  const p = new Portfolio();
  p.seed(0, 10);
  p.record('sell', 5, 100, 2000, 5);
  assert.equal(p.cash, 500);
  assert.equal(p.position, 5);
  // Five bottles left, contributing nothing.
  assert.equal(p.gain, 500);
});

test('buying accrues utility at the private value', () => {
  const p = new Portfolio();
  p.seed(1000, 0);
  p.record('buy', 4, 100, 2000, 5);
  assert.equal(p.cash, 600);
  assert.equal(p.position, 4);
  assert.equal(p.realizedUtility, 20);
  assert.equal(p.gain, 620);
});

test('a taking sell fills at the bid, not at the last price', () => {
  const runner = runnerWith([{ kind: 'take', side: 'sell', qty: 5 }]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  const fill = runner.portfolio.fills.at(-1);
  assert.equal(fill.price, 24000);
  assert.equal(fill.qty, 5);
  assert.equal(runner.portfolio.position, 15);
});

test('a taking order cannot fill for more than is quoted', () => {
  const runner = runnerWith([{ kind: 'take', side: 'sell', qty: 20 }]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  // Only 10 quoted on the bid.
  assert.equal(runner.portfolio.fills.at(-1).qty, 10);
  assert.equal(runner.portfolio.position, 10);
});

test('a taking order with no quote on that side does not fill', () => {
  const runner = runnerWith([{ kind: 'take', side: 'sell', qty: 5 }]);
  runner.step({ t: 'clock', clock: 2000 }, market({ best: { bid: null, ask: null } }));
  assert.equal(runner.portfolio.fills.length, 0);
  assert.equal(runner.portfolio.rejected, 1);
});

test('a resting sell does NOT fill at its own price', () => {
  const runner = runnerWith([{ kind: 'make', side: 'sell', qty: 5, price: 24500 }]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  assert.equal(runner.portfolio.resting.length, 1);
  // A print exactly at the order's price leaves it behind the existing queue.
  runner.step({ t: 'trade', price: 24500, qty: 50, tick: 1 }, market());
  assert.equal(runner.portfolio.fills.length, 0);
  assert.equal(runner.portfolio.resting.length, 1);
});

test('a resting sell fills when the market trades through it', () => {
  const runner = runnerWith([{ kind: 'make', side: 'sell', qty: 5, price: 24500 }]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  runner.step({ t: 'trade', price: 24600, qty: 50, tick: 1 }, market());
  const fill = runner.portfolio.fills.at(-1);
  assert.equal(fill.qty, 5);
  assert.equal(fill.price, 24500);
  assert.equal(runner.portfolio.resting.length, 0);
});

test('a resting fill is capped by the size of the print', () => {
  const runner = runnerWith([{ kind: 'make', side: 'sell', qty: 10, price: 24500 }]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  runner.step({ t: 'trade', price: 24600, qty: 3, tick: 1 }, market());
  assert.equal(runner.portfolio.fills.at(-1).qty, 3);
  // The rest stays in the book.
  assert.equal(runner.portfolio.resting[0].qty, 7);
});

test('short selling is refused', () => {
  const runner = runnerWith([{ kind: 'take', side: 'sell', qty: 5 }]);
  runner.portfolio.position = 0;
  runner.step({ t: 'clock', clock: 2000 }, market());
  assert.equal(runner.portfolio.fills.length, 0);
  assert.equal(runner.portfolio.rejected, 1);
});

test('resting sells cannot commit more than the position holds', () => {
  const runner = new StrategyRunner(
    scripted([
      { kind: 'make', side: 'sell', qty: 15, price: 24500 },
      { kind: 'make', side: 'sell', qty: 15, price: 24600 },
    ]),
  );
  runner.seed(0, 20);
  runner.step({ t: 'clock', clock: 2000 }, market());
  const committed = runner.portfolio.resting.reduce((n, o) => n + o.qty, 0);
  assert.equal(committed, 20);
});

test('a cancel clears the resting book', () => {
  const runner = runnerWith([
    { kind: 'make', side: 'sell', qty: 5, price: 24500 },
    { kind: 'cancel' },
  ]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  assert.equal(runner.portfolio.resting.length, 0);
});

test('an order above the price cap is refused', () => {
  const runner = runnerWith([{ kind: 'make', side: 'sell', qty: 5, price: 25001 }]);
  runner.step({ t: 'clock', clock: 2000 }, market());
  assert.equal(runner.portfolio.resting.length, 0);
});

test('nothing trades before the account is seeded', () => {
  const runner = new StrategyRunner(scripted([{ kind: 'take', side: 'sell', qty: 5 }]));
  runner.step({ t: 'clock', clock: 2000 }, market());
  assert.equal(runner.portfolio.fills.length, 0);
});

test('every strategy is seeded from the same real account', () => {
  const board = new StrategyBoard([scripted([], 'a'), scripted([], 'b')]);
  board.handle({ t: 'account', cash: 0, position: 20, vt: 5 });
  for (const r of board.runners) {
    assert.equal(r.portfolio.position, 20);
    assert.equal(r.portfolio.cash, 0);
  }
});

test('a later account update does not re-seed a running portfolio', () => {
  const board = new StrategyBoard([scripted([], 'a')]);
  board.handle({ t: 'account', cash: 0, position: 20, vt: 5 });
  board.runners[0].portfolio.record('sell', 5, 100, 2000, 5);
  board.handle({ t: 'account', cash: 999999, position: 3, vt: 5 });
  assert.equal(board.runners[0].portfolio.position, 15);
  assert.equal(board.runners[0].portfolio.cash, 500);
});

test('a new period resets the comparison', () => {
  const board = new StrategyBoard([scripted([], 'a')]);
  board.handle({ t: 'account', cash: 0, position: 20, vt: 5 });
  board.runners[0].portfolio.record('sell', 5, 100, 2000, 5);
  board.handle({ t: 'session', state: 'start', total: 3000 });
  assert.equal(board.runners[0].portfolio.seeded, false);
  assert.equal(board.runners[0].portfolio.fills.length, 0);
});

test('the sparkline keeps one point per clock unit', () => {
  const runner = runnerWith([]);
  for (const clock of [2000, 2000, 1999, 1998]) {
    runner.step({ t: 'clock', clock }, market({ clock }));
  }
  assert.equal(runner.series.length, 3);
});
