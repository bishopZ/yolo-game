"""
inference/server.py
────────────────────
Yolo Game — Python inference subprocess

Reads raw RGBA camera frames from stdin, runs yolo26n detection via MLX,
and writes one JSON result per frame to stdout.

IPC protocol (ADR-YG-01, ADR-YG-03):
  STDIN per frame:
    Header: 12 bytes — width (4 bytes LE uint32), height (4 bytes LE uint32),
            channels (4 bytes LE uint32)
    Payload: width × height × channels bytes (raw RGBA uint8)

  STDOUT per frame:
    One line of JSON, newline-terminated:
    {"found": true, "boxes": [[x1,y1,x2,y2], ...], "labels": ["cup", ...],
     "scores": [0.87, ...]}
    or {"found": false, "boxes": [], "labels": [], "scores": []}

  STDERR: startup/error messages only (not read by main process in normal flow)

Model warmup (ADR-YG-04):
  On startup, the model is loaded and a blank frame is inferred to trigger
  MLX JIT compilation before any game rounds begin.

Usage:
  python inference/server.py [--model models/yolo26n.npz] [--conf 0.5]

The script stays running until stdin closes (Electron main process exits).
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
import zipfile
from pathlib import Path

import numpy as np

from coco_names import label_for_cls_id

try:
    from yolo26mlx import YOLO as YOLO26
except ImportError as exc:
    print(
        json.dumps({"error": f"yolo26mlx not installed: {exc}"}),
        flush=True,
    )
    sys.exit(1)


# ── CLI ──────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Yolo Game inference subprocess")
    p.add_argument(
        "--model",
        default="models/yolo26n.npz",
        help="Path to .npz yolo26mlx weights (default: models/yolo26n.npz)",
    )
    p.add_argument(
        "--conf",
        type=float,
        default=0.1,
        help="Confidence threshold (default: 0.1)",
    )
    return p.parse_args()


# ── Model path validation ─────────────────────────────────────────────────────

_SETUP_HINT = (
    "See README Setup step 4: download yolo26n.pt, then run "
    "'yolo-mlx converters convert models/yolo26n.pt -o models/yolo26n.npz --verify' "
    "and copy models/yolo26n.npz into this repo."
)


def _resolve_model_path(model_path: str) -> str:
    """
    Resolve a usable weights path.

    - Missing file: try sibling .pt when .npz was requested.
    - Invalid .npz (not a zip archive): use sibling .pt if present (common mistake:
      copying or renaming the PyTorch checkpoint).
    """
    path = Path(model_path)
    if not path.is_absolute():
        path = Path.cwd() / path

    if not path.exists():
        pt_fallback = path.with_suffix(".pt")
        if pt_fallback.exists():
            print(
                f"[server] {path} not found; using {pt_fallback}",
                file=sys.stderr,
                flush=True,
            )
            return str(pt_fallback)
        raise FileNotFoundError(f"Model not found: {path}. {_SETUP_HINT}")

    if path.suffix.lower() == ".npz" and not zipfile.is_zipfile(path):
        pt_fallback = path.with_suffix(".pt")
        if pt_fallback.exists():
            print(
                f"[server] {path} is not a valid NPZ archive; loading {pt_fallback} instead",
                file=sys.stderr,
                flush=True,
            )
            return str(pt_fallback)
        raise ValueError(
            f"{path} is not a valid MLX .npz weights file (expected a zip archive). "
            f"If you have PyTorch weights, place yolo26n.pt next to it or re-convert. {_SETUP_HINT}"
        )

    return str(path)


def _emit_fatal(error: str) -> None:
    """Write a JSON error line so the Electron main process can show it in the UI."""
    _emit({"error": error})
    print(f"[server] FATAL: {error}", file=sys.stderr, flush=True)


# ── Model loading & warmup ───────────────────────────────────────────────────

def _load_and_warm(model_path: str, conf: float) -> "YOLO26":
    """Load model and run a blank-frame warmup to trigger MLX JIT."""
    print(f"[server] loading model: {model_path}", file=sys.stderr, flush=True)
    t0 = time.perf_counter()
    model = YOLO26(model_path)
    elapsed = time.perf_counter() - t0
    print(f"[server] model loaded in {elapsed:.2f}s", file=sys.stderr, flush=True)

    # Warmup: blank RGB frame (640×640×3 uint8 zeros) — triggers JIT compilation
    print("[server] warming up (JIT compile) …", file=sys.stderr, flush=True)
    t1 = time.perf_counter()
    blank = np.zeros((640, 640, 3), dtype=np.uint8)
    model.predict(blank, conf=conf, imgsz=640)
    warmup_ms = (time.perf_counter() - t1) * 1000
    print(f"[server] warmup done in {warmup_ms:.0f}ms", file=sys.stderr, flush=True)

    # Signal readiness to main process via a "ready" JSON line
    _emit({"ready": True})
    return model


# ── I/O helpers ──────────────────────────────────────────────────────────────

def _read_exact(n: int) -> bytes | None:
    """Read exactly n bytes from stdin. Returns None on EOF."""
    buf = b""
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return None  # EOF
        buf += chunk
    return buf


def _read_frame() -> tuple[np.ndarray, int, int] | None:
    """
    Read one frame from stdin.

    Returns:
        (rgb_array, width, height) where rgb_array is uint8 HWC (H×W×3), or
        None on EOF.
    """
    header = _read_exact(12)
    if header is None:
        return None

    width, height, channels = struct.unpack("<III", header)
    payload_size = width * height * channels
    payload = _read_exact(payload_size)
    if payload is None:
        return None

    # Reshape RGBA → drop alpha → RGB
    rgba = np.frombuffer(payload, dtype=np.uint8).reshape((height, width, channels))
    rgb = rgba[:, :, :3]  # drop alpha channel
    return rgb, width, height


def _emit(obj: dict) -> None:
    """Write one JSON line to stdout, flush immediately."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


