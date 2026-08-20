// Order execution: arming, validation, and the outbound queue.
//
// Nothing here talks to a browser. The hub decides what should happen and puts
// it in a queue; the extension collects it, validates it again in the page, and
// sends it. Two independent arm switches have to be on before a single order
// can leave: one here, set from the viewer, and one in the extension itself,
// set from its popup. A bug on either side cannot trade on its own.
//
// Orders go out as the plain WebSocket messages the FTS client already sends:
//
//   { header: 'sell', isno, price, qty }   market sell, hits the bid
//   { header: 'ask',  isno, price, qty }   resting sell
//   { header: 'clearasks', isno }          pull resting sells
//
// That is deliberately not the mSubmitAsk / mHitBid route. Those are DOM
// wrappers whose only failure mode is a blocking alert(), and a blocking dialog
// freezes the whole page. Speaking the protocol directly has no dialog path and
// no dependency on the unvalidated #mQty field.

export const CAP = 25000;
export const TICK = 0.01;

// Ceilings that hold regardless of what a strategy asks for.
export const LIMITS = {
  maxQty: 40, // no single order larger than a plausible endowment
  // Buying is where the money can actually be lost: bottles pay zero at the
  // bell, so every purchase is only worth making if it can be sold on for more,
  // and no price above the cap can ever print. Paying near the ceiling is
  // buying with no upside left, so the ceiling on what may be paid is a third
  // of it, and the position it can build is bounded too.
  maxBuyFraction: 0.35,
  maxInventory: 80,
  maxOrders: 60, // per armed session, trades only
  minGapMs: 400, // never trade faster than this
  minCancelGapMs: 200, // cancels are cheaper, but still not unbounded
  minUrgentGapMs: 300, // taking the cap, or beating the bell
  maxTtlMs: 60 * 60 * 1000,
};

export function roundToTick(price) {
  return Math.round(price / TICK) * TICK;
}

export class Execution {
  constructor(limits = LIMITS) {
    this.limits = limits;
    this.armed = false;
    this.strategyId = null;
    this.expiresAt = null;
    this.queue = [];
    this.history = [];
    this.sent = 0;
    this.lastAt = { cancel: -Infinity, urgent: -Infinity, routine: -Infinity };
    this.lastQueuedWasCancel = false;
    this.lastError = null;
    this.seq = 0;
  }

  get status() {
    return {
      armed: this.armed,
      strategyId: this.strategyId,
      expiresAt: this.expiresAt,
      queued: this.queue.length,
      sent: this.sent,
      remaining: Math.max(0, this.limits.maxOrders - this.sent),
      lastError: this.lastError,
      history: this.history.slice(-12),
    };
  }

  arm({ strategyId, ttlMs }, now = Date.now()) {
    if (!strategyId) throw new Error('arming needs a strategy');
    const ttl = Math.min(Number(ttlMs) || 0, this.limits.maxTtlMs);
    if (ttl <= 0) throw new Error('arming needs a positive ttl');
    this.armed = true;
    this.strategyId = strategyId;
    this.expiresAt = now + ttl;
    this.lastError = null;
    return this.status;
  }

  disarm(reason = 'manual') {
    if (this.armed) this.note({ kind: 'disarmed', reason });
    this.armed = false;
    this.strategyId = null;
    this.expiresAt = null;
    // Anything still waiting is abandoned rather than sent late.
    this.queue = [];
    return this.status;
  }

  // Disarms on its own once the window is up, so a forgotten session cannot
  // keep trading.
  tick(now = Date.now()) {
    if (this.armed && this.expiresAt !== null && now >= this.expiresAt) {
      this.disarm('expired');
      return true;
    }
    return false;
  }

  note(entry) {
    this.history.push({ at: Date.now(), ...entry });
    if (this.history.length > 200) this.history.shift();
  }

