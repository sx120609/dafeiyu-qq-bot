#!/usr/bin/env bash
# Usage: download.sh <tag> <input.tsv> [max]
# input rows: image_url \t source_page \t title \t note
# Saves into web-raw/<tag>/<tag>-NNN.<ext>; appends rows to web-tools/map_<tag>.tsv:
#   file \t image_url \t source_page \t title \t note
set -u
ROOT=/d/Dev/Workspaces/bot-gpt-ds-codex-qq/stickers
TOOLS=$ROOT/web-tools
tag=$1; in=$2; max=${3:-100000}
dir=$ROOT/web-raw/$tag
mkdir -p "$dir"
map=$TOOLS/map_$tag.tsv
touch "$map"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
n=$(wc -l < "$map")
count=0
while IFS=$'\t' read -r url src title note; do
  [ -z "$url" ] && continue
  cut -f2 "$map" | grep -qxF -- "$url" && continue
  count=$((count+1)); [ $count -gt $max ] && break
  n=$((n+1))
  base=$(printf "%s-%03d" "$tag" "$n")
  ref=""
  case "$url" in
    *pximg.net*) ref="https://www.pixiv.net/";;
    *sinaimg.cn*|*soutula.com*) ref="";;
    *hdslb.com*) ref="https://www.bilibili.com/";;
    *) if [ -n "$src" ]; then ref=$(echo "$src" | grep -oE '^https?://[^/]+')/; fi;;
  esac
  tmp="$dir/$base.part"
  if [ -n "$ref" ]; then
    curl -sL --retry 2 -m 40 --max-filesize 20000000 -A "$UA" -e "$ref" -o "$tmp" "$url"
  else
    curl -sL --retry 2 -m 40 --max-filesize 20000000 -A "$UA" -o "$tmp" "$url"
  fi
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; echo "fail $url" >&2; continue; fi
  # detect type by magic
  magic=$(head -c 12 "$tmp" | od -An -tx1 | tr -d ' \n')
  case "$magic" in
    89504e47*) ext=png;;
    ffd8ff*) ext=jpg;;
    47494638*) ext=gif;;
    52494646????????57454250*) ext=webp;;
    *) if echo "$magic" | grep -q '^52494646'; then ext=webp; else ext=bin; fi;;
  esac
  if [ "$ext" = bin ]; then rm -f "$tmp"; echo "notimage $url" >&2; continue; fi
  mv "$tmp" "$dir/$base.$ext"
  printf "%s\t%s\t%s\t%s\t%s\n" "$base.$ext" "$url" "$src" "$title" "$note" >> "$map"
done < "$in"
echo "map rows: $(wc -l < "$map")"
