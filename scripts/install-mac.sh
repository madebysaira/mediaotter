#!/usr/bin/env bash
# Installs this exact build; keeps the previous panel outside Adobe's scan path.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/MediaOtter"
BACKUPS="$HOME/Library/Application Support/MediaOtter/install-backups"
[ -f "$SRC/CSXS/manifest.xml" ] || { echo "Extension source missing" >&2; exit 1; }
node "$ROOT/scripts/verify-binaries.js"
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
for CEP_VERSION in 10 11 12; do
  CURRENT="$(defaults read "com.adobe.CSXS.$CEP_VERSION" PlayerDebugMode 2>/dev/null || true)"
  if [ "$CURRENT" != "1" ]; then
    echo "Unsigned developer build: enable your host's debug mode yourself if required:"
    echo "defaults write com.adobe.CSXS.$CEP_VERSION PlayerDebugMode 1"
  fi
done
echo "Installed MediaOtter at $DEST"
echo "Quit and restart Premiere, then Window > Extensions > MediaOtter."
