#!/usr/bin/env bash
# MediaOtter — dev install for macOS.
# Copies extension/ into the CEP extensions folder (no admin needed).
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/extension"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/MediaOtter"

if [ ! -d "$SRC" ] || [ ! -f "$SRC/CSXS/manifest.xml" ]; then
  echo "✗ extension/ not found next to this script." >&2
  exit 1
fi

echo "Installing MediaOtter → $DEST"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$SRC" "$DEST"
echo "✓ Copied."

if ! defaults read com.adobe.CSXS.10 PlayerDebugMode >/dev/null 2>&1; then
  echo
  echo "Enable unsigned extensions (one-time):"
  echo "  defaults write com.adobe.CSXS.10 PlayerDebugMode 1"
fi

echo
echo "Next: fully quit and restart Premiere Pro / After Effects, then"
echo "  Window → Extensions → MediaOtter"
