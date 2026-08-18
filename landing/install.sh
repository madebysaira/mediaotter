#!/usr/bin/env sh
# MediaOtter — installer & uninstaller.
#
#   Install:   curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh
#   Uninstall: curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall
#   # or
#   curl -fsSL https://mediaotter.madebysaira.me/uninstall.sh | sh
#
# No admin, no Java. Works on macOS (Apple Silicon + Intel).
set -eu

VERSION="1.0.0"
REPO="madebysaira/mediaotter"
BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/MediaOtter"
STATE="$HOME/Library/Application Support/MediaOtter"
# also legacy linux path handled in uninstall
IS_UNINSTALL=0
PURGE=0

for arg in "$@"; do
  case "$arg" in
    --uninstall|uninstall) IS_UNINSTALL=1 ;;
    --purge) PURGE=1; IS_UNINSTALL=1 ;;
    --help|-h)
      echo "MediaOtter installer v${VERSION}"
      echo ""
      echo "Usage:"
      echo "  curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh"
      echo "  curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall"
      echo "  curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall --purge"
      echo ""
      echo "Flags:"
      echo "  --uninstall    Remove the extension (keeps ~/Library/Application Support/MediaOtter by default)"
      echo "  --purge        With --uninstall, also delete state (auth, history, yt-dlp cache)"
      echo "  --help         Show this help"
      exit 0
      ;;
  esac
done

# ── colors & glyphs ───────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD="$(tput bold 2>/dev/null || printf '')"
  DIM="$(tput dim 2>/dev/null || printf '')"
  RED="$(tput setaf 1 2>/dev/null || printf '')"
  GREEN="$(tput setaf 2 2>/dev/null || printf '')"
  YELLOW="$(tput setaf 3 2>/dev/null || printf '')"
  BLUE="$(tput setaf 4 2>/dev/null || printf '')"
  CYAN="$(tput setaf 6 2>/dev/null || printf '')"
  GREY="$(tput setaf 8 2>/dev/null || printf '')"
  RESET="$(tput sgr0 2>/dev/null || printf '')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; GREY=""; RESET=""
fi

# Use plain ASCII if locale lacks emoji
OTTER="🦦"
if ! printf "%s" "$OTTER" | grep -q "🦦" 2>/dev/null; then OTTER="[MediaOtter]"; fi

info() { printf "%s %s\n" "${BLUE}▸${RESET}" "$*"; }
ok()   { printf "%s %s\n" "${GREEN}✔${RESET}" "$*"; }
warn() { printf "%s %s\n" "${YELLOW}⚠${RESET}" "$*"; }
err()  { printf "%s %s\n" "${RED}✘${RESET}" "$*" >&2; }
step() { printf "\n%s ${BOLD}[%s/%s]${RESET} %s\n" "${CYAN}━━${RESET}" "$1" "$2" "$3"; }
spin() { printf "%s %s" "${DIM}…${RESET}" "$*"; }

header() {
  printf "\n"
  printf "${BOLD}  %s MediaOtter v%s${RESET}\n" "$OTTER" "$VERSION"
  printf "${GREY}  Search YouTube, paste any link — MP4/WAV lands in your Premiere bin${RESET}\n"
  printf "${GREY}  %s  •  %s${RESET}\n" "https://mediaotter.madebysaira.me" "https://github.com/${REPO}"
  printf "\n"
}

