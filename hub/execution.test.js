import test from 'node:test';
import assert from 'node:assert/strict';
import { Execution, LIMITS, CAP, roundToTick } from './execution.js';

const context = (over = {}) => ({
  strategyId: 'cap-strike',
  position: 20,
  cash: 0,
  isno: 1,
  myName: 'me@nhh.no',
  best: {
    bid: { price: 24000, qty: 500, trader: 'someone.else' },
    ask: { price: 24100, qty: 5, trader: 'another' },
  },
  ...over,
});

function armed(over = {}) {
  const ex = new Execution();
  ex.arm({ strategyId: 'cap-strike', ttlMs: 60000 }, 0);
  // Clear the rate limiter so each test controls its own timing.
  ex.lastAt = { cancel: -Infinity, urgent: -Infinity, routine: -Infinity };
  return { ex, ctx: context(over) };
}

const take = (qty = 5) => ({ kind: 'take', side: 'sell', qty });

// Arming ---------------------------------------------------------------------

test('nothing is accepted until armed', () => {
  const ex = new Execution();
  const out = ex.offer(take(), context());
  assert.equal(out.accepted, false);
  assert.match(out.reason, /not armed/);
});

test('arming requires a strategy and a positive window', () => {
  const ex = new Execution();
  assert.throws(() => ex.arm({ strategyId: null, ttlMs: 1000 }));
  assert.throws(() => ex.arm({ strategyId: 'cap-strike', ttlMs: 0 }));
});

test('the arm window expires on its own', () => {
  const ex = new Execution();
  ex.arm({ strategyId: 'cap-strike', ttlMs: 1000 }, 0);
  assert.equal(ex.tick(500), false);
  assert.equal(ex.armed, true);
  assert.equal(ex.tick(1001), true);
  assert.equal(ex.armed, false);
});

test('disarming drops anything still queued rather than sending it late', () => {
  const { ex, ctx } = armed();
  ex.offer(take(), ctx);
  assert.equal(ex.status.queued, 1);
  ex.disarm();
  assert.equal(ex.status.queued, 0);
  assert.equal(ex.armed, false);
});

test('only the armed strategy can place orders', () => {
  const { ex } = armed();
  const out = ex.offer(take(), context({ strategyId: 'ratchet' }));
  assert.equal(out.accepted, false);
  assert.match(out.reason, /not the armed one/);
});

// What may be sent ------------------------------------------------------------

test('a market sell becomes the wire message the page itself sends', () => {
  const { ex, ctx } = armed();
  const { order } = ex.offer(take(5), ctx);
  assert.equal(order.header, 'sell');
  assert.equal(order.isno, 1);
  assert.equal(order.price, '24000');
  assert.equal(order.qty, '5');
});

test('a resting sell goes out as an ask', () => {
  const { ex, ctx } = armed();
  const { order } = ex.offer({ kind: 'make', side: 'sell', qty: 20, price: 24999.99 }, ctx);
  assert.equal(order.header, 'ask');
  assert.equal(order.qty, '20');
  assert.equal(Number(order.price), 24999.99);
});

test('a cancel clears both sides of the book', () => {
  const { ex, ctx } = armed();
  const out = ex.offer({ kind: 'cancel' }, ctx);
  assert.deepEqual(out.orders.map((o) => o.header), ['clearasks', 'clearbids']);
});

test('buying is allowed below the ceiling', () => {
  const { ex, ctx } = armed({ best: { bid: null, ask: { price: 5000, qty: 50, trader: 'other' } } });
  const { order } = ex.offer({ kind: 'take', side: 'buy', qty: 10 }, ctx);
  assert.equal(order.header, 'buy');
  assert.equal(order.price, '5000');
  assert.equal(order.qty, '10');
});

test('buying above the ceiling is refused, because there is no upside left', () => {
  const { ex, ctx } = armed({ best: { bid: null, ask: { price: 20000, qty: 50, trader: 'other' } } });
  const out = ex.offer({ kind: 'take', side: 'buy', qty: 10 }, ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /buy ceiling/);
});

test('a resting bid above the ceiling is refused', () => {
  const { ex, ctx } = armed();
  const out = ex.offer({ kind: 'make', side: 'buy', qty: 10, price: 20000 }, ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /buy ceiling/);
});

