#!/usr/bin/env bash
# Run tests/soak-live.py against the deployed engine once the model gateway answers.
# Optional: scripts/soak.sh tests/soak-commands-network.json  (turn list; the synthetic user becomes admin)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for _ in $(seq 1 30); do curl -sf http://127.0.0.1:18191/healthz >/dev/null && break; sleep 2; done
curl -sf http://127.0.0.1:18191/healthz >/dev/null || { echo 'Model gateway is not running'; exit 1; }
cd "$ROOT"
if [[ $# -ge 1 ]]; then export DAFEIYU_SOAK_TURNS_FILE="$1" DAFEIYU_SOAK_ADMIN=54321 DAFEIYU_SOAK_IDLE="${DAFEIYU_SOAK_IDLE:-60}"; fi
# The outreach scenario turns on starting conversations with a one-minute quiet time.
if [[ "${1:-}" == *outreach* ]]; then export DAFEIYU_SOAK_OUTREACH=1 DAFEIYU_SOAK_REACTIONS=1 DAFEIYU_SOAK_IDLE=10; fi
exec python3 tests/soak-live.py