# ── uninstall ─────────────────────────────────────────────────────────────
if [ "$IS_UNINSTALL" = "1" ]; then
  header
  step 1 3 "Removing extension"
  if [ -d "$DEST" ] || [ -L "$DEST" ]; then
    printf "  %s %s\n" "${DIM}→${RESET}" "$DEST"
    rm -rf "$DEST" 2>/dev/null || {
      err "Could not remove $DEST (try: rm -rf \"$DEST\")"
      exit 1
    }
    ok "Removed extension"
  else
    warn "Already clean — no extension at"
    printf "  ${GREY}%s${RESET}\n" "$DEST"
  fi

  step 2 3 "State & cache"
  if [ "$PURGE" = "1" ]; then
    if [ -d "$STATE" ]; then
      printf "  %s %s ${GREY}(auth, history, logs, bin)${RESET}\n" "${DIM}→${RESET}" "$STATE"
      rm -rf "$STATE" 2>/dev/null || warn "Could not fully remove $STATE"
      ok "Purged state (credentials + history + yt-dlp cache)"
    else
      warn "No state folder at $STATE"
    fi
    # also linux fallback
    if [ -d "$HOME/.mediaotter" ] && [ "$STATE" != "$HOME/.mediaotter" ]; then
      rm -rf "$HOME/.mediaotter" 2>/dev/null || true
    fi
  else
    if [ -d "$STATE" ]; then
      info "Kept state at ${CYAN}$STATE${RESET} ${GREY}(--purge to delete)${RESET}"
      printf "  ${GREY}auth.json, settings.json, history.json, logs/, bin/yt-dlp${RESET}\n"
    else
      info "No state folder to purge"
    fi
  fi

  step 3 3 "Done"
  ok "MediaOtter uninstalled"
  echo ""
  printf "  ${GREY}Quit Premiere/AE (${BOLD}Cmd+Q${RESET}${GREY}) and reopen — panel is gone.${RESET}\n"
  printf "  ${GREY}Re-install any time: ${BOLD}curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh${RESET}${GREY}${RESET}\n"
  if [ "$PURGE" != "1" ] && [ -d "$STATE" ]; then
    printf "  ${GREY}To also wipe auth/history: ${BOLD}curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall --purge${RESET}\n"
  fi
  echo ""
  exit 0
fi

# ── install ───────────────────────────────────────────────────────────────
header

# 1 — detect
step 1 4 "Detecting system"
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64) PKG="mediaotter-darwin-arm64.zip"; PLAT="darwin-arm64"; LABEL="Apple Silicon";;
      x86_64)        PKG="mediaotter-darwin-x64.zip";   PLAT="darwin-x64";   LABEL="Intel";;
      *) printf "${RED}✘${RESET} unsupported Mac architecture: %s\n" "$ARCH" >&2; exit 1;;
    esac
    ;;
  Linux)
    printf "${RED}✘${RESET} Linux is dev-only. MediaOtter needs Premiere/AE on macOS.\n" >&2
    printf "  ${GREY}If you’re testing on a Pi, clone and run from source — see README.${RESET}\n" >&2
    exit 1
    ;;
  *)
    printf "${RED}✘${RESET} unsupported OS: %s\n" "$OS" >&2; exit 1;;
esac
ok "macOS $LABEL ($PLAT) • $ARCH"
printf "  ${GREY}Extension → %s${RESET}\n" "$DEST"

# 2 — download with progress
step 2 4 "Downloading $PKG"
URL="$BASE/$PKG"
PARENT="$(dirname "$DEST")"
mkdir -p "$PARENT"
TMP="$(mktemp -d "$PARENT/.mediaotter-install.XXXXXX")"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap 'cleanup' EXIT INT TERM
ZIP="$TMP/$PKG"
printf "  ${GREY}%s${RESET}\n" "$URL"
echo ""

# pick downloader and show a real progress bar
DL_OK=0
if command -v curl >/dev/null 2>&1; then
  # curl: --progress-bar is pretty, -# is alt. Use progress-bar when tty, silent otherwise
  if [ -t 1 ] || [ -t 2 ]; then
    if curl -fL --progress-bar --retry 3 --retry-delay 1 -o "$ZIP" "$URL"; then
      DL_OK=1
      printf "\n"
    fi
  else
    if curl -fsSL --retry 3 -o "$ZIP" "$URL"; then DL_OK=1; fi
  fi
elif command -v wget >/dev/null 2>&1; then
  if wget --progress=bar:force --tries=3 -O "$ZIP" "$URL" 2>&1 | grep -v "^$" ; then DL_OK=1; fi
