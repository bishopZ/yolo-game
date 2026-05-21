/**
 * game.js — Yolo Game state machine and scoring engine
 *
 * Manages the full game loop:
 *   idle → tips → countdown → prompt → play → round_summary
 *   → (loop for ROUND_COUNT rounds) → final_summary → idle
 *
 * Scoring per round (AC-07):
 *   - Score starts at MAX_ROUND_SCORE (100) and decays linearly to 0 at ROUND_TIME_S (60s)
 *   - Timeout: negative points (TIMEOUT_PENALTY, default -10)
 *   - Give Up at time t_remaining: floor(t_remaining / ROUND_TIME_S * MAX_ROUND_SCORE * GIVE_UP_FRACTION)
 *     = ~15% of the remaining score at tap time
 *
 * Usage:
 *   import { createGame } from './game.js';
 *
 *   const game = createGame({ onState, onTick, onRoundResult });
 *   game.start();       // idle → tips
 *   game.beginPlay();   // tips → countdown (3-2-1) → play
 *   game.found();       // play → round_summary (object found)
 *   game.giveUp();      // play → round_summary (gave up)
 *   game.nextRound();   // round_summary → (next round or final_summary)
 *   game.restart();     // final_summary → idle
 *   game.reset();       // any state → idle
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────

/** Number of rounds per game session. */
export const ROUND_COUNT = 5;

/** Seconds allowed per round. */
export const ROUND_TIME_S = 60;

/** Maximum score achievable by finding instantly. */
export const MAX_ROUND_SCORE = 100;

/** Penalty applied when timer reaches 0 without finding the object. */
export const TIMEOUT_PENALTY = -10;

/**
 * Give Up multiplier: score = floor(remaining_score * GIVE_UP_FRACTION).
 * At 30s remaining, score = floor(50 * 0.15) = 7.
 */
export const GIVE_UP_FRACTION = 0.15;

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
 * Compute the score for finding the object at elapsed seconds into the round.
 * Score decays linearly from MAX_ROUND_SCORE at t=0 to 0 at t=ROUND_TIME_S.
 *
 * @param {number} elapsedS - Seconds elapsed when the object was found.
 * @returns {number} Integer score ≥ 0.
 */
export function scoreForFind(elapsedS) {
  const remaining = Math.max(0, ROUND_TIME_S - elapsedS);
  return Math.floor((remaining / ROUND_TIME_S) * MAX_ROUND_SCORE);
}

/**
 * Compute the Give Up score at the moment the player taps Give Up.
 *
 * @param {number} elapsedS - Seconds elapsed when Give Up was tapped.
 * @returns {number} Integer score ≥ 0.
 */
export function scoreForGiveUp(elapsedS) {
  const remainingScore = Math.max(0, scoreForFind(elapsedS));
  return Math.floor(remainingScore * GIVE_UP_FRACTION);
}

/**
 * Score for a timeout (timer reached 0).
 * @returns {number} TIMEOUT_PENALTY (negative).
 */
