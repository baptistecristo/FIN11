# FIN11: Genie bottles

A live viewer for the NHH FIN11 trading sessions. It shows every filled trade as it
prints, draws a price curve that gains one point per fill, and runs three strategies
side by side on paper so you can see which one is winning right now.

![The viewer: fills tape on the left, price curve on the right](docs/viewer.jpg)
<sub>Synthetic test data. The trader names are invented.</sub>

```powershell
.\scripts\start.ps1
```

Opens in its own window. Load `extension\` once from `chrome://extensions` (Developer
mode, then Load unpacked), and trade in your normal browser as usual.

## The game

The class trades one made-up asset against each other for 50 minutes. You start with
about 20 bottles and no cash. At the bell, bottles are worth **nothing**:

```
total gain  =  cash  +  realized utility  +  0 × bottles
```

So the whole thing is a race to sell your endowment into the bubble before everyone
else does.

## Results

| Session | Rank | Cash at close | Bottles left |
|---|---|---|---|
| #1, 18 Aug 2026 | 14th of ~40 | 161,859.60 | 0 |
| #2 | | | |
| #3 | | | |

Session 1: I finished flat, which was right, but sold in clips too small for a market
that kept running to the 25,000 cap. Rank is from memory, worth re-checking.

---

<details>
<summary><b>Reading the screen</b></summary>

- **Fills tape.** Every trade, newest first. The arrow carries the tick direction and
  comes off the server's `lastTick` field. Nothing else in the tape is coloured.
- **Yours.** Blue, and mixed into the same stream, so you never switch tabs to see what
  you just did.
- **Resting.** The server never names the parties to a trade. It does name whoever sits
  on top of the book, so this column shows who was resting at the price that printed.
  The `~` marks it as an inference.
- **Session bar.** How much of the 50 minutes has gone, with a red mark for where you
  should already be flat.

**It cannot place orders.** It never touches the page's `mSubmitBid` or `mHitAsk`
functions, so it also cannot trigger the blocking `alert()` that makes automating this
site risky. A test asserts those names appear nowhere in the injected code.

</details>

<details>
<summary><b>The strategy panel</b></summary>

Three strategies run all session on their own paper portfolios, seeded from your real
account at the open and scored on the formula the class is ranked by.

They are built around what Session 1 actually did. From the captured book: the market
pinned at the 25,000 cap from **minute 19.6** onward and was still there nine minutes
later when the capture ended, with a bid for **8,687 bottles** sitting at the cap.
Liquidity was never the constraint. The realised average that day was 8,093 a bottle
against 25,000 available for ten minutes straight.

So the mistake was not being late to the exit. It was selling cheap into a market
pinned at its own hard maximum. That gives one rule that needs no market reading at
all: **25,000 is enforced by the server, so no higher price can ever print.** Once the
best bid touches it, holding has no upside left and a retreating bid is a real risk.
All three strategies share that rule and differ only on the way up.

| | |
|---|---|
| **Cap strike** | Waits for the bid to reach the cap, then sells the lot. Rests an ask under the cap meanwhile. |
| **Ratchet** | Refuses to sell below 40% of the cap, and every clip must beat the last sale by 35%. |
| **Trailing peak** | Holds through the climb, sells everything once price breaks 4% off its session high. |

None of them buy: buying pays `Vt` (about 2) against a price in the thousands, so every
purchase destroys value. Every number that shapes behaviour sits at the top of
`hub/strategies/registry.js`.

Backtested on the Session 1 capture with `node scriptsacktest.js`:

| strategy | total gain | avg/bottle |
|---|---|---|
| Cap strike | 499,980 | 24,999 |
| Trailing peak | 499,980 | 24,999 |
| Ratchet | 494,985 | 24,749 |
| *Session 1 actual* | *161,860* | *8,093* |

Treat that as the exit only. The export begins at minute 19.4 with price already at
24,000, so the whole build-up is missing and the three cannot be ranked against each
other on it.

**The fill model is deliberately pessimistic.** A taking order fills at the quoted price
and only for the size quoted. A resting order fills only when a print goes *through* its
price, never merely at it, because at your own price you are behind the queue that was
already there. It also cannot model queue position or your own market impact, so use the
panel to rank strategies against each other rather than to predict your actual take.

Clicking a card selects it and shows what it would do right now. **Nothing is sent.**
Execution is not built: the FTS order functions raise a blocking `alert()` on their error
paths, which freezes browser automation entirely, and that wants a kill switch and a
written set of rules first.

</details>

<details>
<summary><b>Running it without a live market</b></summary>

```powershell
.\scripts\start.ps1 -Replay ..\Downloads\genie_orderbook_full.json -Speed 30
```

Replays the captured Session 1 data. Against a running hub, `node scripts\smoke.js`
feeds a synthetic session that includes fills of your own.

Before a real session, run it once against the live B02 demo market ("Connect to B02
Demo" on the FTS site). That is the only check that exercises the real feed end to end,
and it touches nothing in the ranked competition.

</details>

<details>
<summary><b>How the capture works</b></summary>

The protocol came from reading the FTS client source rather than from guessing at
captured traffic.

**The socket is an implicit global.** The page runs `ws = new WebSocket(url)` with no
`var` in scope, so it lands on `window`. It only appears once you click connect, and it
gets replaced on reconnect. The extension patches the `WebSocket` constructor at
`document_start` instead, catching every socket the page opens.

**Frames arrive batched.** `onmessage` receives a JSON *array* of messages. A listener
that assumes a single object drops most of the feed.

| header | carries |
|---|---|
| `lasttrade` | price, size, and `lastTick`, the tick direction |
| `bestbid` / `bestask` | price, size, and `displayName`, the only place names appear |
| `cash` / `endow` | your money and your position, pushed on every change |
| `info` | your private value `Vt` |
| `time` / `startperiod` | the game clock, and the session length |

**The server never sends your own fills.** No inbound fill message, no blotter in the
page. The hub reconstructs each fill from the deltas: `Δposition` gives the size,
`Δcash ÷ Δposition` gives the price. Those two legs arrive separately, so the hub waits
for both. Pricing off the first leg alone gives you zero.

</details>

<details>
<summary><b>Layout and tests</b></summary>

```
hub/          receives the feed, records it, serves the viewer
  strategies/   paper portfolios and the fill model
extension/    captures the market feed (read-only)
ui/           the viewer window
scripts/      launcher, a synthetic feed, and the backtester
data/         recorded sessions (git-ignored, these hold real names)
```

The hub writes every message to `data/raw-<timestamp>.jsonl` the moment it arrives,
before anything parses it. A page refresh wiped an in-memory buffer in Session 1 and
cost the last 21 minutes: the top, the crash, the close.

```powershell
npm test
```

No dependencies. Node 20+.

</details>
