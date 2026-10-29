"""Parse pixiv ajax search JSON (fetched by curl).
Usage: python -I pixiv_parse.py <out.tsv> <json> [...]
Rows: master_url \t artwork_url \t title \t userName|tags|sl|aiType|pages"""
import json
import re
import sys


def main():
    out = sys.argv[1]
    rows, seen = [], set()
    for path in sys.argv[2:]:
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except Exception:
            continue
        data = (((d.get("body") or {}).get("illustManga") or {}).get("data")) or []
        for it in data:
            if not isinstance(it, dict) or "id" not in it:
                continue
            if it.get("xRestrict") != 0 or (it.get("sl") or 0) > 2:
                continue
            iid = it["id"]
            if iid in seen:
                continue
            seen.add(iid)
            url = it.get("url", "")
            m = re.search(r"/img/(\d{4}/\d{2}/\d{2}/\d{2}/\d{2}/\d{2})/(\d+)_p0", url)
            if not m:
                continue
            master = f"https://i.pximg.net/img-master/img/{m.group(1)}/{iid}_p0_master1200.jpg"
            tags = ",".join(it.get("tags") or [])
            note = f"{it.get('userName','')}|{tags}|sl{it.get('sl')}|ai{it.get('aiType')}|p{it.get('pageCount')}|{it.get('width')}x{it.get('height')}"
            rows.append((master, f"https://www.pixiv.net/artworks/{iid}", (it.get("title") or "").replace("\t", " "), note.replace("\t", " ")))
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
