// The two numbers every strategy has to be read against.
//
// On the Session 1 capture all five strategies scored within 1% of each other,
// which tells you nothing about the strategies and everything about a market
// that was pinned at its ceiling for the whole capture. A score is only
// informative next to what doing nothing would have got and what the best
// possible sequence of sells would have got.

import { Tracker } from '../protocol.js';

// The floor: hold the endowment, sell the lot when the clock says you must.
// Any strategy that cannot beat this is costing money to run.
export const bellDump = {
  id: 'bell-dump',
  name: 'Bell dump',
  blurb: 'Holds everything and sells at the deadline. The do-nothing baseline.',
  init: () => ({}),
  onEvent(event, ctx) {
    if (ctx.position <= 0 || ctx.clock === null) return [];
    if (ctx.clock > (ctx.total ?? 3000) * 0.08) return [];
    return [{ kind: 'take', side: 'sell', qty: ctx.position, urgent: true }];
  },
};

/**
 * The ceiling: the most 20 bottles could have fetched, given only what was
 * actually quoted.
 *
 * Walks every best-bid state the session published and fills greedily from the
 * highest price down, capped by the size quoted at each. It assumes perfect
 * foresight and the front of every queue, so nothing can reach it; it is here
 * to turn "499,980" into "98% of what was on the table".
 */
export function oracleGain(frames, bottles = 20) {
  const tracker = new Tracker();
  const quotes = [];
  for (const { msg } of frames) {
    for (const event of tracker.handle(msg)) {
      if (event.t === 'quote' && event.side === 'bid' && event.price > 0) {
        quotes.push({ price: event.price, qty: Number.isFinite(event.qty) ? event.qty : 1 });
      }
    }
  }
  quotes.sort((a, b) => b.price - a.price);
  let left = bottles;
  let cash = 0;
  for (const q of quotes) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(1, q.qty));
    cash += take * q.price;
    left -= take;
  }
  return cash;
}
