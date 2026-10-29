"""Parse Bing image search async HTML pages fetched by curl.
Usage: python -I bing_parse.py <out.tsv> <page.html> [...]
Writes: murl \t purl \t title \t width x height"""
import html as htmlmod
import json
import re
import sys


def main():
    out = sys.argv[1]
    rows = []
    seen = set()
    for path in sys.argv[2:]:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
        for m in re.finditer(r'\bm="([^"]+)"', text):
            raw = htmlmod.unescape(m.group(1))
            try:
                d = json.loads(raw)
            except Exception:
                continue
            murl = d.get("murl")
            if not murl or murl in seen:
                continue
            seen.add(murl)
            rows.append((murl, d.get("purl", ""), (d.get("t") or "").replace("\t", " "), ""))
        # sizes appear in separate attributes; best-effort
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
