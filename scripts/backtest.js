// Replays a captured session through the strategy board and reports what each
// strategy would have realised.
//
//   node scripts/backtest.js ../Downloads/genie_orderbook_full.json
//
// The comparison that matters is the average price per bottle, against what was
// actually realised on the day.

import { loadReplay } from '../hub/replay.js';
import { Tracker } from '../hub/protocol.js';
import { StrategyBoard } from '../hub/strategies/engine.js';
import { strategies } from '../hub/strategies/registry.js';

const file = process.argv[2] ?? '../Downloads/genie_orderbook_full.json';
const ACTUAL_CASH = 161859.6;
const ACTUAL_BOTTLES = 20;

const messages = await loadReplay(file);
const tracker = new Tracker();
const board = new StrategyBoard(strategies);

for (const { msg } of messages) {
  for (const event of tracker.handle(msg)) board.handle(event);
  for (const event of tracker.flush()) board.handle(event);
}
for (const event of tracker.flush(true)) board.handle(event);

const rows = board.summaries.map((s) => ({
  name: s.name,
  gain: s.gain,
  avg: s.fills ? s.cash / (ACTUAL_BOTTLES - s.position || 1) : 0,
  fills: s.fills,
  left: s.position,
}));

const money = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(10);

console.log(`\nreplayed ${messages.length} messages from ${file}\n`);
console.log('strategy            total gain   avg/bottle   fills   left');
console.log('-'.repeat(60));
for (const r of rows.sort((a, b) => b.gain - a.gain)) {
  console.log(
    `${r.name.padEnd(18)}${money(r.gain)}   ${money(r.avg)}   ${String(r.fills).padStart(5)}  ${String(r.left).padStart(5)}`,
  );
}
console.log('-'.repeat(60));
console.log(`${'Session 1 actual'.padEnd(18)}${money(ACTUAL_CASH)}   ${money(ACTUAL_CASH / ACTUAL_BOTTLES)}       —      0`);

console.log(
  '\nCoverage note: the export starts at session minute 19.4, with the market\n' +
    'already at 24,000. Everything before that — the whole build-up — is missing,\n' +
    'so these numbers show the exit, not the full decision.\n',
);
