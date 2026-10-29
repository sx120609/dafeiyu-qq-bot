#!/usr/bin/env bash
# Write the QQ face ID -> name table (from the NapCat container's QQ install) into the engine resources,
# so a message that is only a QQ face reads as "[QQ表情：捂脸]" instead of an unknown number.
# Usage (WSL): scripts/export-face-names.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
docker exec qq-ai cat /app/.config/QQ/global/nt_data/Emoji/emoji-resource/face_config.json | python3 -c '
import json, sys
data = json.load(sys.stdin)
names = {}
for group, items in data.items():
    if not isinstance(items, list): continue
    for item in items:
        if not isinstance(item, dict): continue
        sid, name = str(item.get("QSid", "")), str(item.get("QDes", "")).lstrip("/").strip()
        if sid.isdigit() and name and sid not in names: names[sid] = name[:12]
json.dump(dict(sorted(names.items(), key=lambda kv: int(kv[0]))), sys.stdout, ensure_ascii=False, indent=0)
print("exported", len(names), "faces", file=sys.stderr)
' > "$ROOT/upstream/Resources/QQControl/faces.json"
