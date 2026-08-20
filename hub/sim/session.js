// A market to test strategies against, when the only real capture we have is
// 23% of one session and every strategy scores within 1% on it.
//
// This generates whole 50-minute sessions as the frames the FTS server would
// have sent, so they run through the same Tracker and the same paper engine as
// a live feed. Nothing here knows what a strategy is.
//
// WHAT IS MEASURED AND WHAT IS ASSUMED
//
// Calibrated against genie_orderbook_full.json (session 1, minutes 19.4-28.5):
//
//   - print sizes: 79% of the 1,112 prints were a single bottle, with a tail
//     out to 1,000. PRINT_SIZES below is that histogram.
//   - print rate: ~2 prints per game-clock unit while the market was pinned at
//     the ceiling. Much thinner before, though we cannot see how much.
//   - spread: median 0 at the ceiling. The book locks when everyone agrees.
//   - crossed books: 5 in 1,403 states, largest edge 1. CROSS_RATE is that
//     number, and it is the whole reason this file is careful: an earlier
//     synthetic feed crossed the book on every tick and made the sniper look
//     like a business.
//   - liquidity holes: one, at minute 23.1-24.0. The best bid fell from 24,888
//     to 1,000 for about 50 seconds while prints carried on at 25,000, because
//     a 387-lot bid was eaten and the book underneath it was air. HOLE_* is
//     that event. It is the single most expensive thing in the capture, and no
//     strategy written before it was measured accounts for it.
//
// Assumed, because the capture starts at minute 19.4 with the market already
// at 24,000:
//
//   - everything before minute 17: the opening price level, how the climb
//     began, whether it was smooth. OPEN_LEVEL is a guess.
//   - every shape other than `pin`. Session 1 pinned at the ceiling; whether a
//     session can break, stall or never bubble at all is not something one
//     session can answer. The shapes are hypotheses, and the point of running
//     all of them is to find strategies that survive being wrong about which.
//
// So: a strategy that wins here has not been shown to win. It has been shown
// not to depend on Session 1 having happened the way it did.

export const CAP = 25000;

// Session 1 print sizes, as [size, count] from the 1,112 captured prints.
const PRINT_SIZES = [
  [1, 881], [2, 37], [3, 5], [4, 2], [5, 17], [9, 2], [10, 7], [12, 1],
  [13, 2], [15, 12], [18, 4], [20, 1], [22, 2], [26, 6], [30, 4], [50, 2],
  [54, 15], [58, 12], [60, 7], [88, 7], [90, 4], [91, 1], [92, 1], [93, 31],
  [100, 9], [158, 1], [200, 1], [212, 1], [280, 1], [300, 11], [500, 11],
  [893, 13], [1000, 1],
];
const PRINT_TOTAL = PRINT_SIZES.reduce((n, [, c]) => n + c, 0);

const CROSS_RATE = 5 / 1403; // measured, and deliberately not rounded up
const CROSS_EDGE = 1;

const HOLE_CHANCE = 0.55; // one hole in the 9 captured minutes of session 1
const HOLE_LEN = [30, 70]; // game-clock units; the observed one ran about 50
const HOLE_DEPTH = [0.04, 0.6]; // where the best bid lands, as a share of mid

const OPEN_LEVEL = 0.002 * CAP; // assumption: the market opens near 50

// Deterministic PRNG, so a scenario that separates two strategies can be
// re-run and argued about.
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normal = (r) => {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};

const pick = (r, lo, hi) => lo + r() * (hi - lo);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Smooth 0->1 ramp, steep in the middle. `k` is how abrupt the climb is.
const logistic = (u, mid, k) => 1 / (1 + Math.exp(-k * (u - mid)));

function ramp(u, { from, to, mid, k }) {
  const a = logistic(0, mid, k);
  const b = logistic(1, mid, k);
  const s = (logistic(u, mid, k) - a) / (b - a);
  return from + (to - from) * s;
}

