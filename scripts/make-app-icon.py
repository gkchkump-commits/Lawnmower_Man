#!/usr/bin/env python3
"""Build the application icon files from a square RGBA source image (Pillow).

    python scripts/make-app-icon.py SOURCE.png

writes
  electron/assets/icon.png  512x512 PNG (window icon, Linux packages)
  electron/assets/icon.ico  16, 24, 32, 48, 64, 128 and 256 px (Windows exe, installer, uninstaller)

The .ico stores 16-128 px as 32-bit BMP (DIB) entries and 256 px as a PNG entry, the layout
Windows Explorer, the taskbar, rcedit and NSIS all read. The tray icons (tray*.png) are separate
and drawn by scripts/make-icons.mjs.
"""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "electron" / "assets"
SIZES = (16, 24, 32, 48, 64, 128, 256)


def resized(src: Image.Image, size: int) -> Image.Image:
    # Resample in premultiplied space so transparent pixels do not bleed dark fringes.
    pre = src.convert("RGBa")
    out = pre.resize((size, size), Image.Resampling.LANCZOS)
    return out.convert("RGBA")


def dib_entry(img: Image.Image) -> bytes:
    """32-bit BGRA DIB with the doubled height and an AND mask, as stored inside .ico files."""
    w, h = img.size
    px = img.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):  # bottom-up
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    row_bytes = ((w + 31) // 32) * 4
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(row_bytes)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0)
    return header + bytes(xor) + bytes(mask)


def png_entry(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def build_ico(src: Image.Image) -> bytes:
    images = [(s, png_entry(resized(src, s)) if s >= 256 else dib_entry(resized(src, s))) for s in SIZES]
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    data = b""
    for size, blob in images:
        dim = 0 if size >= 256 else size  # 0 means 256 in the directory
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset + len(data))
        data += blob
    return head + entries + data


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    src = Image.open(argv[1]).convert("RGBA")
    if src.width != src.height:
        print(f"source must be square, got {src.width}x{src.height}", file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    png = resized(src, 512) if src.width != 512 else src
    png.save(OUT / "icon.png", "PNG", optimize=True)
    ico = build_ico(src)
    (OUT / "icon.ico").write_bytes(ico)
    print(f"wrote {OUT / 'icon.png'} (512x512) and {OUT / 'icon.ico'} ({', '.join(map(str, SIZES))} px, {len(ico)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
