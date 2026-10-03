"""Eye parameters for the shader-drawn eyes (the scan has closed lids).

Each eye is an analytic eyeball behind an almond aperture defined in a local frame on the lid
surface. The aperture follows the reference eye shape (MediaPipe lid contours of the reference
frame), projected onto the warped head.
"""

from __future__ import annotations

import numpy as np

from . import mesh_ops as mo
from .landmarks import EYE_L_LOWER, EYE_L_UPPER, EYE_R_LOWER, EYE_R_UPPER
from .raycast import Caster

EYEBALL_RADIUS = 0.04       # world units (~12 mm)
# The hologram's glowing almond reads a little larger than MediaPipe's lid contour.
APERTURE_SCALE_X = 1.12
APERTURE_SCALE_Y = 1.62
# Measured glowing openings (reference.measure_almond) include the lid-margin glow: the drawn
# aperture is a little smaller so the rendered glow ends where the reference's does.
ALMOND_SCALE_X = 0.97
ALMOND_SCALE_Y = 0.86
IRIS_RADIUS = 0.0254        # world units at the plate (1.3x the first build's 0.0195)
PUPIL_RATIO = 0.33


def _fit_lid(t, y):
    """y(t) = (1 - t^2) * (c0 + c1 t + c2 t^2), least squares."""
    t = np.asarray(t)
    A = np.stack([(1 - t * t), (1 - t * t) * t, (1 - t * t) * t * t], 1)
    c, *_ = np.linalg.lstsq(A, np.asarray(y), rcond=None)
    return c


def eye_params(V, F, ref, view):
    cast = Caster(V, F)
    N = mo.vertex_normals(V, F)
    eyes = []
    almonds = getattr(ref, "almonds", None) or [None, None]
    for (upper, lower), almond in zip(((EYE_L_UPPER, EYE_L_LOWER), (EYE_R_UPPER, EYE_R_LOWER)), almonds):
        if almond is not None:
            # the glowing opening measured in the image (MediaPipe misplaces the hologram's eyes)
            up_s = ref.to_screen(almond["upper"])
            lo_s = ref.to_screen(almond["lower"])
            c_a, c_b = 0.5 * (up_s[0] + lo_s[0]), 0.5 * (up_s[-1] + lo_s[-1])
            scale_x, scale_y = ALMOND_SCALE_X, ALMOND_SCALE_Y
        else:
            up_s = ref.to_screen(ref.landmarks_px[upper, :2])
            lo_s = ref.to_screen(ref.landmarks_px[lower, :2])
            # corners: first / last of each contour (shared); order them screen left -> right
            c_a, c_b = up_s[0], up_s[-1]
            if c_a[0] > c_b[0]:
                c_a, c_b = c_b, c_a
                up_s, lo_s = up_s[::-1], lo_s[::-1]
            scale_x, scale_y = APERTURE_SCALE_X, APERTURE_SCALE_Y
        center_s = 0.5 * (c_a + c_b)
        o, d = view.ray(np.stack([center_s, c_a, c_b]))
        hit, tri = cast.first_hit(o, d)
        if np.isnan(hit).any():
            raise RuntimeError("eye: reference eye does not land on the head surface")
        E, A, B = hit
        # local frame: z mostly forward (eyes look ahead), x from the screen-left to the
        # screen-right corner, y up
        near = np.linalg.norm(V - E, axis=1) < 0.03
        n = N[near].mean(0)
        n /= np.linalg.norm(n)
        ez = 0.35 * n + 0.65 * np.array([0, 0, 1.0])
        ez /= np.linalg.norm(ez)
        ex = B - A
        ex -= ez * (ex @ ez)
        ex /= np.linalg.norm(ex)
        ey = np.cross(ez, ex)
        half = 0.5 * np.linalg.norm(B - A) * scale_x
        # lid curves in the frame (screen -> world scale at the eye's depth)
        k = (view.dist - E[2]) / view.dist
        sx = (c_b - c_a) / np.linalg.norm(c_b - c_a)
        sy = np.array([-sx[1], sx[0]])
        half_s = 0.5 * np.linalg.norm(c_b - c_a)

        def local(pts):
            rel = pts - center_s
            return rel @ sx / half_s, (rel @ sy) * k

        tu, yu = local(up_s)
        tl, yl = local(lo_s)
        cu = _fit_lid(tu, yu) * scale_y
        cl = _fit_lid(tl, yl) * scale_y
        # the corner midpoint is not the eye's optical centre: centre the ball under the iris
        if almond is not None:
            iris_s = ref.to_screen(almond["pupil"][None])[0]
        else:
            iris_s = 0.5 * (up_s[len(up_s) // 2] + lo_s[len(lo_s) // 2])
        o, d = view.ray(iris_s[None])
        I, _ = cast.first_hit(o, d)
        I = I[0] if not np.isnan(I).any() else E
        ball = I - ez * (EYEBALL_RADIUS * 0.82)
        # the reference iris is a large glowing disc (~30 px radius on the 1168 px plate) with a
        # clearly visible dark pupil (~1/3 of it)
        iris_r = IRIS_RADIUS * k
        eyes.append({
            "center": E.tolist(), "axisX": ex.tolist(), "axisY": ey.tolist(), "axisZ": ez.tolist(),
            "halfWidth": float(half), "upper": cu.tolist(), "lower": cl.tolist(),
            "ball": ball.tolist(), "ballRadius": EYEBALL_RADIUS,
            "irisRadius": float(iris_r), "pupilRadius": float(iris_r * PUPIL_RATIO),
        })
    return eyes
