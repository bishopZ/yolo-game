/**
 * preload.cjs — Yolo Game contextBridge
 *
 * Exposes the minimal IPC surface to the renderer:
 *   window.yoloIPC.detectFrame(arrayBuffer) → Promise<DetectionResult>
 *   window.yoloIPC.onInferenceReady(callback) — fires once when Python subprocess is warm
 *   window.yoloIPC.onSubprocessCrash(callback) — fires if Python dies unexpectedly
 *
 * DetectionResult:
 *   { found: boolean, boxes: [[x1,y1,x2,y2],...], labels: string[], scores: number[] }
 *   or { error: string } on crash/timeout
 *
 * ADR-YG-01: frames are passed as ArrayBuffer (Transferable) — no base64 overhead.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yoloIPC', {
  /**
   * Send one camera frame for inference.
   * @param {ArrayBuffer} arrayBuffer — raw RGBA bytes (ADR-YG-02: 640×480 or 640×640)
   * @returns {Promise<DetectionResult>}
   */
  detectFrame(arrayBuffer) {
    return ipcRenderer.invoke('detect-frame', arrayBuffer);
  },

  /**
   * Register a callback for when the Python subprocess is loaded and warm.
   * Fires once after app launch when the model is ready for frames.
   * @param {() => void} callback
   */
  onInferenceReady(callback) {
    ipcRenderer.on('inference-ready', () => callback());
  },

  /**
   * Whether the Python subprocess has finished warmup (handles ready-before-listener race).
   * @returns {Promise<boolean>}
   */
  getInferenceReady() {
    return ipcRenderer.invoke('get-inference-ready');
  },

  /**
   * Register a callback for Python subprocess crashes.
   * The renderer should show a "reconnecting…" UI and stop sending frames.
   * @param {(code: number|null) => void} callback
   */
  onSubprocessCrash(callback) {
    ipcRenderer.on('subprocess-crash', (_event, code) => callback(code));
  },

  /**
   * Model missing, invalid weights, or load failure before warmup completes.
   * @param {(message: string) => void} callback
   */
  onInferenceError(callback) {
    ipcRenderer.on('inference-error', (_event, message) => callback(message));
  },
});
