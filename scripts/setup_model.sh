#!/usr/bin/env bash
# Download yolo26n.pt and convert to MLX npz weights for Yolo Game.
# Run from repo root with your Python venv active.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODELS_DIR="${REPO_ROOT}/models"
NPZ="${MODELS_DIR}/yolo26n.npz"
PT="${MODELS_DIR}/yolo26n.pt"

YOLO_MLX_ROOT="${YOLO_MLX_ROOT:-}"

if [[ -z "${YOLO_MLX_ROOT}" ]]; then
  for candidate in \
    "${REPO_ROOT}/../yolo-mlx" \
    "${REPO_ROOT}/../../yolo-mlx" \
    "${HOME}/git/yolo-mlx" \
    "${HOME}/git/thewebAI/yolo-mlx"
  do
    if [[ -f "${candidate}/scripts/download_yolo26_models.sh" ]]; then
      YOLO_MLX_ROOT="${candidate}"
      break
    fi
  done
fi

if [[ -z "${YOLO_MLX_ROOT}" || ! -f "${YOLO_MLX_ROOT}/scripts/download_yolo26_models.sh" ]]; then
  echo "ERROR: yolo-mlx repo not found." >&2
  echo "Clone https://github.com/thewebAI/yolo-mlx and set YOLO_MLX_ROOT, e.g.:" >&2
  echo "  export YOLO_MLX_ROOT=/path/to/yolo-mlx" >&2
  exit 1
fi

mkdir -p "${MODELS_DIR}"

echo "Using yolo-mlx at: ${YOLO_MLX_ROOT}"
(
  cd "${YOLO_MLX_ROOT}"
  bash scripts/download_yolo26_models.sh
  yolo-mlx converters convert models/yolo26n.pt -o models/yolo26n.npz --verify
)

cp "${YOLO_MLX_ROOT}/models/yolo26n.npz" "${NPZ}"
echo "Installed weights: ${NPZ}"
ls -lh "${NPZ}"
