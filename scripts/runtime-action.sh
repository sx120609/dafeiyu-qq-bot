#!/usr/bin/env bash
# Run one console runtime action: bot-resume, bot-pause, bot-restart, napcat-restart, napcat-start, napcat-stop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
token="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["consoleToken"])' "$ROOT/.runtime/bridge.json")"
curl -s --max-time 120 -X POST -H "Authorization: Bearer $token" -H 'Origin: http://127.0.0.1:18191' -H 'Content-Type: application/json' \
  -d "{\"action\":\"$1\"}" http://127.0.0.1:18191/console/api/runtime/action
echo
