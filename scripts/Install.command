#!/usr/bin/env bash
# Offline installer for a reviewed MediaOtter developer package.
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$PACKAGE_DIR/MediaOtter"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/MediaOtter"
BACKUPS="$HOME/Library/Application Support/MediaOtter/install-backups"
[ "$(uname -s)" = "Darwin" ] || { echo "This installer is for macOS." >&2; exit 1; }
case "$(uname -m)" in arm64) PLATFORM=darwin-arm64;; x86_64) PLATFORM=darwin-x64;; *) exit 1;; esac
[ -f "$SRC/binaries/deno/$PLATFORM/deno" ] || { echo "This package does not contain the runtime for $PLATFORM." >&2; exit 1; }
[ -f "$SRC/CSXS/manifest.xml" ] || { echo "The extension is missing." >&2; exit 1; }
[ -f "$PACKAGE_DIR/FILES.sha256" ] || { echo "The integrity manifest is missing." >&2; exit 1; }
(cd "$PACKAGE_DIR" && shasum -a 256 -c FILES.sha256 >/dev/null)
"$SRC/binaries/yt-dlp" --version
"$SRC/binaries/ffmpeg/$PLATFORM/ffmpeg" -version >/dev/null
"$SRC/binaries/ffmpeg/$PLATFORM/ffprobe" -version >/dev/null
"$SRC/binaries/deno/$PLATFORM/deno" --version
mkdir -p "$(dirname "$DEST")" "$BACKUPS"
STAGE="$(mktemp -d "$(dirname "$DEST")/.mediaotter-install-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$SRC/." "$STAGE/"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  PREVIOUS="$BACKUPS/MediaOtter-$(date +%Y%m%d-%H%M%S)-$$"
  mv "$DEST" "$PREVIOUS"
  echo "Previous panel preserved: $PREVIOUS"
fi
mv "$STAGE" "$DEST"
echo "Installed MediaOtter. Quit and restart Premiere, then Window > Extensions > MediaOtter."
echo "This is an unsigned developer build. Use a publisher-signed ZXP for normal distribution."
for CEP_VERSION in 10 11 12; do
  CURRENT="$(defaults read "com.adobe.CSXS.$CEP_VERSION" PlayerDebugMode 2>/dev/null || true)"
  if [ "$CURRENT" != "1" ]; then
    echo "If your host requires developer mode, enable its matching CEP version yourself:"
    echo "defaults write com.adobe.CSXS.$CEP_VERSION PlayerDebugMode 1"
  fi
done