else
  printf "${RED}✘${RESET} need %s\n" "curl or wget" >&2; exit 1
fi

if [ "$DL_OK" != "1" ] || [ ! -s "$ZIP" ]; then
  err "download failed"
  printf "  ${GREY}URL: %s${RESET}\n" "$URL"
  printf "  ${GREY}Check https://github.com/%s/releases — or retry.${RESET}\n" "$REPO"
  exit 1
fi
SIZE="$(du -h "$ZIP" 2>/dev/null | cut -f1)"
if [ -z "$SIZE" ]; then SIZE="$(wc -c < "$ZIP" 2>/dev/null | tr -d ' ') bytes"; fi
ok "Downloaded $SIZE"

# 3 — install
step 3 4 "Installing"
spin "Extracting…"
if ! ( cd "$TMP" && unzip -q "$ZIP" 2>/dev/null ); then
  # fallback: try python
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$TMP" 2>/dev/null || {
      err "unzip failed (corrupt download?)"
      exit 1
    }
  else
    err "unzip failed"
    exit 1
  fi
fi
printf "\r  ${GREEN}✔${RESET} Extracted %-30s\n" "($SIZE)"
[ -f "$TMP/MediaOtter/CSXS/manifest.xml" ] || {
  err "package corrupt — CSXS/manifest.xml missing"
  printf "  ${GREY}Got: %s${RESET}\n" "$(ls -1 "$TMP" 2>/dev/null | tr '\n' ' ')"
  exit 1
}
spin "Copying to $DEST…"
rm -rf "$DEST" 2>/dev/null || true
mkdir -p "$(dirname "$DEST")"
cp -R "$TMP/MediaOtter" "$DEST"
INSTALLED_SIZE="$(du -sh "$DEST" 2>/dev/null | cut -f1)"
if [ -z "$INSTALLED_SIZE" ]; then INSTALLED_SIZE="$SIZE"; fi
printf "\r  ${GREEN}✔${RESET} Installed %-30s ${GREY}(%s)${RESET}\n" "" "$INSTALLED_SIZE"

# 4 — enable unsigned
step 4 4 "Enabling unsigned extensions (one-time)"
DID=0
for csxs in 10 11; do
  if ! defaults read "com.adobe.CSXS.${csxs}" PlayerDebugMode >/dev/null 2>&1; then
    printf "  ${DIM}→${RESET} com.adobe.CSXS.${csxs}.PlayerDebugMode = 1\n"
    defaults write "com.adobe.CSXS.${csxs}" PlayerDebugMode 1 2>/dev/null || warn "could not write com.adobe.CSXS.${csxs} — run: defaults write com.adobe.CSXS.${csxs} PlayerDebugMode 1"
    DID=1
  else
    printf "  ${GREY}✔ com.adobe.CSXS.${csxs} already enabled${RESET}\n"
  fi
done
if [ "$DID" = "0" ]; then ok "Already enabled"; else ok "Enabled"; fi

# cleanup before success banner so size stays
cleanup; trap - EXIT INT TERM

printf "\n"
printf "${BOLD}${GREEN}  ✔ MediaOtter v%s installed${RESET} ${GREY}(%s)${RESET}\n" "$VERSION" "$INSTALLED_SIZE"
printf "${GREY}  %s${RESET}\n" "$DEST"
printf "\n"
printf "  ${BOLD}Next:${RESET}\n"
printf "    ${CYAN}1.${RESET} Fully quit Premiere Pro / After Effects (${BOLD}Cmd+Q${RESET})\n"
printf "    ${CYAN}2.${RESET} Reopen → ${BOLD}Window → Extensions → MediaOtter${RESET}\n"
printf "\n"
printf "  ${GREY}Docs:      https://mediaotter.madebysaira.me/docs.html${RESET}\n"
printf "  ${GREY}Uninstall: ${BOLD}curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall${RESET}\n"
printf "  ${GREY}Help:      hi@madebysaira.me  •  https://github.com/%s/issues${RESET}\n" "$REPO"
printf "\n"
