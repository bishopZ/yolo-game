/**
 * renderer/app.js — Yolo Game UI
 *
 * Wires the game state machine (game.js) to the DOM screens.
 * Handles:
 *   - Camera access and frame capture loop (5fps, ADR-YG-02)
 *   - Detection overlay (bounding boxes on play-canvas, AC-08)
 *   - All 8 game screens driven by onState callbacks
 *   - IPC calls to window.yoloIPC.detectFrame (from preload.cjs)
 *   - Inference ready/crash events
 *   - Share (Facebook, Bluesky, score image, copy text)
 *
 * ADR-YG-06: Vanilla JS (no build step). ESM imports.
 */

'use strict';

import { createGame, STATES, ROUND_COUNT } from './game.js';
import { resolveLabel, resolveLabels } from './coco_names.js';
import { createTicker } from './ticker.js';
import PUZZLE_MAP from './puzzle_map.json' with { type: 'json' };

const SHARE_REPO_URL =
  'https://github.com/bishopZ/yolo-game';
const SHARE_RELEASE_URL =
  'https://github.com/bishopZ/yolo-game/releases/latest';

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const screens = {
  home:         $('screen-home'),
  tips:         $('screen-tips'),
  countdown:    $('screen-countdown'),
  prompt:       $('screen-prompt'),
  play:         $('screen-play'),
  roundSummary: $('screen-round-summary'),
  finalSummary: $('screen-final-summary'),
};

const el = {
  reconnectBanner:  $('reconnect-banner'),
  warmingNote:      $('warming-note'),
  btnPlay:          $('btn-play'),
  btnBegin:         $('btn-begin'),
  cameraStatus:     $('camera-status'),
  countdownNum:     $('countdown-num'),
  promptRoundLabel: $('prompt-round-label'),
  promptDifficulty: $('prompt-difficulty'),
  promptTarget:     $('prompt-target'),
  promptHint:       $('prompt-hint'),
  playVideo:        $('play-video'),
  playCanvas:       $('play-canvas'),
  playFoundOverlay: $('play-found-overlay'),
  playPromptLabel:  $('play-prompt-label'),
  playTimer:        $('play-timer'),
  playScoreValue:   $('play-score-value'),
  playRoundLabel:   $('play-round-label'),
  btnGiveUp:        $('btn-give-up'),
  summaryIcon:      $('summary-icon'),
  summaryOutcome:   $('summary-outcome'),
  summaryPoints:    $('summary-points'),
  summaryRunning:   $('summary-running-total'),
  btnNextRound:     $('btn-next-round'),
  finalTotal:       $('final-total'),
  finalRounds:      $('final-rounds'),
  btnShareFacebook: $('btn-share-facebook'),
  btnShareBluesky:  $('btn-share-bluesky'),
  btnShareDownload: $('btn-share-download'),
  btnShareCopy:     $('btn-share-copy'),
  btnPlayAgain:     $('btn-play-again'),
  playTickerTrack:  $('play-ticker-track'),
  playTickerContainer: $('play-detection-ticker'),
};

const detectionTicker = createTicker({
  trackEl: el.playTickerTrack,
  containerEl: el.playTickerContainer,
});

// ── Camera / inference state ─────────────────────────────────────────────────

let _cameraStream = null;
let _inferenceReady = false;
let _frameInterval = null;
let _currentLabels = [];   // classes for the current target prompt
let _foundThisRound = false;
let _hasCompletedGame = false;
let _cameraError = null;
let _nearMissShown = false;
let _pulsePhase = 0;
let _lastShareFrame = null;

// Canvas 2D context for drawing detection overlay
let _overlayCtx = null;

const _puzzleClassSet = new Set(
  PUZZLE_MAP.flatMap(p => (p.classes || []).map(c => c.toLowerCase())),
);

const _prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let _foundAudio = null;
const playFoundSound = () => {
  if (_prefersReducedMotion()) return;
  try {
    if (!_foundAudio) {
      _foundAudio = new Audio('assets/found.wav');
      _foundAudio.volume = 0.55;
    }
    _foundAudio.currentTime = 0;
    void _foundAudio.play();
  } catch {
    /* optional asset */
  }
};

// ── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  const s = screens[name];
  if (s) s.classList.add('active');
}

// ── Game instance ─────────────────────────────────────────────────────────────

