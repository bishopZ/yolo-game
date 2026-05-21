/**
 * renderer/tests/scoring.test.js
 * ──────────────────────────────
 * Unit tests for the Yolo Game scoring engine (AC-07).
 *
 * Tests three AC-07 scenarios:
 *   (a) Find at 30s → score = 50
 *   (b) Timeout → score = TIMEOUT_PENALTY (-10)
 *   (c) Give Up at 30s → score ≈ 15% of 50 remaining = 7
 *
 * Run from repo root:
 *   node renderer/tests/scoring.test.js
 */

'use strict';

import {
  scoreForFind,
  scoreForGiveUp,
  scoreForTimeout,
  MAX_ROUND_SCORE,
  ROUND_TIME_S,
  TIMEOUT_PENALTY,
  GIVE_UP_FRACTION,
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

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`  PASS  ${message}  (${actual})`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}  expected≈${expected}±${tolerance} actual=${actual}`);
    failed++;
  }
}

// ── Suite: scoreForFind ────────────────────────────────────────────────────

console.log('\n── scoreForFind ──────────────────────────────────');

assertEqual(
  scoreForFind(0),
  MAX_ROUND_SCORE,
  'Find at t=0 → max score (100)'
);

assertEqual(
  scoreForFind(ROUND_TIME_S / 2),  // t=30s
  50,
  'AC-07(a): Find at 30s → score = 50'
);

assertEqual(
  scoreForFind(ROUND_TIME_S),  // t=60s
  0,
  'Find at exactly 60s → score = 0'
);

assertEqual(
  scoreForFind(ROUND_TIME_S + 5),  // past timeout
  0,
  'Find past 60s → score = 0 (not negative)'
);

assertEqual(
  scoreForFind(ROUND_TIME_S * 0.1),  // t=6s — early find
  Math.floor((1 - 0.1) * MAX_ROUND_SCORE),
  'Find at 10% of time → 90 points'
);

assertEqual(
  scoreForFind(ROUND_TIME_S * 0.9),  // t=54s — late find
  Math.floor((1 - 0.9) * MAX_ROUND_SCORE),
  'Find at 90% of time → 10 points'
);

// ── Suite: scoreForTimeout ─────────────────────────────────────────────────

console.log('\n── scoreForTimeout ───────────────────────────────');

assertEqual(
  scoreForTimeout(),
  TIMEOUT_PENALTY,
  'AC-07(b): Timeout → TIMEOUT_PENALTY (-10)'
);

assert(
  scoreForTimeout() < 0,
  'Timeout score is negative'
);

// ── Suite: scoreForGiveUp ──────────────────────────────────────────────────

console.log('\n── scoreForGiveUp ────────────────────────────────');

const giveUpAt30 = scoreForGiveUp(30);
const remainingScoreAt30 = Math.max(0, scoreForFind(30));  // 50
const expectedGiveUp30 = Math.floor(remainingScoreAt30 * GIVE_UP_FRACTION);  // floor(50 * 0.15) = 7

assertEqual(
  giveUpAt30,
  expectedGiveUp30,
  `AC-07(c): Give Up at 30s → ≈15% of 50 remaining = ${expectedGiveUp30}`
);

assertApprox(
  giveUpAt30 / remainingScoreAt30,
  GIVE_UP_FRACTION,
  0.05,  // within 5% of 15%
  `Give Up fraction ≈ ${Math.round(GIVE_UP_FRACTION * 100)}% of remaining score`
);

assertEqual(
  scoreForGiveUp(0),
  Math.floor(MAX_ROUND_SCORE * GIVE_UP_FRACTION),
  'Give Up immediately → fraction of max score'
);

assertEqual(
  scoreForGiveUp(ROUND_TIME_S),
  0,
  'Give Up at timeout → 0 (no remaining score to fraction)'
);

assert(
  scoreForGiveUp(30) >= 0,
  'Give Up score is non-negative'
);

// ── Suite: score monotonicity ──────────────────────────────────────────────

console.log('\n── Score monotonicity ────────────────────────────');

let mono = true;
for (let t = 0; t < ROUND_TIME_S; t += 5) {
  if (scoreForFind(t) < scoreForFind(t + 5)) {
    mono = false;
    break;
  }
}
assert(mono, 'scoreForFind is non-increasing over time');

// ── Suite: Give Up always ≤ Find ──────────────────────────────────────────

console.log('\n── Give Up ≤ Find score at same elapsed time ────');

let giveUpAlwaysLess = true;
for (let t = 0; t < ROUND_TIME_S; t += 10) {
  if (scoreForGiveUp(t) > scoreForFind(t)) {
    giveUpAlwaysLess = false;
    break;
  }
}
assert(giveUpAlwaysLess, 'Give Up score ≤ Find score at any elapsed time');

// ── Summary ────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────────────');
console.log(`  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n  ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\n  All scoring tests PASS');
}