// The price path each shape is trying to walk. `u` is the fraction of the
// session elapsed. Noise is added on top, so these are intentions, not paths.
export const SHAPES = {
  // Session 1: a fast climb into the ceiling, and it stays there.
  pin: (u) => (u < 0.42 ? ramp(u / 0.42, { from: OPEN_LEVEL, to: CAP, mid: 0.62, k: 11 }) : CAP),

  // The classic bubble. Runs to two thirds of the ceiling, then gives it all
  // back. The shape every "wait for the cap" rule is wrong about.
  pop: (u) => {
    const peak = 0.62 * CAP;
    if (u < 0.45) return ramp(u / 0.45, { from: OPEN_LEVEL, to: peak, mid: 0.6, k: 10 });
    if (u < 0.72) return peak * Math.exp(-6.5 * (u - 0.45));
    return Math.max(OPEN_LEVEL, peak * Math.exp(-6.5 * 0.27));
  },

  // Reaches the ceiling, holds it for half the session, then breaks late. The
  // shape that punishes anyone still holding at minute 42.
  'late-break': (u) => {
    if (u < 0.4) return ramp(u / 0.4, { from: OPEN_LEVEL, to: CAP, mid: 0.62, k: 11 });
    if (u < 0.82) return CAP;
    return Math.max(0.1 * CAP, CAP * Math.exp(-14 * (u - 0.82)));
  },

  // No bubble at all. Price stays near what a bottle is arguably worth, and a
  // strategy that will not sell below 40% of the ceiling never sells.
  //
  // The phase is per-seed. With it fixed the session always happened to end
  // near a local high, which handed the do-nothing baseline the shape for free
  // and made every other strategy look worse than it was. A shape that decides
  // the ranking through where its sine wave happens to stop is measuring the
  // generator, not the strategy.
  damp: (u, phase = 0) => OPEN_LEVEL * (2 + 1.4 * Math.sin(u * 7 + phase)),

  // Three false tops on the way up. Built to shake out a trailing stop.
  sawtooth: (u) => {
    const base = ramp(clamp(u / 0.78, 0, 1), { from: OPEN_LEVEL, to: 0.88 * CAP, mid: 0.55, k: 7 });
    const notches = [[0.25, 0.03], [0.45, 0.035], [0.62, 0.04]];
    let cut = 1;
    for (const [at, width] of notches) {
      const d = Math.abs(u - at);
      if (d < width) cut *= 1 - 0.3 * (1 - d / width);
    }
    return u > 0.78 ? base * cut * (1 - 0.25 * (u - 0.78) / 0.22) : base * cut;
  },

  // Climbs all session and peaks at the bell. Punishes selling early, and is
  // the one shape where being flat before the close costs real money.
  'slow-burn': (u) => ramp(u, { from: OPEN_LEVEL, to: 0.8 * CAP, mid: 0.75, k: 5 }),

  // Tops out at minute 14 and bleeds down for the rest of the session. The
  // only chance to sell well comes before most rules have armed.
  'early-spike': (u) => {
    const peak = 0.68 * CAP;
    if (u < 0.28) return ramp(u / 0.28, { from: OPEN_LEVEL, to: peak, mid: 0.55, k: 9 });
    return Math.max(0.06 * CAP, peak * Math.exp(-3.2 * (u - 0.28)));
  },
};

export const SHAPE_NAMES = Object.keys(SHAPES);

function samplePrintSize(r) {
  let n = r() * PRINT_TOTAL;
  for (const [size, count] of PRINT_SIZES) {
    n -= count;
    if (n <= 0) return size;
  }
  return 1;
}

// Depth at the touch. Thick when the market is calm or pinned, thin when it is
// falling, which is the only time it matters.
function sampleDepth(r, momentum) {
  const heavy = r() < 0.12;
  const base = heavy ? Math.round(pick(r, 300, 9000)) : Math.round(Math.exp(pick(r, 0, 5.4)));
  const fear = momentum < 0 ? clamp(1 + momentum * 8, 0.05, 1) : 1;
  return Math.max(1, Math.round(base * fear));
}

const bookRow = (price, qty) => `<tr><td>${price}</td><td>${qty}</td></tr>`;

/**
 * One synthetic session, as replay frames: [{ clock, msg }], oldest first.
 *
 * `shape` names a price path; `seed` fixes the noise. Everything the strategies
 * can see comes out of here, so the oracle in the harness is computed from
 * these same frames rather than from the path that generated them.
 */