# ── Detection ────────────────────────────────────────────────────────────────

def _detect(
    model: "YOLO26",
    frame: np.ndarray,
    conf: float,
    imgsz: int = 640,
) -> dict:
    """
    Run YOLO26 on frame and return a JSON-serialisable result dict.

    Args:
        model:  loaded YOLO26 instance
        frame:  HWC uint8 RGB numpy array
        conf:   confidence threshold
        imgsz:  inference size (frame already at inference size in normal flow)

    Returns:
        {"found": bool, "boxes": [[x1,y1,x2,y2],...], "labels": [...],
         "scores": [...]}
    """
    results = model.predict(frame, conf=conf, imgsz=imgsz)

    boxes: list[list[float]] = []
    labels: list[str] = []
    scores: list[float] = []

    for result in results:
        if result.boxes is None or len(result.boxes) == 0:
            continue
        # result.boxes.xyxy: tensor [N, 4] — x1 y1 x2 y2
        # result.boxes.conf: tensor [N]
        # result.names: dict[int, str]
        for i in range(len(result.boxes)):
            box = result.boxes.xyxy[i].tolist()
            score = float(result.boxes.conf[i])
            cls_id = int(result.boxes.cls[i])
            label = label_for_cls_id(cls_id, result.names)
            boxes.append([round(v, 1) for v in box])
            labels.append(label)
            scores.append(round(score, 3))

    return {
        "found": len(boxes) > 0,
        "boxes": boxes,
        "labels": labels,
        "scores": scores,
    }


# ── Main loop ────────────────────────────────────────────────────────────────

def main() -> None:
    args = _parse_args()

    # Use binary mode for stdin, text mode for stdout
    if hasattr(sys.stdin, "buffer"):
        pass  # already have binary access via sys.stdin.buffer

    try:
        resolved = _resolve_model_path(args.model)
    except (FileNotFoundError, ValueError) as exc:
        _emit_fatal(str(exc))
        sys.exit(1)

    try:
        model = _load_and_warm(resolved, args.conf)
    except Exception as exc:
        _emit_fatal(f"Failed to load model: {exc}")
        sys.exit(1)
    print("[server] ready — listening for frames", file=sys.stderr, flush=True)

    while True:
        frame_data = _read_frame()
        if frame_data is None:
            print("[server] stdin closed — exiting", file=sys.stderr, flush=True)
            break

        rgb, width, height = frame_data
        result = _detect(model, rgb, args.conf)
        _emit(result)


if __name__ == "__main__":
    main()
