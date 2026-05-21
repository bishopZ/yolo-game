/**
 * renderer/tests/scoring.test.js
 * Unit tests for the Yolo Game scoring engine.
 *
 * Run from repo root:
 *   node renderer/tests/scoring.test.js
 */

'use strict';

import {
  currentRoundScore,
  giveUpPct,
  scoreForFind,
  scoreForGiveUp,
  scoreForTimeout,
  MAX_ROUND_SCORE,
  ROUND_TIME_S,
  GIVE_UP_PCT_START,
  GIVE_UP_PCT_END,
} from '../game.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  PASS  ${message}  (${actual})`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}  expected=${expected} actual=${actual}`);
    failed++;
  }
}

console.log('\n── currentRoundScore (HUD) ───────────────────────');

assertEqual(currentRoundScore(0), MAX_ROUND_SCORE, 'HUD at t=0 → 100');
assertEqual(currentRoundScore(60), 50, 'HUD at 60s on 120s round → 50');
assertEqual(currentRoundScore(ROUND_TIME_S), 0, 'HUD at 120s → 0');

console.log('\n── scoreForFind (2× HUD) ─────────────────────────');

assertEqual(scoreForFind(0), 200, 'Find at t=0 → 200');
assertEqual(scoreForFind(60), 100, 'Find at 60s → 100');
assertEqual(scoreForFind(ROUND_TIME_S), 0, 'Find at timeout → 0');

console.log('\n── giveUpPct ─────────────────────────────────────');

assertEqual(giveUpPct(0), GIVE_UP_PCT_START, 'Give-up % at start → 10%');
assertEqual(giveUpPct(60), 0.5, 'Give-up % at 60s → 50%');
assertEqual(giveUpPct(ROUND_TIME_S), GIVE_UP_PCT_END, 'Give-up % at end → 90%');

console.log('\n── scoreForGiveUp ────────────────────────────────');

assertEqual(scoreForGiveUp(0), 10, 'Give up at start → 10 (10% × 100)');
assertEqual(scoreForGiveUp(60), 25, 'Give up at 60s → 25 (50% × 50)');
assertEqual(scoreForGiveUp(ROUND_TIME_S), 0, 'Give up at timeout → 0');

console.log('\n── scoreForTimeout ───────────────────────────────');

assertEqual(scoreForTimeout(), 0, 'Timeout → 0');
assert(scoreForTimeout() >= 0, 'Timeout score is non-negative');

console.log('\n── Monotonicity ──────────────────────────────────');

let hudMono = true;
for (let t = 0; t < ROUND_TIME_S; t += 5) {
  if (currentRoundScore(t) < currentRoundScore(t + 5)) {
    hudMono = false;
    break;
  }
}
assert(hudMono, 'currentRoundScore is non-increasing over time');

let pctMono = true;
for (let t = 0; t < ROUND_TIME_S; t += 5) {
  if (giveUpPct(t) > giveUpPct(t + 5)) {
    pctMono = false;
    break;
  }
}
assert(pctMono, 'giveUpPct is non-decreasing over time');

console.log('\n── Give Up ≤ Find at same elapsed time ───────────');

let giveUpLeFind = true;
for (let t = 0; t < ROUND_TIME_S; t += 10) {
  if (scoreForGiveUp(t) > scoreForFind(t)) {
    giveUpLeFind = false;
    break;
  }
}
assert(giveUpLeFind, 'Give Up score ≤ Find score at any elapsed time');

console.log('\n─────────────────────────────────────────────────');
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n  ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\n  All scoring tests PASS');
}
