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


# (name, intensity, closed, points in plate px[, per-point intensity profile])
# Traced from docs/reference/neutral.jpg: thin forehead flow lines that branch like veins and
# meet at the glabella, the centre line, faint temple lines, bright nostril / alar rims, OPEN
# nasolabial arcs fading out beside the chin (a closed ring would read as a muzzle).
AUTHORED = [
    ("center", 0.8, False, [(392, 52), (392, 120), (392, 200), (392, 280), (392, 348), (392, 420), (392, 470)]),
    ("foreheadL", 0.85, False, [(214, 122), (226, 168), (250, 222), (284, 266), (316, 300), (336, 326),
                                (347, 352), (353, 378), (356, 404), (355, 430)]),
    ("veinL1", 0.4, False, [(251, 224), (266, 204), (281, 180), (292, 152)]),
    ("veinL2", 0.42, False, [(302, 287), (318, 266), (331, 240), (338, 214)]),
    ("veinL3", 0.4, False, [(343, 343), (352, 318), (360, 292), (363, 266)]),
    ("glabella", 0.75, False, [(356, 400), (366, 384), (380, 362), (392, 347), (404, 362), (418, 384), (428, 400)]),
    ("templeL", 0.45, False, [(150, 222), (153, 258), (160, 294), (168, 330)]),
    ("nostrilL", 0.95, False, [(336, 684), (338, 668), (348, 657), (362, 654), (376, 660), (384, 672)]),
    ("alarL", 0.85, False, [(338, 630), (326, 644), (318, 662), (322, 679), (334, 690), (350, 694)]),
    ("nasolabialL", 0.55, False, [(322, 664), (302, 684), (280, 712), (264, 752), (262, 794), (272, 830),
                                  (292, 862), (318, 884)], [0.7, 1.0, 1.0, 1.0, 0.85, 0.6, 0.3, 0.0]),
    ("chin", 0.35, False, [(392, 866), (392, 900), (392, 930), (392, 956)]),
]
# the face is symmetric: screen-right twins of the "...L" / "...L<n>" curves
AUTHORED += [(n.replace("L", "R", 1), i, c, _mirror(p), *rest) for n, i, c, p, *rest in AUTHORED
             if n.endswith("L") or (n[:-1].endswith("L") and n[-1].isdigit())]

# eye-orbit loops: ellipses (wider than tall: top along the brow, bottom along the cheekbone),
# slightly tilted (outer side lower), OPEN at the top-inner corner where they meet the glabella
# lines, faint along the brow and brightest along the cheekbone.
# (name, intensity, centre px, radii px, tilt deg)
ORBITS = [("orbitL", 0.8, (238, 490), (121, 99), -4.0)]
ORBITS += [(n[:-1] + "R", i, (2 * CX - c[0], c[1]), r, -t) for n, i, c, r, t in ORBITS]


def orbit_profile(theta):
    """Intensity along a screen-left orbit loop. theta = 0 at the inner side (toward the nose),
    pi/2 at the bottom (image y grows downward), pi at the outer side, 3pi/2 at the top."""
    th = np.mod(theta, 2 * np.pi)
    bottom = np.exp(-((th - 1.75) / 0.95) ** 2)                   # cheekbone arc
    prof = 0.4 + 0.6 * bottom
    # the gap faces the nose: the loop fades out over the top-inner part (5.2 .. 5.95 rad) and
    # back in over the inner-lower part (0.35 .. 0.75 rad)
    fade_out = np.clip((5.95 - th) / 0.75, 0, 1)
    fade_in = np.clip((th - 0.35) / 0.4, 0, 1)
    gate = np.where(th > 4.0, fade_out, fade_in)
    return prof * gate ** 1.5


def orbit_points(center, radii, tilt_deg, mirror=False, n=200):
    """Ellipse points (px) and their intensity profile; the gap faces the nose."""
    th = np.linspace(0.35, 5.95, n)
    x = radii[0] * np.cos(th)
    y = radii[1] * np.sin(th)
    if mirror:
        x = -x                                            # inner side toward the nose (screen left)
    a = np.radians(tilt_deg)
    xr = x * np.cos(a) - y * np.sin(a)
    yr = x * np.sin(a) + y * np.cos(a)
    return np.stack([center[0] + xr, center[1] + yr], 1), orbit_profile(th)


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


def resample(poly: np.ndarray, step: float, dims: int = 3) -> np.ndarray:
    """Even arc-length samples of a polyline; arc length is measured on the first `dims`
    columns (extra columns, e.g. an intensity profile, are interpolated along)."""
    seg = np.linalg.norm(np.diff(poly[:, :dims], axis=0), axis=1)
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
    """Returns (list of dict(name, intensity, closed, points (n,3)[, profile (n,)]))."""
    cast = Caster(V, F)
    curves = []

    def add(name, inten, closed, px, prof=None):
        """px (m, 2) dense plate points + optional per-point profile -> surface curve."""
        s_ = ref.to_screen(np.asarray(px, float))
        o, d = view.ray(s_)
        hit, _ = cast.first_hit(o, d)
        ok = ~np.isnan(hit[:, 0])
        if ok.sum() < 2:
            return
        P = hit[ok]
        c = {"name": name, "intensity": inten, "closed": closed}
        if prof is None:
            c["points"] = resample(P, step)
        else:
            R = resample(np.c_[P, np.asarray(prof, float)[ok]], step)
            c["points"], c["profile"] = R[:, :3], np.clip(R[:, 3], 0, None)
        curves.append(c)

    for name, inten, closed, pts, *rest in AUTHORED:
        dense = catmull_rom(pts, 10, closed)
        prof = None
        if rest:
            u = np.linspace(0, 1, len(pts))
            prof = np.interp(np.linspace(0, 1, len(dense)), u, rest[0])
        add(name, inten, closed, dense, prof)
    for name, inten, c, r, tilt in ORBITS:
        pts, prof = orbit_points(c, r, tilt, mirror=name.endswith("R"))
        add(name, inten, False, pts, prof)
    # lips: the scan's own lip contours (they deform with the rig) and the seam. The upper
    # vermilion border and the upper edge of the mouth line are the brightest gold of the face.
    for name, ids, inten in (("lipUpper", LIP_OUTER_UPPER, 1.0), ("lipLower", LIP_OUTER_LOWER, 0.6)):
        P = catmull_rom(lm[ids], 8)
        curves.append({"name": name, "intensity": inten, "closed": False, "points": resample(P, step * 0.6)})
    curves.append({"name": "seam", "intensity": 1.15, "closed": False, "points": resample(np.asarray(seam_pts), step * 0.5)})
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
        if c.get("profile") is not None:
            I = I * np.asarray(c["profile"], float)
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
