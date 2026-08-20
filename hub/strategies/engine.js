// Shadow trading engine.
//
// Each strategy gets its own paper portfolio, seeded from your real account at
// the moment the hub first sees it, and scored on the same formula the class is
// ranked by: cash + realized utility + 0 x bottles.
//
// The fill model is deliberately pessimistic. A resting order fills only when a
// print goes THROUGH its price, never merely at it, because at your own price
// you are behind the queue that was already sitting there. An optimistic model
// would have shown every strategy filling instantly at the 25,000 cap in
// Session 4 and made all three look brilliant. A paper engine that flatters is
// worse than none, because the whole point is deciding which one to trust.

const CAP = 25000;

// The hand every trader is dealt: about 20 bottles and no cash, borrowing at
// zero interest. Used to seed the paper portfolios at the opening bell so they
// are running from the first message rather than from whenever the account
// first reports.
export const OPENING_BOTTLES = 20;
export const OPENING_CASH = 0;

export class Portfolio {
  constructor() {
    this.cash = 0;
    this.position = 0;
    this.realizedUtility = 0;
    this.seeded = false;
    this.resting = [];
    this.fills = [];
    this.rejected = 0;
  }

  seed(cash, position) {
    this.cash = cash;
    this.position = position;
    this.seeded = true;
  }

  get gain() {
    // Bottles are worth nothing at the bell, so they contribute nothing here
    // either. This is the number the class is actually ranked on.
    return this.cash + this.realizedUtility;
  }

  record(side, qty, price, clock, vt) {
    if (qty <= 0) return null;
    if (side === 'sell') {
      this.position -= qty;
      this.cash += qty * price;
    } else {
      this.position += qty;
      this.cash -= qty * price;
      // Buying is the only action that accrues utility.
      this.realizedUtility += qty * (vt ?? 0);
    }
    const fill = { clock, side, qty, price };
    this.fills.push(fill);
    return fill;
  }
}

export class StrategyRunner {
  constructor(strategy) {
    this.strategy = strategy;
    this.portfolio = new Portfolio();
    this.memory = {};
    this.series = [];
    this.intents = [];
    this.lastSampleClock = null;
  }

  get id() {
    return this.strategy.id;
  }

  seed(cash, position) {
    if (this.portfolio.seeded) return;
    this.portfolio.seed(cash, position);
    this.memory = this.strategy.init ? this.strategy.init({ cash, position }) ?? {} : {};
  }

  // `market` is the shared view: { clock, total, best, last, vt }.
  step(event, market) {
    const p = this.portfolio;
    if (!p.seeded) return;

    // Resolve resting orders against the print before the strategy reacts to it,
    // so a strategy never sees its own order fill before the market caused it.
    if (event.t === 'trade') this.matchAgainstPrint(event, market);

    const produced = this.strategy.onEvent
      ? this.strategy.onEvent(event, this.context(market)) ?? []
      : [];
    for (const intent of produced) this.submit(intent, market);

    if (event.t === 'clock' || event.t === 'trade') this.sample(market);
  }

  context(market) {
    return {
      clock: market.clock,
      total: market.total,
      best: market.best,
      last: market.last,
      vt: market.vt,
      position: this.portfolio.position,
      cash: this.portfolio.cash,
      resting: this.portfolio.resting.length,
      memory: this.memory,
      cap: CAP,
    };
  }

  submit(intent, market) {
    if (!intent || !intent.kind) return;
    const p = this.portfolio;

    if (intent.kind === 'cancel') {
      p.resting = [];
      return;
    }

    const side = intent.side;
    let qty = Math.floor(Number(intent.qty) || 0);
    if (qty <= 0) return;

    // Short selling is prohibited by the instructor, the server and the UI, so
    // the paper engine refuses it too rather than reporting a gain that could
    // never have been earned.
    if (side === 'sell') {
      const committed = p.resting
        .filter((o) => o.side === 'sell')
        .reduce((n, o) => n + o.qty, 0);
      const available = p.position - committed;
      if (available <= 0) {
        p.rejected += 1;
        return;
      }
      qty = Math.min(qty, available);
    }

    this.intents.push({ clock: market.clock, ...intent, qty });
    if (this.intents.length > 20) this.intents.shift();

    if (intent.kind === 'take') {
      this.take(side, qty, market);
      return;
    }

    if (intent.kind === 'make') {
      const price = Number(intent.price);
      if (!Number.isFinite(price) || price <= 0 || price > CAP) return;
      p.resting.push({ side, qty, price, placed: market.clock });
    }
  }