export function scoreForTimeout() {
  return TIMEOUT_PENALTY;
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
 * @property {number}       roundScore   - Points earned this round (may be negative)
 * @property {number}       runningTotal - Cumulative score after this round
 */

// ── Game factory ───────────────────────────────────────────────────────────

/**
 * Create a new game instance.
 *
 * @param {Object} options
 * @param {(state: GameState, data?: Object) => void} options.onState
 *   Called every time the state changes. `data` carries state-specific info
 *   (e.g. countdown value, current prompt, round results).
 * @param {(elapsedS: number, remainingS: number, currentScore: number) => void} [options.onTick]
 *   Called roughly every second during PLAY state.
 * @param {(result: RoundResult) => void} [options.onRoundResult]
 *   Called when a round ends (before state transitions to round_summary).
 * @param {Object[]} [options.puzzleMap]
 *   Array of {prompt, classes, hint} objects. If omitted, must be loaded
 *   externally via game.setPuzzleMap(arr).
 * @returns {Object} Game controller with public methods.
 */
export function createGame({ onState, onTick, onRoundResult, puzzleMap = [] } = {}) {

  // ── Private state ──────────────────────────────────────────────────────

  let _state = STATES.IDLE;
  let _puzzleMap = [...puzzleMap];

  // Round tracking
  let _roundIndex = 0;        // 0-indexed current round
  let _roundStartTime = 0;    // performance.now() or Date.now() at round start
  let _roundOrder = [];       // shuffled indices into _puzzleMap
  let _totalScore = 0;
  let _roundResults = [];     // RoundResult[]
  let _currentPrompt = null;  // {prompt, classes, hint}

  // Timers
  let _tickInterval = null;
  let _countdownInterval = null;
  let _countdownValue = COUNTDOWN_S;

  // ── Internal helpers ───────────────────────────────────────────────────

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
    // Use at most ROUND_COUNT prompts, shuffled
    const indices = _puzzleMap.map((_, i) => i);
    const shuffled = _shuffle(indices);
    return shuffled.slice(0, ROUND_COUNT);
  }

  function _startTick() {
    _stopTick();
    _tickInterval = setInterval(() => {
      const elapsed = _elapsedS();
      const remaining = Math.max(0, ROUND_TIME_S - elapsed);
      const current = Math.max(0, scoreForFind(elapsed));
      if (typeof onTick === 'function') {
        onTick(elapsed, remaining, current);
      }
      if (elapsed >= ROUND_TIME_S) {
        _handleTimeout();
      }
    }, 250); // tick 4× per second for smooth score decay
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

  // ── Public API ─────────────────────────────────────────────────────────

  return {

    /** Replace or set the puzzle map after creation. */
    setPuzzleMap(arr) {
      _puzzleMap = [...arr];
    },

    /** Current puzzle map (read-only copy). */
    getPuzzleMap() {
      return [..._puzzleMap];
    },

    /** Current game state. */
    getState() {
      return _state;
    },

    /** Total score so far. */
    getTotalScore() {
      return _totalScore;
    },

    /** All round results so far. */
    getRoundResults() {
      return [..._roundResults];
    },

    /** Current round number (1-indexed). */
    getCurrentRound() {
      return _roundIndex + 1;
    },

    /** Current prompt object ({prompt, classes, hint}) or null. */
    getCurrentPrompt() {
      return _currentPrompt ? { ..._currentPrompt } : null;
    },

    /**
     * Start the game from idle state.
     * idle → tips
     */
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

    /**
     * Player taps "Begin" on tips screen.
     * tips → countdown → play
     */
    beginPlay() {
      if (_state !== STATES.TIPS) return;
      _startCountdown(() => {
        // Transition: countdown → prompt → play
        _currentPrompt = _puzzleMap[_roundOrder[_roundIndex]];
        _emit(STATES.PROMPT, { prompt: _currentPrompt });
        // Brief pause so player reads the prompt, then auto-advance to PLAY
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

    /**
     * Called by the detection layer when the target object is found.
     * play → round_summary
     */
    found() {
      if (_state !== STATES.PLAY) return;
      _stopTick();
      const elapsed = _elapsedS();
      const roundScore = scoreForFind(elapsed);
      _recordRoundResult('found', elapsed, roundScore);
    },

    /**
     * Player taps "Give Up".
     * play → round_summary
     */
    giveUp() {
      if (_state !== STATES.PLAY) return;
      _stopTick();
      const elapsed = _elapsedS();
      const roundScore = scoreForGiveUp(elapsed);
      _recordRoundResult('gave_up', elapsed, roundScore);
    },

    /**
     * Player taps "Next Round" from round summary.
     * round_summary → (countdown → play) or final_summary
     */
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
      // tips already seen — go straight to countdown
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

    /**
     * Player taps "Play Again" from final summary.
     * final_summary → idle
     */
    restart() {
      if (_state !== STATES.FINAL_SUMMARY) return;
      this.reset();
    },

    /**
     * Reset to idle from any state (emergency / back-button).
     */
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
