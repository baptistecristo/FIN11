// Runs every strategy across every session shape, many seeds each.
//
//   node scripts/scenarios.js                 all shapes, 40 seeds
//   node scripts/scenarios.js --seeds 200     tighter numbers, slower
//   node scripts/scenarios.js --shape pop     one shape, with per-seed detail
//
// The question this answers is not "which strategy is best" — one market cannot
// say that. It is "which strategies fall apart when the session is not shaped
// like Session 1", which is a question a simulator can answer honestly as long
// as it is not also the thing inventing the opportunity. See hub/sim/session.js
// for what in it is measured and what is assumed.

import { Tracker } from '../hub/protocol.js';
import { StrategyBoard } from '../hub/strategies/engine.js';
import { strategies } from '../hub/strategies/registry.js';
import { generateSession, SHAPE_NAMES } from '../hub/sim/session.js';
import { bellDump, oracleGain } from '../hub/sim/benchmarks.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const SEEDS = Number(flag('seeds', 40));
const ONLY = flag('shape', null);
const shapes = ONLY ? [ONLY] : SHAPE_NAMES;
const roster = [...strategies, bellDump];

function runOne(frames) {
  const tracker = new Tracker();
  const board = new StrategyBoard(roster);
  for (const { msg } of frames) {
    for (const event of tracker.handle(msg)) board.handle(event);
    for (const event of tracker.flush()) board.handle(event);
  }
  for (const event of tracker.flush(true)) board.handle(event);
  return board.summaries;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const money = (n) => Math.round(n).toLocaleString('en-US');
const pad = (s, n) => String(s).padStart(n);

// gain / oracle, as a percentage. The only figure comparable across shapes:
// a pinned session pays ten times what a damp one does, so raw gains cannot be
// averaged over shapes without the pinned ones deciding everything.
const capture = (gain, oracle) => (oracle > 0 ? (100 * gain) / oracle : 0);

const byShape = new Map();
const overall = new Map();
for (const s of roster) overall.set(s.id, []);

for (const shape of shapes) {
  const rows = new Map();
  for (const s of roster) rows.set(s.id, { gains: [], captures: [], left: 0 });
  const oracles = [];

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const frames = generateSession({ shape, seed });
    const oracle = oracleGain(frames);
    oracles.push(oracle);
    for (const summary of runOne(frames)) {
      const row = rows.get(summary.id);
      row.gains.push(summary.gain);
      row.captures.push(capture(summary.gain, oracle));
      overall.get(summary.id).push(capture(summary.gain, oracle));
      if (summary.position > 0) row.left += 1;
    }
  }
  byShape.set(shape, { rows, oracle: mean(oracles) });
}

for (const shape of shapes) {
  const { rows, oracle } = byShape.get(shape);
  console.log(`\n${shape}   (${SEEDS} seeds, best possible ${money(oracle)} a session)`);
  console.log('  strategy          mean gain     median      worst     % of best   held at bell');
  console.log('  ' + '-'.repeat(78));
  const ordered = [...rows.entries()].sort((a, b) => mean(b[1].captures) - mean(a[1].captures));
  for (const [id, row] of ordered) {
    const name = roster.find((s) => s.id === id).name;
    console.log(
      `  ${name.padEnd(16)}${pad(money(mean(row.gains)), 10)}${pad(money(median(row.gains)), 11)}` +
        `${pad(money(Math.min(...row.gains)), 11)}${pad(mean(row.captures).toFixed(1) + '%', 12)}` +
        `${pad(row.left, 13)}`,
    );
  }
}

if (shapes.length > 1) {
  console.log(`\nacross all ${shapes.length} shapes, as a share of what was on the table`);
  console.log('  strategy            mean     median      worst shape');
  console.log('  ' + '-'.repeat(58));
  const ordered = [...overall.entries()].sort((a, b) => mean(b[1]) - mean(a[1]));
  for (const [id, caps] of ordered) {
    const name = roster.find((s) => s.id === id).name;
    let worstShape = '';
    let worstValue = Infinity;
    for (const shape of shapes) {
      const v = mean(byShape.get(shape).rows.get(id).captures);
      if (v < worstValue) {
        worstValue = v;
        worstShape = shape;
      }
    }
    console.log(
      `  ${name.padEnd(16)}${pad(mean(caps).toFixed(1) + '%', 9)}${pad(median(caps).toFixed(1) + '%', 11)}` +
        `   ${worstValue.toFixed(1)}% (${worstShape})`,
    );
  }
  console.log(
    '\nThe mean is who to run on a session you know nothing about. The worst\n' +
      'shape is what it costs to be wrong about which session you got.\n',
  );
}
