#!/usr/bin/env bash
set -euo pipefail
BASE="$HOME/dafeiyu-gpt"
SOURCE="$BASE/staging/dafeiyu-linux"
TARGET="$BASE/upstream/dist/dafeiyu-linux"
test -x "$SOURCE/dafeiyu"
BACKUP="$BASE/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
systemctl --user stop dafeiyu-bot.service dafeiyu-codex.service
cp -a "$TARGET" "$BACKUP/"
cp "$SOURCE/dafeiyu" "$TARGET/dafeiyu"
cp -a "$SOURCE/Resources/." "$TARGET/Resources/"
echo 'Staged engine installed; previous executable and resources retained for rollback.'
