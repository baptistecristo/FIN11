# Strategy notes

Why each strategy is written the way it is, and what the testing does and does not prove.
Read the [README](../README.md) first.

## What Session 1 showed

The market pinned at the 25,000 cap from minute 19.6 onward and was still there nine
minutes later when the recording ended, with a bid for 8,687 bottles sitting at the cap.
Liquidity was never the constraint. So one rule needs no market reading at all: 25,000 is
enforced by the server, no higher price can ever print, and once the best bid touches it
there is nothing left to wait for.

The same recording holds a second lesson that took longer to notice. At minute 23.15 the
best bid went 24,888 to 23,000 to 1,000 and stayed under 15,000 for about fifty seconds,
while trades carried on printing at 25,000 because buyers were still lifting offers. A
387-lot bid had been eaten and the book underneath it was air. Any rule that answers "sell
everything now" with a market order can land in that window and realise 4% of what it
expected. So no strategy here will sell into a bid that has fallen away from the offer,
right up until the bell makes any price better than none.

## The four rules all five share

In `hub/strategies/common.js`:

- **Take the ceiling.** Once the bid is at 25,000 there is nothing above it to wait for.
- **Finish flat, on a schedule.** Not a view on price, but an admission that we do not
  know which session this is. Nothing is sold on the clock alone before halfway; from
  there the share that must already be gone rises to everything by the deadline. It is
  what stops any of them holding the lot into a crash.
- **Refuse a hole.** A bid under half the offer is a gap in the book, not a price.
- **Learn what a break is worth.** Every rule that asks "has it topped out?" measures
  against the largest pullback this market has already recovered from, rather than a
  percentage picked in advance.

## Tested across session shapes

The real recording covers 23% of one session and cannot separate the strategies: all five
land within 1% of each other on it, and all of them beat the 8,093 a bottle I realised on
the day. So they are also run over seven synthetic session shapes, forty to sixty seeds
each, generated as the frames the server would have sent and fed through the same tracker
and the same paper engine as a live market.

Scores are the share of what was on the table, meaning the most 20 bottles could have
fetched against the bids actually quoted. A pinned session pays a hundred times what a
flat one does, so raw gains cannot be averaged across shapes without the pinned ones
deciding everything. Corner exceeds 100% because it buys.

| | pin | pop | late-break | damp | sawtooth | slow-burn | early-spike | **mean** | **worst** |
|---|---|---|---|---|---|---|---|---|---|
| Corner | 238% | 37% | 212% | 49% | 284% | 201% | 26% | **149%** | 26% |
| Trailing peak | 99% | 54% | 98% | 58% | 63% | 50% | 54% | **68%** | 50% |
| Cap strike | 94% | 46% | 94% | 43% | 88% | 59% | 38% | **66%** | 38% |
| Sniper | 100% | 17% | 100% | 53% | 95% | 59% | 17% | **63%** | 17% |
| Ratchet | 65% | 45% | 65% | 51% | 65% | 49% | 50% | **56%** | 44% |
| *Bell dump* | *97%* | *14%* | *25%* | *44%* | *74%* | *77%* | *11%* | ***49%*** | *11%* |

*Bell dump* is not a strategy. It holds everything and sells at the deadline, and it is
there because a strategy that cannot beat doing nothing is costing money to run. It wins
outright in `slow-burn`, where the market peaks at the bell.

Six of the seven shapes are hypotheses; only the pinned one is calibrated against real
data, along with print sizes, print rate, spread behaviour and the rate of crossed books.
So this is not evidence about which strategy is best. It is evidence about which ones fall
apart when the session is not shaped like Session 1. No strategy wins everywhere, and the
spread between them is smaller than the spread between shapes.

Two cautions, both learned here. The first generator moved price 3.5% per quote and
updated the bid before the ask, manufacturing a crossed book on every tick; the sniper
"earned" 199 fills against the 5 that exist in real data. The second version fixed the
price path and still published the two sides of the book in the wrong order, so a rising
bid briefly sat above the previous lower ask, and the sniper harvested the entire climb
from that: 2.8m a session, five times what was ever on the table. A test now walks a
generated session one message at a time and fails if crossed books are more common than
the 0.36% measured in the real recording. **A backtest will happily generate the
opportunity you are testing for.**

## The two bets that needed bounding

**Corner.** Cornering cannot create demand here. Bottles pay zero at the bell and the
private value is about 2, so nobody ever needs to buy them from you. The reason to do it
anyway is that Session 1 ran to the ceiling, and inventory bought cheaply beforehand is
worth a lot into that. Its discipline is arithmetic: a bid at X only pays if you can sell
above X, and nothing above 25,000 can ever print. Hence a hard buy ceiling at 30% of the
cap, a 70-bottle limit, and bids that improve the market by one step rather than leaping
above it. Leap, and you become the only buyer, everyone dumps on you, and you finish
holding worthless bottles with the cash gone. Three further bounds came out of the shape
testing: a budget of 120,000, which is what this bet is allowed to lose; a requirement
that the market has already multiplied eightfold off its opening bid, since a quiet
session drifts by a factor of three on its own; and never paying more than 90% of the best
bid the session has produced. Together they cost about 40 points of mean and turned its
worst flat session from -5,276 into +827.

**Sniper.** Measured on the real book before it was written: 5 strictly crossed moments in
1,403 book states, worth 794 in total, largest single edge 1, and a median spread of zero.
The risk is one-sided. Profit is 1 a bottle when both legs fill; the loss is the full
24,999 when the sell leg misses, because what you are left holding pays nothing at the
bell. That needs a 99.996% fill rate to break even. Backtested on the real recording it
earns 50 more than simply exiting well. It exists so the question is answered with a
number rather than a hunch, and to catch a genuinely fat mistake if a later session is
more volatile. It is not where the money is.

## What the paper scores cannot tell you

The fill model is deliberately pessimistic: a taking order fills at the quoted price and
only for the size quoted, and a resting order fills only when a print goes *through* its
price, never merely at it, because at your own price you are behind the queue that was
already there. It cannot model queue position or my own market impact, so the panel ranks
strategies against each other rather than predicting an actual take. Against the simulated
shapes that matters most for Corner: buying seventy bottles, three and a half endowments,
would move the price it is buying at in a real class, which makes its 149% the most
optimistic number on this page.
