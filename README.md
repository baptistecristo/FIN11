# FIN11 — Genie bottles

Tools for the NHH FIN11 trading sessions: a live viewer for the market, and
eventually a bot.

## The competition, briefly

Once per session the class trades a single made-up asset — "Genie bottles" — against
each other on [FTS Web Trader](http://ftswebtrader.com/), a browser-based market
simulator. Everyone sees one shared order book and trades into it in real time.

The rules that matter:

| | |
|---|---|
| **Length** | 50 real minutes, shown as a game clock counting down from 3000 |
| **Starting position** | ~20 bottles, and 0 cash (you may borrow, interest-free) |
| **Buying** | costs money, and gives you *utility* — a private value `Vt` per bottle |
| **Selling** | gives you money |
| **Short selling** | not allowed |
| **At the bell** | **bottles are worth nothing** |

You are ranked on:

```
total gain  =  cash  +  realized utility  +  0 × bottles
```

That last term is the whole game. Bottles pay you nothing at the end, so anything
still in your account when the clock hits zero is value you destroyed. `Vt` is only
worth about 2, which is trivial next to prices that ran to the server's 25,000 cap —
so in practice the winning move is not clever buying, it is **selling your endowment
into the bubble before everyone else tries to**.

Traders are split into 5 types. Everyone within a type shares the same private value
and the same starting bottles, and you are ranked against your own type.

## My results

| Session | Date | Rank | Cash at close | Bottles left | Notes |
|---|---|---|---|---|---|
| Trading #1 | 2026-08-18 | 14th of ~40 | 161,859.60 | 0 | Sold all 20 bottles near the cap and finished flat, which is the right shape. Too slow into the top. |
| Trading #2 | — | — | — | — | |
| Trading #3 | — | — | — | — | |

<sub>Session 1 rank is from memory and worth re-checking against the posted results.</sub>

**What I'd do differently:** being flat at the close was right, but I sold too gradually
into a market that kept running to the cap. The viewer below exists mostly to fix that —
to watch the top form instead of guessing at it.

The screenshot below is synthetic test data; the names in it are invented.

## The viewer

A read-only window that shows every filled trade as it prints, and draws the price
curve one point per fill.

![the viewer](docs/viewer.jpg)

- **Fills tape** — every trade, newest first. Green is an uptick, red a downtick;
  that comes straight off the server's `lastTick` field, not from anything inferred.
- **Your own fills** — highlighted amber and mixed into the same stream, so you never
  have to switch tabs to see what you just did.
- **Resting column** — the server never names the parties to a trade. It does name
  whoever is on top of the book, so this shows who was resting at the price that
  printed. Prefixed with `~` because it is an inference, not a fact from the wire.
- **Expiry gutter** — the bar under the chart draining left to right, with a marker
  for where you should already be flat. Time is the thing that kills you in this game,
  so it gets its own axis.

**It cannot place orders.** It never touches the page's `mSubmitBid` / `mHitAsk`
functions, which means it also cannot trigger the blocking `alert()` that makes
automating this site risky. The bot, when it exists, will be a separate program.

### Running it

```powershell
.\scripts\start.ps1
```

That starts the local hub and opens the viewer in its own window. Then, once only:

1. Go to `chrome://extensions`, turn on **Developer mode**
2. **Load unpacked** → select the `extension\` folder
3. Open [ftswebtrader.com](http://ftswebtrader.com/) and log in as usual

Trade in your normal browser. The extension listens to the market feed and forwards
it to the viewer; it re-attaches itself on every page load, so a refresh mid-session
costs you nothing.

### Trying it without a live market

```powershell
.\scripts\start.ps1 -Replay ..\Downloads\genie_orderbook_full.json -Speed 30
```

Replays the captured Session 1 data through the same pipeline. Or, against a running
hub, `node scripts\smoke.js` feeds a synthetic session including fills of your own.

There is also a live demo market on the FTS site ("Connect to B02 Demo") which
exercises the whole chain on real traffic without touching the ranked competition.

## Layout

```
hub/          local server: receives the feed, records it, serves the viewer
extension/    Chrome extension that captures the market feed (read-only)
ui/           the viewer window
scripts/      launcher and a synthetic feed for testing
data/         recorded sessions (git-ignored)
docs/         design notes
```

Every message is written to `data/raw-<timestamp>.jsonl` the moment it arrives.
Session 1 lost its last 21 minutes — the top, the crash and the close — to a page
refresh that wiped an in-memory buffer, and that must not happen twice.

```powershell
npm test      # protocol parsing, fill reconstruction, the capture hook
```

No dependencies. Node 20+.