  // `account` is the real one: { position, cash }. Strategies are simulated
  // elsewhere, but an armed order is checked against what is actually held.
  offer(intent, context, now = Date.now()) {
    if (!this.armed) return { accepted: false, reason: 'not armed' };
    if (this.strategyId !== context.strategyId) {
      return { accepted: false, reason: 'strategy is not the armed one' };
    }

    // A cancel only removes exposure, so it neither spends the order budget nor
    // waits behind the trade rate limit. The strategies emit cancel-then-sell
    // as a pair; counting the cancel as a trade would starve the sell, which is
    // the half that matters.
    const isCancel = intent.kind === 'cancel';

    if (!isCancel && this.sent >= this.limits.maxOrders) {
      this.disarm('order limit reached');
      return { accepted: false, reason: 'order limit reached' };
    }
    // Three independent lanes, each with its own rate limit. Importance has to
    // beat arrival order: a routine order placed microseconds earlier in the
    // same batch must never starve the one that takes the ceiling or beats the
    // bell. Limiting the lanes separately stops runaway within each without
    // letting one block another, and the session budget still caps them all.
    const lane = isCancel ? 'cancel' : intent.urgent ? 'urgent' : 'routine';

    if (isCancel) {
      // A cancel must never be the thing that gets dropped: the guards send
      // cancel-then-sell, and a cancel that fails leaves resting asks holding
      // the position the sell is trying to use. So instead of a time limit,
      // the only cancel refused is one with nothing to cancel — a repeat with
      // no order placed since the last one.
      if (this.lastQueuedWasCancel) {
        return { accepted: false, reason: 'nothing placed since the last cancel' };
      }
    } else {
      const gap = lane === 'urgent' ? this.limits.minUrgentGapMs : this.limits.minGapMs;
      if (now - this.lastAt[lane] < gap) {
        return { accepted: false, reason: `too soon after the last ${lane} order` };
      }
    }

    const order = this.translate(intent, context);
    if (order.error) {
      this.lastError = order.error;
      this.note({ kind: 'rejected', reason: order.error, intent });
      return { accepted: false, reason: order.error };
    }

    // A cancel becomes two messages, one per side; everything else is one.
    const messages = order.messages ?? [order.message];
    const queued = messages.map((message) => {
      this.seq += 1;
      return { id: `o${this.seq}`, at: now, ...message, meta: order.meta };
    });
    this.queue.push(...queued);
    this.lastAt[lane] = now;
    this.lastQueuedWasCancel = isCancel;
    for (const q of queued) {
      this.note({ kind: 'queued', id: q.id, header: q.header, qty: q.qty, price: q.price });
    }
    return { accepted: true, order: queued[0], orders: queued };
  }

  // Turns a strategy intent into the wire message, refusing anything that
  // cannot be justified from the current account and book.
  translate(intent, context) {
    const { position, best, isno = 1, myName } = context;

    if (intent.kind === 'cancel') {
      // Both sides. A strategy that switches from accumulating to selling has
      // resting bids to pull as well as asks.
      return {
        messages: [
          { header: 'clearasks', isno },
          { header: 'clearbids', isno },
        ],
        meta: { kind: 'cancel' },
      };
    }

    const buying = intent.side === 'buy';
    if (!buying && intent.side !== 'sell') return { error: `unknown side ${intent.side}` };

    const qty = Math.floor(Number(intent.qty));
    if (!Number.isFinite(qty) || qty < 1) return { error: 'quantity must be a positive whole number' };
    if (qty > this.limits.maxQty) return { error: `quantity above the ${this.limits.maxQty} ceiling` };
    if (position === null || position === undefined) return { error: 'position unknown' };

    if (buying) {
      if (position + qty > this.limits.maxInventory) {
        return { error: `would hold ${position + qty}, above the ${this.limits.maxInventory} ceiling` };
      }
    } else {
      // No short selling: prohibited by the instructor, the server and the UI.
      if (qty > position) return { error: `would sell ${qty} holding ${position}` };
    }

    const ceiling = CAP * this.limits.maxBuyFraction;

    if (intent.kind === 'take') {
      const quote = buying ? best?.ask : best?.bid;
      if (!quote || !Number.isFinite(quote.price)) {
        return { error: buying ? 'no offer to buy from' : 'no bid to sell into' };
      }
      // The page refuses to let you hit your own quote; without its DOM check
      // we have to make the same test ourselves.
      if (myName && quote.trader && quote.trader === myName) {
        return { error: `best ${buying ? 'ask' : 'bid'} is your own` };
      }
      const price = roundToTick(quote.price);
      if (!(price > 0) || price > CAP) return { error: 'quote price out of range' };
      if (buying && price > ceiling) {
        return { error: `will not pay ${price}, above the ${Math.round(ceiling)} buy ceiling` };
      }
      return {
        message: {
          header: buying ? 'buy' : 'sell',
          isno,
          price: String(price),
          qty: String(Math.min(qty, quote.qty ?? qty)),
        },
        meta: { kind: 'take', side: intent.side, qty, price },
      };
    }

    if (intent.kind === 'make') {
      const price = roundToTick(Number(intent.price));
      if (!Number.isFinite(price) || price <= 0) return { error: 'invalid limit price' };
      if (price > CAP) return { error: `limit above the ${CAP} cap` };
      if (buying && price > ceiling) {
        return { error: `will not bid ${price}, above the ${Math.round(ceiling)} buy ceiling` };
      }
      return {
        message: { header: buying ? 'bid' : 'ask', isno, price: String(price), qty: String(qty) },
        meta: { kind: 'make', side: intent.side, qty, price },
      };
    }

    return { error: `unknown intent ${intent.kind}` };
  }

  // Handed to the extension, which clears the queue as it takes them.
  drain() {
    const orders = this.queue;
    this.queue = [];
    return orders;
  }

  acknowledge(results = []) {
    for (const r of results) {
      if (r.ok) {
        if (!r.cancel) this.sent += 1;
        this.note({ kind: 'sent', id: r.id });
      } else {
        this.lastError = r.error ?? 'send failed';
        this.note({ kind: 'failed', id: r.id, reason: this.lastError });
        // A failure means the page is not in the state we thought it was in.
        this.disarm('order failed');
      }
    }
    return this.status;
  }
}
