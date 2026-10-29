"""Parse qiubiaoqing.com album pages fetched by curl.
Usage: python -I qbq_parse.py <out.tsv> <page.html> [...]
Writes rows: original_image_url \t detail_page_url \t title \t album"""
import re
import sys


def main():
    out = sys.argv[1]
    rows, seen = [], set()
    for path in sys.argv[2:]:
        with open(path, encoding="utf-8", errors="replace") as f:
            html = f.read()
        for m in re.finditer(r'<a href="(https://www\.qiubiaoqing\.com/img_detail/\d+\.html)" title="([^"]*)"[^>]*>\s*<img src="(https://imgs\.qiubiaoqing\.com/qiubiaoqing/imgs/[^"?]+)', html):
            detail, title, img = m.groups()
            if img in seen:
                continue
            seen.add(img)
            rows.append((img, detail, title.replace("\t", " "), path.rsplit("/", 1)[-1]))
    with open(out, "w", encoding="utf-8") as f:
        for r in rows:
            f.write("\t".join(r) + "\n")
    print(len(rows), "rows")


if __name__ == "__main__":
    main()
