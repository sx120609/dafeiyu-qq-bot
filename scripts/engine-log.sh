#!/usr/bin/env bash
# Print the tail of the engine log, including any Swift crash report.
LINES="${1:-120}"
tail -n "$LINES" "$HOME/dafeiyu-gpt/engine.log" | cut -c1-400
echo "--- restarts"
systemctl --user show dafeiyu-bot.service -p NRestarts -p ActiveEnterTimestamp
journalctl --no-pager -o short-iso --since '-30min' 2>/dev/null | grep 'fatal signal' | tail -5
