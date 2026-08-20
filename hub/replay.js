// Replay sources for the hub.
//
// Two formats are supported:
//
//   *.jsonl  raw frames recorded by this hub. Replayed verbatim, so a recorded
//            session reproduces exactly what the viewer showed at the time.
//
//   *.json   the Session 04 export (genie_orderbook_full.json). Predates this
//            tool, so it holds parsed rows rather than frames; they are turned
//            back into the messages the server would have sent.

import fs from 'node:fs/promises';
import path from 'node:path';

// Returns [{ clock, msg }], newest last, ordered the way the session ran.
// The game clock counts down from the session length, so descending clock is
// forward in time.
export async function loadReplay(file) {
  const resolved = path.resolve(file);
  const text = await fs.readFile(resolved, 'utf8');
  return path.extname(resolved).toLowerCase() === '.jsonl'
    ? fromRawLog(text)
    : fromSessionExport(text);
}

function fromRawLog(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const frame = entry.frame ?? entry;
    let messages = frame;
    if (typeof messages === 'string') {
      try {
        messages = JSON.parse(messages);
      } catch {
        continue;
      }
    }
    for (const msg of Array.isArray(messages) ? messages : [messages]) {
      if (msg && typeof msg === 'object') {
        out.push({ clock: Number(msg.iTime ?? msg.msg ?? 0) || 0, msg });
      }
    }
  }
  return out;
}

function fromSessionExport(text) {
  const data = JSON.parse(text);
  const total = 3000;
  // Group every captured row by the game clock it was seen at, so the replay
  // reproduces bursts rather than smearing them evenly.
  const byClock = new Map();
  const at = (clock) => {
    if (!byClock.has(clock)) byClock.set(clock, []);
    return byClock.get(clock);
  };

  for (const row of data.bids || []) {
    at(row.clock).push({
      header: 'bestbid',
      isno: 1,
      msg: 'x',
      price: row.price,
      qty: row.qty,
      displayName: row.trader,
      msg2: `<tr><td>${row.price}</td><td>${row.qty}</td></tr>`,
    });
  }
  for (const row of data.asks || []) {
    at(row.clock).push({
      header: 'bestask',
      isno: 1,
      msg: 'x',
      price: row.price,
      qty: row.qty,
      displayName: row.trader,
      msg2: `<tr><td>${row.price}</td><td>${row.qty}</td></tr>`,
    });
  }
  // The export predates capturing lastTick, so the tick direction is recovered
  // by comparing each print to the one before it. Live sessions read the real
  // value off the wire; this only fills the gap in the historical fixture.
  const trades = [...(data.trades || [])].sort((a, b) => b.clock - a.clock);
  let previous = null;
  for (const row of trades) {
    const tick = previous === null ? 0 : Math.sign(row.price - previous);
    previous = row.price;
    at(row.clock).push({ header: 'lasttrade', isno: 1, price: row.price, qty: row.qty, lastTick: tick });
  }

  const clocks = [...byClock.keys()].sort((a, b) => b - a);
  const out = [];
  const security = data.meta?.security || 'Genie bottle';
  out.push({ clock: total, msg: { header: 'secname', isno: 1, msg: security } });
  out.push({ clock: total, msg: { header: 'startperiod', iTime: String(total), msg: '1' } });
  // The export covers only part of the session; open the account at its start.
  out.push({ clock: total, msg: { header: 'cash', msg: '0' } });
  out.push({ clock: total, msg: { header: 'endow', isno: 1, msg: '20' } });

  for (const clock of clocks) {
    out.push({ clock, msg: { header: 'time', msg: String(clock) } });
    const rows = byClock.get(clock);
    // Synthesize the chart feed from the best quotes seen at this clock, since
    // the export predates capturing bidasklast directly.
    const bid = rows.find((m) => m.header === 'bestbid');
    const ask = rows.find((m) => m.header === 'bestask');
    const trade = rows.find((m) => m.header === 'lasttrade');
    if (bid || ask || trade) {
      out.push({
        clock,
        msg: {
          header: 'bidasklast',
          isno: 1,
          iTime: String(clock),
          msg: bid ? String(bid.price) : '0',
          msg1: ask ? String(ask.price) : '0',
          msg2: trade ? String(trade.price) : '0',
        },
      });
    }
    for (const msg of rows) out.push({ clock, msg });
  }
  return out;
}
