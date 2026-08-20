import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, num, parseBook, parsePerformance, unwrap } from './protocol.js';

// Feeds messages through a tracker the way the server does: handle each message
// in the batch, then flush once.
function feed(tracker, messages, { force = false } = {}) {
  const events = [];
  for (const m of messages) events.push(...tracker.handle(m));
  events.push(...tracker.flush(force));
  return events;
}

// A tracker whose clock the test drives, for the leg-timeout cases.
function trackerWithClock() {
  const clock = { t: 0 };
  return { tr: new Tracker({ now: () => clock.t }), clock };
}

const only = (events, t) => events.filter((e) => e.t === t);

test('num strips the thousands separators the server sends', () => {
  assert.equal(num('24,000'), 24000);
  assert.equal(num('1.2'), 1.2);
  assert.equal(num(''), null);
  assert.equal(num(undefined), null);
  assert.equal(num('nonsense'), null);
});

test('unwrap handles both batched arrays and single objects', () => {
  assert.equal(unwrap('[{"header":"time"},{"header":"cash"}]').length, 2);
  assert.equal(unwrap('{"header":"time"}').length, 1);
  assert.deepEqual(unwrap('not json'), []);
  assert.deepEqual(unwrap('[]'), []);
});

test('parseBook reads the depth ladder out of table-row HTML', () => {
  const html = '<tr><td>24,000</td><td>189</td></tr><tr><td>23,999</td><td>10</td></tr>';
  assert.deepEqual(parseBook(html), [
    { price: 24000, qty: 189 },
    { price: 23999, qty: 10 },
  ]);
  assert.deepEqual(parseBook(''), []);
  assert.deepEqual(parseBook(null), []);
});

test('parsePerformance splits the delimited ranking table', () => {
  assert.deepEqual(parsePerformance('a%b#c%d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('bidasklast becomes a curve point on the game clock', () => {
  const tr = new Tracker();
  const [point] = only(
    feed(tr, [{ header: 'bidasklast', isno: 1, iTime: '1839', msg: '24,000', msg1: '24,999', msg2: '24,000' }]),
    'curve',
  );
  assert.deepEqual(point, { t: 'curve', clock: 1839, bid: 24000, ask: 24999, last: 24000 });
});

test('bidasklast treats non-positive values as absent quotes', () => {
  const tr = new Tracker();
  const [point] = only(
    feed(tr, [{ header: 'bidasklast', isno: 1, iTime: '1000', msg: '0', msg1: '-1', msg2: '24,000' }]),
    'curve',
  );
  assert.equal(point.bid, null);
  assert.equal(point.ask, null);
  assert.equal(point.last, 24000);
});

test('a bidasklast with nothing quoted produces no point', () => {
  const tr = new Tracker();
  assert.deepEqual(
    only(feed(tr, [{ header: 'bidasklast', isno: 1, iTime: '1000', msg: '0', msg1: '0', msg2: '0' }]), 'curve'),
    [],
  );
});

test('lastTick gives the trade side directly', () => {
  const tr = new Tracker();
  const events = feed(tr, [
    { header: 'time', msg: '1839' },
    { header: 'lasttrade', isno: 1, price: '24,000', lastTick: '1', qty: '5' },
    { header: 'lasttrade', isno: 1, price: '23,999', lastTick: '-1', qty: '2' },
    { header: 'lasttrade', isno: 1, price: '23,999', lastTick: '0' },
  ]);
  const trades = only(events, 'trade');
  assert.equal(trades[0].side, 'buy');
  assert.equal(trades[0].qty, 5);
  assert.equal(trades[0].clock, 1839);
  assert.equal(trades[1].side, 'sell');
  assert.equal(trades[2].side, null);
  // The page's own handler ignores qty, so treat it as optional but flag the guess.
  assert.equal(trades[2].qty, 1);
  assert.equal(trades[2].qtyKnown, false);
  assert.equal(trades[0].qtyKnown, true);
});

test('best quotes carry the quoting trader and the depth ladder', () => {
  const tr = new Tracker();
  const [quote] = only(
    feed(tr, [
      {
        header: 'bestbid',
        isno: 1,
        msg: 'x',
        price: '24,000',
        qty: '189',
        displayName: 'alice.trader',
        msg2: '<tr><td>24,000</td><td>189</td></tr>',
      },
    ]),
    'quote',
  );
  assert.equal(quote.side, 'bid');
  assert.equal(quote.price, 24000);
  assert.equal(quote.trader, 'alice.trader');
  assert.deepEqual(quote.depth, [{ price: 24000, qty: 189 }]);
});

test('an empty best quote clears the side', () => {
  const tr = new Tracker();
  const [quote] = only(feed(tr, [{ header: 'bestask', isno: 1, msg: '' }]), 'quote');
  assert.equal(quote.price, null);
  assert.deepEqual(quote.depth, []);
  assert.equal(tr.best.ask, null);
});

test('a sell is reconstructed from the cash and position legs together', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'time', msg: '1839' },
    { header: 'cash', msg: '0' },
    { header: 'endow', isno: 1, msg: '20' },
  ]);
  // Both legs of the fill, in one batch, position first.
  const fills = only(
    feed(tr, [
      { header: 'endow', isno: 1, msg: '15' },
      { header: 'cash', msg: '120,000' },
    ]),
    'myfill',
  );
  assert.equal(fills.length, 1);
  assert.deepEqual(
    { side: fills[0].side, qty: fills[0].qty, price: fills[0].price },
    { side: 'sell', qty: 5, price: 24000 },
  );
});

