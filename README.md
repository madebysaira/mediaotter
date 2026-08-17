# 🦦 MediaOtter

**Search & download video/audio straight into Premiere Pro and After Effects.**

MediaOtter is an open-source Adobe CEP panel that puts a friendly YouTube search —
plus **any** of yt-dlp's 1000+ supported sites via a pasted URL — directly inside
your NLE. Pick a result, choose the quality, download, and it lands in your project
bin as a **Premiere-ready MP4 (H.264/AAC)** or **WAV (PCM 48 kHz)**.

Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg, bundled and pinned —
nothing to install system-wide. Free, no accounts, **no telemetry**.

## ✨ Features

- 🔎 **YouTube search with live suggestions** — type-ahead autocomplete as you type
- ▶️ **In-panel preview** — watch before you download (custom player overlay)
- 🎬 **Video download** — muxed MP4 H.264/AAC preferred; 4K/2K/1080p/720p caps;
  optional **transcode to H.264** when only VP9/AV1 exists
- 🎧 **Audio download** — WAV PCM 48 kHz stereo, born Premiere-ready
- ✂️ **Download just a section** — pick a start/end range, get only what you need
- 🌐 **Any site by URL** — Vimeo, SoundCloud, Twitch, TikTok, X/Twitter, archive.org,
  and 1000+ more through yt-dlp
- 📥 **One-click import** — downloads auto-import into a **MediaOtter** bin;
  drag history items straight onto your timeline
- 👤 **Your YouTube account** — optional sign-in (bring-your-own Google
  credentials) to browse **your playlists, likes and subscriptions**; browser-cookie
  session for private / age-restricted downloads
- 🎨 **Premium dark UI** — glassmorphism, Poppins, real-time progress
  (percent / speed / ETA / size)
- 🔄 **Self-updating yt-dlp** — SHA-256-verified updates so extractors stay fresh

## ⚠️ Please use responsibly

MediaOtter is a download tool. Only download content you own or have permission to
use, and respect each platform's terms of service and copyright.

## 📦 Install (macOS first, Windows supported)

```bash
node scripts/download-binaries.js   # fetch pinned yt-dlp/ffmpeg/deno
./scripts/install-mac.sh            # → ~/Library/Application Support/Adobe/CEP/extensions/MediaOtter
defaults write com.adobe.CSXS.10 PlayerDebugMode 1   # one-time (unsigned panel)
```

Restart Premiere Pro / After Effects → **Window → Extensions → MediaOtter**.

Full build & platform notes: **[docs/INSTALL.md](docs/INSTALL.md)**

## 🔑 Credentials & privacy

- Open-source users bring their **own free Google Cloud credentials** (5 min setup):
  **[docs/CREDENTIALS.md](docs/CREDENTIALS.md)**
- Nothing sensitive is ever committed: `credentials.json`, tokens and history are
  gitignored or stored in `~/.mediaotter/` with 0600 permissions.
- Packaged builds inject the maintainer's credentials **at build time via env vars**,
  never from the repo.

## 🧱 Architecture

```
extension/
├── CSXS/manifest.xml      # CEP 10, hosts: PPRO 14+ & AEFT 18+
├── index.html             # panel UI (search / paste / preview / downloads / settings)
├── css/main.css           # premium dark theme (light mode included)
├── js/
│   ├── app.js             # panel controller
│   ├── csbridge.js        # CSInterface ↔ ExtendScript bridge
│   ├── downloader.js      # yt-dlp engine: search, suggestions, metadata, download
│   ├── quality.js         # format/compat planner (H.264 first, merge, transcode)
│   ├── binary-manager.js  # bundled runtimes + SHA-256-verified yt-dlp auto-update
│   ├── cookie-jar.js      # browser-session cookies for yt-dlp
│   ├── auth.js            # Google OAuth (PKCE loopback — no client secret)
│   ├── playlists.js       # YouTube Data API: playlists / likes
│   ├── settings.js / history.js / logger.js / util.js
├── jsx/hostscript.jsx     # ExtendScript: import into bin, add to timeline (PPRO+AEFT)
└── lib/                   # CSInterface.js, bundled fonts (offline)
scripts/
├── download-binaries.js   # fetch + SHA-256-pin yt-dlp/ffmpeg/deno per platform
├── build-zxp.js           # package dist/mediaotter-<ver>.zxp
├── inject-credentials.js  # env → gitignored credentials.json (refuses placeholders)
├── install-mac.sh         # dev install into the CEP extensions folder
├── validate.js            # syntax + manifest + secret-scan gates
└── engine-test.js         # live integration test (search→download→verify)
```

## 🧪 Status

Engine proven live: search (scrape + continuation), suggestions, metadata,
WAV audio download, MP4 video download, section-range trimming, and generic-site
URLs all pass an end-to-end integration test.

## 📄 License

[MIT](LICENSE) — use it, fork it, ship it.
