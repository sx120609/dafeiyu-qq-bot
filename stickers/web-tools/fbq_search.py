"""Parse fabiaoqing.com search pages fetched by curl.
Usage: python -I fbq_search.py <out.tsv> <page1.html> [page2.html ...]"""
import re
import sys


def main():
    out = sys.argv[1]
    rows = []
    seen = set()
    for path in sys.argv[2:]:
        with open(path, encoding="utf-8", errors="replace") as f:
            html = f.read()
        for m in re.finditer(r'<a href="(/biaoqing/detail/id/\d+\.html)"[^>]*>\s*<img[^>]*?data-original="([^"]+)"[^>]*?title="([^"]*)"', html, re.S):
            href, img, title = m.groups()
            if img in seen:
                continue
            seen.add(img)
            rows.append((img, "https://fabiaoqing.com" + href, title))
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
