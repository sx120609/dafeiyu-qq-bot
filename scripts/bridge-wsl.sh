#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DAFEIYU_BRIDGE_CONFIG="$ROOT/.runtime/bridge.json"
exec /usr/bin/node "$ROOT/bridge/main.mjs"
