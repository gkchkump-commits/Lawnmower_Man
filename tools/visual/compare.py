#!/usr/bin/env python3
"""Visual comparison helpers: similarity scores, side-by-side images and contact grids.

Score a render against a reference frame (luminance SSIM + PSNR inside the head region):

    python tools/visual/compare.py score --a render.png --b public/assets/avatars/reference/preview/neutral.jpg \
        [--mask public/assets/avatars/reference/masks_a.png] [--crop x0,y0,x1,y1] [--out side_by_side.png] [--json]

Build a labelled grid of images (e.g. a pose sheet):

    python tools/visual/compare.py grid --out sheet.jpg --cols 4 --height 584 img1.png img2.png ... [--labels a,b,...]

The mask is the pack's masks_a.png (R channel = silhouette alpha); it is resized to the render
size, so renders must show the full plate frame (the relief head's default framing). Without
--mask the whole image is scored. Requires numpy + opencv (same as tools/bake).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def load_rgb(path: str) -> np.ndarray:
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        # composite premultiplied/straight RGBA over black
        a = img[..., 3:4].astype(np.float32) / 255.0
        img = (img[..., :3].astype(np.float32) * a).astype(np.uint8)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def luma(rgb: np.ndarray) -> np.ndarray:
    f = rgb.astype(np.float64)
    return 0.2126 * f[..., 0] + 0.7152 * f[..., 1] + 0.0722 * f[..., 2]


def ssim_map(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Standard SSIM (Gaussian window sigma 1.5, K1=0.01, K2=0.03) on 0..255 luminance."""
    C1 = (0.01 * 255) ** 2
    C2 = (0.03 * 255) ** 2
    blur = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)  # noqa: E731
    mu_a, mu_b = blur(a), blur(b)
    saa = blur(a * a) - mu_a ** 2
    sbb = blur(b * b) - mu_b ** 2
    sab = blur(a * b) - mu_a * mu_b
    return ((2 * mu_a * mu_b + C1) * (2 * sab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (saa + sbb + C2))


def score(a_rgb: np.ndarray, b_rgb: np.ndarray, mask: np.ndarray | None) -> dict:
    if b_rgb.shape[:2] != a_rgb.shape[:2]:
        b_rgb = cv2.resize(b_rgb, (a_rgb.shape[1], a_rgb.shape[0]), interpolation=cv2.INTER_AREA)
    la, lb = luma(a_rgb), luma(b_rgb)
    m = np.ones(la.shape, bool) if mask is None else mask
    smap = ssim_map(la, lb)
    mse = float(np.mean((la[m] - lb[m]) ** 2))
    psnr = float("inf") if mse <= 1e-12 else 10 * np.log10(255.0 ** 2 / mse)
    # colour error (mean absolute, 0..255) and a blurred structural score (ignores grid aliasing)
    mae_rgb = float(np.mean(np.abs(a_rgb.astype(np.float64) - b_rgb.astype(np.float64))[m]))
    la2, lb2 = cv2.GaussianBlur(la, (0, 0), 2.0), cv2.GaussianBlur(lb, (0, 0), 2.0)
    ssim_blur = float(np.mean(ssim_map(la2, lb2)[m]))
    return {"ssim": round(float(np.mean(smap[m])), 4), "ssimBlur": round(ssim_blur, 4),
            "psnr": round(psnr, 2), "maeRGB": round(mae_rgb, 2), "pixels": int(m.sum())}


def label(img: np.ndarray, text: str) -> np.ndarray:
    out = img.copy()
    cv2.putText(out, text, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(out, text, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def cmd_score(args) -> int:
    a = load_rgb(args.a)
    b = load_rgb(args.b)
    mask = None
    if args.mask:
        mrgb = load_rgb(args.mask)
        mask = cv2.resize(mrgb[..., 0], (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA) > 127
    if args.crop:
        x0, y0, x1, y1 = [int(v) for v in args.crop.split(",")]
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
        a, b = a[y0:y1, x0:x1], b[y0:y1, x0:x1]
        mask = None if mask is None else mask[y0:y1, x0:x1]
    res = score(a, b, mask)
    if args.out:
        bb = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
        diff = np.clip(np.abs(a.astype(np.int16) - bb.astype(np.int16)) * 3, 0, 255).astype(np.uint8)
        sheet = np.hstack([label(a, "render"), label(bb, "reference"), label(diff, "|diff| x3")])
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(args.out, cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))
    if args.json:
        print(json.dumps(res))
    else:
        print(f"SSIM {res['ssim']:.4f}  SSIM(blur2) {res['ssimBlur']:.4f}  PSNR {res['psnr']:.2f} dB  "
              f"MAE {res['maeRGB']:.2f}  ({res['pixels']} px)")
    return 0


def cmd_grid(args) -> int:
    labels = args.labels.split(",") if args.labels else [Path(p).stem for p in args.images]
    tiles = []
    for p, lab in zip(args.images, labels + [""] * len(args.images)):
        img = load_rgb(p)
        h = args.height
        w = int(round(img.shape[1] * h / img.shape[0]))
        tiles.append(label(cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA), lab))
    cols = max(1, args.cols)
    tw = max(t.shape[1] for t in tiles)
    rows = []
    for r in range(0, len(tiles), cols):
        row = [cv2.copyMakeBorder(t, 0, 0, 0, tw - t.shape[1], cv2.BORDER_CONSTANT) for t in tiles[r:r + cols]]
        while len(row) < cols:
            row.append(np.zeros_like(row[0]))
        rows.append(np.hstack(row))
    sheet = np.vstack(rows)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    ok = cv2.imwrite(args.out, cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"saved {args.out} ({sheet.shape[1]}x{sheet.shape[0]})" if ok else f"failed to write {args.out}")
    return 0 if ok else 1


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score", help="similarity of a render vs a reference image")
    s.add_argument("--a", required=True, help="render (png)")
    s.add_argument("--b", required=True, help="reference (jpg/png); resized to the render")
    s.add_argument("--mask", help="masks_a.png of the pack (R = silhouette) to score only the head")
    s.add_argument("--crop", help="x0,y0,x1,y1 in render pixels")
    s.add_argument("--out", help="write render | reference | diff image")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_score)
    g = sub.add_parser("grid", help="labelled contact sheet")
    g.add_argument("--out", required=True)
    g.add_argument("--cols", type=int, default=4)
    g.add_argument("--height", type=int, default=584)
    g.add_argument("--labels")
    g.add_argument("images", nargs="+")
    g.set_defaults(fn=cmd_grid)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
