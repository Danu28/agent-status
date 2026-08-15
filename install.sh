#!/usr/bin/env bash
# install-agent-status.sh — install/update the agent-status extension into the live agent dir.
# Repo (source of truth): https://github.com/Danu28/agent-status
# Single-file extension — flat copy, idempotent.
set -euo pipefail

REPO=https://github.com/Danu28/agent-status
CACHE="$HOME/.pi/agent/.extension-src/agent-status"
EXT="$HOME/.pi/agent/extensions"

mkdir -p "$(dirname "$CACHE")"
if [ -d "$CACHE/.git" ]; then
  git -C "$CACHE" pull --ff-only
else
  git clone --depth 1 "$REPO" "$CACHE"
fi
test -f "$CACHE/agent-status.ts" || { echo "clone failed — aborting"; exit 1; }

cp "$CACHE/agent-status.ts" "$EXT/agent-status.ts"

echo "✓ agent-status installed (repo $(git -C "$CACHE" rev-parse --short HEAD))."
echo "  Run /reload in pi to activate."