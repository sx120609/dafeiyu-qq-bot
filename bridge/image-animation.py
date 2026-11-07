import io
import sys

from PIL import Image


def main():
    columns, rows, count, duration = map(int, sys.argv[1:])
    with Image.open(io.BytesIO(sys.stdin.buffer.read())) as source:
        # A shared palette keeps unchanged colors stable as the animation plays.
        sheet = source.convert('RGB').quantize(colors=256)
    width, height = sheet.width // columns, sheet.height // rows
    if width < 1 or height < 1:
        raise ValueError('Frame sheet is smaller than its grid')
    frames = []
    for index in range(count):
        # Relays may round image dimensions; keep every frame the same size without including the next cell.
        x = (index % columns) * sheet.width // columns
        y = (index // columns) * sheet.height // rows
        frames.append(sheet.crop((x, y, x + width, y + height)))
    output = io.BytesIO()
    frames[0].save(output, format='GIF', save_all=True, append_images=frames[1:],
                   duration=duration, loop=0, disposal=2, optimize=False)
    with Image.open(io.BytesIO(output.getvalue())) as animation:
        if animation.n_frames < 2:
            raise ValueError('Frame sheet contains no animation')
    sys.stdout.buffer.write(output.getvalue())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
