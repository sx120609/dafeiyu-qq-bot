#!/usr/bin/env bash
# Look up QQ face / reaction emoji IDs by name in the NapCat container's QQ face table.
# Usage: find-face-ids.sh 棒棒糖 拳头 问号 鲸鱼
set -euo pipefail
docker exec qq-ai cat /app/.config/QQ/global/nt_data/Emoji/emoji-resource/face_config.json | python3 -c '
import json, sys
names = sys.argv[1:]
data = json.load(sys.stdin)
for group, items in data.items():
    if not isinstance(items, list): continue
    for item in items:
        if not isinstance(item, dict): continue
        desc = str(item.get("QDes", "")) + " " + str(item.get("Describe", ""))
        if any(n in desc for n in names):
            print(group, {k: item.get(k) for k in ("QSid", "QDes", "EMCode", "AniStickerType", "isHide")})
' "$@"
