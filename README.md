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

You need a Windows PC with Chrome, and [Node.js](https://nodejs.org) installed. Node is
free, and the installer's default options are fine.

1. **Get the code.** Click the green **Code** button at the top of this page, choose
   **Download ZIP**, and unzip it somewhere you'll find again.

2. **Add the extension to Chrome.** The viewer can't see the market by itself. A small
   piece of software, called an extension, passes what your browser sees over to it.
   Open a new tab, go to `chrome://extensions`, turn on **Developer mode** at the top
   right, click **Load unpacked**, and pick the `extension` folder from the unzipped
   code. You only do this once.

3. **Start it.** In File Explorer, right-click the unzipped folder and choose **Open in
   Terminal**, then paste this and press Enter:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
   ```

   Windows blocks downloaded scripts by default, which is what the long first half of
   that line is for. A window opens with an empty tape and an empty chart. That window
   is the viewer, and it stays empty until you connect to a market.

4. **Open the market.** In your normal browser, go to
   [ftswebtrader.com](http://ftswebtrader.com). If your session is running, log in the
   way you normally would. If it isn't, click **Connect to Demo**. That drops you into a
   practice market which works the same way and has nothing to do with anyone's grade.

5. **Watch it fill up.** Every trade in the market appears on the left as it happens, the
   line on the right is the price, and the panel below runs five different selling plans
   against your real position at once, scoring each one. Press **1** to **5** to see what
   each would be doing. It places no orders of its own until you arm it, in the extension
   and in the viewer both.

### Or have Claude Code or Codex do it with you

Open the unzipped folder in Claude Code (or Codex) and paste this:

```text
I've just downloaded this project and I don't know how any of it works.

1. Check whether I have everything I need to run it. If something's missing, tell me
   where to get it in plain language.
2. Walk me through loading the browser extension in the `extension` folder, one click at
   a time. I've never installed one this way before, so don't assume I know the words.
3. Start the project for me and tell me when it's ready.
4. Then explain what I'm looking at in the window that opened: what the list on the left
   is, what the line on the right means, and what the five numbered plans are each
   trying to do differently.

Explain as you go, and stop and ask me before anything that would place a real order.
```

It can do steps 1, 3 and 4 for you. Step 2 is clicks inside your own browser that it
can't make for you, so it will talk you through those instead.

---

To play back a recording you already have, run `.\scripts\start.ps1 -Replay <file>
-Speed 40` and it runs through the same viewer. `npm test` runs the test suite.