const game = createGame({
  puzzleMap: PUZZLE_MAP,

  onState(state, data) {
    switch (state) {
      case STATES.IDLE:          onIdle(); break;
      case STATES.TIPS:          onTips(); break;
      case STATES.COUNTDOWN:     onCountdown(data); break;
      case STATES.PROMPT:        onPrompt(data); break;
      case STATES.PLAY:          onPlay(data); break;
      case STATES.ROUND_SUMMARY: onRoundSummary(data); break;
      case STATES.FINAL_SUMMARY: onFinalSummary(data); break;
    }
  },

  onTick(elapsedS, remainingS, currentScore) {
    const secs = Math.ceil(remainingS);
    const mins = Math.floor(secs / 60);
    const s    = secs % 60;
    el.playTimer.textContent = `${mins}:${String(s).padStart(2, '0')}`;
    el.playTimer.classList.toggle('urgent', remainingS <= 10);
    el.playScoreValue.textContent = currentScore;
  },

  onRoundResult(_result) { /* handled by onRoundSummary */ },
});

// ── State handlers ────────────────────────────────────────────────────────────

function onIdle() {
  showScreen('home');
  el.btnPlay.textContent = _hasCompletedGame ? 'Play Again' : 'Play Now';
  el.btnNextRound.textContent = 'Next Round →';
}

async function onTips() {
  showScreen('tips');
  el.cameraStatus.textContent = '';
  el.btnBegin.disabled = false;
  _cameraError = null;
  await startCamera();
  updateCameraStatus();
}

function onCountdown({ countdown }) {
  showScreen('countdown');
  el.countdownNum.textContent = countdown;
}

function onPrompt({ prompt }) {
  showScreen('prompt');
  el.promptRoundLabel.textContent = `Round ${game.getCurrentRound()} of ${ROUND_COUNT}`;
  const tier = prompt.difficulty === 'hard' ? 'Hard' : 'Easy';
  el.promptDifficulty.textContent = tier;
  el.promptDifficulty.className = `prompt-difficulty prompt-difficulty--${prompt.difficulty || 'easy'}`;
  el.promptDifficulty.hidden = false;
  el.promptTarget.textContent = prompt.prompt.replace(/^Find\s+a?\s*/i, '');
  el.promptHint.textContent = prompt.hint || '';
  _currentLabels = prompt.classes || [];
  _foundThisRound = false;
  _nearMissShown = false;
}

async function onPlay({ round, totalRounds }) {
  showScreen('play');
  el.playRoundLabel.textContent = `Round ${round} of ${totalRounds}`;

  const prompt = game.getCurrentPrompt();
  el.playPromptLabel.textContent = prompt ? prompt.prompt : '—';
  _currentLabels = prompt ? (prompt.classes || []) : [];
  _foundThisRound = false;
  _nearMissShown = false;
  _pulsePhase = 0;
  el.playFoundOverlay.classList.remove('visible');

  resetTicker();
  detectionTicker.setTargetLabels(_currentLabels);
  await startCamera();
  startInferenceLoop();
  detectionTicker.start();
}

function onRoundSummary({ result }) {
  stopInferenceLoop();
  resetTicker();
  stopCamera();
  showScreen('roundSummary');

  el.btnNextRound.textContent =
    game.getCurrentRound() >= ROUND_COUNT ? 'Complete' : 'Next Round →';

  const ICONS    = { found: '✅', gave_up: '🏳', timeout: '⏰' };
  const LABELS   = { found: 'Found it!', gave_up: 'Gave Up', timeout: "Time's Up" };
  const CLASSES  = { found: 'found', gave_up: 'gave_up', timeout: 'timeout' };

  el.summaryIcon.textContent = ICONS[result.outcome] || '•';
  el.summaryOutcome.textContent = LABELS[result.outcome] || result.outcome;
  el.summaryOutcome.className = `summary-outcome-label ${CLASSES[result.outcome] || ''}`;

  const pts = result.roundScore;
  el.summaryPoints.textContent = pts >= 0 ? `+${pts}` : `${pts}`;
  el.summaryPoints.className = `summary-points ${pts > 0 ? 'positive' : pts < 0 ? 'negative' : 'zero'}`;
  el.summaryRunning.textContent = result.runningTotal;
}

function onFinalSummary({ totalScore, rounds }) {
  _hasCompletedGame = true;
  showScreen('finalSummary');
  el.finalTotal.textContent = totalScore;

  el.finalRounds.innerHTML = '';
  rounds.forEach(r => {
    const row = document.createElement('div');
    row.className = 'final-round-row';
    const sc = r.roundScore;
    row.innerHTML = `
      <span class="final-round-prompt">${r.prompt}</span>
      <span class="final-round-score ${sc > 0 ? 'pos' : sc < 0 ? 'neg' : 'zero'}">
        ${sc >= 0 ? '+' : ''}${sc}
      </span>`;
    el.finalRounds.appendChild(row);
  });
}

