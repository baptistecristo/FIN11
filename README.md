# FIN11: Genie bottles

A live viewer for the NHH FIN11 trading sessions. It shows every filled trade as it
prints, and draws a price curve that gains one point per fill.

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
extension/    captures the market feed (read-only)
ui/           the viewer window
scripts/      launcher, and a synthetic feed for testing
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
