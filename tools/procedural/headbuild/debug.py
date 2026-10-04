"""Diagnostic renders for the build (weights, curves, seam, outline over the reference)."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .raster import render_view
from .rig import RIG_CHANNELS


def _face_colors(F, per_vertex_rgb):
    return per_vertex_rgb[F].mean(1)


def write_debug(out: Path, V, F, skin_n, rig, aux, view, ref_img, lm, path, curves, eyes, outline):
    out.mkdir(parents=True, exist_ok=True)
    Fs = F[(F < skin_n).all(1)]
    Vs = V[:skin_n]
    base = render_view(Vs, Fs, view, light=(0, 0.4, 1))
    cv2.imwrite(str(out / "shaded.png"), base)
    # weights
    tiles = []
    for ch, name in enumerate(RIG_CHANNELS):
        col = np.zeros((skin_n, 3))
        col[:, 2] = rig[:skin_n, ch]
        col[:, 1] = 0.25
        col[:, 0] = 0.25
        img = render_view(Vs, Fs, view, light=(0, 0.4, 1), colors=_face_colors(Fs, col))
        cv2.putText(img, name, (10, 40), 0, 1.2, (255, 255, 255), 2)
        tiles.append(cv2.resize(img, (392, 584)))
    cv2.imwrite(str(out / "weights.png"), np.vstack([np.hstack(tiles[:4]), np.hstack(tiles[4:])]))
    for k, name in enumerate(["ao", "convexity", "lips", "ear"]):
        col = np.repeat(aux[:skin_n, k:k + 1], 3, 1)
        img = render_view(Vs, Fs, view, light=(0, 0, 1), ambient=1.0, colors=_face_colors(Fs, col))
        cv2.imwrite(str(out / f"aux_{name}.png"), img)
    # curves + seam + eyes + outline over the reference
    ov = cv2.addWeighted(ref_img, 0.55, base, 0.45, 0)
    for c in curves:
        P = view.to_px(c["points"]).astype(np.int32)
        cv2.polylines(ov, [P], c["closed"], (60, 200, 255), 1, cv2.LINE_AA)
    P = view.to_px(V[path]).astype(np.int32)
    cv2.polylines(ov, [P], False, (0, 0, 255), 1, cv2.LINE_AA)
    for e in eyes:
        c = np.array(e["center"])
        for t in np.linspace(-1, 1, 40):
            for coef, colr in ((e["upper"], (0, 255, 0)), (e["lower"], (255, 0, 255))):
                y = (1 - t * t) * (coef[0] + coef[1] * t + coef[2] * t * t)
                p = c + np.array(e["axisX"]) * t * e["halfWidth"] + np.array(e["axisY"]) * y
                x0, y0 = view.to_px(p)[0]
                cv2.circle(ov, (int(x0), int(y0)), 1, colr, -1)
    o = np.asarray(outline)
    px = np.stack([o[:, 0] * view.height + view.width / 2, view.height / 2 - o[:, 1] * view.height], 1).astype(np.int32)
    cv2.polylines(ov, [px], True, (0, 255, 0), 1, cv2.LINE_AA)
    cv2.imwrite(str(out / "overlay.png"), ov)
