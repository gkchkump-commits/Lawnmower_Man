"""Small numeric / image helpers shared by the bake stages."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import cv2
import numpy as np


def log(msg: str) -> None:
    print(f"[bake] {msg}", flush=True)


def sha256_file(path: str | os.PathLike, limit: int | None = None) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            if limit is not None and f.tell() >= limit:
                break
    return h.hexdigest()


def to_float(img_bgr_u8: np.ndarray) -> np.ndarray:
    """uint8 BGR -> float32 RGB in 0..1."""
    return cv2.cvtColor(img_bgr_u8, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0


def luminance(rgb: np.ndarray) -> np.ndarray:
    """Rec.709 luma of a float RGB image (gamma-encoded values, which is what we want for masks)."""
    return (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]).astype(np.float32)


def smoothstep(e0: float, e1: float, x):
    t = np.clip((np.asarray(x, dtype=np.float32) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def disk(radius: int) -> np.ndarray:
    r = int(max(1, radius))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def polygon_mask(shape, pts, value: float = 1.0) -> np.ndarray:
    m = np.zeros(shape[:2], np.float32)
    cv2.fillPoly(m, [np.round(np.asarray(pts) * 16).astype(np.int32)], value, lineType=cv2.LINE_AA, shift=4)
    return m


def feather(mask: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return mask.astype(np.float32)
    return cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigma)


def largest_component(binary: np.ndarray) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), connectivity=8)
    if n <= 1:
        return binary.astype(bool)
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == idx


def fill_holes(binary: np.ndarray) -> np.ndarray:
    # Pad with a 1px background frame so a single flood fill from the corner reaches every
    # background pixel connected to the border; whatever stays unfilled is foreground or a hole.
    b = np.pad(binary.astype(np.uint8), 1)
    h, w = b.shape
    ff_mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(b, ff_mask, (0, 0), 2)
    return (b != 2)[1:-1, 1:-1]


def ensure_dir(p: str | os.PathLike) -> Path:
    path = Path(p)
    path.mkdir(parents=True, exist_ok=True)
    return path


def hex_color(rgb01) -> str:
    r, g, b = [int(round(float(np.clip(c, 0, 1)) * 255)) for c in rgb01[:3]]
    return f"#{r:02x}{g:02x}{b:02x}"


def round_list(a, nd: int = 2):
    """Flatten + round a numeric array for compact JSON (ints when nd == 0)."""
    flat = np.asarray(a, dtype=np.float64).ravel()
    if nd == 0:
        return [int(v) for v in np.round(flat).astype(np.int64)]
    out = np.round(flat, nd)
    # Avoid "-0.0" noise in the JSON.
    out[out == 0] = 0.0
    return [float(v) for v in out]


def inside_polygon(points, poly, margin: float = 0.0) -> np.ndarray:
    """Boolean mask of points inside a polygon, grown by ``margin`` px (negative shrinks).

    Uses cv2.pointPolygonTest's signed distance (positive inside).
    """
    contour = np.asarray(poly, np.float32).reshape(-1, 1, 2)
    pts = np.asarray(points, np.float64)
    out = np.empty(len(pts), bool)
    for i, (x, y) in enumerate(pts[:, :2]):
        out[i] = cv2.pointPolygonTest(contour, (float(x), float(y)), True) >= -margin
    return out
