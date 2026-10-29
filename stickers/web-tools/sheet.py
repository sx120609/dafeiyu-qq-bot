"""Make labelled contact sheets for screening.
Usage: python -I sheet.py <out_prefix> <tile_px> <cols> <rows> <image> [image ...]
Each tile shows the image (first frame; for animated, the middle frame) with a label:
file stem, WxH, frame count."""
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageSequence

Image.MAX_IMAGE_PIXELS = 80_000_000


def load(path):
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    if n > 1:
        im.seek(n // 2)
    fr = im.convert("RGBA")
    bg = Image.new("RGBA", fr.size, (255, 255, 255, 255))
    bg.alpha_composite(fr)
    return bg.convert("RGB"), im.size, n


def main():
    prefix, tile, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    paths = sys.argv[5:]
    per = cols * rows
    try:
        font = ImageFont.truetype("arial.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
    label_h = 18
    for si in range(0, len(paths), per):
        chunk = paths[si:si + per]
        sheet = Image.new("RGB", (cols * tile, rows * (tile + label_h)), (200, 200, 200))
        d = ImageDraw.Draw(sheet)
        for i, p in enumerate(chunk):
            x = (i % cols) * tile
            y = (i // cols) * (tile + label_h)
            stem = os.path.splitext(os.path.basename(p))[0]
            try:
                img, size, n = load(p)
                img.thumbnail((tile - 4, tile - 4))
                sheet.paste(img, (x + (tile - img.width) // 2, y + (tile - img.height) // 2))
                lab = f"{stem.split('-')[-1]} {size[0]}x{size[1]}" + (f" A{n}" if n > 1 else "")
            except Exception as e:  # noqa
                lab = f"{stem} ERR"
            d.rectangle([x, y + tile, x + tile, y + tile + label_h], fill=(0, 0, 0))
            d.text((x + 3, y + tile + 1), lab, fill=(255, 255, 0), font=font)
        out = f"{prefix}_{si // per + 1:02d}.jpg"
        sheet.save(out, quality=85)
        print(out)


if __name__ == "__main__":
    main()
