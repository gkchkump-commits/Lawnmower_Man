"""Gold contour lines ("circuit" lines) as 3D polylines on the head surface.

Layout follows the reference look: forehead flow lines branching from the glabella, the
centre line, rings around the eye sockets, nostril rims, nasolabial folds, lip contours and the
chin line. Facial-feature curves come from the (warped) scan's own landmarks / lip seam; the
free-form ones are authored in reference-frame pixel coordinates (784 x 1168 plate) and
projected onto the surface along the camera rays.
"""

from __future__ import annotations

import numpy as np

from .landmarks import LIP_OUTER_LOWER, LIP_OUTER_UPPER
from .raycast import Caster

CX = 392.0   # plate centre line (px)
CURVE_DIST_RANGE = 0.05   # world units mapped to 0..1 in the per-vertex curve distance


def _mirror(pts):
    return [(2 * CX - x, y) for x, y in pts]


# (name, intensity, closed, points in plate px)
AUTHORED = [
    ("center", 0.8, False, [(392, 52), (392, 120), (392, 200), (392, 280), (392, 348), (392, 420), (392, 470)]),
    ("foreheadL", 0.85, False, [(214, 122), (226, 168), (250, 222), (284, 266), (316, 300), (336, 326),
                                (347, 352), (353, 378), (356, 404), (355, 430)]),
    ("glabella", 0.75, False, [(356, 400), (366, 384), (380, 362), (392, 347), (404, 362), (418, 384), (428, 400)]),
    ("templeL", 0.45, False, [(150, 222), (153, 258), (160, 294), (168, 330)]),
    ("nostrilL", 0.85, False, [(336, 684), (338, 668), (348, 657), (362, 654), (376, 660), (384, 672)]),
    ("nasolabialL", 0.6, False, [(334, 646), (306, 670), (280, 704), (263, 748), (262, 796), (274, 840),
                                 (298, 882), (330, 912)]),
    ("chin", 0.6, False, [(392, 838), (392, 880), (392, 920), (392, 952)]),
]
# the face is symmetric: screen-right twins of the "...L" curves
AUTHORED += [(n[:-1] + "R", i, c, _mirror(p)) for n, i, c, p in AUTHORED if n.endswith("L")]

# eye-socket rings: (centre px, radii px)
RINGS = [("ringL", 1.0, (246, 488), (116, 110)), ("ringR", 1.0, (539, 487), (116, 110))]


def catmull_rom(pts: np.ndarray, samples_per_seg=8, closed=False) -> np.ndarray:
    P = np.asarray(pts, float)
    if closed:
        P = np.vstack([P[-1], P, P[0], P[1]])
    else:
        P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for t in np.linspace(0, 1, samples_per_seg, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                              (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-2] if not closed else P[1])
    return np.array(out)


def resample(poly: np.ndarray, step: float) -> np.ndarray:
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    s = np.r_[0, np.cumsum(seg)]
    n = max(2, int(np.ceil(s[-1] / step)) + 1)
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, poly[:, k]) for k in range(poly.shape[1])], 1)


def project_px(cast: Caster, view, ref, pts_px):
    """Plate px -> surface points along camera rays (misses dropped)."""
    s = ref.to_screen(np.asarray(pts_px, float))
    o, d = view.ray(s)
    hit, _ = cast.first_hit(o, d)
    return hit[~np.isnan(hit[:, 0])]


def build_curves(V, F, lm, seam_pts, ref, view, step=0.005):
    """Returns (list of dict(name, intensity, closed, points (n,3)))."""
    cast = Caster(V, F)
    curves = []
    for name, inten, closed, pts in AUTHORED:
        dense = catmull_rom(pts, 10, closed)
        P = project_px(cast, view, ref, dense)
        if len(P) >= 2:
            curves.append({"name": name, "intensity": inten, "closed": closed, "points": resample(P, step)})
    for name, inten, c, r in RINGS:
        t = np.linspace(0, 2 * np.pi, 160)
        pts = np.stack([c[0] + r[0] * np.cos(t), c[1] + r[1] * np.sin(t)], 1)
        P = project_px(cast, view, ref, pts)
        curves.append({"name": name, "intensity": inten, "closed": True, "points": resample(P, step)})
    # lips: the scan's own lip contours (they deform with the rig) and the seam
    for name, ids, inten in (("lipUpper", LIP_OUTER_UPPER, 0.9), ("lipLower", LIP_OUTER_LOWER, 0.9)):
        P = catmull_rom(lm[ids], 8)
        curves.append({"name": name, "intensity": inten, "closed": False, "points": resample(P, step * 0.6)})
    curves.append({"name": "seam", "intensity": 1.25, "closed": False, "points": resample(np.asarray(seam_pts), step * 0.5)})
    return curves


def chunk(curves, max_seg=8, pad=0.0):
    """Flatten curves into a point list + chunks of <= max_seg segments with bounding spheres,
    and one group (bounding sphere + chunk range) per curve for two-level culling.
    Chunks never span two curves; consecutive chunks share their boundary point."""
    pts, chunks, groups = [], [], []
    for c in curves:
        first = len(chunks)
        P = c["points"]
        I = np.full(len(P), c["intensity"], float)
        # taper the ends of open curves
        if not c["closed"] and len(P) > 6:
            ramp = np.clip(np.arange(len(P)) / 4.0, 0, 1)
            I = I * np.minimum(ramp, ramp[::-1]) ** 0.7
        base = len(pts)
        pts.extend(np.c_[P, I].tolist())
        for s in range(0, len(P) - 1, max_seg):
            e = min(len(P) - 1, s + max_seg)
            Q = P[s:e + 1]
            cen = 0.5 * (Q.min(0) + Q.max(0))
            rad = float(np.linalg.norm(Q - cen, axis=1).max()) + pad
            chunks.append({"start": base + s, "count": e - s, "center": cen.tolist(), "radius": rad})
        cen = 0.5 * (P.min(0) + P.max(0))
        groups.append({"firstChunk": first, "chunkCount": len(chunks) - first, "center": cen.tolist(),
                       "radius": float(np.linalg.norm(P - cen, axis=1).max()) + pad})
    return np.array(pts, float), chunks, groups


def curve_distance(V, pts, chunks):
    """Per-vertex distance to the nearest curve segment (exact, via a KD-tree on densely
    resampled segment points)."""
    from scipy.spatial import cKDTree
    samples = []
    for c in chunks:
        P = pts[c["start"]:c["start"] + c["count"] + 1]
        for a, b in zip(P[:-1], P[1:]):
            n = max(2, int(np.ceil(np.linalg.norm(b - a) / 0.0005)) + 1)
            samples.append(a + (b - a) * np.linspace(0, 1, n)[:, None])
    tree = cKDTree(np.vstack(samples))
    d, _ = tree.query(V, k=1)
    return d
