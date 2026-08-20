# FTS Live Tape — design

**Status:** built 2026-08-19. Supersedes the observation notes in `FTS_TRADING_BOT_HANDOFF.md`.

Revised during the build, on request: the order book was dropped from the display,
and the price curve is now built from filled trades — one point per print — rather
than from the `bidasklast` quote feed.

A read-only viewer for the NHH FTS Web Trader "Genie bottle" market: a streaming
list of filled orders and a live price curve, in its own desktop window.

Built before the bot, deliberately. The viewer never places an order, so it cannot
trigger the blocking `alert()` that made arming a bot unsafe in Session 04.

## Why this shape

Session 04 was observed by reverse-engineering captured WebSocket traffic, which
surfaced four message types. Reading the actual client source
(`http://ftswebtrader.com/jsConstant.js`, `JavaScript1.js`, `jsMontage.js`,
`jsGoogle.js`) surfaced the full protocol instead. Three findings drove the design:

1. `bidasklast` is a purpose-built chart feed carrying bid, ask and last together,
   already stamped with game time. The price curve needs no reconstruction.
2. `lasttrade` carries `lastTick` (+1/-1), the aggressor direction. Trade side is
   read directly from the server, not inferred from quote comparison.
3. Own fills are *not* pushed. `buy`/`sell` are outbound-only order submission and
   the page has no blotter. But `cash` and `endow` are pushed on every change, so
   each fill reconstructs exactly from the deltas.

## Protocol

Source of truth: `handleTrdMessage` in `jsConstant.js`. Frames arrive **batched as
JSON arrays** — a listener that assumes single objects drops most of the feed.

| header | fields | use |
|---|---|---|
| `bidasklast` | `isno, iTime, msg`=bid, `msg1`=ask, `msg2`=last | price curve |
| `lasttrade` | `isno, price, lastTick`, `qty` | market tape; `lastTick` = side |
| `bestbid` / `bestask` | `price, qty, displayName, msg2`=book HTML | top of book + depth |
| `cash` | `msg` | cash account |
| `endow` | `isno, msg`, `msg1`=futures obligation | position |
| `info` | `isno, msg` | private value Vt |
| `time` | `msg` | game clock |
| `startperiod` | `iTime, msg` | session length (3000) |
| `pausemarket` / `resumemarket` / `endperiod` | — | session lifecycle |
| `performance` | delimiter-split table | ranking |

`qty` on `lasttrade` is ignored by the page's own handler but is present on the
wire — captured Session-04 data shows it varying (1, 2, 5, 54, 93, 893). Treated
as optional and defaulted to 1 when absent.

## What the viewer shows

Filled trades and nothing else. The depth ladder and best-quote panel were built
and then removed: they answer a different question from the one this window is for.

The curve is therefore drawn from `lasttrade` prints, step-after, one point per
fill. `bidasklast` is still parsed and recorded but no longer drawn — a quote
sample is not a trade, and mixing the two would blur what the curve means.

Trader attribution is the one place the display goes beyond the wire. `lasttrade`
carries no names, so per-fill names are inferred from whoever was resting on the
touch at that price, and rendered dimmed with a `~` prefix. Names on quotes are
exact and shown plainly in a top-of-book strip.

**Capture is unchanged by any of this.** The hub still writes every message type
to disk, including the book. Displaying less must never mean recording less.

## Architecture

```
Chrome tab, ftswebtrader.com          <- the user trades here, normally
  |  MAIN-world content script: patches the WebSocket constructor
  |  ISOLATED-world relay -> background service worker
  v  POST http://127.0.0.1:8787/ingest   (batched every 100ms)
Hub (Node, zero npm dependencies)
  |  raw frames -> data/raw-<ts>.jsonl on arrival   <- reload-proof
  |  normalize -> trade | quote | account | myfill | clock | info | session
  v  SSE http://127.0.0.1:8787/events
Viewer -> chrome --app=http://127.0.0.1:8787
```

**Why the WebSocket constructor is patched, not `window.ws`.** The page assigns
`ws = new WebSocket(url)` inside a click handler with no `var` in scope — an
implicit global, which is why `window.ws` worked in Session 04. But it does not
exist at `document_start`, and it is reassigned on reconnect. Patching the
constructor at `document_start` catches the socket however and whenever it is
created, including reconnects, with no polling.

**Why HTTP POST + SSE, not a WebSocket server.** Node has no built-in WebSocket
*server*, and the traffic is ~1.3 messages/second. POST batched at 100ms is far
below any threshold where WebSocket framing would matter, and it keeps the hub at
zero npm dependencies — nothing to install, nothing to break mid-session.

**Why the extension fetches from the background worker.** The FTS page is served
from a public IP; a direct `fetch` to 127.0.0.1 from page context is a Private
Network Access request that Chrome may preflight or block. Extension background
fetches with `host_permissions` are not subject to that.

## Reload survival

Session 04 lost the last 21.5 minutes — the top, the pin at cap, the crash and the
close — because a page reload wiped an in-memory `window.*` buffer. Two independent
defences:

- The content script re-attaches automatically on every page load.
- The hub appends every raw frame to disk on arrival. Hub state is derived, never
  authoritative; a viewer restart replays from the JSONL.

## Own-fill reconstruction

On each `cash` / `endow` change, compare against the previous pair:

- `d_position = position - prev_position`, `d_cash = cash - prev_cash`
- `d_position > 0` -> BUY of `d_position` at `-d_cash / d_position`
- `d_position < 0` -> SELL of `-d_position` at `d_cash / -d_position`

Exact, because it derives from the server's own account state. Emitted as `myfill`
and marked on the price curve.

The two legs arrive as separate messages, so the fill is only resolved once both
have landed — pricing on the first leg alone yields zero. A fill whose second leg
never arrives is reported unpriced after a 3-second timeout rather than dropped;
the timeout is generous because an unpriced fill cannot be corrected afterwards.

## Scope

In: price curve built from fills, the fills tape with your own fills highlighted
inline, inferred resting-trader attribution, exact top-of-book names,
cash/position/Vt/fill count, countdown, live total gain
(`cash + realized utility + 0 x bottles`), raw feed tab, disk persistence, replay
of captured sessions.

Out: the depth ladder. Order entry of any kind. No call to `mSubmitBid`, `mSubmitAsk`, `mHitAsk`,
`mHitBid`, `mClearBids`, `mClearAsks`. No short selling. The bot is a separate
program built later against the same hub.

## Validation

1. Live B02 demo market (`#cmdTrdConnectDemo`, logs in as `Trader <random>` /
   `ftsDemo@ftsweb.com`) proves capture end-to-end on real traffic with no contact
   with the ranked competition.
2. Replay of the Session-04 files as a regression fixture.
3. Unit tests over protocol normalization and fill reconstruction.
