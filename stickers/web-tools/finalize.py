"""Build final sticker files and manifest.json.
Usage: python -I finalize.py <spec.tsv> <raw_dir> <tools_dir> <out_dir>
spec columns: raw_rel \t out_stem \t frame(- for static) \t title \t emotion \t context \t author_override(- for auto)
raw_rel like "nl/nl-108.gif"; its map is <tools_dir>/map_<tag>.tsv (tag = first dir component)."""
import json
import os
import shutil
import sys
from urllib.parse import urlsplit, urlunsplit

from PIL import Image

EMOTIONS = {"neutral", "joy", "smug", "annoyed", "sad", "sleepy", "flustered", "teasing"}
MAX_BYTES = 3 * 1024 * 1024


def load_maps(tools_dir):
    maps = {}
    for name in os.listdir(tools_dir):
        if name.startswith("map_") and name.endswith(".tsv"):
            tag = name[4:-4]
            with open(os.path.join(tools_dir, name), encoding="utf-8") as f:
                for line in f:
                    p = line.rstrip("\n").split("\t")
                    if len(p) >= 3:
                        maps[(tag, p[0])] = p
    return maps


def clean_url(u):
    if not u:
        return ""
    s = urlsplit(u)
    if s.scheme not in ("http", "https"):
        return ""
    path = s.path
    if s.query:
        qs = dict(p.split("=", 1) for p in s.query.split("&") if "=" in p)
        # bilibili mobile article link -> canonical path form
        if s.netloc.endswith("bilibili.com") and path.startswith("/read/mobile") and qs.get("id", "").isdigit():
            path = f"/read/cv{qs['id']}"
        elif "id" in qs or "tid" in qs or path in ("", "/") or path.endswith("/"):
            # the page identity lives only in the query string; cannot express it without one
            if not (s.netloc.endswith("linux.do")):
                return ""
    return urlunsplit(("https", s.netloc, path, "", ""))


def main():
    spec, raw_dir, tools_dir, out_dir = sys.argv[1:5]
    maps = load_maps(tools_dir)
    os.makedirs(out_dir, exist_ok=True)
    manifest = []
    names = set()
    with open(spec, encoding="utf-8") as f:
        rows = [[c.strip() for c in l.rstrip("\n").split(" || ")] for l in f if l.strip() and not l.startswith("#")]
    for r in rows:
        raw_rel, stem, frame, title, emotion, context, author = (r + ["-"] * 7)[:7]
        assert emotion in EMOTIONS, (stem, emotion)
        assert len(title) <= 80 and len(context) <= 300, stem
        assert stem not in names, stem
        names.add(stem)
        tag, fname = raw_rel.split("/", 1)
        m = maps.get((tag, fname))
        assert m, raw_rel
        src_page = clean_url(m[2])
        note = m[4] if len(m) > 4 else ""
        if author == "-":
            author = note.split("|", 1)[0] if tag == "px" else ""
        path = os.path.join(raw_dir, raw_rel)
        im = Image.open(path)
        n = getattr(im, "n_frames", 1)
        fmt = im.format
        if n > 1 or frame != "-":
            idx = int(frame) if frame != "-" else 0
            im.seek(idx)
            fr = im.convert("RGBA")
            if fr.getextrema()[3][0] == 255:
                fr = fr.convert("RGB")
            out = os.path.join(out_dir, stem + ".png")
            fr.save(out, optimize=True)
        else:
            ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}.get(fmt)
            if ext and os.path.getsize(path) <= MAX_BYTES and max(im.size) <= 4096:
                out = os.path.join(out_dir, stem + ext)
                shutil.copyfile(path, out)
            else:
                img = im.convert("RGB")
                img.thumbnail((4096, 4096))
                out = os.path.join(out_dir, stem + ".jpg")
                img.save(out, quality=92)
        # verify
        chk = Image.open(out)
        w, h = chk.size
        size = os.path.getsize(out)
        assert size <= MAX_BYTES, (out, size)
        assert max(w, h) <= 4096, out
        assert getattr(chk, "n_frames", 1) == 1, out
        print(f"{os.path.basename(out)}\t{w}x{h}\t{size // 1024}KB\t{chk.format}")
        manifest.append({
            "file": os.path.basename(out),
            "title": title,
            "emotion": emotion,
            "context": context,
            "source": src_page,
            "author": author,
        })
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(len(manifest), "entries")


if __name__ == "__main__":
    main()
