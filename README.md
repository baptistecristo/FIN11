# FIN11: Genie bottles

In the NHH FIN11 trading game, about forty of us trade one invented asset against each
other for fifty minutes. I built a viewer that reads the market feed live out of my
browser and runs five exit strategies side by side on paper, each scored on the formula
the class is ranked by, so that during the session I can see which one is ahead and switch
to it. Armed, it will also place the orders itself.

![The viewer: fills tape on the left, price curve on the right](docs/viewer.jpg)
<sub>Synthetic test data, and the trader names are invented. In a real session the viewer
shows classmates' initials only, and nothing identifying anyone has ever been committed
to this repository.</sub>

## The game

You start with about 20 bottles and no cash. At the bell the bottles pay nothing:

```
total gain  =  cash  +  realized utility  +  0 × bottles
```

So the session is a race to sell your endowment into the bubble before the rest of the
class does. The server caps the price at 25,000 and rejects anything above it, and that
cap is what the whole thing turns on: once the best bid touches it, holding has no upside
left and a bid that retreats is a real risk.

## Reading the market live

The trading site keeps its WebSocket connection as an implicit global. It exists only
after you click connect, and the page replaces it on every reconnect, so reading that
variable breaks the first time you reload. A small Chrome extension patches the WebSocket
constructor as the page loads instead, which catches every connection the site opens, and
mirrors the feed to a local hub. The viewer then runs in a browser window opened for it
alone, beside the trading tab, so the tape and the strategy panel never sit on top of the
order ticket. I trade in my normal browser as usual.

## Five strategies, scored live

All five start at the opening bell from my real position and run on every tick, so the
comparison covers the whole session rather than starting whenever I opened the window.

| | what it does | best when |
|---|---|---|
| **1 Cap strike** | Waits for the bid to reach the 25,000 cap, then sells the lot. Gives up on the cap once the market has topped out below it. | the market pins at the ceiling, as it did in Session 1 |
| **2 Ratchet** | Keeps the share sold in step with how far the bid has come toward the cap. Never sells backwards. | you want a rising average price and no single timing call |
| **3 Trailing peak** | Rides the climb, leaves on a break bigger than any pullback the session has already recovered from. | the bubble breaks before the bell |
| **4 Corner** | Buys the float on a fixed budget once a bubble is visibly under way, then sells into it. | the bubble repeats. It is the only one that can lose money |
| **5 Sniper** | Takes crossed books: buys the offer and sells the bid at once. | almost never, and the measurement is in the notes |

Press **1-5** to switch. Whichever one is selected can be armed to trade, behind a second
switch in the extension and a kill key.

## What the sessions say so far

| Session | Rank | Cash at close | Bottles left |
|---|---|---|---|
| #1, 18 Aug 2026 | 14th of ~40 | 161,859.60 | 0 |
| #2, not yet traded | — | — | — |
| #3, not yet traded | — | — | — |

I finished Session 1 flat, which was right, but sold in clips too small for a market that
ran to the cap and stayed there. My realised average was 8,093 a bottle against 25,000
quoted for ten minutes straight. The mistake was not being late to the exit. It was
selling cheap into a market sitting at its own hard maximum.

That session's recording covers only about 23% of the fifty minutes, and only the exit, so
it cannot say which strategy is best. Run against seven simulated session shapes instead,
no strategy wins everywhere, and the gap between shapes is wider than the gap between
strategies. That is the reason the panel runs all five at once rather than committing to
one before the bell.

Reasoning behind each strategy, and the full test results, are in
[docs/strategy-notes.md](docs/strategy-notes.md).

## Running it

```powershell
.\scripts\start.ps1
npm test
```

Before the first run, load `extension\` once from `chrome://extensions` — Developer mode,
then **Load unpacked**. The viewer has no feed without it. Then trade in your normal
browser as usual, and the extension mirrors the feed to the hub.

Outside a session you can replay a saved capture through the same viewer:

```powershell
.\scripts\start.ps1 -Replay <file> -Speed 40
```

Node 20+, no dependencies.
