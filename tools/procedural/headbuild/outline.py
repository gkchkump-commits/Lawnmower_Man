"""Rest-pose silhouette polygon (screen plane, world units) for hit testing and the aura."""

from __future__ import annotations

import cv2

from .raster import render_mask


def silhouette(V, F, view, y_min=-0.43, max_points=96):
    m = render_mask(V, F, view)[:, :view.width]
    cut = int(round(view.height / 2 - y_min * view.height))
    m[max(0, cut):] = 0
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    eps = 1.0
    while True:
        a = cv2.approxPolyDP(c, eps, True)
        if len(a) <= max_points:
            break
        eps *= 1.25
    return view.px_to_screen(a[:, 0, :].astype(float))
