"""Render a strip of evenly spaced frames of an animated image for choosing one.
Usage: python -I frames.py <out.jpg> <count> <image>"""
import sys

from PIL import Image, ImageDraw


def main():
    out, count, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    idxs = sorted(set(int(i * (n - 1) / max(count - 1, 1)) for i in range(count)))
    tile = 260
    sheet = Image.new("RGB", (tile * len(idxs), tile + 18), (200, 200, 200))
    d = ImageDraw.Draw(sheet)
    for k, i in enumerate(idxs):
        im.seek(i)
        fr = im.convert("RGBA")
        bg = Image.new("RGBA", fr.size, (255, 255, 255, 255))
        bg.alpha_composite(fr)
        fr = bg.convert("RGB")
        fr.thumbnail((tile - 4, tile - 4))
        sheet.paste(fr, (k * tile + (tile - fr.width) // 2, (tile - fr.height) // 2))
        d.text((k * tile + 4, tile + 2), f"frame {i}/{n}", fill=(0, 0, 0))
    sheet.save(out, quality=88)
    print(out, n)


if __name__ == "__main__":
    main()
