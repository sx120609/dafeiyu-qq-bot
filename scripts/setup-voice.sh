#!/bin/bash
# Voice messages: NapCat's own ffmpeg conversion fails in the container (QQ answers 1200), so the gateway encodes
# SILK itself with pilk, in a private venv. Run once in WSL.
set -euo pipefail
VENV="$HOME/.local/share/dafeiyu/voice-venv"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q pilk
"$VENV/bin/python" -c 'import pilk; print("pilk ready")'
