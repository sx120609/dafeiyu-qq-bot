#!/usr/bin/env bash
# Usage: bing_fetch.sh <tag> <pages> <query> [query ...]
# Fetches Bing image search async pages into web-raw/pages and parses into web-tools/bing_<tag>.tsv
# Each output row: murl \t purl \t title \t query
set -u
ROOT=/d/Dev/Workspaces/bot-gpt-ds-codex-qq/stickers
TOOLS=$ROOT/web-tools
PAGES_DIR=$ROOT/web-raw/pages
mkdir -p "$PAGES_DIR"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
tag=$1; pages=$2; shift 2
out=$TOOLS/bing_$tag.tsv
: > "$out"
qi=0
for query in "$@"; do
  qi=$((qi+1))
  q=$(python -I -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$query")
  files=()
  for ((p=0; p<pages; p++)); do
    first=$((p*35))
    f="$PAGES_DIR/bing_${tag}_${qi}_${p}.html"
    [ -s "$f" ] || curl -sL --retry 2 -m 25 -A "$UA" -H "Accept-Language: zh-CN,zh;q=0.9" -o "$f" "https://www.bing.com/images/async?q=$q&first=$first&count=35&mmasync=1&setlang=zh-cn&adlt=strict"
    files+=("$f")
  done
  tmp=$TOOLS/_tmp_$tag.tsv
  python -I "$TOOLS/bing_parse.py" "$tmp" "${files[@]}" >/dev/null
  awk -v q="$query" -F'\t' 'BEGIN{OFS="\t"}{print $1,$2,$3,q}' "$tmp" >> "$out"
  rm -f "$tmp"
done
# dedupe by murl
awk -F'\t' '!seen[$1]++' "$out" > "$out.u" && mv "$out.u" "$out"
wc -l "$out"