test('a buy is reconstructed with cash arriving first', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'cash', msg: '100,000' },
    { header: 'endow', isno: 1, msg: '0' },
  ]);
  const fills = only(
    feed(tr, [
      { header: 'cash', msg: '52,000' },
      { header: 'endow', isno: 1, msg: '2' },
    ]),
    'myfill',
  );
  assert.deepEqual(
    { side: fills[0].side, qty: fills[0].qty, price: fills[0].price },
    { side: 'buy', qty: 2, price: 24000 },
  );
});

test('a fill whose legs straddle two batches is not priced at zero', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'cash', msg: '0' },
    { header: 'endow', isno: 1, msg: '20' },
  ]);
  // Position leg alone: must not resolve yet, or the price would come out zero.
  assert.deepEqual(only(feed(tr, [{ header: 'endow', isno: 1, msg: '15' }]), 'myfill'), []);
  // Cash leg lands in the next batch and completes the pair.
  const fills = only(feed(tr, [{ header: 'cash', msg: '120,000' }]), 'myfill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].price, 24000);
  assert.equal(fills[0].qty, 5);
});

test('a forced flush waits out the leg timeout before giving up on the price', () => {
  const { tr, clock } = trackerWithClock();
  feed(tr, [
    { header: 'cash', msg: '0' },
    { header: 'endow', isno: 1, msg: '20' },
  ]);
  tr.handle({ header: 'endow', isno: 1, msg: '15' });
  // Forcing inside the window must not resolve: an unpriced fill is permanent,
  // and the cash leg is very likely still in flight.
  clock.t = 500;
  assert.deepEqual(tr.flush(true), []);
  // The cash leg arrives late but still gets the price right.
  clock.t = 2000;
  const fills = only(feed(tr, [{ header: 'cash', msg: '120,000' }]), 'myfill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].price, 24000);
});

test('a fill whose cash leg never arrives is reported unpriced, not dropped', () => {
  const { tr, clock } = trackerWithClock();
  feed(tr, [
    { header: 'cash', msg: '0' },
    { header: 'endow', isno: 1, msg: '20' },
  ]);
  tr.handle({ header: 'endow', isno: 1, msg: '15' });
  clock.t = 4000;
  const fills = tr.flush(true).filter((e) => e.t === 'myfill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].qty, 5);
  assert.equal(fills[0].side, 'sell');
  assert.equal(fills[0].price, null);
});

test('cash moving on its own is not reported as a fill', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'cash', msg: '0' },
    { header: 'endow', isno: 1, msg: '20' },
  ]);
  assert.deepEqual(only(feed(tr, [{ header: 'cash', msg: '10' }], { force: true }), 'myfill'), []);
});

test('the opening account state is not mistaken for a fill', () => {
  const tr = new Tracker();
  const fills = only(
    feed(tr, [
      { header: 'cash', msg: '0' },
      { header: 'endow', isno: 1, msg: '20' },
    ]),
    'myfill',
  );
  assert.deepEqual(fills, []);
});

test('session lifecycle and clock are tracked', () => {
  const tr = new Tracker();
  const events = feed(tr, [
    { header: 'startperiod', iTime: '3000', msg: '1' },
    { header: 'time', msg: '2999' },
    { header: 'pausemarket' },
    { header: 'resumemarket' },
    { header: 'endperiod' },
  ]);
  assert.deepEqual(
    only(events, 'session').map((e) => e.state),
    ['start', 'pause', 'resume', 'end'],
  );
  assert.equal(tr.sessionLength, 3000);
  assert.equal(tr.clock, 2999);
  assert.equal(only(events, 'clock').at(-1).total, 3000);
});

test('the private value is pulled out of the info message', () => {
  const tr = new Tracker();
  const [info] = only(feed(tr, [{ header: 'info', isno: 1, msg: 'Your value is 5.02 per bottle' }]), 'info');
  assert.equal(info.vt, 5.02);
});

test('unknown headers are ignored rather than throwing', () => {
  const tr = new Tracker();
  assert.deepEqual(feed(tr, [{ header: 'somethingnew', msg: 'x' }, {}, { nope: 1 }]), []);
});

