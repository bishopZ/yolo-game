/**
 * COCO 80-class names (0-indexed) — mirrors inference/coco_names.py.
 * Used to normalize "classN" placeholders from the model in the renderer.
 */

export const COCO_NAMES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
  'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
  'toothbrush',
];

const CLASS_NUM_RE = /^class(\d+)$/i;

/**
 * @param {string} label - Label from inference (may be "class67" or "cup")
 * @returns {string} Friendly COCO name when possible
 */
export const resolveLabel = (label) => {
  if (!label) return label;
  const m = CLASS_NUM_RE.exec(label.trim());
  if (!m) return label;
  const id = parseInt(m[1], 10);
  if (id >= 0 && id < COCO_NAMES.length) return COCO_NAMES[id];
  return label;
};

/**
 * @param {string[]} labels
 * @returns {string[]}
 */
export const resolveLabels = (labels) => (labels || []).map(resolveLabel);
