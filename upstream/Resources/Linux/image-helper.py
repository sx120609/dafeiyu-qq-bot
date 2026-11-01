#!/usr/bin/env python3
"""Bounded local ImageIO replacement. No network, paths, or image metadata in the protocol."""
import base64, io, json, math, resource, sys, warnings
from PIL import Image, ImageOps


def shrink_gif(image, count, budget=2_900_000):
    """An animated GIF re-encoded to fit `budget`: smaller frames first, then every second or third frame (their
    delays added up, so it plays at the same speed)."""
    frames, delays = [], []
    for i in range(count):
        image.seek(i)
        frames.append(image.convert('RGBA'))
        delays.append(max(20, int(image.info.get('duration', 100) or 100)))
    loop = image.info.get('loop', 0)
    longest = max(image.size)
    for step in (1, 2, 3):
        kept = frames[::step]
        times = [sum(delays[i:i + step]) for i in range(0, count, step)]
        for edge in (480, 400, 320, 256, 200):
            if edge >= longest and step == 1 and edge != 480:
                continue
            scale = min(1., edge / longest)
            size = (max(1, round(image.size[0] * scale)), max(1, round(image.size[1] * scale)))
            resized = [frame.resize(size, Image.LANCZOS) if scale < 1 else frame for frame in kept]
            output = io.BytesIO()
            resized[0].save(output, format='GIF', save_all=True, append_images=resized[1:], duration=times, loop=loop, disposal=2)
            if output.tell() <= budget:
                return output.getvalue()
    raise ValueError('output size')


def process(payload):
    mode = payload['mode']
    limits = {'frames': (32_000_000, 20000, 150_000_000), 'artwork': (20_000_000, 12000, 40_000_000),
              'sticker': (3_000_000, 4096, 4096 * 4096), 'generated': (8_000_000, 4096, 8_000_000),
              'search': (3_000_000, 4096, 8_000_000), 'sticker-import': (16_000_000, 4096, 8_000_000)}
    byte_limit, edge, pixels = limits[mode]
    raw = base64.b64decode(payload['image'], validate=True)
    if len(raw) > byte_limit:
        raise ValueError('size')
    image = Image.open(io.BytesIO(raw))
    width, height = image.size
    # Big JPEG originals are decoded at a reduced scale straight away: far less memory and time, and the frames
    # are shrunk to 1280 px anyway.
    if mode == 'frames' and image.format == 'JPEG' and max(width, height) > 2560:
        image.draft('RGB', (2560, 2560))
    count = getattr(image, 'n_frames', 1)
    if not (1 <= width <= edge and 1 <= height <= edge and width * height <= pixels and 1 <= count <= 1000):
        raise ValueError('dimensions')
    # Stickers may be animated GIFs (QQ's 动画表情); they are checked frame by frame and kept as they are.
    animated_sticker = mode in ('sticker', 'sticker-import') and image.format == 'GIF' and count > 1
    if mode != 'frames' and count != 1 and not (animated_sticker and count <= 300):
        raise ValueError('static required')
    if animated_sticker:
        for i in range(count):
            image.seek(i)
            image.load()
        if len(raw) > 3_000_000:
            return [base64.b64encode(shrink_gif(image, count)).decode('ascii')]
        return [base64.b64encode(raw).decode('ascii')]
    options = payload.get('options', {})
    if mode == 'artwork' and (max(width, height) < options['minLongEdge'] or min(width, height) < options['minShortEdge']):
        raise ValueError('resolution')
    indexes = [0]
    if mode == 'frames':
        budget = min(count, max(1, min(6, int(options.get('maxFrames', 6)))))
        elapsed, ends = 0., []
        for i in range(count):
            image.seek(i)
            delay = float(image.info.get('duration', 100)) / 1000
            elapsed += min(10., max(.02, delay)) if math.isfinite(delay) else .1
            ends.append(elapsed)
        selected = {0}
        if budget > 1:
            selected.add(count - 1)
            for step in range(1, budget - 1):
                selected.add(next((i for i, end in enumerate(ends) if end >= elapsed * step / (budget - 1)), count - 1))
            for step in range(budget):
                if len(selected) < budget:
                    selected.add(step * (count - 1) // (budget - 1))
        indexes = sorted(selected)
    outputs = []
    for i in indexes:
        image.seek(i)
        frame = ImageOps.exif_transpose(image.copy())
        frame.load()
        if mode in ('sticker', 'generated'):
            return [base64.b64encode(raw).decode('ascii')]
        frame = frame.convert('RGBA')
        if mode in ('frames', 'artwork'):
            frame.thumbnail((1280, 1280) if mode == 'frames' else (2048, 2048))
            # Composite transparency onto white, rather than misreading it as a black background.
            background = Image.new('RGB', frame.size, 'white')
            background.paste(frame, mask=frame.getchannel('A'))
            frame = background
        output = io.BytesIO()
        if mode == 'sticker-import':
            frame.info.clear()
        frame.save(output, format='PNG' if mode in ('search', 'sticker-import') else 'JPEG', quality=80 if mode == 'frames' else 88)
        encoded = output.getvalue()
        if len(encoded) > (2_000_000 if mode == 'frames' else 3_000_000):
            raise ValueError('output size')
        outputs.append(base64.b64encode(encoded).decode('ascii'))
    return outputs


if __name__ == '__main__':
    resource.setrlimit(resource.RLIMIT_AS, (2048 * 1024**2, 2048 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    resource.setrlimit(resource.RLIMIT_FSIZE, (20_000_000, 20_000_000))
    Image.MAX_IMAGE_PIXELS = 150_000_000
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    try:
        data = sys.stdin.buffer.read(48_000_001)
        if len(data) > 48_000_000:
            raise ValueError('input size')
        print(json.dumps(process(json.loads(data)), separators=(',', ':')))
    except Exception:
        sys.exit(1)
