// Posts a short synthetic session to a running hub, shaped exactly like what
// the extension sends: an array of raw WebSocket payload strings, each payload
// itself a batched JSON array of messages.
//
// Use it to prove the whole chain works before a real session — including your
// own fills, which the Session 04 replay cannot exercise because that export
// has no account data in it.
//
//   node hub/server.js            (in one terminal)
//   node scripts/smoke.js         (in another)

const PORT = Number(process.env.FTS_PORT || 8787);
const ENDPOINT = `http://127.0.0.1:${PORT}/ingest`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(messages) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([JSON.stringify(messages)]),
  });
  if (!res.ok) throw new Error(`hub returned ${res.status}`);
}

const TOTAL = 3000;
// The server refuses anything above this, so the fixture must too or the
// strategies get scored against a market that could never have happened.
const CAP = 25000;

async function main() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/health`);
  } catch {
    console.error(`No hub on port ${PORT}. Start it with: node hub/server.js`);
    process.exit(1);
  }

  console.log('opening the market...');
  await send([
    { header: 'secname', isno: 1, msg: 'Genie bottle' },
    { header: 'startperiod', iTime: String(TOTAL), msg: '1' },
    { header: 'info', isno: 1, msg: 'Your private value is 5.02 per bottle' },
    { header: 'cash', msg: '0' },
    { header: 'endow', isno: 1, msg: '20' },
  ]);

  // Invented names. Never put real classmates' names in a committed file.
  const traders = ['alice.trader', 'bob.trader', 'carol.trader', 'dave.trader', 'erin.trader', 'frank.trader'];
  const someone = (i) => traders[i % traders.length];

  let price = 1200;
  let cash = 0;
  let position = 20;
  let previous = price;

  // Walk the clock down, drifting the price up into a bubble the way the real
  // session did, and sell the endowment off in clips along the way.
  const sellAt = new Set([2600, 2200, 1800, 1400, 1000, 700, 500, 300]);

  let round = 0;
  for (let clock = TOTAL - 20; clock > 150; clock -= 20) {
    round += 1;
    const previousPrice = previous;
    price = Math.min(CAP, Math.max(50, Math.round(price * (1 + (Math.random() * 0.16 - 0.045)))));
    const tick = Math.sign(price - previous);
    previous = price;

    const bid = price - 2;
    const ask = Math.min(CAP, price + 3);
    const bidMsg = { header: 'bestbid', isno: 1, msg: 'x', price: String(bid), qty: '40', displayName: someone(round), msg2: `<tr><td>${bid}</td><td>40</td></tr>` };
    const askMsg = { header: 'bestask', isno: 1, msg: 'x', price: String(ask), qty: '12', displayName: someone(round + 3), msg2: `<tr><td>${ask}</td><td>12</td></tr>` };

    // Publish the side that leaves the book uncrossed after EACH message, not
    // just after both. A strategy reacts to one quote at a time, so sending a
    // risen bid before the offer that justifies it creates an instant where the
    // new bid sits above the previous, lower offer — a crossed book that never
    // existed. This fixture used to do exactly that, and the sniper collected
    // 149 fills off it against the 5 crossed moments in the whole real capture.
    const quotes = price >= previousPrice ? [askMsg, bidMsg] : [bidMsg, askMsg];

    const batch = [
      { header: 'time', msg: String(clock) },
      ...quotes,
      // Print at whichever side was taken, so the resting quoter resolves the
      // way it does in a real book.
      { header: 'lasttrade', isno: 1, price: String(tick >= 0 ? ask : bid), qty: String(1 + Math.floor(Math.random() * 40)), lastTick: String(tick) },
      { header: 'bidasklast', isno: 1, iTime: String(clock), msg: String(bid), msg1: String(ask), msg2: String(price) },
    ];

    // A fill of your own: both legs in the same push, as the server sends them.
    if (sellAt.has(clock) && position > 0) {
      const qty = Math.min(position, 3);
      position -= qty;
      cash += qty * price;
      batch.push({ header: 'endow', isno: 1, msg: String(position) });
      batch.push({ header: 'cash', msg: String(cash) });
    }

    await send(batch);
    await sleep(45);
  }

  await send([{ header: 'endperiod', msg: '1' }]);
  console.log(`done — sold down to ${position} bottles, cash ${cash.toLocaleString('en-US')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
