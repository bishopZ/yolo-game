#!/usr/bin/env bash
# Build standalone resources for signed macOS releases:
#   bundle/python/  — relocatable venv (--copies) with yolo26mlx + numpy
#   bundle/models/  — yolo26n.npz (preferred) or yolo26n.pt
#
# Run from repo root before `npm run pack` or `npm run dist`.
# From-source dev can still use .venv + models/ at repo root (see README).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="${REPO_ROOT}/bundle"
PYTHON_DIR="${BUNDLE_DIR}/python"
MODELS_DIR="${BUNDLE_DIR}/models"
NPZ="${MODELS_DIR}/yolo26n.npz"
PT="${MODELS_DIR}/yolo26n.pt"
REQ="${REPO_ROOT}/inference/requirements.txt"
YOLO26_PT_URL="https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt"

is_zip_npz() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  local sig
  sig="$(dd if="$f" bs=1 count=2 2>/dev/null | xxd -p 2>/dev/null || true)"
  [[ "$sig" == "504b" ]]
}

ensure_weights() {
  mkdir -p "${MODELS_DIR}"

  if [[ -f "${NPZ}" ]] && is_zip_npz "${NPZ}"; then
    echo "Weights OK: ${NPZ}"
    return 0
  fi

  local -a sources=(
    "${REPO_ROOT}/models/yolo26n.npz"
    "${REPO_ROOT}/../../ComfyUI YOLO MLX node/comfyui/models/yolo/yolo26n.npz"
    "${REPO_ROOT}/../../ComfyUI YOLO MLX node/comfyui/models/models/yolo26n.npz"
    "${HOME}/git/yolo-mlx/models/yolo26n.npz"
    "${HOME}/git/thewebAI/yolo-mlx/models/yolo26n.npz"
  )
  for src in "${sources[@]}"; do
    if [[ -f "${src}" ]] && is_zip_npz "${src}"; then
      echo "Copying weights from ${src}"
      cp "${src}" "${NPZ}"
      echo "Installed weights: ${NPZ}"
      ls -lh "${NPZ}"
      return 0
    fi
  done

  if [[ -f "${REPO_ROOT}/scripts/setup_model.sh" ]]; then
    echo "Trying setup_model.sh …"
    if (cd "${REPO_ROOT}" && bash scripts/setup_model.sh); then
      if [[ -f "${REPO_ROOT}/models/yolo26n.npz" ]]; then
        cp "${REPO_ROOT}/models/yolo26n.npz" "${NPZ}"
        echo "Installed weights via setup_model: ${NPZ}"
        return 0
      fi
    fi
  fi

  if [[ ! -f "${PT}" ]]; then
    echo "Downloading yolo26n.pt …"
    curl -L --fail --progress-bar -o "${PT}" "${YOLO26_PT_URL}"
  fi

  if command -v yolo-mlx >/dev/null 2>&1; then
    echo "Converting ${PT} → ${NPZ} via yolo-mlx …"
    yolo-mlx converters convert "${PT}" -o "${NPZ}" --verify
    echo "Installed weights: ${NPZ}"
    return 0
  fi

  if [[ -f "${PT}" ]]; then
    echo "Using PyTorch weights (no converter): ${PT}"
    echo "  Runtime will load .pt via yolo26mlx."
    return 0
  fi

  echo "ERROR: could not obtain yolo26n weights." >&2
  exit 1
}

pick_python() {
  if [[ -n "${PYTHON_BIN:-}" && -x "${PYTHON_BIN}" ]]; then
    echo "${PYTHON_BIN}"
    return 0
  fi
  local candidate ver major minor
  for candidate in python3.12 python3.11 python3.10 python3; do
    if ! command -v "${candidate}" >/dev/null 2>&1; then
      continue
    fi
    ver="$("${candidate}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    major="${ver%%.*}"
    minor="${ver#*.}"
    if [[ "${major}" -eq 3 && "${minor}" -ge 10 && "${minor}" -le 12 ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  echo "ERROR: need Python 3.10–3.12 on PATH (MLX / yolo-mlx). Set PYTHON_BIN." >&2
  exit 1
}

find_yolo_mlx_root() {
  if [[ -n "${YOLO_MLX_ROOT:-}" && -f "${YOLO_MLX_ROOT}/pyproject.toml" ]]; then
    echo "${YOLO_MLX_ROOT}"
    return 0
  fi
  local candidate
  for candidate in \
    "${REPO_ROOT}/../../ComfyUI YOLO MLX node/repo" \
    "${REPO_ROOT}/../../YOLO26 MLX/repo" \
    "${REPO_ROOT}/../yolo-mlx" \
    "${REPO_ROOT}/../../yolo-mlx" \
    "${HOME}/git/yolo-mlx" \
    "${HOME}/git/thewebAI/yolo-mlx"
  do
    if [[ -f "${candidate}/pyproject.toml" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

ensure_python() {
  if [[ "$(uname -m)" != "arm64" ]]; then
    echo "ERROR: embedded MLX runtime must be built on Apple Silicon (arm64)." >&2
    exit 1
  fi

  if [[ -d "${PYTHON_DIR}/bin" && -x "${PYTHON_DIR}/bin/python3" ]]; then
    if "${PYTHON_DIR}/bin/python3" -c "import yolo26mlx, numpy" 2>/dev/null; then
      echo "Embedded Python OK: ${PYTHON_DIR}"
      return 0
    fi
    echo "Refreshing embedded Python (import check failed) …"
    rm -rf "${PYTHON_DIR}"
  fi

  local py_bin
  py_bin="$(pick_python)"
  echo "Using ${py_bin} ($(${py_bin} --version)) for embedded runtime …"

  mkdir -p "${BUNDLE_DIR}"
  echo "Creating embedded venv at ${PYTHON_DIR} …"
  "${py_bin}" -m venv --copies "${PYTHON_DIR}"
  "${PYTHON_DIR}/bin/pip" install --upgrade pip wheel

  # Non-editable install only — .pth pointers break inside a shipped .app on other machines.
  if yolo_root="$(find_yolo_mlx_root)"; then
    echo "Installing yolo-mlx (wheel) from ${yolo_root} …"
    "${PYTHON_DIR}/bin/pip" install "${yolo_root}"
  else
    echo "Installing yolo-mlx from GitHub (main) …"
    "${PYTHON_DIR}/bin/pip" install -r "${REQ}"
  fi

  echo "Verifying yolo26mlx …"
  "${PYTHON_DIR}/bin/python3" -c "from yolo26mlx import YOLO; import numpy; print('yolo26mlx', YOLO, 'numpy', numpy.__version__)"
}

smoke_load_model() {
  local model_arg="${NPZ}"
  if [[ ! -f "${model_arg}" ]] || ! is_zip_npz "${model_arg}"; then
    model_arg="${PT}"
  fi
  if [[ ! -f "${model_arg}" ]]; then
    echo "WARN: skipping model load smoke test (no weights file)"
    return 0
  fi
  echo "Smoke test: load ${model_arg} …"
  "${PYTHON_DIR}/bin/python3" -c "
from yolo26mlx import YOLO
m = YOLO('${model_arg}')
print('model load OK')
"
}

cd "${REPO_ROOT}"
ensure_weights
ensure_python
smoke_load_model
echo ""
echo "Bundle ready for electron-builder:"
echo "  ${PYTHON_DIR}"
echo "  ${MODELS_DIR}"
du -sh "${BUNDLE_DIR}" 2>/dev/null || true
