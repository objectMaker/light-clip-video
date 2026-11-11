"""Generate the app icons from scratch (no external deps).

Design: dark rounded square, a blue play triangle, and a white subtitle bar.
Pure stdlib PNG/ICO writer so it runs anywhere Python does.
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (30, 30, 46, 255)
BG2 = (24, 24, 37, 255)
BLUE = (79, 156, 249, 255)
WHITE = (235, 236, 245, 255)


def inside_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def render(size):
    px = bytearray()
    a = (0.36 * size, 0.27 * size)
    b = (0.36 * size, 0.73 * size)
    c = (0.74 * size, 0.50 * size)
    # rounded-square radius
    r = size * 0.22
    for y in range(size):
        px.append(0)  # filter byte
        for x in range(size):
            # rounded corners
            cx = min(max(x, r), size - 1 - r)
            cy = min(max(y, r), size - 1 - r)
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy > r * r:
                px.extend(BG2)
                continue
            color = BG
            if inside_triangle(x, y, a, b, c):
                color = BLUE
            # subtitle bar
            if 0.20 * size <= x <= 0.80 * size and 0.80 * size <= y <= 0.865 * size:
                color = WHITE
            px.extend(color)
    return bytes(px)


def png(size):
    raw = render(size)
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def write(name, size):
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(png(size))
    print("wrote", name, size)


sizes = {16: "16x16.png", 32: "32x32.png", 48: "48x48.png", 64: "64x64.png",
         128: "128x128.png", 256: "128x128@2x.png"}
data = {}
for s, name in sizes.items():
    d = png(s)
    data[s] = d
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(d)

# icon.png = 512 for store listing
with open(os.path.join(OUT, "icon.png"), "wb") as f:
    f.write(png(512))

# ICO embedding multiple PNGs (Windows Vista+ supports PNG-in-ICO)
ico_sizes = [16, 32, 48, 64, 128, 256]
ico_data = {s: png(s) for s in ico_sizes}
header = struct.pack("<HHH", 0, 1, len(ico_sizes))
offset = 6 + 16 * len(ico_sizes)
entries = b""
blobs = b""
for s in ico_sizes:
    d = ico_data[s]
    w = 0 if s >= 256 else s
    h = 0 if s >= 256 else s
    entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(d), offset)
    offset += len(d)
    blobs += d
with open(os.path.join(OUT, "icon.ico"), "wb") as f:
    f.write(header + entries + blobs)
print("wrote icon.ico with", len(ico_sizes), "sizes")
print("done ->", os.path.abspath(OUT))
