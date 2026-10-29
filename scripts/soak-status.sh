#!/usr/bin/env bash
# Is a soak run alive, and what has its engine written to stderr?
ps -eo pid,etime,cmd | grep -E '[s]oak-live|[d]afeiyu-linux/dafeiyu'
latest="$(ls -t "$(dirname "$0")/../.runtime/soak/"*.log 2>/dev/null | head -1)"
[[ -n "$latest" ]] && { echo "$latest ($(wc -c <"$latest") bytes)"; tail -c 1500 "$latest"; }
