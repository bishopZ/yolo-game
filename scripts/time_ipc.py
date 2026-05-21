"""
scripts/time_ipc.py
────────────────────
Measures the end-to-end IPC round-trip latency for the Yolo Game inference
subprocess: synthetic frame → stdin → Python inference → JSON result → stdout.

Verifies AC-03: round-trip ≤ 200ms at 640×480 on Bishop's Apple Silicon.

Usage (from repo root, with .venv active and weights at models/yolo26n.npz):
    python scripts/time_ipc.py
    python scripts/time_ipc.py --model models/yolo26n.npz --iterations 20
    python scripts/time_ipc.py --width 640 --height 640

Output example:
    Yolo Game IPC round-trip latency
    Chip: Apple M4 Pro | Python 3.11.0 | platform: macOS-15.0
    Width: 640 | Height: 480 | Channels: 4 | Iterations: 10
    ─────────────────────────────────────────────
    Iteration  1:   48.2 ms
    Iteration  2:   12.3 ms
    ...
    ─────────────────────────────────────────────
    p50:   13.1 ms
    p95:   18.4 ms
    min:   11.9 ms
    max:   48.2 ms (first call includes JIT; see p50/p95 for steady-state)
    ─────────────────────────────────────────────
    AC-03 (p95 ≤ 200ms): PASS
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import struct
import subprocess
import sys
import time
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Yolo Game IPC round-trip timer")
    p.add_argument("--model", default="models/yolo26n.npz")
    p.add_argument("--conf", type=float, default=0.5)
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--iterations", type=int, default=10)
    return p.parse_args()


def _make_frame(width: int, height: int, channels: int = 4) -> bytes:
    """Create a synthetic RGBA frame (all mid-grey) for timing."""
    header = struct.pack("<III", width, height, channels)
    payload = bytes([128] * (width * height * channels))
    return header + payload


def _chip_info() -> str:
    try:
        import subprocess as sp
        result = sp.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=2,
        )
        return result.stdout.strip() or platform.processor()
    except Exception:
        return platform.processor()


def main() -> None:
    args = _parse_args()
    repo_root = Path(__file__).resolve().parent.parent
    server_script = repo_root / "inference" / "server.py"

    if not server_script.exists():
        print(f"ERROR: server.py not found at {server_script}", file=sys.stderr)
        sys.exit(1)

    model_path = str(repo_root / args.model)
    if not Path(model_path).exists():
        print(f"ERROR: model not found at {model_path}", file=sys.stderr)
        print("Run: bash scripts/download_yolo26_models.sh && yolo-mlx converters convert ...", file=sys.stderr)
        sys.exit(1)

    # Spawn inference subprocess
    proc = subprocess.Popen(
        [sys.executable, str(server_script), "--model", model_path, "--conf", str(args.conf)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for "ready" signal
    print("Waiting for model to load and warm up …", flush=True)
    ready_line = proc.stdout.readline()
    try:
        ready = json.loads(ready_line)
        if ready.get("error"):
            print(f"Server error: {ready['error']}")
            sys.exit(1)
        if not ready.get("ready"):
            print(f"Unexpected first message: {ready_line}")
    except json.JSONDecodeError:
        print(f"Could not parse ready message: {ready_line!r}")
        sys.exit(1)

    frame = _make_frame(args.width, args.height)
    latencies: list[float] = []

    print()
    print("Yolo Game IPC round-trip latency")
    print(f"Chip: {_chip_info()} | Python {platform.python_version()} | {platform.system()}-{platform.release()}")
    print(f"Width: {args.width} | Height: {args.height} | Channels: 4 | Iterations: {args.iterations}")
    print("─" * 45)

    for i in range(args.iterations):
        t0 = time.perf_counter()
        proc.stdin.write(frame)
        proc.stdin.flush()
        line = proc.stdout.readline()
        elapsed_ms = (time.perf_counter() - t0) * 1000
        latencies.append(elapsed_ms)

        try:
            result = json.loads(line)
            status = f"found={result.get('found')}, n_boxes={len(result.get('boxes', []))}"
        except json.JSONDecodeError:
            status = f"parse error: {line!r}"

        print(f"  Iteration {i+1:2d}:  {elapsed_ms:6.1f} ms  ({status})")

    proc.stdin.close()
    proc.wait()

    latencies_sorted = sorted(latencies)
    n = len(latencies_sorted)
    p50 = latencies_sorted[n // 2]
    p95 = latencies_sorted[int(n * 0.95)]
    min_lat = latencies_sorted[0]
    max_lat = latencies_sorted[-1]

    print("─" * 45)
    print(f"  p50:  {p50:6.1f} ms")
    print(f"  p95:  {p95:6.1f} ms")
    print(f"  min:  {min_lat:6.1f} ms")
    print(f"  max:  {max_lat:6.1f} ms  (first call may include JIT; see p50/p95)")
    print("─" * 45)

    threshold = 200.0
    ac03_pass = p95 <= threshold
    print(f"  AC-03 (p95 ≤ {threshold:.0f}ms): {'PASS' if ac03_pass else 'FAIL'}")
    print()

    if not ac03_pass:
        print("FAIL: p95 exceeds 200ms. See ADR-YG-01 mitigations:")
        print("  - Reduce frame size (ADR-YG-02): try --width 320 --height 320")
        print("  - Consider Unix domain socket instead of stdin/stdout")
        sys.exit(1)


if __name__ == "__main__":
    main()