test('a resting bid below the ceiling goes out as a bid', () => {
  const { ex, ctx } = armed();
  const { order } = ex.offer({ kind: 'make', side: 'buy', qty: 10, price: 6000 }, ctx);
  assert.equal(order.header, 'bid');
  assert.equal(order.price, '6000');
});

test('buying past the inventory ceiling is refused', () => {
  const { ex, ctx } = armed({
    position: LIMITS.maxInventory - 2,
    best: { bid: null, ask: { price: 5000, qty: 50, trader: 'other' } },
  });
  const out = ex.offer({ kind: 'take', side: 'buy', qty: 10 }, ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /ceiling/);
});

test('lifting your own offer is refused', () => {
  const { ex, ctx } = armed({
    best: { bid: null, ask: { price: 5000, qty: 50, trader: 'me@nhh.no' } },
  });
  const out = ex.offer({ kind: 'take', side: 'buy', qty: 10 }, ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /your own/);
});

test('selling more than is held is refused', () => {
  const { ex, ctx } = armed({ position: 3 });
  const out = ex.offer(take(5), ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /holding 3/);
});

test('selling with an unknown position is refused', () => {
  const { ex, ctx } = armed({ position: null });
  assert.equal(ex.offer(take(5), ctx).accepted, false);
});

test('a quantity above the ceiling is refused', () => {
  const { ex, ctx } = armed({ position: 500 });
  const out = ex.offer(take(LIMITS.maxQty + 1), ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /ceiling/);
});

test('a fractional or zero quantity is refused', () => {
  const { ex, ctx } = armed();
  assert.equal(ex.offer(take(0), ctx).accepted, false);
  assert.equal(ex.offer(take(-2), ctx).accepted, false);
});

test('taking with no bid on the book is refused', () => {
  const { ex, ctx } = armed({ best: { bid: null, ask: null } });
  const out = ex.offer(take(5), ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /no bid/);
});

test('hitting your own bid is refused', () => {
  const { ex, ctx } = armed({
    best: { bid: { price: 24000, qty: 10, trader: 'me@nhh.no' }, ask: null },
  });
  const out = ex.offer(take(5), ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /your own/);
});

test('a limit above the cap is refused', () => {
  const { ex, ctx } = armed();
  const out = ex.offer({ kind: 'make', side: 'sell', qty: 5, price: CAP + 1 }, ctx);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /cap/);
});

test('prices are snapped to the tick', () => {
  assert.equal(roundToTick(24999.987), 24999.99);
  assert.equal(roundToTick(100.001), 100);
});

test('a take never sends for more than the bid is showing', () => {
  const { ex, ctx } = armed({
    best: { bid: { price: 24000, qty: 3, trader: 'other' }, ask: null },
  });
  const { order } = ex.offer(take(10), ctx);
  assert.equal(order.qty, '3');
});

// Rate and volume ceilings -----------------------------------------------------

test('orders cannot be fired back to back', () => {
  const { ex, ctx } = armed();
  assert.equal(ex.offer(take(1), ctx, 10_000).accepted, true);
  assert.equal(ex.offer(take(1), ctx, 10_100).accepted, false);
  assert.equal(ex.offer(take(1), ctx, 10_000 + LIMITS.minGapMs).accepted, true);
});

test('the session order limit disarms rather than merely refusing', () => {
  const { ex, ctx } = armed();
  ex.sent = LIMITS.maxOrders;
  const out = ex.offer(take(1), ctx, 99_000);
  assert.equal(out.accepted, false);
  assert.equal(ex.armed, false);
});

// Acknowledgement --------------------------------------------------------------

test('draining hands the queue over once', () => {
  const { ex, ctx } = armed();
  ex.offer(take(1), ctx, 1000);
  assert.equal(ex.drain().length, 1);
  assert.equal(ex.drain().length, 0);
});

test('an unknown side is refused', () => {
  const { ex, ctx } = armed();
  assert.equal(ex.offer({ kind: 'take', side: 'sideways', qty: 1 }, ctx).accepted, false);
  assert.equal(ex.drain().length, 0);
});

test('a failed send disarms immediately', () => {
  const { ex, ctx } = armed();
  ex.offer(take(1), ctx, 1000);
  const orders = ex.drain();
  ex.acknowledge([{ id: orders[0].id, ok: false, error: 'socket closed' }]);
  assert.equal(ex.armed, false);
  assert.match(ex.lastError, /socket closed/);
});

