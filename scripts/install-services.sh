#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.config/systemd/user" "$HOME/dafeiyu-gpt"
cat > "$HOME/.config/systemd/user/dafeiyu-codex.service" <<EOF
[Unit]
Description=Local Codex adapter for Dafeiyu
[Service]
ExecStart=/bin/bash $ROOT/scripts/bridge-wsl.sh
# always: a stray SIGTERM counts as a clean exit for on-failure and would leave the bot without a gateway.
Restart=always
RestartSec=5
UMask=0077
StandardOutput=append:%h/dafeiyu-gpt/bridge.log
StandardError=append:%h/dafeiyu-gpt/bridge.log
EOF
cat > "$HOME/.config/systemd/user/dafeiyu-bot.service" <<EOF
[Unit]
Description=Dafeiyu GPT QQ engine
Requires=dafeiyu-codex.service
After=dafeiyu-codex.service
[Service]
ExecStart=/usr/bin/python3 $ROOT/scripts/supervisor.py
Restart=always
RestartSec=5
KillMode=control-group
UMask=0077
StandardOutput=append:%h/dafeiyu-gpt/engine.log
StandardError=append:%h/dafeiyu-gpt/engine.log
EOF
systemctl --user daemon-reload
echo 'User services installed (no Windows auto-start).'
