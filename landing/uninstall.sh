#!/usr/bin/env sh
# MediaOtter — one-line uninstall (wrapper).
#   curl -fsSL https://mediaotter.madebysaira.me/uninstall.sh | sh
# Forwards to install.sh --uninstall so both URLs stay in sync.
set -eu
# fetch the real installer and run its uninstall path
if command -v curl >/dev/null 2>&1; then
  curl -fsSL https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall "$@"
elif command -v wget >/dev/null 2>&1; then
  wget -qO- https://mediaotter.madebysaira.me/install.sh | sh -s -- --uninstall "$@"
else
  echo "MediaOtter: need curl or wget" >&2; exit 1
fi
