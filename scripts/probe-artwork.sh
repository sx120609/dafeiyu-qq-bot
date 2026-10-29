#!/usr/bin/env bash
# Download one ranking illustration the way the engine does and run it through the image helper.
set -uo pipefail
id="${1:?pixiv illust id}"
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
urls="$(curl -s -m 20 -H 'User-Agent: Mozilla/5.0' -H 'Referer: https://www.pixiv.net/' "https://www.pixiv.net/ajax/illust/$id" \
  | python3 -c 'import json,sys;u=json.load(sys.stdin)["body"]["urls"];print(u.get("original","")+" "+u.get("regular",""))')"
for url in $urls; do
  curl -s -m 60 -o "$dir/img" -w "%{http_code} %{size_download}B %{time_total}s $url\n" -H 'User-Agent: Mozilla/5.0' -H 'Referer: https://www.pixiv.net/' "$url"
done
helper="$HOME/dafeiyu-gpt/upstream/dist/dafeiyu-linux/Resources/Linux/image-helper.py"
ls -la "$helper"
head -c 400 "$helper"; echo
python3 -c 'import PIL; print("Pillow", PIL.__version__)' 2>&1
