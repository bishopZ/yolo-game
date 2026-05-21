/**
 * main.cjs — Yolo Game Electron main process
 *
 * Responsibilities:
 *   1. Launch a Python inference subprocess on app start (ADR-YG-04: warmup before game)
 *   2. Accept detectFrame IPC calls from the renderer
 *   3. Serialize frames to the subprocess stdin (ADR-YG-01: raw RGBA ArrayBuffer)
 *   4. Read JSON detection lines from subprocess stdout (ADR-YG-03)
 *   5. Relay results back to the renderer as Promise resolutions
 *   6. Detect subprocess crashes and notify the renderer (ADR-YG-05)
 *
 * IPC protocol with Python subprocess:
 *   STDIN per frame: 12-byte header (width u32le, height u32le, channels u32le) + payload
 *   STDOUT per frame: one JSON line {"found":bool,"boxes":...,"labels":...,"scores":...}
 *   First STDOUT line: {"ready":true} — subprocess signals warmup complete
 *
 * ADR-YG-05: Distribute as `npm start` — no signed .app required.
 *
 * CommonJS entry: Electron 42 / Node 24 cannot load the electron runtime API via ESM imports.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

const PYTHON = process.env.YOLO_PYTHON || 'python3';
// Resolved at module load (see resolveModelPath)
const SERVER_SCRIPT = path.join(__dirname, 'inference', 'server.py');
const CONF = process.env.YOLO_CONF || '0.25';

const SETUP_HINT =
  'See README Setup step 4: convert yolo26n.pt to models/yolo26n.npz with yolo-mlx converters.';

// ── Model path helpers ────────────────────────────────────────────────────────

const isZipFile = (filePath) => {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4b; // PK (zip / npz)
  } catch {
    return false;
  }
};

const resolveModelPath = () => {
  if (process.env.YOLO_MODEL) return process.env.YOLO_MODEL;

  const npz = path.join(__dirname, 'models', 'yolo26n.npz');
  const pt = path.join(__dirname, 'models', 'yolo26n.pt');

  if (fs.existsSync(npz) && isZipFile(npz)) return npz;
  if (fs.existsSync(pt)) return pt;
  if (fs.existsSync(npz)) return npz; // let Python report invalid NPZ
  return npz;
};

const MODEL_PATH_RESOLVED = resolveModelPath();

const validateModelBeforeSpawn = () => {
  if (!fs.existsSync(MODEL_PATH_RESOLVED)) {
    return `Model not found at ${MODEL_PATH_RESOLVED}. ${SETUP_HINT}`;
  }
  if (
    MODEL_PATH_RESOLVED.endsWith('.npz') &&
    !isZipFile(MODEL_PATH_RESOLVED) &&
    !fs.existsSync(path.join(__dirname, 'models', 'yolo26n.pt'))
  ) {
    return (
      `${MODEL_PATH_RESOLVED} is not a valid .npz archive (often a misnamed .pt file). ${SETUP_HINT}`
    );
  }
  return null;
};

// ── State ─────────────────────────────────────────────────────────────────────

let _win = null;
let _proc = null;           // Python subprocess
let _inferenceReady = false; // true after subprocess signals {"ready":true}
let _pendingResolve = null;  // resolve() for the in-flight detectFrame call
let _pendingReject = null;   // reject() for the in-flight detectFrame call
let _lineBuffer = '';        // partial line buffer for stdout

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  _win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // required for contextBridge module imports
    },
    titleBarStyle: 'default',
    title: 'Yolo Game',
  });

  _win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Re-emit ready after the renderer loads (module script may register listeners late).
  _win.webContents.on('did-finish-load', () => {
    if (_inferenceReady && _win) {
      _win.webContents.send('inference-ready');
    }
  });

  _win.on('closed', () => {
    _win = null;
  });
}

// ── Python subprocess ─────────────────────────────────────────────────────────

function _notifyInferenceError(message) {
  console.error('[main] inference setup error:', message);
  _inferenceReady = false;
  if (_win) _win.webContents.send('inference-error', message);
}

function startInferenceSubprocess() {
  const preflight = validateModelBeforeSpawn();
  if (preflight) {
    _notifyInferenceError(preflight);
    return;
  }

  console.log(
    `[main] spawning inference subprocess: ${PYTHON} ${SERVER_SCRIPT} --model ${MODEL_PATH_RESOLVED}`,
  );

  _proc = spawn(PYTHON, [SERVER_SCRIPT, '--model', MODEL_PATH_RESOLVED, '--conf', CONF], {
    stdio: ['pipe', 'pipe', 'inherit'], // stdin+stdout piped; stderr to console
  });

  // Read stdout line by line
  _proc.stdout.setEncoding('utf8');
  _proc.stdout.on('data', (chunk) => {
    _lineBuffer += chunk;
    let newlineIdx;
    while ((newlineIdx = _lineBuffer.indexOf('\n')) !== -1) {
      const line = _lineBuffer.slice(0, newlineIdx).trim();
      _lineBuffer = _lineBuffer.slice(newlineIdx + 1);
      if (line) _handleSubprocessLine(line);
    }
  });

  _proc.on('close', (code) => {
    console.warn(`[main] inference subprocess exited with code ${code}`);
    _inferenceReady = false;
    _rejectPending({ error: `subprocess exited with code ${code}` });
    if (_win) {
      _win.webContents.send('subprocess-crash', code);
      if (code !== 0 && !_inferenceReady) {
        _win.webContents.send(
          'inference-error',
          `Inference exited with code ${code}. Check the terminal for details. ${SETUP_HINT}`,
        );
      }
    }
    _proc = null;
  });

  _proc.on('error', (err) => {
    console.error('[main] failed to spawn inference subprocess:', err.message);
    console.error('[main] make sure Python is on PATH and yolo26mlx is installed in your venv.');
    _rejectPending({ error: err.message });
  });
}

function _handleSubprocessLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    console.warn('[main] unparseable subprocess line:', line);
    return;
  }

  // Ready signal (first message after warmup)
  if (obj.ready === true) {
    _inferenceReady = true;
    console.log('[main] inference subprocess ready');
    if (_win) _win.webContents.send('inference-ready');
    return;
  }

  // Error from subprocess
  if (obj.error) {
    console.error('[main] subprocess error:', obj.error);
    _rejectPending(obj);
    if (_win) _win.webContents.send('inference-error', obj.error);
    return;
  }

  // Normal detection result
  if (_pendingResolve) {
    _pendingResolve(obj);
    _pendingResolve = null;
    _pendingReject = null;
  }
}

function _rejectPending(err) {
  if (_pendingReject) {
    _pendingReject(err);
    _pendingResolve = null;
    _pendingReject = null;
  }
}

// ── IPC handler ───────────────────────────────────────────────────────────────

/**
 * detectFrame: receive raw RGBA ArrayBuffer from renderer, forward to subprocess,
 * return detection JSON to renderer.
 *
 * The renderer sends frames at ~5fps (ADR-YG-02). We queue at most one in-flight
 * frame at a time — if the renderer sends faster, earlier frames are dropped.
 */
ipcMain.handle('get-inference-ready', () => _inferenceReady);

ipcMain.handle('detect-frame', async (_event, arrayBuffer) => {
  if (!_proc || !_inferenceReady) {
    return { found: false, boxes: [], labels: [], scores: [], warming: true };
  }

  // Drop previous pending frame (frame rate > inference rate → drop)
  if (_pendingResolve) {
    _rejectPending({ dropped: true });
  }

  return new Promise((resolve, reject) => {
    _pendingResolve = resolve;
    _pendingReject = reject;

    // Write header + payload to subprocess stdin (ADR-YG-01)
    const buf = Buffer.from(arrayBuffer);
    // We expect the renderer to have already sized the frame correctly (ADR-YG-02).
    // Infer width/height from buffer size: channels=4 (RGBA), 640×480 default.
    // The renderer must prepend the 12-byte header itself (width u32le, height u32le, channels u32le).
    // If the buffer already has a header (first 12 bytes), pass it straight through.
    _proc.stdin.write(buf);
  });
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startInferenceSubprocess();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Kill inference subprocess cleanly
  if (_proc) {
    _proc.stdin.end();
    _proc.kill();
    _proc = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
