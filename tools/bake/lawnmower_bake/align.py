"""Frame-to-frame alignment: translation registration on high-passed images (+ phase correlation).

MediaPipe landmarks drift with expression on this footage, and ECC is unreliable on the fine
hologram grid, so frames are aligned by exhaustive NCC over integer shifts with a sub-pixel fit.
"""

from __future__ import annotations

import cv2
import numpy as np


def translation(dx: float, dy: float) -> np.ndarray:
    return np.float32([[1, 0, dx], [0, 1, dy]])


def warp(img: np.ndarray, M: np.ndarray, size_wh) -> np.ndarray:
    return cv2.warpAffine(img, M, tuple(int(v) for v in size_wh), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REFLECT)


def highpass(gray: np.ndarray, sigma: float = 4.0) -> np.ndarray:
    g = gray.astype(np.float32)
    return g - cv2.GaussianBlur(g, (0, 0), sigma)


def register_translation(ref_gray: np.ndarray, img_gray: np.ndarray, mask: np.ndarray,
                         init=(0.0, 0.0), search: int = 10) -> tuple[float, float, float]:
    """Translation (tx, ty) so that ``warp(img, translation(tx, ty))`` matches ``ref`` inside mask.

    Exhaustive normalized cross-correlation of high-passed images over integer shifts around
    ``init`` followed by a parabolic sub-pixel fit. The hologram's fine grid makes this far more
    reliable than ECC or landmark fits (MediaPipe landmarks drift with expression). Returns
    (tx, ty, ncc).
    """
    H, W = ref_gray.shape[:2]
    ys, xs = np.nonzero(mask > 0.05)
    if len(ys) < 50:
        return float(init[0]), float(init[1]), 0.0
    m = 2 + search + int(np.ceil(max(abs(init[0]), abs(init[1]))))
    y0, y1 = max(0, ys.min() - m), min(H, ys.max() + m + 1)
    x0, x1 = max(0, xs.min() - m), min(W, xs.max() + m + 1)
    ref = highpass(ref_gray)[y0:y1, x0:x1]
    w = mask[y0:y1, x0:x1].astype(np.float32)
    base = warp(highpass(img_gray), translation(*init), (W, H))[y0:y1, x0:x1]
    a = ref * w
    na = np.sqrt((a * a).sum()) + 1e-9
    scores = np.full((2 * search + 1, 2 * search + 1), -1.0, np.float64)
    for iy, dy in enumerate(range(-search, search + 1)):
        for ix, dx in enumerate(range(-search, search + 1)):
            b = np.roll(base, (dy, dx), axis=(0, 1)) * w
            scores[iy, ix] = float((a * b).sum() / (na * (np.sqrt((b * b).sum()) + 1e-9)))
    iy, ix = np.unravel_index(int(np.argmax(scores)), scores.shape)

    def sub(c_m, c_0, c_p):
        d = c_m - 2 * c_0 + c_p
        return 0.0 if abs(d) < 1e-12 else float(np.clip(0.5 * (c_m - c_p) / d, -0.5, 0.5))

    fx = sub(scores[iy, ix - 1], scores[iy, ix], scores[iy, ix + 1]) if 0 < ix < 2 * search else 0.0
    fy = sub(scores[iy - 1, ix], scores[iy, ix], scores[iy + 1, ix]) if 0 < iy < 2 * search else 0.0
    return (float(init[0] + ix - search + fx), float(init[1] + iy - search + fy), float(scores[iy, ix]))


def phase_shift(ref_gray: np.ndarray, img_gray: np.ndarray) -> tuple[float, float]:
    win = cv2.createHanningWindow((ref_gray.shape[1], ref_gray.shape[0]), cv2.CV_32F)
    (dx, dy), _ = cv2.phaseCorrelate(ref_gray.astype(np.float32), img_gray.astype(np.float32), win)
    return float(dx), float(dy)
