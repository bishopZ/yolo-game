# Yolo Game

**Getting people back into the physical world**, one object at a time.

Most games keep you seated, staring at a screen. Yolo Game does the opposite. It gives you a prompt, starts a 2-minute countdown, and sends you sprinting through your house to hold a real object up to the camera before time runs out. YOLO26 MLX runs entirely on your Apple Silicon Mac, no cloud, no latency, recognizing objects as fast as you can find them.

---

## What it is

A local-first scavenger hunt game powered by [YOLO26 MLX](https://github.com/thewebAI/yolo-mlx) on-device object detection.

- **5 rounds per session** - rounds 1–3 use **easy** household prompts; rounds 4–5 ramp to **hard**. Each round starts a 2-minute timer and activates your camera.
- **Find it fast** - score decays linearly from 100 to 0 over 2 minutes. Finding the object scores 2× the current HUD value.
- **Tap Give Up** to collect a share of remaining score - the share grows as time passes, so there's a sweet spot around the halfway mark.
- **Run out the clock** and you score 0 for that round.
- Works best on a Mac where you can move around -hold the laptop and walk room to room, or prop it up and run back with objects.

Built for the **[WebAI YOLO26 MLX Build Challenge](https://community.webai.com/t/the-yolo26-mlx-build-challenge-may-2026/16)** - Austin-flavored track.

---

## Requirements

- **Apple Silicon Mac** (M1, M2, M3, or M4) - MLX requires Apple Silicon
- **macOS 13+**
- **Python 3.10+**
- **Node.js 18+**
- **npm 9+**

---

## Download the Mac app (standalone - no terminal)

Pre-built **Apple Silicon** releases include the game, **yolo26n** weights, and an embedded Python/MLX runtime. No Homebrew, venv, or manual model download required.

**[Latest release (DMG)](https://github.com/bishopZ/yolo-game/releases/download/v1.0.0/Yolo.Game-1.0.0-arm64.dmg)**

1. Open the DMG and drag **Yolo Game** to Applications.
2. Launch the app; allow **camera** access when macOS prompts.
3. Wait for “Loading inference model…” to finish (~5-10s first launch), then tap **Play Now**.

**Requirements:** Apple Silicon Mac (M1–M4), macOS 13+.

### Build a standalone DMG yourself

From `repo/` on an Apple Silicon Mac with Python 3.10–3.12:

```bash
npm install
npm run dist    # runs prepare:bundle, then electron-builder (signed if APPLE_* env set)
npm run pack    # unsigned .app in dist/mac-arm64/ for smoke tests
```

`scripts/prepare_bundle.sh` creates `bundle/python` (embedded venv) and `bundle/models/yolo26n.npz` before packaging. See **[docs/macos-code-signing.md](docs/macos-code-signing.md)** for signing and notarization.

---

## Setup (from source - developers)

Use this path if you are hacking on the game or running `npm start` without a release DMG. The **signed DMG** does not need these steps.

### 1. Clone the repo

```bash
git clone https://github.com/bishopZ/yolo-game.git
cd yolo-game
```

### 2. Install Node dependencies

```bash
npm install
```

> **Electron binary:** Electron 42+ downloads its runtime on the **first** `npm start` (not during `npm install`). The first launch may take a minute while the binary is fetched.
>
> **Cursor / VS Code:** Some editors set `ELECTRON_RUN_AS_NODE=1`, which breaks `require('electron')`. The `start` script unsets that variable automatically on macOS/Linux.

### 3. Set up the Python inference environment

```bash
# Python 3.10–3.12 recommended (MLX / yolo-mlx)
python3.12 -m venv .venv
source .venv/bin/activate

# Install yolo-mlx from GitHub (or pip install -e /path/to/yolo-mlx clone)
pip install -r inference/requirements.txt
```

> **Note:** Requires Apple Silicon. `requirements.txt` installs [yolo-mlx](https://github.com/thewebAI/yolo-mlx) from GitHub. Override the interpreter with `YOLO_PYTHON` when launching the app.

### 4. Download and convert the yolo26n weights

**Quick path** (if you have a local [yolo-mlx](https://github.com/thewebAI/yolo-mlx) clone):

```bash
export YOLO_MLX_ROOT=/path/to/yolo-mlx   # optional if auto-detected
bash scripts/setup_model.sh
```

**Manual path** - from the yolo-mlx repo root:

```bash
bash scripts/download_yolo26_models.sh
yolo-mlx converters convert models/yolo26n.pt -o models/yolo26n.npz --verify
```

Copy (or symlink) the resulting `yolo26n.npz` into this repo:

```bash
mkdir -p models
cp /path/to/yolo-mlx/models/yolo26n.npz models/
```

The game expects weights at `models/yolo26n.npz` relative to the repo root. The file must be a real NPZ zip archive (typically ~6MB). If you only have `yolo26n.pt`, place it at `models/yolo26n.pt` - the game can load `.pt` directly, or convert it with the command above.

### 5. Run the game

Activate your Python venv, then:

```bash
source .venv/bin/activate
npm start
```

The app launches an Electron window. The model loads and warms up in the background (JIT compile on first inference - typically 5-10 seconds on M-series). The **Play Now** button activates once the model is ready.

> **Camera permission:** macOS may prompt for camera access. Click Allow.

---

## How it works

```
Renderer (Electron web view)
  └─ Canvas grabs 640×480 RGBA frame from <video>
  └─ ArrayBuffer → contextBridge → Electron main process
        └─ Raw bytes → Python subprocess stdin
              └─ numpy.frombuffer → RGB → yolo26n.predict()
              └─ JSON detection line → stdout
        └─ Result relayed back to renderer
  └─ Bounding boxes drawn on overlay canvas
  └─ If detected label matches target prompt → round scored
```

Inference runs at ~5fps. Camera preview runs at native frame rate. Only the detection overlay updates at inference speed.

**Model:** `yolo26n` - the smallest YOLO26 variant, ~6MB NPZ, 5.9ms inference on M4 Pro. COCO class vocabulary (80 classes) maps to the [puzzle map](renderer/puzzle_map.json) of 33 household-findable prompts.

---

## Extending with custom puzzles

### Path A - COCO classes only (stay in this repo)

Edit `[renderer/puzzle_map.json](renderer/puzzle_map.json)`. Each entry:


| Field        | Purpose                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `prompt`     | Shown to the player (e.g. `"Find a cup or mug"`)                                              |
| `classes`    | One or more [COCO-80](https://github.com/thewebAI/yolo-mlx) class names the detector must see |
| `hint`       | Optional tip on the prompt screen                                                             |
| `difficulty` | `"easy"` or `"hard"` — sessions use 3 easy prompts then 2 hard                                |


Reload the game (`npm start` or restart the app). No rebuild required.

### Path B - Custom classes beyond COCO-80

You leave the JSON-only path and train or fine-tune a model that emits **new** class labels, then point the Python subprocess at those weights.

**Prerequisites**

- Apple Silicon Mac, macOS 13+
- Python 3.10+ venv with `yolo26mlx` (same as Setup §3)
- Local clone of [yolo-mlx](https://github.com/thewebAI/yolo-mlx) and weights tooling
- Labeled images for your new classes (or a workflow that produces them)
- Comfort with WebAI’s **Infernace** / fine-tune flow (not shipped inside this game)

**Process (headline steps)**

1. **Train or obtain weights** - Use upstream YOLO26 MLX + Infernace docs to add detection heads for your classes and export a compatible `.npz` / `.pt`.
2. **Install weights** - Place the file under `models/` (or set `YOLO_MODEL` when launching).
3. **Wire inference** - Ensure `inference/server.py` loads your variant; adjust env vars documented in Setup if needed.
4. **Map prompts** - Add `puzzle_map.json` entries whose `classes` strings **exactly match** the labels your model returns.
5. **Play-test** - Run at home; tune `YOLO_CONF` if finds are too strict or loose.

Full training commands, dataset formats, and Infernace UI steps live in upstream docs. Do not duplicate them here:

- [YOLO26 MLX (yolo-mlx)](https://github.com/thewebAI/yolo-mlx)
- [WebAI community — YOLO26 MLX challenge & Infernace](https://community.webai.com)

If you modify `inference/server.py` or bundle custom weights, AGPL-3.0 applies to what you distribute - see [LICENSE](LICENSE).

---

## Project structure

```
yolo-game/
├── main.cjs                 Electron main process (subprocess spawn, IPC)
├── preload.cjs              contextBridge API surface (CJS for Electron 42 / Node 24)
├── package.json
├── inference/
│   ├── server.py            Python inference subprocess (stdin/stdout IPC)
│   └── requirements.txt
├── scripts/
│   ├── time_ipc.py          Round-trip latency benchmark (verifies AC-03)
│   └── detect_test.py       Standalone detection test (verifies AC-04)
├── renderer/
│   ├── index.html           Main game UI
│   ├── app.js               UI logic (state machine subscriber)
│   ├── styles.css           Mobile-first responsive styles
│   ├── game.js              State machine + scoring engine
│   ├── puzzle_map.json      33 household prompts → COCO class names
│   ├── test.html            IPC smoke-test page (dev use)
│   └── tests/
│       ├── scoring.test.js  Scoring unit tests (AC-07)
│       └── state.test.js    State machine unit tests
└── models/                  .gitignored — place yolo26n.npz here
```

---

## License

[AGPL-3.0](LICENSE) - required by the WebAI challenge terms. See `LICENSE` for full text.

---

## Credits

- [YOLO26 MLX](https://github.com/thewebAI/yolo-mlx) - upstream inference library by WebAI
- Built by [Bishop Zareh](https://bishopz.com) for the WebAI YOLO26 MLX Build Challenge, May 2026

