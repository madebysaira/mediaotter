# Install and build MediaOtter 1.1.0

## Offline macOS developer package

1. Get `mediaotter-1.1.0-darwin-arm64-developer.zip` for Apple Silicon, or the corresponding `darwin-x64` package after the publisher has built and tested it. Keep the ZIP's `.sha256` file alongside it.
2. Verify in Terminal: `shasum -a 256 -c mediaotter-1.1.0-darwin-arm64-developer.zip.sha256`.
3. Extract it. The archive contains `MediaOtter/`, `Install.command`, `FILES.sha256` and these instructions.
4. Run `bash /path/to/extracted/Install.command`. Node, Java and administrator access are not required. The installer verifies the internal manifest and executes runtime version checks before replacing the panel.
5. Fully quit and restart Premiere, then choose **Window → Extensions → MediaOtter**.

Existing panels are preserved under `~/Library/Application Support/MediaOtter/install-backups/`. Local settings, account tokens and history remain separate. To restore, quit Premiere, move the current panel outside Adobe's extensions directory, then move the chosen backup to `~/Library/Application Support/Adobe/CEP/extensions/MediaOtter`.

The package is unsigned. Adobe's developer mode may be required. The installer prints commands but does not change security preferences. CEP 12 hosts use `com.adobe.CSXS.12`, CEP 11 uses `.11`, and CEP 10 uses `.10`; determine the runtime used by your installed host. For a CEP 12 development host:

```sh
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

For ordinary end-user distribution, the publisher should provide a signed ZXP and a trusted extension installer. Do not disable system security protections to install this panel.

## Contributors

```sh
npm run binaries
npm run check
npm run test:integration
node scripts/verify-binaries.js
npm run install:mac
npm run build:zxp
```

Use Node 14+ for contributor scripts. Runtime versions and SHA256 hashes are recorded in `extension/binaries/release.json`. Packages are named for the build machine's architecture. `--all` fetches other runtime assets but does not establish compatibility on those devices.

The manifest permits Premiere 14.4+ with CEP 10+ and After Effects 18+. The tested engine environment is macOS Apple Silicon; declared host ranges do not establish validation of all older releases.

## Signed publisher build

Set `MEDIAOTTER_SIGN_CERT` to your certificate file, `MEDIAOTTER_SIGN_PASSWORD` to its password, and `MEDIAOTTER_ZXPSIGNCMD` to Adobe's ZXPSignCmd. Then run `npm run build:zxp`; it signs and verifies the package. Without these values the build produces a developer ZIP. Credentials and signing certificates are excluded from packages and version control.

Complete `docs/REPAIR-NOTES.md` before publishing. Upload both the archive and its `.sha256` asset. The website installer uses those exact versioned names. Changing these scripts does not publish a release or deploy the website.

## Windows

Fetch and verify Windows runtime assets on Windows. Copy `extension/` to `%APPDATA%\Adobe\CEP\extensions\MediaOtter\`. Use a signed package for ordinary distribution. Download, cancel, reveal and import require Windows device verification before release.

## Troubleshooting

- Panel missing: check installed `CSXS/manifest.xml`, host version and matching CEP developer mode for unsigned builds, then restart the host.
- Engine missing: verify runtimes and use the correct architecture package; installing Node/Python globally should not be needed.
- Source rejects access: update yt-dlp in Settings. Optionally test your own browser session. Cookie access can fail or prompt for Keychain access; it does not guarantee restricted content is downloadable.
- No video quality: enable H.264 encoding for VP9/AV1 or unknown direct-file dimensions. Protected media cannot be converted by this setting.
- Import fails: open a project; completed media stays available for manual import or retry. Unsaved projects use the state folder's `downloads/` directory.
- Save diagnostics from Settings and review paths before sharing. Include the failing action and error, excluding tokens, cookies and credentials.
