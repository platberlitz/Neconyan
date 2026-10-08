#!/usr/bin/env bash
set -euo pipefail

cd "${NECONYAN_INSTALL_DIR:-$HOME/Neconyan}"
NECO_IMPORT_DATA=$(node .local-runtime/termux-import/termux-import-folder.js "$@")
if [[ -z "$NECO_IMPORT_DATA" || ! -d "$NECO_IMPORT_DATA" ]]; then
    printf 'No existing recovery folder was selected. Nothing was started.\n' >&2
    exit 1
fi
termux-wake-lock
printf 'Recovery data folder: %s\nOpen http://127.0.0.1:5534\n' "$NECO_IMPORT_DATA"
exec node --import ./.local-runtime/termux-import/termux-file-stats.js server.js \
    --dataRoot "$NECO_IMPORT_DATA" --port 5534
