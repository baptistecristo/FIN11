// Normalization of FTS Web Trader WebSocket frames into viewer events.
//
// Field shapes come from handleTrdMessage() in the site's jsConstant.js.
// Pure functions plus one stateful Tracker; no I/O, so this is the part
// that gets unit tested.

const MESSAGE_DELIMITER = '#';
const QUOTE_DELIMITER = '%';

// How long to wait for a fill's second leg before giving up and reporting the
// fill without a price. The server pushes cash and position together, so the
// real gap is milliseconds; this only has to be long enough that a hiccup does
// not cost us the price, since once reported the fill cannot be re-priced.
const LEG_TIMEOUT_MS = 3000;

// Prices arrive display-formatted ("24,000"). Strip separators before Number().
export function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// The depth ladder ships as table-row HTML. Regex per the Session 04 harness.
export function parseBook(html) {
  if (!html || typeof html !== 'string') return [];
  const rows = [];
  const re = /<td>([\d.,]+)<\/td>\s*<td>([\d.,]+)<\/td>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const price = num(m[1]);
    const qty = num(m[2]);
    if (price !== null && qty !== null) rows.push({ price, qty });
  }
  return rows;
}

export function parsePerformance(msg) {
  if (!msg) return [];
  return String(msg)
    .split(MESSAGE_DELIMITER)
    .filter((line) => line !== '')
    .map((line) => line.split(QUOTE_DELIMITER));
}

// A socket frame is either one message object or a batch array. The page's own
// handler branches on msg.length; assuming a single object drops most of the feed.
export function unwrap(payload) {
  let data = payload;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  if (Array.isArray(data)) return data.filter((m) => m && typeof m === 'object');
  if (data && typeof data === 'object') return [data];
  return [];
}

