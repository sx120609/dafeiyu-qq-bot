#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.local/opt/swift-6.4.1-RELEASE-ubuntu26.04/usr/bin:$PATH"
BUILD="$HOME/dafeiyu-gpt/upstream"
rsync -a --delete "$ROOT/upstream/Sources/" "$BUILD/Sources/"
rsync -a --delete "$ROOT/upstream/Tests/" "$BUILD/Tests/"
rsync -a "$ROOT/upstream/Resources/" "$BUILD/Resources/"
rsync -a "$ROOT/upstream/scripts/" "$BUILD/scripts/"
cd "$BUILD"
export DAFEIYU_RESOURCES="$BUILD/Resources"
bash scripts/test.sh >../test-stage.log 2>&1
swift build -c release --jobs 2 >../build-stage.log 2>&1
STAGE="$HOME/dafeiyu-gpt/staging/dafeiyu-linux"
mkdir -p "$STAGE/Resources"
cp "$(swift build -c release --show-bin-path)/WeChatAIBot" "$STAGE/dafeiyu"
cp -R Resources/QQControl Resources/QQStickers Resources/Linux Resources/SocialControl Resources/SocialBrowser "$STAGE/Resources/"
python3 scripts/test-control-panel.py "$STAGE/dafeiyu" >../panel-stage.log 2>&1
python3 scripts/test-onebot-transport.py "$STAGE/dafeiyu" >../onebot-stage.log 2>&1
echo 'Staging build and protocol checks passed.'
