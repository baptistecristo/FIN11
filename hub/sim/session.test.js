// The generator's job is to be wrong in ways that do not flatter a strategy.
// These tests are mostly about one failure: manufacturing an edge that does not
// exist in the real book, which has now happened twice on this project.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Tracker } from '../protocol.js';
import { generateSession, SHAPE_NAMES, CAP, rng } from './session.js';

// Replays a session the way a strategy experiences it — one message at a time,
// looking at the book after each — and reports what it saw.
function walk(frames) {
  const tracker = new Tracker();
  let states = 0;
  let crossed = 0;
  let worstEdge = 0;
  let prints = 0;
  let printsOutsideBook = 0;
  const bids = [];

  for (const { msg } of frames) {
    for (const event of tracker.handle(msg)) {
      if (event.t === 'quote') {
        const bid = tracker.best.bid;
        const ask = tracker.best.ask;
        if (bid && ask) {
          states += 1;
          const edge = bid.price - ask.price;
          if (edge > 0) {
            crossed += 1;
            worstEdge = Math.max(worstEdge, edge);
          }
        }
        if (event.side === 'bid' && event.price > 0) bids.push(event.price);
      }
      if (event.t === 'trade') {
        prints += 1;
        const bid = tracker.best.bid;
        const ask = tracker.best.ask;
        // A crossed book has no inside, so prints during one are exempt.
        if (bid && ask && bid.price < ask.price) {
          if (event.price > ask.price || event.price < bid.price) printsOutsideBook += 1;
        }
      }
    }
  }
  return { states, crossed, worstEdge, prints, printsOutsideBook, bids };
}

test('every shape produces a session a strategy can trade', () => {
  for (const shape of SHAPE_NAMES) {
    const frames = generateSession({ shape, seed: 3 });
    const seen = walk(frames);
    assert.ok(seen.prints > 200, `${shape}: only ${seen.prints} prints`);
    assert.ok(seen.bids.length > 100, `${shape}: only ${seen.bids.length} bid quotes`);
    assert.ok(Math.max(...seen.bids) <= CAP, `${shape}: bid above the cap`);
    assert.ok(Math.min(...seen.bids) >= 1, `${shape}: bid at or below zero`);
  }
});

// The one that matters. Session 1 had 5 crossed books in 1,403 states, a rate
// of 0.36%, and the largest edge in the whole capture was 1. A generator that
// crosses more often than that is not simulating a market, it is paying the
// sniper out of thin air — which is exactly what happened when the two sides of
// the book were published in the wrong order.
test('crossed books stay as rare as the ones in the real capture', () => {
  for (const shape of SHAPE_NAMES) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const seen = walk(generateSession({ shape, seed }));
      const rate = seen.crossed / seen.states;
      assert.ok(
        rate < 0.01,
        `${shape}/${seed}: ${(rate * 100).toFixed(2)}% of books crossed, real was 0.36%`,
      );
      assert.ok(
        seen.worstEdge <= 2,
        `${shape}/${seed}: largest edge ${seen.worstEdge}, real capture's largest was 1`,
      );
    }
  }
});

test('prints land inside the book that was published before them', () => {
  for (const shape of SHAPE_NAMES) {
    const seen = walk(generateSession({ shape, seed: 11 }));
    assert.equal(
      seen.printsOutsideBook,
      0,
      `${shape}: ${seen.printsOutsideBook} of ${seen.prints} prints outside the quoted book`,
    );
  }
});

test('the same seed gives the same session', () => {
  const a = generateSession({ shape: 'pop', seed: 42 });
  const b = generateSession({ shape: 'pop', seed: 42 });
  assert.deepEqual(a, b);
  const c = generateSession({ shape: 'pop', seed: 43 });
  assert.notDeepEqual(a, c);
});

test('shapes actually differ in the way they are named for', () => {
  const peak = (shape) => {
    const bids = walk(generateSession({ shape, seed: 9 })).bids;
    return { high: Math.max(...bids), last: bids[bids.length - 1] };
  };
  // pin ends at the ceiling it reached; pop gives it back.
  assert.ok(peak('pin').last > 0.9 * CAP);
  assert.ok(peak('pop').last < 0.3 * peak('pop').high);
  assert.ok(peak('late-break').high > 0.9 * CAP);
  assert.ok(peak('late-break').last < 0.5 * CAP);
  // damp never bubbles at all: this is the shape that catches a strategy with
  // a floor price hard-coded as a share of the cap.
  assert.ok(peak('damp').high < 0.05 * CAP);
  // slow-burn peaks at the bell rather than before it.
  assert.ok(peak('slow-burn').last > 0.6 * peak('slow-burn').high);
});

test('the generator is not accidentally a random walk', () => {
  // Two seeds of the same shape should agree on the shape, not just on noise.
  const highs = [1, 2, 3, 4, 5, 6].map(
    (seed) => Math.max(...walk(generateSession({ shape: 'pin', seed })).bids),
  );
  assert.ok(highs.every((h) => h > 0.9 * CAP), `pin highs varied too much: ${highs}`);
});

test('rng is deterministic and stays in range', () => {
  const r = rng(7);
  const xs = Array.from({ length: 500 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, rng(7)));
});