// Accumulates market and account state, emitting viewer events. Own fills are
// derived here: the server pushes cash and position but never a fill event.
export class Tracker {
  // `now` is injectable so the leg-timeout behaviour can be tested without
  // waiting on a real clock.
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.clock = null;
    this.sessionLength = null;
    this.cash = null;
    this.position = null;
    this.vt = null;
    this.security = null;
    this.best = { bid: null, ask: null };
    this.last = null;
    // Which security this tracker is following, and how many messages for other
    // securities it has thrown away. See sameSecurity().
    this.isno = null;
    this.ignored = 0;
    // A fill moves cash and position, but they arrive as two separate messages.
    // Hold the pre-move values until both legs land, then reconcile in flush().
    this.pending = null;
  }

  // The FIN11 case trades one security, so every quote that arrives is a quote
  // in the only book there is. The B02 demo market — the one the README tells
  // you to rehearse on — trades four, and interleaves their quotes on the same
  // socket. Without this check the book becomes a blend of all of them: on the
  // live demo, security 3's bid of 88.70 landed against security 4's offer of
  // 84.97, a crossed book of 3.73 that existed in nothing but our own state.
  // The sniper takes crossed books.
  //
  // So the tracker follows whichever security it hears from first and counts
  // the rest. A message with no isno at all is not filtered, because the
  // account and clock messages carry none and are not per-security anyway.
  sameSecurity(msg) {
    const isno = num(msg.isno);
    if (isno === null) return true;
    if (this.isno === null) {
      this.isno = isno;
      return true;
    }
    if (this.isno === isno) return true;
    this.ignored += 1;
    return false;
  }

  // Returns the events produced by one message.
  handle(msg) {
    const header = msg && msg.header;
    if (!header) return [];
    const at = this.clock;

    // Only the market-data headers are per-security; everything else is either
    // about the session or about your account.
    if (
      (header === 'bestbid' ||
        header === 'bestask' ||
        header === 'lasttrade' ||
        header === 'bidasklast') &&
      !this.sameSecurity(msg)
    ) {
      return [];
    }

    switch (header) {
      case 'time': {
        const clock = num(msg.msg);
        if (clock === null) return [];
        this.clock = clock;
        return [{ t: 'clock', clock, total: this.sessionLength }];
      }

      case 'startperiod': {
        this.sessionLength = num(msg.iTime);
        this.clock = this.sessionLength;
        return [
          { t: 'session', state: 'start', total: this.sessionLength },
          { t: 'clock', clock: this.clock, total: this.sessionLength },
        ];
      }

      case 'pausemarket':
        return [{ t: 'session', state: 'pause', clock: at }];
      case 'resumemarket':
        return [{ t: 'session', state: 'resume', clock: at }];
      case 'endperiod':
        return [{ t: 'session', state: 'end', clock: at }];

      case 'secname': {
        this.security = msg.msg || null;
        return [{ t: 'meta', security: this.security }];
      }

      // Purpose-built chart feed: bid, ask and last together on the game clock.
      case 'bidasklast': {
        const clock = num(msg.iTime);
        const bid = num(msg.msg);
        const ask = num(msg.msg1);
        const last = num(msg.msg2);
        if (clock === null || clock < 0) return [];
        // The page treats non-positive values as "no quote" rather than as data.
        const point = {
          t: 'curve',
          clock,
          bid: bid > 0 ? bid : null,
          ask: ask > 0 ? ask : null,
          last: last > 0 ? last : null,
        };
        if (point.bid === null && point.ask === null && point.last === null) return [];
        if (point.last !== null) this.last = point.last;
        return [point];
      }

      case 'lasttrade': {
        const price = num(msg.price);
        if (price === null) return [];
        this.last = price;
        // lastTick is the aggressor direction, straight from the server.
        const tick = num(msg.lastTick) ?? 0;
        const qty = num(msg.qty);
        return [
          {
            t: 'trade',
            clock: at,
            price,
            qty: qty === null ? 1 : qty,
            qtyKnown: qty !== null,
            tick,
            side: tick > 0 ? 'buy' : tick < 0 ? 'sell' : null,
            ...this.restingAt(price, tick),
          },
        ];
      }

      case 'bestbid':
      case 'bestask': {
        const side = header === 'bestbid' ? 'bid' : 'ask';
        // An empty msg means the side was cleared out entirely.
        if (msg.msg === '') {
          this.best[side] = null;
          return [{ t: 'quote', side, price: null, qty: null, trader: null, depth: [] }];
        }
        const price = num(msg.price);
        const qty = num(msg.qty);
        const trader = msg.displayName || null;
        const depth = parseBook(msg.msg2);
        this.best[side] = price === null ? null : { price, qty, trader };
        return [{ t: 'quote', side, price, qty, trader, depth }];
      }

      case 'cash': {
        const cash = num(msg.msg);
        if (cash === null) return [];
        return this.applyAccount({ cash });
      }

      case 'endow': {
        const position = num(msg.msg);
        if (position === null) return [];
        return this.applyAccount({ position });
      }

      case 'info': {
        const text = msg.msg == null ? '' : String(msg.msg);
        // Vt is presented as prose; pull the first number out of it if there is one.
        const found = text.match(/-?[\d,]+(?:\.\d+)?/);
        if (found) this.vt = num(found[0]);
        return [{ t: 'info', text, vt: this.vt }];
      }

      case 'performance':
        return [{ t: 'performance', rows: parsePerformance(msg.msg) }];

      case 'error':
      case 'popuperror':
        return [{ t: 'error', text: msg.msg == null ? '' : String(msg.msg) }];

      default:
        return [];
    }
  }

  // Who was resting at the price a trade printed at.
  //
  // The server never names the parties to a trade — `lasttrade` carries price,
  // quantity and tick only. But it does name whoever is on top of the book, so
  // a print at the best bid or best ask identifies the passive side. This is an
  // inference, not a fact from the wire, and is labelled as such in the UI.
  restingAt(price, tick) {
    const bid = this.best.bid;
    const ask = this.best.ask;
    const atAsk = ask && ask.price === price && ask.trader;
    const atBid = bid && bid.price === price && bid.trader;

    if (atAsk && atBid) {
      // Locked market: the price alone cannot say which side was taken, so fall
      // back to the tick, and report nothing when even that is neutral.
      if (tick > 0) return { restingTrader: ask.trader, restingSide: 'ask' };
      if (tick < 0) return { restingTrader: bid.trader, restingSide: 'bid' };
      return { restingTrader: null, restingSide: null };
    }
    if (atAsk) return { restingTrader: ask.trader, restingSide: 'ask' };
    if (atBid) return { restingTrader: bid.trader, restingSide: 'bid' };
    return { restingTrader: null, restingSide: null };
  }

  // Records the change and opens a pending reconciliation. Emitting the fill here
  // would be wrong: whichever leg lands first shows a moved position against an
  // unmoved cash balance, which prices the fill at zero.
  applyAccount(patch) {
    if (this.cash !== null && this.position !== null && this.pending === null) {
      this.pending = { cash: this.cash, position: this.position, touched: {}, at: this.now() };
    }
    if (patch.cash !== undefined) {
      this.cash = patch.cash;
      if (this.pending) this.pending.touched.cash = true;
    }
    if (patch.position !== undefined) {
      this.position = patch.position;
      if (this.pending) this.pending.touched.position = true;
    }
    return [
      { t: 'account', clock: this.clock, cash: this.cash, position: this.position, vt: this.vt },
    ];
  }

  // Resolves a pending account move into a fill. Called once per received batch,
  // and again on a timer with force=true so a fill whose two legs straddle two
  // batches still resolves instead of hanging. Forcing only takes effect once
  // the pending move has waited out LEG_TIMEOUT_MS, because an unpriced fill is
  // permanent — there is no second chance to price it.
  flush(force = false) {
    if (this.pending === null) return [];
    const { cash, position, touched } = this.pending;
    const expired = force && this.now() - this.pending.at >= LEG_TIMEOUT_MS;
    const dPosition = this.position - position;
    const dCash = this.cash - cash;

    // Cash moved on its own: not a trade (interest, or an adjustment).
    if (dPosition === 0) {
      if (touched.cash && !expired) return [];
      this.pending = null;
      return [];
    }

    // Position moved but the matching cash leg has not landed yet. Keep waiting
    // until the leg timeout, then report the fill unpriced rather than lose it.
    if (!touched.cash && !expired) return [];

    this.pending = null;
    const qty = Math.abs(dPosition);
    const side = dPosition > 0 ? 'buy' : 'sell';
    // Signs are opposite: buying spends cash, selling raises it.
    const price = touched.cash ? Math.abs(dCash) / qty : null;
    return [
      {
        t: 'myfill',
        clock: this.clock,
        side,
        qty,
        price,
        cash: this.cash,
        position: this.position,
      },
    ];
  }
}
