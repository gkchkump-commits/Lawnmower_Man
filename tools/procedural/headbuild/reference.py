"""Measurements of the reference frame (docs/reference/neutral.jpg): landmarks + silhouette.

Only geometry is taken from the reference (where the eyes, lips and outline are); no pixels
of it end up in the model.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class ReferenceProfile:
    width: int
    height: int
    landmarks_px: np.ndarray          # (478, 3) MediaPipe landmarks in px
    rows_px: np.ndarray               # sample rows (px)
    half_width_px: np.ndarray         # silhouette half width per row (px, from the centre line)
    center_x_px: float
    top_px: float                     # top of the cranium
    chin_px: float                    # bottom of the chin
    # lower face: rows (px) and half width (px) of the bright face edge (excludes the dim neck
    # and the particles beside the jaw, which widen `half_width_px` there)
    jaw_rows_px: np.ndarray = field(default_factory=lambda: np.zeros(0))
    jaw_half_px: np.ndarray = field(default_factory=lambda: np.zeros(0))
    # the glowing eye openings measured in the image, screen-left eye first: dicts with
    # "pupil" (2,), "upper" / "lower" (n, 2) lid boundary points in px, left -> right; [] if not found
    almonds: list = field(default_factory=list)

    def to_screen(self, p_px: np.ndarray) -> np.ndarray:
        """px -> screen-plane world units (plate is 1 unit tall, origin at the centre)."""
        p = np.atleast_2d(p_px)
        return np.stack([(p[:, 0] - self.width / 2) / self.height, (self.height / 2 - p[:, 1]) / self.height], 1)

    def lm(self, idx) -> np.ndarray:
        """Screen-plane position of landmark index / list of indices (mean)."""
        idx = np.atleast_1d(idx)
        return self.to_screen(self.landmarks_px[idx, :2]).mean(0)


# the blurred, thresholded silhouette includes the hologram's outer glow; the surface edge lies
# this many px inside it (checked by eye on the 784 x 1168 frame)
GLOW_PX = 14.0


# MediaPipe iris centres (screen-left eye, screen-right eye)
IRIS_CENTERS = (468, 473)


def find_pupil(luma: np.ndarray, near_px, search=60):
    """The dark pupil inside a glowing eye: brightest blob (blur 6 px) near `near_px`, then the
    darkest point (blur 2 px) within 20 px of it."""
    x0, y0 = int(near_px[0]) - search, int(near_px[1]) - search
    sub = luma[max(0, y0):max(0, y0 + 2 * search), max(0, x0):max(0, x0 + 2 * search)]
    if sub.shape[0] < 41 or sub.shape[1] < 41:
        return np.asarray(near_px[:2], float)            # (near / outside the image border)
    x0, y0 = max(0, x0), max(0, y0)
    b = cv2.GaussianBlur(sub, (0, 0), 6)
    by, bx = np.unravel_index(np.argmax(b), b.shape)
    s = cv2.GaussianBlur(sub, (0, 0), 2)
    wy0, wx0 = max(0, by - 20), max(0, bx - 20)
    win = s[wy0:by + 20, wx0:bx + 20]
    py, px = np.unravel_index(np.argmin(win), win.shape)
    return np.array([x0 + wx0 + px, y0 + wy0 + py], float)


def correct_eyes(img_bgr: np.ndarray, landmarks_px: np.ndarray, reach_px=95.0):
    """MediaPipe misplaces the hologram's glowing eyes (~20-30 px too low on neutral.jpg). Shift
    the landmarks around each eye so its iris centre lands on the pupil measured in the image
    (Gaussian falloff: the lids move fully, the brows partly, the rest of the face not)."""
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    L = np.asarray(landmarks_px, float).copy()
    out = L.copy()
    offsets = []
    for idx in IRIS_CENTERS:
        if idx >= len(L):
            offsets.append([0.0, 0.0])
            continue
        c = L[idx, :2]
        off = find_pupil(g, c) - c
        if np.linalg.norm(off) > 60:          # implausible: keep MediaPipe
            off = np.zeros(2)
        w = np.exp(-(np.linalg.norm(L[:, :2] - c, axis=1) / reach_px) ** 2)
        out[:, :2] += w[:, None] * off
        offsets.append(off.tolist())
    return out, offsets


# the eye opening: the lid margins are the edge of the glow brighter than this (blurred luma)
ALMOND_LUMA = 175.0


def measure_almond(gray: np.ndarray, pupil, th=ALMOND_LUMA, box=(170, 60), step=2, max_size=(190, 85)):
    """Lid boundaries of a glowing eye: the glow brighter than a threshold (blur 2.5 px) in a box
    around the pupil, holes (the dark pupil, gaps between iris rays) filled, the component
    containing the pupil; per column its top and bottom. The threshold starts at `th` and rises
    until the component no longer merges with neighbouring glows (orbit lines, cheek light).
    Returns {"pupil", "upper", "lower", "threshold"} (px, left -> right) or None."""
    for t in np.arange(th, th + 60, 5.0):
        a = _almond_at(gray, pupil, t, box, step)
        if a is None:
            continue
        w_ = a["upper"][-1, 0] - a["upper"][0, 0]
        h_ = np.max(a["lower"][:, 1] - a["upper"][:, 1])
        if w_ <= max_size[0] and h_ <= max_size[1]:
            a["threshold"] = float(t)
            return a
    return None


def _almond_at(gray, pupil, th, box, step):
    px, py = int(round(pupil[0])), int(round(pupil[1]))
    bx, by = box
    h, w = gray.shape
    x0, x1, y0, y1 = max(0, px - bx), min(w, px + bx), max(0, py - by), min(h, py + by)
    b = cv2.GaussianBlur(gray, (0, 0), 2.5)[y0:y1, x0:x1]
    m = (b > th).astype(np.uint8)
    # fill holes: everything not reachable from the box border through dark pixels
    inv = np.pad(1 - m, 1, constant_values=1).astype(np.uint8)
    ff = inv.copy()
    cv2.floodFill(ff, None, (0, 0), 2)
    m = np.where(ff[1:-1, 1:-1] == 2, 0, 1).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    k = lab[py - y0, px - x0]
    if k == 0:
        return None
    x, y, ww, hh, area = st[k]
    if ww < 60 or hh < 20 or y == 0 or y + hh >= y1 - y0:
        return None                     # too small, or it runs out of the box (merged glow)
    xs, yu, yl = [], [], []
    for cx in range(x, x + ww, step):
        col = np.where(lab[:, cx] == k)[0]
        if len(col):
            xs.append(cx + x0)
            yu.append(col.min() + y0)
            yl.append(col.max() + y0)
    return {"pupil": np.array([px, py], float), "upper": np.c_[xs, yu].astype(float),
            "lower": np.c_[xs, yl].astype(float)}


def measure(img_bgr: np.ndarray, landmarks_px: np.ndarray) -> ReferenceProfile:
    h, w = img_bgr.shape[:2]
    landmarks_px, offsets = correct_eyes(img_bgr, landmarks_px)
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    almonds = []
    for idx in IRIS_CENTERS:
        a = measure_almond(g, landmarks_px[idx, :2]) if idx < len(landmarks_px) else None
        if a is None:
            almonds = []
            break
        almonds.append(a)
    b = cv2.GaussianBlur(g, (0, 0), 6)
    m = (b > 30).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if n < 2:
        raise RuntimeError("reference silhouette not found")
    big = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    m = lab == big
    cx = float(landmarks_px[[1, 6, 168, 152], 0].mean())  # facial midline
    rows = np.arange(0, h, 4)
    half = np.full(len(rows), np.nan)
    for k, y in enumerate(rows):
        xs = np.where(m[y])[0]
        if len(xs):
            # particles only ever widen one side, so the narrower side is the better estimate
            half[k] = max(0.0, min(cx - xs.min(), xs.max() - cx) - GLOW_PX)
    ys = np.where(m.any(1))[0]
    top = float(ys.min()) + GLOW_PX * 0.6
    # chin: the bright rim under the chin is the last bright run on the midline column
    col = cv2.GaussianBlur(g, (0, 0), 3)[:, int(cx) - 30:int(cx) + 30].mean(1)
    lip_y = int(landmarks_px[17, 1])
    below = np.arange(lip_y + 40, min(h - 1, lip_y + 320))
    drop = below[np.argmax(col[below] - col[below + 8])]   # strongest bright -> dark step
    chin = float(drop + 2)
    jr, jh = jaw_profile(g, landmarks_px, cx, chin)
    return ReferenceProfile(w, h, landmarks_px, rows, half, cx, top, chin, jr, jh, almonds)


# the face's lit edge band is much brighter than the neck behind the jaw and most particles
JAW_EDGE_LUMA = 70.0


def jaw_profile(gray: np.ndarray, landmarks_px: np.ndarray, cx: float, chin_px: float, step: int = 8):
    """Half width of the lower face (mouth corners -> chin) from the bright face edge, per row.
    The narrower side wins (a particle only ever widens one side); the profile is made
    monotone (the jaw only narrows toward the chin) and lightly smoothed."""
    b = cv2.GaussianBlur(gray, (0, 0), 3)
    top = int(landmarks_px[[61, 291], 1].mean())
    rows = np.arange(top, int(chin_px) - 4, step)
    half = []
    for y in rows:
        xs = np.where(b[y] > JAW_EDGE_LUMA)[0]
        half.append(max(0.0, min(cx - xs.min(), xs.max() - cx)) if len(xs) else np.nan)
    half = np.asarray(half, float)
    ok = np.isfinite(half)
    if ok.sum() >= 2:
        half = np.interp(np.arange(len(half)), np.where(ok)[0], half[ok])
        half = np.minimum.accumulate(half)
        half = np.convolve(np.r_[half[0], half, half[-1]], [0.25, 0.5, 0.25], mode="valid")
    return rows.astype(float), half
