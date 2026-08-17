# 🛠 MediaOtter — Install & Build

## Requirements

- **macOS** (Apple Silicon or Intel) or Windows 10/11
- **Adobe Premiere Pro 2021+** or **Adobe After Effects 2021+**
- Adobe Creative Cloud desktop app (for the host apps to accept the extension)

## Quick start (users)

### 1. Fetch the binaries

MediaOtter bundles its own yt-dlp, ffmpeg and Deno — nothing to install system-wide:

```bash
node scripts/download-binaries.js          # fetches for YOUR platform
# or, when packaging for everything:
node scripts/download-binaries.js --all
```

Pins and SHA-256 hashes land in `extension/binaries/release.json`.

### 2. Install the extension (macOS)

```bash
./scripts/install-mac.sh
```

This copies the panel to `~/Library/Application Support/Adobe/CEP/extensions/MediaOtter`
(no admin rights needed). Windows: copy the `extension/` folder to
`%APPDATA%\Adobe\CEP\extensions\MediaOtter\`.

### 3. Enable unsigned extensions (one-time)

Because MediaOtter is open source and not signed by Adobe:

- **macOS**: open Terminal and run:
  ```bash
  defaults write com.adobe.CSXS.10 PlayerDebugMode 1
  ```
- **Windows**: create the registry key
  `HKEY_CURRENT_USER\Software\Adobe\CSXS.10` → `PlayerDebugMode` = `1` (DWORD).

Then fully **quit and restart** Premiere Pro / After Effects.

### 4. First run

- In Premiere Pro: **Window → Extensions → MediaOtter**
- In After Effects: **Window → Extensions → MediaOtter**

Optional: set up your own YouTube credentials for playlist browsing —
see [CREDENTIALS.md](CREDENTIALS.md).

---

## Build (for contributors / packagers)

```bash
# 1. fetch runtime binaries (all platforms)
node scripts/download-binaries.js --all

# 2. (packagers only) inject maintainer credentials — NEVER commits these
export MF_GOOGLE_CLIENT_ID="…"
export MF_GOOGLE_API_KEY="…"
node scripts/inject-credentials.js

# 3. package the .zxp
node scripts/build-zxp.js            # → dist/mediaotter-1.0.0.zxp

# 4. dev-install
./scripts/install-mac.sh
```

### Validation before shipping

```bash
node scripts/validate.js             # syntax checks, manifest lint, secret scan
MEDIAOTTER_TEST_DIR=/tmp/otter-test node scripts/engine-test.js   # live engine test
```

## Platform notes

| Component | macOS | Windows |
|---|---|---|
| yt-dlp | bundled standalone binary (`yt-dlp_macos`) | `yt-dlp.exe` |
| ffmpeg | static build (arm64 / x64) | static build (x64) |
| Deno (PO-token JS runtime) | bundled | bundled |
| Python | not needed (standalone yt-dlp) | not needed |
| Install dir | `~/Library/Application Support/Adobe/CEP/extensions/MediaOtter` | `%APPDATA%\Adobe\CEP\extensions\MediaOtter` |

## Troubleshooting

- **"Sign in to confirm you're not a bot"**: turn on **YouTube browser session**
  in Settings (uses your browser's cookies) — this is the fix for age-restricted
  or bot-flagged content.
- **Panel doesn't appear**: verify `PlayerDebugMode` (step 3), restart the app,
  and check the extension shows under Window → Extensions.
- **Downloads fail with HTTP 4xx**: check `~/.mediaotter/logs/mediaotter.log`,
  then try the browser session setting.
- **4K shows VP9/AV1**: enable *Allow encoding to H.264* in Settings to get a
  Premiere-max-compatible H.264 file (slower, but plays anywhere).