// ── Camera ────────────────────────────────────────────────────────────────────

async function startCamera() {
  if (_cameraStream) return true;
  try {
    _cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    el.playVideo.srcObject = _cameraStream;
    await el.playVideo.play();
    _cameraError = null;
    return true;
  } catch (err) {
    _cameraError = err.message || 'Camera access denied';
    console.warn('[app] camera error:', _cameraError);
    return false;
  }
}

function updateCameraStatus() {
  if (_cameraStream) {
    el.cameraStatus.textContent = '';
    el.btnBegin.disabled = false;
    return;
  }
  if (_cameraError) {
    el.cameraStatus.textContent =
      `Camera required: ${_cameraError}. Allow access in System Settings, then tap Begin again.`;
    el.btnBegin.disabled = true;
  }
}

function stopCamera() {
  if (_cameraStream) {
    _cameraStream.getTracks().forEach(t => t.stop());
    _cameraStream = null;
    el.playVideo.srcObject = null;
  }
}

// ── Inference loop ────────────────────────────────────────────────────────────

function startInferenceLoop() {
  if (_frameInterval) return;
  if (!_overlayCtx) {
    _overlayCtx = el.playCanvas.getContext('2d');
  }

  // Hidden capture canvas (not the overlay canvas)
  const captureCanvas = document.createElement('canvas');
  const captureCtx    = captureCanvas.getContext('2d');

  _frameInterval = setInterval(async () => {
    if (!_inferenceReady || _foundThisRound) return;
    if (el.playVideo.readyState < 2) return;

    // Capture and resize to 640×480 (ADR-YG-02)
    const W = 640, H = 480, C = 4;
    captureCanvas.width  = W;
    captureCanvas.height = H;
    captureCtx.drawImage(el.playVideo, 0, 0, W, H);
    const imageData = captureCtx.getImageData(0, 0, W, H);

    // Build header + payload (ADR-YG-01)
    const combined = new Uint8Array(12 + imageData.data.byteLength);
    const hView    = new DataView(combined.buffer, 0, 12);
    hView.setUint32(0, W, true);
    hView.setUint32(4, H, true);
    hView.setUint32(8, C, true);
    combined.set(new Uint8Array(imageData.data.buffer), 12);

    let result;
    try {
      result = await window.yoloIPC.detectFrame(combined.buffer);
    } catch {
      return; // subprocess not ready or dropped frame — ignore
    }

    if (!result || result.dropped || result.warming) return;

    const labels = resolveLabels(result.labels || []);
    result.labels = labels;

    if (result.found) {
      const scores = result.scores || [];
      const summary = labels.map((label, i) => {
        const pct = scores[i] != null ? `${Math.round(scores[i] * 100)}%` : '?';
        return `${label} (${pct})`;
      }).join(', ');
      console.log(`[yolo] ${summary || 'detection (no labels)'}`);
    }

    drawOverlay(result, W, H);
    feedTicker(labels);
    maybeNearMiss(labels);

    if (result.found && _currentLabels.length > 0) {
      const detected = labels.map(l => l.toLowerCase());
      const targets  = _currentLabels.map(l => l.toLowerCase());
      const hit = targets.some(t => detected.includes(t));
      if (hit && !_foundThisRound && game.getState() === STATES.PLAY) {
        _foundThisRound = true;
        captureShareFrame();
        playFoundSound();
        el.playFoundOverlay.classList.add('visible');
        setTimeout(() => {
          el.playFoundOverlay.classList.remove('visible');
          game.found();
        }, 600);
      }
    }
  }, 200); // ~5fps
}

function stopInferenceLoop() {
  if (_frameInterval) {
    clearInterval(_frameInterval);
    _frameInterval = null;
  }
  if (_overlayCtx) {
    _overlayCtx.clearRect(0, 0, el.playCanvas.width, el.playCanvas.height);
  }
}

function resetTicker() {
  detectionTicker.stop();
  detectionTicker.reset();
}

function feedTicker(labels) {
  detectionTicker.setExcludeLabels(_currentLabels);
  detectionTicker.setTargetLabels(_currentLabels);
  detectionTicker.addDetections(labels);
}

