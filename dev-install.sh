#!/usr/bin/env bash
# dev-install.sh — sync the LOCAL agent-status.ts into pi's live extension dir,
# without pushing to the remote repo. For active development.
#
# Unlike install.sh (which clones/pulls from GitHub — the source of truth and
# therefore blind to uncommitted local changes), this script copies straight
# from your working tree so edits show up immediately.
#
# Usage:
#   ./dev-install.sh              # copy local file once, then /reload in pi
#   ./dev-install.sh --watch      # poll; re-copy automatically on every save
#   ./dev-install.sh <file>       # copy a specific file instead of agent-status.ts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HOME/.pi/agent/extensions"
DEST="$EXT/agent-status.ts"

MODE=once
SRC_REL="agent-status.ts"
[ "${1:-}" = "--watch" ] && { MODE=watch; shift; }
[ "${1:-}" != "" ] && SRC_REL="$1"
# Resolve relative to the script dir; keep absolute paths as-is.
case "$SRC_REL" in
  /*) SRC="$SRC_REL" ;;
  *)  SRC="$SCRIPT_DIR/$SRC_REL" ;;
esac

test -f "$SRC" || { echo "✗ source not found: $SRC" >&2; exit 1; }

mkdir -p "$EXT"

sync_once() {
  cp "$SRC" "$DEST"
  echo "✓ synced $SRC_REL → $DEST"
}

if [ "$MODE" = "once" ]; then
  sync_once
  echo "  Run /reload in pi to activate."
  exit 0
fi

# --watch: poll for changes and re-sync on every save. A cksum comparison
# avoids re-copying when nothing changed; a transient read during an editor
# save (file momentarily absent) just skips a tick instead of aborting.
echo "Watching $SRC for changes (Ctrl-C to stop)…"
LAST=""
while true; do
  if ! CUR="$(cksum < "$SRC" 2>/dev/null)"; then
    sleep 1
    continue
  fi
  if [ "$CUR" != "$LAST" ]; then
    cp "$SRC" "$DEST"
    LAST="$CUR"
    echo "$(date +%H:%M:%S) → synced (run /reload in pi to activate)"
  fi
  sleep 1
done
