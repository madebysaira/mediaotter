# MediaOtter

Search, preview, download and import media into Premiere Pro through an open-source Adobe CEP panel. The 1.1.0 repair adds reliable download verification, honest import results, and search recommendations.

## Workflow

- Search YouTube videos or playlists with autocomplete, editor-oriented starter searches, and recent searches saved on your computer.
- Paste a supported media URL. YouTube uses its embedded player; other sites show metadata and a link to preview at the source.
- Choose an available video resolution or audio, optionally choose a start/end section, and download.
- Video is inspected and normalized to MP4 H.264/AAC; audio becomes WAV PCM 16-bit, 48 kHz, stereo. Exact format IDs and output inspection enforce the selected resolution limit.
- Completed media imports into a MediaOtter project bin. Failed imports remain visible and can be retried. History items can be revealed or dragged into Premiere.
- Optional Google sign-in supports your playlists and likes with your own Google desktop OAuth configuration. Browser cookies are optional and off by default.

Recommendations are starter searches and your recent queries. They do not analyze your project or use an AI recommendation service.

## Install and verify

See [installation instructions](docs/INSTALL.md) for the offline developer ZIP, source installation and signed ZXP distribution. A developer ZIP is unsigned; renaming a ZIP to `.zxp` does not sign it.

```sh
npm run binaries
npm run check
npm run test:integration
npm run install:mac
npm run build:zxp
```

Node 14+ is required for contributor scripts, not for the packaged Mac installer. yt-dlp, FFmpeg, FFprobe and Deno are bundled. Do not run the website release installer until its corresponding release assets have been uploaded.

## Verification status

The repair was exercised on macOS Apple Silicon: real YouTube video and playlist search, autocomplete, continuation and metadata; generated local media downloaded through real yt-dlp; MP4/WAV conversion, section duration, VP9/Opus normalization, resolution limits and cancellation. Regression tests also check host import failures, duplicate import avoidance, unsaved projects and ExtendScript bridge failures using a host model.

See [repair notes](docs/REPAIR-NOTES.md) for exact evidence and remaining host/distribution checks. Windows, Intel macOS and After Effects must be verified on their own devices. Website restrictions, DRM, expired URLs, unavailable formats and embedding-disabled videos can prevent access. Google sign-in and browser-cookie access require the user's own configuration and permissions.

## Architecture and privacy

`app.js` controls the CEP HTML panel. `downloader.js` provides search and a bounded job queue. `quality.js` selects formats. `binary-manager.js` selects bundled runtimes and maintains a separate yt-dlp update. `util.js` manages processes and local files. `csbridge.js` calls `jsx/hostscript.jsx`, which imports actual files through the Premiere/After Effects scripting API.

Downloads use isolated temporary directories. Completion requires a real file, positive duration, compatible codecs and valid section duration. Cancellation terminates the child process tree. The host bridge confirms its script is loaded and checks the imported project item.

Search and media requests contact YouTube or the chosen source; update checks contact GitHub. No separate MediaOtter analytics service is used. Settings, history, recent searches, diagnostics and optional tokens are local. Never share account tokens, cookies, credentials or the full state folder with bug reports. [Credential setup](docs/CREDENTIALS.md).

## Contributing

Run `npm run check` and the generated-media integration test before packaging. Use a disposable project for actual Premiere import checks. Host scripts must retain ExtendScript-compatible syntax. [Repair and release checklist](docs/REPAIR-NOTES.md).

Only download content you own or are authorized to use. Respect the source's terms and applicable rights.

[MIT license](LICENSE). Bundled tools retain their own licenses; see [third-party notices](docs/THIRD-PARTY.md).