test('a print at the best ask names the resting seller', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'bestask', isno: 1, msg: 'x', price: '25,000', qty: '5', displayName: 'bob.trader' },
    { header: 'bestbid', isno: 1, msg: 'x', price: '24,000', qty: '9', displayName: 'alice.trader' },
  ]);
  const [trade] = only(feed(tr, [{ header: 'lasttrade', isno: 1, price: '25,000', lastTick: '1' }]), 'trade');
  assert.equal(trade.restingTrader, 'bob.trader');
  assert.equal(trade.restingSide, 'ask');
});

test('a print at the best bid names the resting buyer', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'bestask', isno: 1, msg: 'x', price: '25,000', qty: '5', displayName: 'bob.trader' },
    { header: 'bestbid', isno: 1, msg: 'x', price: '24,000', qty: '9', displayName: 'alice.trader' },
  ]);
  const [trade] = only(feed(tr, [{ header: 'lasttrade', isno: 1, price: '24,000', lastTick: '-1' }]), 'trade');
  assert.equal(trade.restingTrader, 'alice.trader');
  assert.equal(trade.restingSide, 'bid');
});

test('a print away from both quotes names nobody', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'bestask', isno: 1, msg: 'x', price: '25,000', qty: '5', displayName: 'bob.trader' },
    { header: 'bestbid', isno: 1, msg: 'x', price: '24,000', qty: '9', displayName: 'alice.trader' },
  ]);
  const [trade] = only(feed(tr, [{ header: 'lasttrade', isno: 1, price: '24,500', lastTick: '0' }]), 'trade');
  assert.equal(trade.restingTrader, null);
  assert.equal(trade.restingSide, null);
});

test('a locked market falls back to the tick, and reports nobody when neutral', () => {
  const tr = new Tracker();
  feed(tr, [
    { header: 'bestask', isno: 1, msg: 'x', price: '25,000', qty: '5', displayName: 'bob.trader' },
    { header: 'bestbid', isno: 1, msg: 'x', price: '25,000', qty: '9', displayName: 'alice.trader' },
  ]);
  const [up] = only(feed(tr, [{ header: 'lasttrade', isno: 1, price: '25,000', lastTick: '1' }]), 'trade');
  assert.equal(up.restingTrader, 'bob.trader');
  const [down] = only(feed(tr, [{ header: 'lasttrade', isno: 1, price: '25,000', lastTick: '-1' }]), 'trade');
  assert.equal(down.restingTrader, 'alice.trader');
  const [flat] = only(feed(tr, [{ header: 'lasttrade', isno: 1, price: '25,000', lastTick: '0' }]), 'trade');
  assert.equal(flat.restingTrader, null);
});

// A market with more than one security -----------------------------------------

test('quotes for another security do not land in this book', () => {
  // These are the real frames off the live B02 demo market, which trades four
  // securities and interleaves their quotes on one socket. Blend them and
  // security 3's bid of 88.70 sits against security 4's offer of 84.97 — a
  // crossed book of 3.73 that exists nowhere but in our own state, on the very
  // market the README tells you to rehearse on. The sniper takes crossed books.
  const tr = new Tracker();
  feed(tr, [
    { header: 'bestbid', isno: '4', price: '78.47', qty: '35', displayName: 'Trader 39' },
    { header: 'bestask', isno: '4', price: '84.97', qty: '100', displayName: 'Trader 2' },
  ]);
  const events = feed(tr, [
    { header: 'bestbid', isno: '3', price: '88.70', qty: '80', displayName: 'Trader 31' },
    { header: 'bestask', isno: '3', price: '90.00', qty: '10480', displayName: 'Trader 58' },
  ]);
  assert.deepEqual(only(events, 'quote'), [], 'emitted a quote for a security we are not following');
  assert.equal(tr.best.bid.price, 78.47);
  assert.equal(tr.best.ask.price, 84.97);
  assert.ok(tr.best.bid.price < tr.best.ask.price, 'book crossed itself across securities');
  assert.equal(tr.isno, 4);
  assert.equal(tr.ignored, 2);
});

test('a feed with one security is followed exactly as before', () => {
  const tr = new Tracker();
  const events = feed(tr, [
    { header: 'bestbid', isno: 1, price: '24,000', qty: '189', displayName: 'a.trader' },
    { header: 'bestask', isno: 1, price: '24,999', qty: '1', displayName: 'b.trader' },
    { header: 'lasttrade', isno: 1, price: '24,000', qty: '1', lastTick: '0' },
  ]);
  assert.equal(only(events, 'quote').length, 2);
  assert.equal(only(events, 'trade').length, 1);
  assert.equal(tr.ignored, 0);
});

test('messages carrying no security id are never filtered', () => {
  // The clock and the account are not per-security and carry no isno.
  const tr = new Tracker();
  feed(tr, [{ header: 'bestbid', isno: '4', price: '78.47', qty: '35' }]);
  const events = feed(tr, [{ header: 'time', msg: '1839' }]);
  assert.equal(only(events, 'clock').length, 1);
  assert.equal(tr.ignored, 0);
});
