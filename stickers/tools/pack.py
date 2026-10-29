# Cut the generated stickers out of their magenta chroma-key background, fit them to 512x512 and write manifest.json.
# Usage: python pack.py            (paths are resolved from this script's location)
#        python pack.py --check <work folder> ...   cut single candidates to work/<folder>/cut-dark.png for review
# work/picks.json maps a sticker id to the work folder whose out.png is delivered; ids missing from it are skipped.
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
WORK = os.path.join(ROOT, "work")
OUT = os.path.join(ROOT, "generated")
SIDE = 512
MARGIN = 16
DARK = (40, 42, 48, 255)


def cut_out(image):
    """RGBA with the flat magenta key removed; images that already have alpha keep it. Edge spill is cleaned either way."""
    rgba = np.asarray(image.convert("RGBA")).astype(np.float32)
    red, green, blue = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    if rgba[..., 3].min() < 8:
        alpha = rgba[..., 3] / 255
        colour = rgba[..., :3].copy()
    else:
        # How magenta a pixel is: both red and blue far above green.
        key = np.minimum(red, blue) - green
        alpha = np.clip(1 - (key - 60) / (170 - 60), 0, 1)
        # Un-mix the key colour from anti-aliased edge pixels so no pink fringe is left.
        safe = np.maximum(alpha, 0.05)[..., None]
        background = np.array([255, 0, 255], dtype=np.float32)
        unmixed = (rgba[..., :3] - (1 - alpha[..., None]) * background) / safe
        edge = (alpha < 0.999)[..., None]
        colour = np.where(edge, np.clip(unmixed, 0, 255), rgba[..., :3])
    # Remaining spill on pixels near the transparent edge: pull red and blue down to green.
    spill = np.clip(np.minimum(colour[..., 0], colour[..., 2]) - colour[..., 1], 0, None)
    solid = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(7))
    near = np.asarray(solid).astype(np.float32) < 250
    colour[..., 0] = np.where(near, colour[..., 0] - spill, colour[..., 0])
    colour[..., 2] = np.where(near, colour[..., 2] - spill, colour[..., 2])
    out = np.dstack([colour, alpha * 255])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def drop_specks(image, minimum_share=0.0015):
    """Remove small disconnected opaque islands (stray key leftovers), keeping real floating props."""
    alpha = np.asarray(image.getchannel("A")).copy()
    alpha[alpha < 16] = 0
    height, width = alpha.shape
    # Pad by one pixel so neighbour lookups never leave the array.
    padded = np.zeros((height + 2, width + 2), dtype=np.uint8)
    padded[1:-1, 1:-1] = alpha > 0
    stride = width + 2
    mask = bytearray(padded.tobytes())
    labels = [0] * len(mask)
    sizes = [0]
    current = 0
    for start in np.flatnonzero(padded).tolist():
        if labels[start]:
            continue
        current += 1
        stack = [start]
        labels[start] = current
        count = 0
        while stack:
            position = stack.pop()
            count += 1
            for neighbour in (position - 1, position + 1, position - stride, position + stride):
                if mask[neighbour] and not labels[neighbour]:
                    labels[neighbour] = current
                    stack.append(neighbour)
        sizes.append(count)
    total = max(1, int(sum(sizes)))
    small = [index for index, size in enumerate(sizes) if index and size < total * minimum_share]
    if small:
        grid = np.array(labels, dtype=np.int32).reshape(height + 2, stride)[1:-1, 1:-1]
        alpha[np.isin(grid, small)] = 0
    image.putalpha(Image.fromarray(alpha))
    return image, len(small)


def fit(image):
    box = image.getbbox()
    image = image.crop(box)
    room = SIDE - 2 * MARGIN
    scale = room / max(image.size)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    image = image.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", (SIDE, SIDE), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((SIDE - image.width) // 2, (SIDE - image.height) // 2))
    return canvas


def fringe(image):
    """Count visible pixels that still look magenta."""
    rgba = np.asarray(image).astype(np.int32)
    visible = rgba[..., 3] > 20
    pinkish = (np.minimum(rgba[..., 0], rgba[..., 2]) - rgba[..., 1] > 60) & (rgba[..., 0] > 140) & (rgba[..., 2] > 140)
    return int((visible & pinkish).sum())


def on_background(image, colour):
    tile = Image.new("RGBA", image.size, colour)
    tile.alpha_composite(image)
    return tile.convert("RGB")


def process(path):
    image = Image.open(path)
    cut = cut_out(image)
    cut, specks = drop_specks(cut)
    return fit(cut), specks


def sheet(images, colour, path):
    columns = 6
    cell = 260
    rows = (len(images) + columns - 1) // columns
    board = Image.new("RGB", (columns * cell + 8, rows * cell + 8), colour[:3])
    for index, image in enumerate(images):
        small = image.resize((cell - 8, cell - 8), Image.LANCZOS)
        board.paste(on_background(small, colour), (8 + (index % columns) * cell, 8 + (index // columns) * cell))
    board.save(path)


def check(folders):
    for folder in folders:
        packed, specks = process(os.path.join(WORK, folder, "out.png"))
        on_background(packed, DARK).save(os.path.join(WORK, folder, "cut-dark.png"))
        mode = Image.open(os.path.join(WORK, folder, "out.png")).mode
        print(folder, "mode", mode, "specks", specks, "fringe", fringe(packed))


def pack():
    catalog = json.load(open(os.path.join(TOOLS, "catalog.json"), encoding="utf-8"))
    picks = json.load(open(os.path.join(WORK, "picks.json"), encoding="utf-8"))
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    images = []
    for sticker in catalog["stickers"]:
        folder = picks.get(sticker["id"])
        name = f"{sticker['id']}-{sticker['slug']}.png"
        target = os.path.join(OUT, name)
        if not folder:
            if os.path.exists(target):
                os.remove(target)
            print("skip", sticker["id"])
            continue
        packed, specks = process(os.path.join(WORK, folder, "out.png"))
        packed.save(target, optimize=True)
        size = os.path.getsize(target)
        images.append(packed)
        manifest.append({
            "file": name,
            "title": sticker["title"],
            "emotion": sticker["emotion"],
            "context": sticker["context"],
            "author": catalog["characters"][sticker["who"]]["author"],
        })
        print(name, "from", folder, f"{size // 1024} KB", "specks", specks, "fringe", fringe(packed))
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    sheet(images, DARK, os.path.join(WORK, "preview-dark.png"))
    sheet(images, (236, 236, 232, 255), os.path.join(WORK, "preview-light.png"))
    print("packed", len(manifest))


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--check":
        check(sys.argv[2:])
    else:
        pack()
