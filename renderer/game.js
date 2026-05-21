/**
 * game.js — Yolo Game state machine and scoring engine
 *
 * Manages the full game loop:
 *   idle → tips → countdown → prompt → play → round_summary
 *   → (loop for ROUND_COUNT rounds) → final_summary → idle
 *
 * Scoring per round:
 *   - HUD shows currentRoundScore: 100 → 0 linearly over ROUND_TIME_S
 *   - Found: 2 × currentRoundScore at moment of find
 *   - Give Up: currentRoundScore × giveUpPct (10% → 90% over the round)
 *   - Timeout: 0
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────

/** Number of rounds per game session. */
export const ROUND_COUNT = 5;

/** Seconds allowed per round. */
export const ROUND_TIME_S = 120;

/** Maximum score shown on HUD at round start. */
export const MAX_ROUND_SCORE = 100;

/** Give-up share of HUD score at round start. */
export const GIVE_UP_PCT_START = 0.10;

/** Give-up share of HUD score at round end. */
export const GIVE_UP_PCT_END = 0.90;

/** Countdown duration in seconds (3-2-1). */
export const COUNTDOWN_S = 3;

/**
 * State names.
 * @typedef {'idle'|'tips'|'countdown'|'prompt'|'play'|'round_summary'|'final_summary'} GameState
 */
export const STATES = Object.freeze({
  IDLE:          'idle',
  TIPS:          'tips',
  COUNTDOWN:     'countdown',
  PROMPT:        'prompt',
  PLAY:          'play',
  ROUND_SUMMARY: 'round_summary',
  FINAL_SUMMARY: 'final_summary',
});

// ── Score helpers ──────────────────────────────────────────────────────────

/**
 * Live round score shown on the HUD — decays 100 → 0 over ROUND_TIME_S.
 *
 * @param {number} elapsedS - Seconds elapsed in the round.
 * @returns {number} Integer score ≥ 0.
 */
export function currentRoundScore(elapsedS) {
  const remaining = Math.max(0, ROUND_TIME_S - elapsedS);
  return Math.floor((remaining / ROUND_TIME_S) * MAX_ROUND_SCORE);
}

/**
 * Give-up percentage ramps from GIVE_UP_PCT_START to GIVE_UP_PCT_END over the round.
 *
 * @param {number} elapsedS - Seconds elapsed when Give Up was tapped.
 * @returns {number} Fraction in [0.10, 0.90].
 */
export function giveUpPct(elapsedS) {
  const t = Math.min(Math.max(0, elapsedS), ROUND_TIME_S) / ROUND_TIME_S;
  return GIVE_UP_PCT_START + t * (GIVE_UP_PCT_END - GIVE_UP_PCT_START);
}

/**
 * Score for finding the object — 2× the HUD value at find time.
 *
 * @param {number} elapsedS - Seconds elapsed when the object was found.
 * @returns {number} Integer score ≥ 0.
 */
export function scoreForFind(elapsedS) {
  return currentRoundScore(elapsedS) * 2;
}

/**
 * Score for Give Up — share of HUD score based on elapsed time.
 *
 * @param {number} elapsedS - Seconds elapsed when Give Up was tapped.
 * @returns {number} Integer score ≥ 0.
 */
export function scoreForGiveUp(elapsedS) {
  return Math.floor(currentRoundScore(elapsedS) * giveUpPct(elapsedS));
}

/**
 * Score for a timeout (timer reached 0).
 * @returns {number} Always 0.
 */
export function scoreForTimeout() {
  return 0;
}

// ── Round result type ──────────────────────────────────────────────────────

/**
 * @typedef {'found'|'gave_up'|'timeout'} RoundOutcome
 *
 * @typedef {Object} RoundResult
 * @property {number}       round        - 1-indexed round number
 * @property {string}       prompt       - The prompt shown to the player
 * @property {RoundOutcome} outcome      - How the round ended
 * @property {number}       elapsedS     - Seconds elapsed in the round
 * @property {number}       roundScore   - Points earned this round
 * @property {number}       runningTotal - Cumulative score after this round
 */

// ── Game factory ───────────────────────────────────────────────────────────

/**
 * Create a new game instance.
 *
 * @param {Object} options
 * @param {(state: GameState, data?: Object) => void} options.onState
 * @param {(elapsedS: number, remainingS: number, currentScore: number) => void} [options.onTick]
 * @param {(result: RoundResult) => void} [options.onRoundResult]
 * @param {Object[]} [options.puzzleMap]
 * @returns {Object} Game controller with public methods.
 */
