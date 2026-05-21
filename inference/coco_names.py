"""
COCO 80-class names (0-indexed), standard YOLO / Ultralytics ordering.

yolo26mlx may expose result.names as placeholders (e.g. "class67") instead of
human-readable labels — use label_for_cls_id() to resolve friendly names.
"""

from __future__ import annotations

COCO_NAMES: tuple[str, ...] = (
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
)


def _names_lookup(names: object | None, cls_id: int) -> str | None:
    if names is None:
        return None
    if isinstance(names, dict):
        raw = names.get(cls_id)
        if raw is None:
            raw = names.get(str(cls_id))
        return str(raw) if raw is not None else None
    if isinstance(names, (list, tuple)) and 0 <= cls_id < len(names):
        return str(names[cls_id])
    return None


def label_for_cls_id(cls_id: int, names: object | None = None) -> str:
    """
    Resolve a detection class id to a friendly COCO label.

    Prefers model names when they are real strings (not "classN" placeholders).
    Falls back to COCO_NAMES[cls_id].
    """
    raw = _names_lookup(names, cls_id)
    if raw and not raw.startswith("class"):
        return raw
    if 0 <= cls_id < len(COCO_NAMES):
        return COCO_NAMES[cls_id]
    return raw if raw else f"class{cls_id}"
