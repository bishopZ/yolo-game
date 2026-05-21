# macOS code signing — Yolo Game

Step-by-step guide to build a signed, notarized **standalone** Yolo Game `.app` / `.dmg` for GitHub Releases.

**Prerequisites:** Apple Developer account (paid), Apple Silicon Mac, Xcode Command Line Tools, Node 18+, **Python 3.10–3.12** (for `prepare:bundle` only — end users do not install Python).

---

## 1. Create a Developer ID Application certificate

1. Open [Apple Developer → Certificates](https://developer.apple.com/account/resources/certificates/list).
2. Click **+** → **Developer ID Application** → Continue.
3. Create a CSR in **Keychain Access** (Certificate Assistant → Request a Certificate From a Certificate Authority).
4. Upload the CSR, download the certificate, double-click to install in **login** keychain.
5. In Keychain Access, find **Developer ID Application: Your Name (TEAM_ID)** — note **TEAM_ID** for later.

---

## 2. App-specific password (notarization)

1. [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → **App-Specific Passwords**.
2. Generate a password labeled e.g. `electron-builder-notarize`.
3. Save it — you cannot view it again.

---

## 3. Local signing environment variables

In your shell profile or a `.env` file **never committed to git**:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

For signing only (no notarization yet), Keychain usually supplies the cert automatically if exactly one **Developer ID Application** cert exists.

Optional explicit cert (base64 `.p12`):

```bash
export CSC_LINK="/path/to/DeveloperID.p12"
export CSC_KEY_PASSWORD="p12-export-password"
```

---

## 4. Standalone bundle before packaging

`npm run pack` and `npm run dist` automatically run `scripts/prepare_bundle.sh`, which creates:

| Path | Contents |
|------|----------|
| `bundle/python/` | Embedded Python 3.10–3.12 venv with yolo-mlx + MLX (~240MB) |
| `bundle/models/yolo26n.npz` | On-device weights (~10MB) |

To build or refresh the bundle manually:

```bash
cd /path/to/yolo-game
bash scripts/prepare_bundle.sh
```

CI uses Python 3.12 from `actions/setup-python`. Local builds prefer `python3.12` when on PATH.

Weights are copied from `models/`, a sibling ComfyUI checkout, or downloaded from Ultralytics if missing. yolo-mlx installs from a local clone when found, otherwise from `git+https://github.com/thewebAI/yolo-mlx.git@main`.

electron-builder copies `bundle/` into the `.app` as `Contents/Resources/python` and `Contents/Resources/models`.

---

## 5. Build commands

From `repo/`:

```bash
npm install
npm run pack    # unsigned .app in dist/mac-arm64/ — smoke test
npm run dist    # signed (+ notarized if APPLE_* env set)
```

**Smoke test (unsigned):**

```bash
open dist/mac-arm64/Yolo\ Game.app
```

Allow camera when prompted. Wait for the model to warm up, play one round, and confirm a detection can score **Found**.

**Signed release:**

```bash
npm run dist
open dist/Yolo\ Game-*.dmg
```

Drag to Applications, open from `/Applications`, confirm Gatekeeper allows launch (notarized builds should open without right-click → Open).

---

## 6. Embedded Python in the packaged app

The signed app uses **`Contents/Resources/python/bin/python3`** by default. No system Python or pip steps are required for players.

Optional overrides (debugging / custom weights):

```bash
export YOLO_PYTHON="/path/to/.venv/bin/python3"
export YOLO_MODEL="/path/to/custom.npz"
open -a "Yolo Game"
```

From-source developers still use `.venv` + `models/` at the repo root for `npm start`; see README **Setup (from source)**.

---

## 7. GitHub Actions secrets

For CI releases on tag `v*`, add repository secrets:

| Secret | Value |
|--------|--------|
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password |
| `APPLE_TEAM_ID` | 10-character team ID |
| `CSC_LINK` | Base64-encoded `.p12` (optional if using keychain-only local builds) |
| `CSC_KEY_PASSWORD` | `.p12` export password |

The workflow sets up Python 3.12, runs `npm ci`, then `npm run dist` or `npm run pack` (which triggers `prepare:bundle`).

Without Apple secrets, the workflow uploads an **unsigned** `dist/mac-arm64/` artifact.

---

## 8. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Blank camera in packaged app | System Settings → Privacy → Camera → enable **Yolo Game**; reinstall after signing (TCC binds to bundle ID). |
| Gatekeeper blocks app | Use notarized `dist` build, or right-click → Open once. |
| `Model not found` | Re-run `bash scripts/prepare_bundle.sh` before `npm run dist`; confirm `bundle/models/yolo26n.npz` exists. |
| Subprocess exits immediately | Launch from Terminal to see stderr: `/Applications/Yolo\ Game.app/Contents/MacOS/Yolo\ Game`. For custom Python, set `YOLO_PYTHON`. |
| `prepare_bundle` fails on pip | Use Python 3.10–3.12 (`PYTHON_BIN=python3.12`). Ensure network for GitHub yolo-mlx clone in CI. |
| DMG huge (~300MB+) | Expected — MLX Metal + numpy + weights are bundled for standalone use. |

---

## 9. References

- [electron-builder — macOS](https://www.electron.build/configuration/mac)
- [electron-builder — code signing](https://www.electron.build/code-signing)
- README — **Download the Mac app (standalone)**