export function generateSession({
  shape = 'pin',
  seed = 1,
  total = 3000,
  vt = 2,
  cap = CAP,
} = {}) {
  const path = SHAPES[shape];
  if (!path) throw new Error(`unknown shape: ${shape}`);
  const r = rng(seed);
  const phase = r() * Math.PI * 2;
  const out = [];
  const push = (clock, msg) => out.push({ clock, msg });

  push(total, { header: 'secname', isno: 1, msg: 'Genie bottle' });
  push(total, { header: 'startperiod', iTime: String(total), msg: '1' });
  push(total, { header: 'cash', msg: '0' });
  push(total, { header: 'endow', isno: 1, msg: '20' });
  push(total, { header: 'info', isno: 1, msg: `Your value Vt is ${vt}` });

  // Deviation from the intended path, as an AR(1) in log price: the market
  // wanders around its shape rather than tracking it exactly.
  let dev = 0;
  const phi = 0.93;
  const sigma = 0.035;

  let holeUntil = -1;
  let holeFloor = 1;
  const holeAt = r() < HOLE_CHANCE ? Math.round(total * pick(r, 0.25, 0.85)) : -1;

  let lastBid = null;
  let lastAsk = null;
  let prevMid = null;

  for (let clock = total; clock >= 0; clock -= 1) {
    const u = (total - clock) / total;
    push(clock, { header: 'time', msg: String(clock) });

    dev = phi * dev + sigma * normal(r);
    const target = path(u, phase);
    const mid = clamp(target * Math.exp(dev), 1, cap);
    const momentum = prevMid === null ? 0 : (mid - prevMid) / Math.max(prevMid, 1);
    prevMid = mid;

    // Spread collapses as the market approaches the ceiling: at the cap
    // everyone agrees on the price, and the captured median spread was 0.
    const proximity = mid / cap;
    const half = Math.max(0, pick(r, 0.002, 0.05) * (1 - proximity) ** 1.5);

    let bid = Math.max(1, Math.round(mid * (1 - half)));
    let ask = Math.min(cap, Math.round(mid * (1 + half)));
    if (ask <= bid) ask = Math.min(cap, bid + 1);
    if (bid >= ask) bid = Math.max(1, ask - 1);

    // The liquidity hole. The bid falls away, prints carry on near the top
    // because buyers are still lifting offers, and the book refills a minute
    // later as if nothing happened.
    if (clock === holeAt) {
      holeUntil = clock - Math.round(pick(r, HOLE_LEN[0], HOLE_LEN[1]));
      holeFloor = pick(r, HOLE_DEPTH[0], HOLE_DEPTH[1]);
    }
    const inHole = clock <= holeAt && clock > holeUntil;
    if (inHole) bid = Math.max(1, Math.round(mid * holeFloor * pick(r, 0.85, 1.15)));

    // A crossed book, at the rate one was actually observed and no more. This
    // is the sniper's entire opportunity set, so it is the number in this file
    // most worth being suspicious of.
    //
    // It is only injected when it can be published without a transient — that
    // is, when the previous bid is already below the new offer. Otherwise
    // putting the offer out first would cross it against the stale higher bid
    // and hand the sniper an edge of several hundred instead of the one that
    // was intended. Skipping those makes crosses slightly rarer than measured,
    // which is the safe direction to be wrong in.
    const crossed = !inHole && (lastBid === null || lastBid < ask) && r() < CROSS_RATE;
    if (crossed) bid = Math.min(cap, ask + CROSS_EDGE);

    const bidQty = inHole
      ? Math.max(1, Math.round(sampleDepth(r, -0.1) * 0.2))
      : sampleDepth(r, momentum);
    const askQty = sampleDepth(r, -momentum);

    // Both sides go out before any print, and in the order that leaves the book
    // uncrossed after EACH message rather than only after both.
    //
    // This is the whole ballgame, and it is subtle enough that the first
    // version of this file got it wrong. A strategy reacts to one quote at a
    // time. Publish a rising bid before the ask that justifies it and there is
    // an instant where the new bid sits above the previous, lower ask — a
    // crossed book that never existed. In a market climbing from 50 to 25,000
    // that instant recurs on every tick, and the sniper harvested the entire
    // climb from it: 2.8m a session, five times what was ever on the table.
    //
    // So: whichever side can be published without crossing goes first. When the
    // cross is the deliberate one, the ask goes first so the edge the sniper
    // sees is the one unit that was actually put there.
    const emitBid = () => {
      if (bid === lastBid) return;
      push(clock, {
        header: 'bestbid', isno: 1, msg: 'x', price: bid, qty: bidQty,
        displayName: 'sim.bidder', msg2: bookRow(bid, bidQty),
      });
      lastBid = bid;
    };
    const emitAsk = () => {
      if (ask === lastAsk) return;
      push(clock, {
        header: 'bestask', isno: 1, msg: 'x', price: ask, qty: askQty,
        displayName: 'sim.offerer', msg2: bookRow(ask, askQty),
      });
      lastAsk = ask;
    };
    // Publishing the bid first is safe when it lands under the standing offer;
    // otherwise the market has risen and the offer must go first, where it is
    // safe because it is above the standing bid. A deliberate cross always puts
    // the offer first, which the check above has already made safe.
    if (!crossed && (lastAsk === null || bid < lastAsk)) {
      emitBid();
      emitAsk();
    } else {
      emitAsk();
      emitBid();
    }
    push(clock, {
      header: 'bidasklast', isno: 1, iTime: String(clock),
      msg: String(bid), msg1: String(ask), msg2: String(Math.round(mid)),
    });

    // Trading is busiest when the market is moving and when it is pinned at a
    // price everyone wants; it is thin in the quiet opening.
    const heat = 0.25 + 2 * proximity ** 2 + 12 * Math.abs(momentum);
    let prints = 0;
    for (let i = 0; i < 6; i += 1) if (r() < heat / 6) prints += 1;

    for (let i = 0; i < prints; i += 1) {
      const buyerAggressive = r() < clamp(0.5 + momentum * 6, 0.05, 0.95);
      const price = buyerAggressive ? ask : bid;
      push(clock, {
        header: 'lasttrade', isno: 1,
        price, qty: samplePrintSize(r), lastTick: buyerAggressive ? 1 : -1,
      });
    }
  }

  push(0, { header: 'endperiod', msg: '1' });
  return out;
}