  // A taking order crosses the spread. It fills at the quoted price, and only
  // for as much size as is actually quoted there.
  take(side, qty, market) {
    const quote = side === 'sell' ? market.best.bid : market.best.ask;
    if (!quote || !Number.isFinite(quote.price)) {
      this.portfolio.rejected += 1;
      return;
    }
    const available = Number.isFinite(quote.qty) ? quote.qty : qty;
    const filled = Math.min(qty, Math.max(0, available));
    if (filled <= 0) {
      this.portfolio.rejected += 1;
      return;
    }
    this.portfolio.record(side, filled, quote.price, market.clock, market.vt);
  }

  // A resting order only fills when the market trades through its price. The
  // print's own size caps how much of the book it can consume.
  matchAgainstPrint(trade, market) {
    const p = this.portfolio;
    if (p.resting.length === 0) return;
    let remaining = Number.isFinite(trade.qty) ? trade.qty : 1;
    const survivors = [];

    for (const order of p.resting) {
      // Queue position decides whether a print at your own price fills you.
      //
      // An order that betters the best quote is alone at the front, so a print
      // that reaches it fills it. An order merely matching the best is behind
      // whatever was already resting there, and only fills once the market
      // trades through. Requiring a through-print in both cases would mean a
      // price-improving quote never fills at all, which is wrong and would
      // understate any strategy that works by posting the best price.
      const best = order.side === 'sell' ? market.best.ask : market.best.bid;
      const improves =
        best && Number.isFinite(best.price)
          ? (order.side === 'sell' ? order.price < best.price : order.price > best.price)
          : true;

      const reached =
        order.side === 'sell'
          ? improves ? trade.price >= order.price : trade.price > order.price
          : improves ? trade.price <= order.price : trade.price < order.price;

      if (!reached || remaining <= 0) {
        survivors.push(order);
        continue;
      }
      let fillable = Math.min(order.qty, remaining);
      if (order.side === 'sell') fillable = Math.min(fillable, p.position);
      if (fillable <= 0) {
        survivors.push(order);
        continue;
      }
      p.record(order.side, fillable, order.price, market.clock, market.vt);
      remaining -= fillable;
      if (fillable < order.qty) survivors.push({ ...order, qty: order.qty - fillable });
    }
    p.resting = survivors;
  }

  // One sparkline point per game-clock unit, so the series stays bounded even
  // through a burst of prints.
  sample(market) {
    if (market.clock === null || market.clock === undefined) return;
    if (this.lastSampleClock === market.clock) {
      this.series[this.series.length - 1] = this.portfolio.gain;
      return;
    }
    this.lastSampleClock = market.clock;
    this.series.push(this.portfolio.gain);
    if (this.series.length > 400) this.series.shift();
  }

  get summary() {
    const p = this.portfolio;
    return {
      id: this.strategy.id,
      name: this.strategy.name,
      blurb: this.strategy.blurb,
      seeded: p.seeded,
      gain: p.gain,
      cash: p.cash,
      position: p.position,
      utility: p.realizedUtility,
      fills: p.fills.length,
      resting: p.resting.length,
      rejected: p.rejected,
      series: this.series.slice(-160),
      intents: this.intents.slice(-6),
      lastFill: p.fills.at(-1) ?? null,
    };
  }
}

// Runs every strategy over the same event stream so their numbers are comparable.
export class StrategyBoard {
  constructor(strategies) {
    this.runners = strategies.map((s) => new StrategyRunner(s));
    this.market = { clock: null, total: null, best: { bid: null, ask: null }, last: null, vt: null };
  }

  handle(event) {
    const m = this.market;
    switch (event.t) {
      case 'clock':
        m.clock = event.clock;
        if (event.total != null) m.total = event.total;
        break;
      case 'session':
        if (event.total != null) m.total = event.total;
        if (event.state === 'start') {
          // A fresh period starts the comparison over, and seeds immediately on
          // the standard hand rather than waiting for the first account
          // message. Otherwise the strategies miss the opening minutes, which
          // is exactly where an accumulating strategy does its work.
          this.reset();
          for (const r of this.runners) r.seed(OPENING_CASH, OPENING_BOTTLES);
        }
        break;
      case 'quote':
        m.best[event.side] = event.price === null ? null : { price: event.price, qty: event.qty };
        break;
      case 'trade':
        m.last = event.price;
        break;
      case 'info':
        if (event.vt != null) m.vt = event.vt;
        break;
      case 'account':
        // Seed every strategy from your real opening account, so all four
        // portfolios start from the same hand.
        if (event.cash !== null && event.position !== null) {
          for (const r of this.runners) r.seed(event.cash, event.position);
        }
        if (event.vt != null) m.vt = event.vt;
        break;
      default:
        break;
    }

    for (const r of this.runners) r.step(event, m);
  }

  reset() {
    for (const r of this.runners) {
      r.portfolio = new Portfolio();
      r.series = [];
      r.intents = [];
      r.memory = {};
      r.lastSampleClock = null;
    }
  }

  get summaries() {
    return this.runners.map((r) => r.summary);
  }
}