export function createGame({ onState, onTick, onRoundResult, puzzleMap = [] } = {}) {

  let _state = STATES.IDLE;
  let _puzzleMap = [...puzzleMap];

  let _roundIndex = 0;
  let _roundStartTime = 0;
  let _roundOrder = [];
  let _totalScore = 0;
  let _roundResults = [];
  let _currentPrompt = null;

  let _tickInterval = null;
  let _countdownInterval = null;
  let _countdownValue = COUNTDOWN_S;

  function _emit(state, data) {
    _state = state;
    if (typeof onState === 'function') onState(state, data || {});
  }

  function _stopTick() {
    if (_tickInterval !== null) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }
  }

  function _stopCountdown() {
    if (_countdownInterval !== null) {
      clearInterval(_countdownInterval);
      _countdownInterval = null;
    }
  }

  function _elapsedS() {
    return (_now() - _roundStartTime) / 1000;
  }

  function _now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function _buildRoundOrder() {
    const indices = _puzzleMap.map((_, i) => i);
    const shuffled = _shuffle(indices);
    return shuffled.slice(0, ROUND_COUNT);
  }

  function _startTick() {
    _stopTick();
    _tickInterval = setInterval(() => {
      const elapsed = _elapsedS();
      const remaining = Math.max(0, ROUND_TIME_S - elapsed);
      const current = currentRoundScore(elapsed);
      if (typeof onTick === 'function') {
        onTick(elapsed, remaining, current);
      }
      if (elapsed >= ROUND_TIME_S) {
        _handleTimeout();
      }
    }, 250);
  }

  function _handleTimeout() {
    _stopTick();
    const elapsed = _elapsedS();
    const roundScore = scoreForTimeout();
    _recordRoundResult('timeout', elapsed, roundScore);
  }

  function _recordRoundResult(outcome, elapsedS, roundScore) {
    _totalScore += roundScore;
    const result = {
      round: _roundIndex + 1,
      prompt: _currentPrompt ? _currentPrompt.prompt : '',
      outcome,
      elapsedS: Math.round(elapsedS * 10) / 10,
      roundScore,
      runningTotal: _totalScore,
    };
    _roundResults.push(result);
    if (typeof onRoundResult === 'function') onRoundResult(result);
    _emit(STATES.ROUND_SUMMARY, { result });
  }

  function _startCountdown(callback) {
    _stopCountdown();
    _countdownValue = COUNTDOWN_S;
    _emit(STATES.COUNTDOWN, { countdown: _countdownValue });

    _countdownInterval = setInterval(() => {
      _countdownValue -= 1;
      if (_countdownValue <= 0) {
        _stopCountdown();
        callback();
      } else {
        _emit(STATES.COUNTDOWN, { countdown: _countdownValue });
      }
    }, 1000);
  }

  return {

    setPuzzleMap(arr) {
      _puzzleMap = [...arr];
    },

    getPuzzleMap() {
      return [..._puzzleMap];
    },

    getState() {
      return _state;
    },

    getTotalScore() {
      return _totalScore;
    },

    getRoundResults() {
      return [..._roundResults];
    },

    getCurrentRound() {
      return _roundIndex + 1;
    },

    getCurrentPrompt() {
      return _currentPrompt ? { ..._currentPrompt } : null;
    },

    start() {
      if (_state !== STATES.IDLE) return;
      if (_puzzleMap.length < ROUND_COUNT) {
        throw new Error(
          `Puzzle map has only ${_puzzleMap.length} entries; need at least ${ROUND_COUNT}.`
        );
      }
      _roundIndex = 0;
      _totalScore = 0;
      _roundResults = [];
      _roundOrder = _buildRoundOrder();
      _emit(STATES.TIPS);
    },

    beginPlay() {
      if (_state !== STATES.TIPS) return;
      _startCountdown(() => {
        _currentPrompt = _puzzleMap[_roundOrder[_roundIndex]];
        _emit(STATES.PROMPT, { prompt: _currentPrompt });
        setTimeout(() => {
          _roundStartTime = _now();
          _emit(STATES.PLAY, {
            round: _roundIndex + 1,
            totalRounds: ROUND_COUNT,
            prompt: _currentPrompt,
          });
          _startTick();
        }, 1500);
      });
    },

    found() {
      if (_state !== STATES.PLAY) return;
      _stopTick();
      const elapsed = _elapsedS();
      const roundScore = scoreForFind(elapsed);
      _recordRoundResult('found', elapsed, roundScore);
    },

    giveUp() {
      if (_state !== STATES.PLAY) return;
      _stopTick();
      const elapsed = _elapsedS();
      const roundScore = scoreForGiveUp(elapsed);
      _recordRoundResult('gave_up', elapsed, roundScore);
    },

    nextRound() {
      if (_state !== STATES.ROUND_SUMMARY) return;
      _roundIndex += 1;
      if (_roundIndex >= ROUND_COUNT) {
        _emit(STATES.FINAL_SUMMARY, {
          totalScore: _totalScore,
          rounds: [..._roundResults],
        });
        return;
      }
      _startCountdown(() => {
        _currentPrompt = _puzzleMap[_roundOrder[_roundIndex]];
        _emit(STATES.PROMPT, { prompt: _currentPrompt });
        setTimeout(() => {
          _roundStartTime = _now();
          _emit(STATES.PLAY, {
            round: _roundIndex + 1,
            totalRounds: ROUND_COUNT,
            prompt: _currentPrompt,
          });
          _startTick();
        }, 1500);
      });
    },

    restart() {
      if (_state !== STATES.FINAL_SUMMARY) return;
      this.reset();
    },

    reset() {
      _stopTick();
      _stopCountdown();
      _state = STATES.IDLE;
      _roundIndex = 0;
      _totalScore = 0;
      _roundResults = [];
      _currentPrompt = null;
      _roundOrder = [];
      _emit(STATES.IDLE);
    },
  };
}
