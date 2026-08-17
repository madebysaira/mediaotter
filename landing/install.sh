#!/usr/bin/env sh
# MediaOtter — one-line installer.
#
#   curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh
#
# Installs the MediaOtter CEP panel for Premiere Pro / After Effects into the
# user CEP extensions folder. No admin, no Java, no ZXPSignCmd required.
set -eu

VERSION="1.0.0"
REPO="madebysaira/mediaotter"
BASE="https://github.com/${REPO}/releases/download/v${VERSION}"

say()  { printf '\033[1;34m%s\033[0m\n' "MediaOtter: $*"; }
die()  { printf '\033[1;31mMediaOtter: %s\033[0m\n' "$*" >&2; exit 1; }

# --- detect OS + arch -------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64) PKG="mediaotter-darwin-arm64.zip"; PLAT="darwin-arm64";;
      x86_64)        PKG="mediaotter-darwin-x64.zip";   PLAT="darwin-x64";;
      *) die "unsupported Mac architecture: $ARCH";;
    esac
    DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/MediaOtter";;
  Linux)
    die "MediaOtter targets Premiere Pro / After Effects (macOS + Windows). Linux is a dev-only build.";;
  *)
    die "unsupported OS: $OS";;
esac

# --- download ---------------------------------------------------------------
# Extract in the CEP folder's parent (same disk as the install target) so a
# small or full system temp dir can never break the install.
PARENT="$(dirname "$DEST")"
mkdir -p "$PARENT"
TMP="$(mktemp -d "$PARENT/.mediaotter-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
ZIP="$TMP/$PKG"
say "Downloading $PKG ($PLAT)..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$ZIP" "$BASE/$PKG"
elif command -v wget >/dev/null 2>&1; then
  wget -q --tries=3 -O "$ZIP" "$BASE/$PKG"
else
  die "need curl or wget"
fi
[ -s "$ZIP" ] || die "download failed (empty file). Try again or check https://github.com/$REPO/releases"

# --- install ----------------------------------------------------------------
say "Installing to $DEST"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
( cd "$TMP" && unzip -q "$ZIP" )
[ -f "$TMP/MediaOtter/CSXS/manifest.xml" ] || die "package corrupt: CSXS/manifest.xml missing"
cp -R "$TMP/MediaOtter" "$DEST"

# --- enable unsigned extensions (one-time) ----------------------------------
if [ "$OS" = "Darwin" ]; then
  if ! defaults read com.adobe.CSXS.10 PlayerDebugMode >/dev/null 2>&1; then
    say "Enabling unsigned-extension loading (com.adobe.CSXS.10 PlayerDebugMode)..."
    defaults write com.adobe.CSXS.10 PlayerDebugMode 1
  fi
fi

echo
say "✓ MediaOtter v${VERSION} installed ($(du -sh "$DEST" 2>/dev/null | cut -f1))"
echo
echo "  Next steps:"
echo "    1. Fully quit Premiere Pro / After Effects (Cmd+Q)"
echo "    2. Reopen, then Window → Extensions → MediaOtter"
echo
echo "  Need help? hi@madebysaira.me"