function maybeNearMiss(labels) {
  if (_nearMissShown || _foundThisRound) return;
  const targets = _currentLabels.map(l => l.toLowerCase());
  const hit = labels.some(l => targets.includes(l.toLowerCase()));
  if (hit) return;
  const near = labels.find(l => {
    const key = l.toLowerCase();
    return _puzzleClassSet.has(key) && !targets.includes(key);
  });
  if (!near) return;
  _nearMissShown = true;
  el.playPromptLabel.textContent = `Spotted ${near} — not this round's target`;
  el.playPromptLabel.classList.add('near-miss');
  setTimeout(() => {
    el.playPromptLabel.classList.remove('near-miss');
    const prompt = game.getCurrentPrompt();
    el.playPromptLabel.textContent = prompt ? prompt.prompt : '—';
  }, 2200);
}

function captureShareFrame() {
  const vw = el.playVideo.videoWidth;
  const vh = el.playVideo.videoHeight;
  if (!vw || !vh) return;
  const c = document.createElement('canvas');
  c.width = vw;
  c.height = vh;
  const ctx = c.getContext('2d');
  ctx.drawImage(el.playVideo, 0, 0, vw, vh);
  if (el.playCanvas.width > 0) {
    ctx.drawImage(el.playCanvas, 0, 0, el.playCanvas.width, el.playCanvas.height, 0, 0, vw, vh);
  }
  _lastShareFrame = c;
}

// ── Detection overlay ─────────────────────────────────────────────────────────

function drawOverlay(result, captureW, captureH) {
  // Sync canvas dimensions to video display size
  const vw = el.playVideo.offsetWidth;
  const vh = el.playVideo.offsetHeight;
  if (vw === 0 || vh === 0) return;

  el.playCanvas.width  = vw;
  el.playCanvas.height = vh;
  _overlayCtx.clearRect(0, 0, vw, vh);

  if (!result.boxes || result.boxes.length === 0) return;

  _pulsePhase += 0.22;
  const pulse = 0.65 + 0.35 * Math.sin(_pulsePhase);

  // Coordinate scale: capture → display
  const scaleX = vw / captureW;
  const scaleY = vh / captureH;

  result.boxes.forEach((box, i) => {
    const [x1, y1, x2, y2] = box;
    const label  = resolveLabel(result.labels[i] || '');
    if (label.toLowerCase() === 'person') return;

    const score  = result.scores[i] || 0;
    const isTarget = _currentLabels.map(l => l.toLowerCase()).includes(label.toLowerCase());

    const rx  = x1 * scaleX;
    const ry  = y1 * scaleY;
    const rw  = (x2 - x1) * scaleX;
    const rh  = (y2 - y1) * scaleY;

    _overlayCtx.globalAlpha = isTarget ? 1 : 0.35;
    _overlayCtx.strokeStyle = isTarget ? '#22c55e' : 'rgba(255,255,255,0.45)';
    _overlayCtx.lineWidth   = isTarget ? 2 + pulse * 2 : 1.5;
    if (isTarget) {
      _overlayCtx.shadowColor = '#22c55e';
      _overlayCtx.shadowBlur = 8 + pulse * 6;
    } else {
      _overlayCtx.shadowBlur = 0;
    }
    _overlayCtx.strokeRect(rx, ry, rw, rh);
    _overlayCtx.shadowBlur = 0;
    _overlayCtx.globalAlpha = 1;

    if (isTarget) {
      // Label pill
      const text = `${label} ${Math.round(score * 100)}%`;
      _overlayCtx.font = 'bold 13px -apple-system, sans-serif';
      const textW = _overlayCtx.measureText(text).width;
      const px = rx, py = ry - 6;
      _overlayCtx.fillStyle = '#22c55e';
      _overlayCtx.beginPath();
      _overlayCtx.roundRect(px - 2, py - 16, textW + 10, 20, 4);
      _overlayCtx.fill();
      _overlayCtx.fillStyle = '#000';
      _overlayCtx.fillText(text, px + 3, py - 2);
    }
  });
}

// ── Inference IPC events ──────────────────────────────────────────────────────

const applyInferenceReady = () => {
  _inferenceReady = true;
  el.warmingNote.textContent = '';
  el.warmingNote.classList.remove('error');
  el.btnPlay.disabled = false;
};

const showInferenceError = (message) => {
  _inferenceReady = false;
  el.btnPlay.disabled = true;
  el.warmingNote.textContent = message;
  el.warmingNote.classList.add('error');
  console.error('[app] inference error:', message);
};

