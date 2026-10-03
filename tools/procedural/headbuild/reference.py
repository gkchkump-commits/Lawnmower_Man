"""Measurements of the reference frame (docs/reference/neutral.jpg): landmarks + silhouette.

Only geometry is taken from the reference (where the eyes, lips and outline are); no pixels
of it end up in the model.
"""

from __future__ import annotations

from dataclasses import dataclass

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


def measure(img_bgr: np.ndarray, landmarks_px: np.ndarray) -> ReferenceProfile:
    h, w = img_bgr.shape[:2]
    g = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
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
    return ReferenceProfile(w, h, landmarks_px, rows, half, cx, top, chin)
