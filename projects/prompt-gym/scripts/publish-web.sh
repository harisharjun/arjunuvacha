#!/usr/bin/env bash
# Copies the SPA into the Hugo static tree so it ships at /prompt-gym/.
#
# Reminder: the GitHub Action deploys public/ without building it, so this
# script is only step one. After running it you still need:
#   hugo && git add static/prompt-gym public && git commit && git push
set -euo pipefail

cd "$(dirname "$0")/.."
DEST="../../static/prompt-gym"

# No bundler yet (M0) — web/ is plain static files. When a build step lands,
# switch SRC to web/dist.
SRC="web"

mkdir -p "$DEST"
rsync -a --delete --exclude 'dist/' "$SRC"/ "$DEST"/

echo "Published $SRC/ -> static/prompt-gym/"
ls -1 "$DEST"