if (window.yoloIPC) {
  window.yoloIPC.onInferenceReady(applyInferenceReady);
  window.yoloIPC.onInferenceError(showInferenceError);

  window.yoloIPC.onSubprocessCrash((code) => {
    _inferenceReady = false;
    el.btnPlay.disabled = true;
    el.reconnectBanner.classList.add('visible');
    console.warn('[app] inference subprocess crashed, code:', code);
    setTimeout(() => el.reconnectBanner.classList.remove('visible'), 5000);
  });

  // Model may become ready before this module registers onInferenceReady.
  void window.yoloIPC.getInferenceReady().then(ready => {
    if (ready) applyInferenceReady();
  });
} else {
  // Running outside Electron (e.g. browser test) — disable IPC
  console.warn('[app] window.yoloIPC not available — running in mock mode');
  _inferenceReady = false;
  el.warmingNote.textContent = '(No inference — running in browser)';
}

// ── Button handlers ───────────────────────────────────────────────────────────

el.btnPlay.addEventListener('click', () => {
  game.start();
});

el.btnBegin.addEventListener('click', async () => {
  if (!_cameraStream) {
    const ok = await startCamera();
    updateCameraStatus();
    if (!ok) return;
  }
  game.beginPlay();
});

el.btnGiveUp.addEventListener('click', () => {
  if (game.getState() === STATES.PLAY) {
    stopInferenceLoop();
    stopCamera();
    game.giveUp();
  }
});

el.btnNextRound.addEventListener('click', () => {
  game.nextRound();
});

el.btnPlayAgain.addEventListener('click', () => {
  game.restart();
});

const buildShareMessage = () => {
  const score = game.getTotalScore();
  return (
    `I scored ${score} points in Yolo Game — a real-world scavenger hunt on YOLO26 MLX (on-device, no cloud). ` +
    `Play: ${SHARE_RELEASE_URL} · Code: ${SHARE_REPO_URL} #YOLOMLX #WebAI`
  );
};

const buildShareCardCanvas = () => {
  const w = 1200;
  const h = 630;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  if (_lastShareFrame) {
    const fw = _lastShareFrame.width;
    const fh = _lastShareFrame.height;
    const scale = Math.min((w - 80) / fw, (h - 200) / fh);
    const dw = fw * scale;
    const dh = fh * scale;
    const dx = (w - dw) / 2;
    const dy = 48;
    ctx.drawImage(_lastShareFrame, dx, dy, dw, dh);
  }

  ctx.fillStyle = '#f0f0f0';
  ctx.font = 'bold 52px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('YOLO GAME', w / 2, h - 120);
  ctx.font = '36px -apple-system, sans-serif';
  ctx.fillStyle = '#22c55e';
  ctx.fillText(`${game.getTotalScore()} points`, w / 2, h - 68);
  ctx.font = '18px -apple-system, sans-serif';
  ctx.fillStyle = '#888';
  ctx.fillText('Getting people back into the physical world', w / 2, h - 32);
  return c;
};

const flashShareButton = (btn, okLabel, defaultLabel) => {
  btn.textContent = okLabel;
  setTimeout(() => { btn.textContent = defaultLabel; }, 2000);
};

el.btnShareFacebook.addEventListener('click', () => {
  const u = encodeURIComponent(SHARE_REPO_URL);
  window.open(`https://www.facebook.com/sharer/sharer.php?u=${u}`, '_blank', 'noopener');
});

el.btnShareBluesky.addEventListener('click', () => {
  const text = encodeURIComponent(buildShareMessage());
  window.open(`https://bsky.app/intent/compose?text=${text}`, '_blank', 'noopener');
});

el.btnShareDownload.addEventListener('click', () => {
  const c = buildShareCardCanvas();
  const link = document.createElement('a');
  link.download = `yolo-game-score-${game.getTotalScore()}.png`;
  link.href = c.toDataURL('image/png');
  link.click();
  flashShareButton(el.btnShareDownload, 'Saved!', 'Save image');
});

el.btnShareCopy.addEventListener('click', async () => {
  const text = buildShareMessage();
  const c = buildShareCardCanvas();
  try {
    if (navigator.clipboard?.write) {
      const blob = await new Promise(res => c.toBlob(res, 'image/png'));
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'image/png': blob,
        }),
      ]);
      flashShareButton(el.btnShareCopy, 'Copied!', 'Copy text');
      return;
    }
  } catch {
    /* fall through */
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    flashShareButton(el.btnShareCopy, 'Copied!', 'Copy text');
  }
});

// ── Initial state: disable Play until inference is ready ──────────────────────

// If running inside Electron, inference is warming up; wait for onInferenceReady.
// If outside Electron (mock mode), enable anyway for UI testing.
el.btnPlay.disabled = !!window.yoloIPC;
