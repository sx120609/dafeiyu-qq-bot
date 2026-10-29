#!/usr/bin/env bash
# Recent model calls and the generation queue, as the console sees them.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
token="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["consoleToken"])' "$ROOT/.runtime/bridge.json")"
curl -s --max-time 20 -H "Authorization: Bearer $token" -H 'Origin: http://127.0.0.1:18191' http://127.0.0.1:18191/console/api/overview \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("queue",d.get("queue"));[print(m) for m in d.get("recentMetrics",[])[:12]]'
