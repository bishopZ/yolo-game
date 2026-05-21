"""
scripts/detect_test.py
───────────────────────
Standalone YOLO26 detection test — no Electron, no IPC.
Runs yolo26n directly on an image file and prints detections.

Verifies AC-04: yolo26n detects at least one test object at conf ≥ 0.5.

Usage (from repo root, with .venv active and weights converted):
    python scripts/detect_test.py images/test.jpg
    python scripts/detect_test.py images/test.jpg --conf 0.25
    python scripts/detect_test.py images/test.jpg --model models/yolo26n.npz

Place a test image at images/test.jpg, or provide any image path.
Point camera at a cup, laptop, book, chair, person, or bottle for a quick test.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Standalone YOLO26 detection test")
    p.add_argument("image", help="Path to a test image (JPEG, PNG, etc.)")
    p.add_argument("--model", default="models/yolo26n.npz")
    p.add_argument("--conf", type=float, default=0.5)
    return p.parse_args()


# Test classes used in AC-04 (all common household objects in COCO)
AC04_CLASSES = {"bottle", "cup", "book", "laptop", "chair", "person"}


def main() -> None:
    args = _parse_args()
    repo_root = Path(__file__).resolve().parent.parent

    image_path = Path(args.image)
    if not image_path.exists():
        print(f"ERROR: image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    model_path = repo_root / args.model
    if not model_path.exists():
        print(f"ERROR: model not found: {model_path}", file=sys.stderr)
        print("Run: bash scripts/download_yolo26_models.sh && yolo-mlx converters convert ...", file=sys.stderr)
        sys.exit(1)

    try:
        from yolo26mlx import YOLO as YOLO26
    except ImportError as e:
        print(f"ERROR: yolo26mlx not installed: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading model: {model_path}")
    model = YOLO26(str(model_path))

    print(f"Running inference on: {image_path}  (conf={args.conf})")
    results = model.predict(str(image_path), conf=args.conf)

    print()
    print("── Detections ──────────────────────────────────")
    total_detections = 0
    ac04_detections = []

    for result in results:
        if result.boxes is None or len(result.boxes) == 0:
            continue
        for i in range(len(result.boxes)):
            box = result.boxes.xyxy[i].tolist()
            score = float(result.boxes.conf[i])
            cls_id = int(result.boxes.cls[i])
            label = result.names.get(cls_id, str(cls_id))
            total_detections += 1
            ac04_flag = " ← AC-04" if label in AC04_CLASSES else ""
            print(f"  [{i+1:2d}] {label:<15s}  conf={score:.3f}  box={[round(v,1) for v in box]}{ac04_flag}")
            if label in AC04_CLASSES:
                ac04_detections.append(label)

    if total_detections == 0:
        print("  (no detections)")

    print("─" * 49)
    print(f"  Total detections: {total_detections}")
    print(f"  AC-04 classes detected: {ac04_detections or '(none)'}")
    print()

    # AC-04 check
    ac04_pass = len(ac04_detections) >= 1
    print(f"AC-04 (≥1 detection from {{bottle,cup,book,laptop,chair,person}} at conf≥{args.conf}): "
          f"{'PASS' if ac04_pass else 'FAIL'}")

    if not ac04_pass:
        print()
        print("Tip: Point camera at a cup, laptop, book, chair, or person in normal lighting.")
        print(f"     Or lower --conf (currently {args.conf}).")
        sys.exit(1)


if __name__ == "__main__":
    main()