test('a successful send counts against the session limit', () => {
  const { ex, ctx } = armed();
  ex.offer(take(1), ctx, 1000);
  const orders = ex.drain();
  ex.acknowledge([{ id: orders[0].id, ok: true }]);
  assert.equal(ex.status.sent, 1);
  assert.equal(ex.status.remaining, LIMITS.maxOrders - 1);
  assert.equal(ex.armed, true);
});

test('a guard cancel does not block the sell that follows it', () => {
  // The strategies emit cancel-then-sell as one pair. Both must get through.
  const { ex, ctx } = armed();
  const at = 5000;
  assert.equal(ex.offer({ kind: 'cancel' }, ctx, at).accepted, true);
  const sell = ex.offer(take(20), ctx, at);
  assert.equal(sell.accepted, true, sell.reason);
  assert.equal(sell.order.header, 'sell');

  const queued = ex.drain();
  assert.deepEqual(queued.map((o) => o.header), ['clearasks', 'clearbids', 'sell']);
});

test('cancels do not spend the session order budget', () => {
  const { ex, ctx } = armed();
  ex.sent = LIMITS.maxOrders;
  // A trade is refused at the limit, but pulling orders still has to work.
  assert.equal(ex.offer({ kind: 'cancel' }, ctx, 8000).accepted, true);
});

test('a repeated cancel with nothing placed in between is refused', () => {
  const { ex, ctx } = armed();
  assert.equal(ex.offer({ kind: 'cancel' }, ctx, 9000).accepted, true);
  assert.equal(ex.offer({ kind: 'cancel' }, ctx, 9050).accepted, false);
  // Once something is actually resting again, cancelling it is allowed.
  assert.equal(ex.offer({ kind: 'make', side: 'sell', qty: 5, price: 24000 }, ctx, 9100).accepted, true);
  assert.equal(ex.offer({ kind: 'cancel' }, ctx, 9110).accepted, true);
});

test('a cancel is never dropped ahead of the sell it protects', () => {
  // Cap strike parks, then the cap guard fires in the same batch. The guard's
  // cancel has to get through, or resting asks hold the position the sell needs.
  const { ex, ctx } = armed();
  const at = 40_000;
  ex.offer({ kind: 'cancel' }, ctx, at);
  ex.offer({ kind: 'make', side: 'sell', qty: 20, price: 24999.99 }, ctx, at);
  assert.equal(ex.offer({ kind: 'cancel' }, ctx, at).accepted, true);
  assert.equal(ex.offer({ kind: 'take', side: 'sell', qty: 20, urgent: true }, ctx, at).accepted, true);

  assert.deepEqual(
    ex.drain().map((o) => o.header),
    ['clearasks', 'clearbids', 'ask', 'clearasks', 'clearbids', 'sell'],
  );
});

test('an urgent sell is not starved by a routine order in the same batch', () => {
  const { ex, ctx } = armed();
  const at = 20_000;
  // Cap strike parks a resting ask on a clock tick...
  assert.equal(ex.offer({ kind: 'make', side: 'sell', qty: 20, price: 24999.99 }, ctx, at).accepted, true);
  // ...and the cap guard fires on the very next message. It must still get out.
  const urgent = ex.offer({ kind: 'take', side: 'sell', qty: 20, urgent: true }, ctx, at + 1);
  assert.equal(urgent.accepted, true, urgent.reason);
  assert.equal(urgent.order.header, 'sell');
});

test('urgent orders are still rate limited and still spend the budget', () => {
  const { ex, ctx } = armed();
  const at = 30_000;
  assert.equal(ex.offer({ kind: 'take', side: 'sell', qty: 1, urgent: true }, ctx, at).accepted, true);
  assert.equal(ex.offer({ kind: 'take', side: 'sell', qty: 1, urgent: true }, ctx, at + 10).accepted, false);
  assert.equal(
    ex.offer({ kind: 'take', side: 'sell', qty: 1, urgent: true }, ctx, at + LIMITS.minUrgentGapMs).accepted,
    true,
  );

  ex.sent = LIMITS.maxOrders;
  assert.equal(ex.offer({ kind: 'take', side: 'sell', qty: 1, urgent: true }, ctx, at + 5000).accepted, false);
});
