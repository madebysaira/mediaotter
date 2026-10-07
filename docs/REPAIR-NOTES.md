# MediaOtter 1.1.0 repair notes

Date: 7 October 2026. Starting public commit: `585242c4fd8db106e80c6b241615adc1bab69b38`. Changes were made to the independent public MediaOtter implementation.

## What was repaired

| Failure | Result after repair |
| --- | --- |
| Relative browser-entry `require()` errors concealed by mock preview modules | Resolve the extension root and load actual modules by absolute path; initialization failures remain visible. |
| Project path points to `.prproj`, not a directory | Resolve its parent directory; an unsaved project uses the local downloads folder. |
| Pasted URL classifier is synchronous but caller uses `.then()` | Wrap classification correctly; route playlists and media separately. |
| Search playlist results populate a hidden account screen | Open playlist items in the visible search view, including public playlists without sign-in. |
| Wrong playlist filter; new YouTube lockup results unparsed | Correct filters and parse both classic renderers and current playlist/video lockups. |
| Older requests overwrite newer searches/previews | Generation checks for search, continuation and media details; deduplicate search results. |
| Quality caps and conversion flags disagree | Exact format IDs, real resolution labels, one conversion contract, and output codec/height verification. |
| Missing dimensions/empty formats crash or offer wrong media | Empty/audio-only metadata yields no video choices; unknown direct files require encoding permission and are inspected after download. |
| MP4 container incorrectly implies compatible video/audio | Inspect streams and copy compatible H.264/AAC or convert as needed. WAV is normalized to 48 kHz stereo PCM. |
| Partial stdout chunks corrupt output-path discovery | UTF-8 line buffering with a final line flush, bounded captured output and actionable process errors. |
| Download done without validated final media | Isolated job workspace, verified output, final move, then completion event. |
| Cancellation leaks children/queue slots | Kill the child process group (or Windows process tree), cancel queued jobs and release each slot once. |
| Import or script failure reported as success | Verify host readiness, import boolean and actual project item; separate download and import results. |
| Optional timeline insertion uses a path and ignores failure | Use the imported ProjectItem, supported arguments and explicit failure warning. Automatic import goes into the bin. |
| Browser cookie probe rejection is unhandled | Supported-browser validation, bounded probe, clean errors and no stale status override. |
| OAuth browser opens before loopback server listens | Open after listening; match state for both successful and error callbacks; use argument-based browser launch. |
| CEP Node is too old for yt-dlp's JavaScript solver | Use bundled Deno; offer external Node only when it meets the minimum version. |
| Startup forces update checks; manual failure looks up-to-date | Throttle background checks and propagate explicit update errors. |
| `.zxp` contains an unsigned ZIP | Produce a clearly named developer ZIP or sign/verify through Adobe ZXPSignCmd. |
| Installer destroys previous panel and changes debug settings silently | Preserve backups; stage replacement; verify runtime/package integrity; print developer-mode instructions. |
| Broken npm engine test path | Correct command, regression suite, generated-media integration suite and CI workflow. |

## Search recommendations

Starter queries cover cinematic B-roll, ambience, film grain and transition sounds. Recent queries are saved locally, shown as clickable recommendations and can be cleared. This is a lightweight recommendation feature; project-aware suggestions and personalized ranking remain separate product work.

## Evidence obtained

- `npm run check`: syntax, XML, secret checks, exported API checks and 20 passing regression checks.
- `npm run test:integration`: owned generated image/tone media served locally and downloaded by real yt-dlp. Passed MP4 video, WAV audio, 1–3 second audio/video sections, VP9/Opus to H.264/AAC conversion, 144p cap enforcement, queued work, cancellation and temporary cleanup. Files inspected with real FFprobe.
- Live public YouTube checks: autocomplete, video results, playlist results (20 each in the additional filter check), continuation (19 items in the additional continuation check) and metadata/formats. No Google sign-in or browser cookies were used.
- Apple Silicon runtime checks: yt-dlp `2026.08.19`, FFmpeg/FFprobe `6.0`, Deno `2.9.7`; six recorded file checksums verified and all four executables run successfully.
- A developer archive was built with a whole-file integrity manifest, runtime tools and an offline installer. No signing credential was available.

Host regression tests use a model of Premiere's scripting API. They do not establish actual editor behavior. Premiere 26.5.2 exposes the installed MediaOtter menu entry, but automated menu selection did not open the panel. The final panel startup/search/download/import check is pending a visible panel. A disposable verification project was created for this test; no media was inserted into an existing editing sequence.

## Installed-source mismatch

The original active MediaOtter entry was a symlink to another local implementation with Sidestream identifiers and licensing dependencies. That target differed from the public source and had no Git HEAD. The repair uses the public source and preserves the old entry as a backup outside Adobe's scan directory. Treat the old experimental folder as a separate implementation; merging it into this code would reintroduce unclear dependencies and version drift.

## Device and release checklist

Before calling this a normal publisher release:

1. Open the exact installed build in Premiere; confirm version, loaded path and host readiness.
2. In a disposable saved and unsaved project, download owned audio and video, confirm the imported bin items actually play, and retry an import without duplicating it.
3. Check a public playlist, pasted generic URL, failed source, section range, two simultaneous jobs and cancellation during conversion from the actual panel.
4. Check optional timeline insertion only in a disposable sequence. Check drag-to-timeline and preview behavior on the host.
5. Validate Google sign-in with the publisher's own registered desktop client and test cookie access with the user's own permission; the repair's callback unit test is not a completed Google authorization.
6. Validate each advertised Mac/Windows architecture and host version. After Effects also needs its own device test.
7. Include all upstream runtime notices/source requirements, sign and verify the ZXP, install on a clean machine, then publish the matching release assets and website installer.

The source branch/build does not publish a release, deploy the landing website or configure a Google account. CI added by this repair must also pass remotely before it is described as verified CI.

## Maintenance suggestions

Keep UI, candidate selection, download execution, output verification and host import as distinct stages. Save stage-specific diagnostics without tokens/cookies. Refresh yt-dlp regularly and retain owned-media regression fixtures. YouTube web scraping can change without notice: add saved renderer fixtures and extract the current client context for continuation requests when that flow next changes. A future Premiere UXP migration needs a deliberate replacement for Node child-process execution; it should be planned separately from this CEP repair.

Primary references: [Adobe CEP 12 cookbook](https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md), [yt-dlp EJS requirements](https://github.com/yt-dlp/yt-dlp/wiki/EJS), [Sidestream public feature surface](https://sidestream.tv/). The installed Sidestream 1.0.21 client was inspected locally as a reference, without copying its commercial implementation into this repair.
