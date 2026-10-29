#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/opt/swift-6.4.1-RELEASE-ubuntu26.04/usr/bin:$PATH"
cd "$HOME/dafeiyu-gpt/upstream"
bash scripts/test.sh >../test.log 2>&1
python3 scripts/test-linux-images.py >>../test.log 2>&1
bash scripts/build-linux.sh >../build.log 2>&1
python3 scripts/test-control-panel.py dist/dafeiyu-linux/dafeiyu >../panel-test.log 2>&1
python3 scripts/test-onebot-transport.py dist/dafeiyu-linux/dafeiyu >../onebot-test.log 2>&1
python3 scripts/check-public.py >../public-test.log 2>&1
