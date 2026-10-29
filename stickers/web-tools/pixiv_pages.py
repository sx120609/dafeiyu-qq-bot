"""Turn pixiv /ajax/illust/<id>/pages JSON files into a download TSV.
Usage: python -I pixiv_pages.py <out.tsv> <meta.tsv> <pages_json> [...]
pages_json file names must be pages_<id>.json. meta.tsv = pixiv_parse output (for title/author).
Rows: regular_url \t artwork_url \t title #page \t note"""
import json
import os
import re
import sys


def main():
    out, meta_path = sys.argv[1], sys.argv[2]
    meta = {}
    with open(meta_path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 4:
                iid = parts[1].rsplit("/", 1)[-1]
                meta[iid] = (parts[2], parts[3])
    rows = []
    for path in sys.argv[3:]:
        m = re.search(r"pages_(\d+)\.json$", os.path.basename(path))
        if not m:
            continue
        iid = m.group(1)
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            continue
        title, note = meta.get(iid, ("", ""))
        for i, pg in enumerate(d.get("body") or []):
            url = (pg.get("urls") or {}).get("regular")
            if url:
                rows.append((url, f"https://www.pixiv.net/artworks/{iid}", f"{title} #{i + 1}", note))
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
