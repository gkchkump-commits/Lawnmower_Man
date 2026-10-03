"""2.5D relief mesh: point sampling, constrained triangulation (lip slit), depth and rig weights.

Coordinates are plate pixels: x right, y DOWN, z toward the camera (px). The engine converts to
world units. All rig weights are in 0..1 and are documented in tools/bake/README.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator

from . import landmarks as LM
from .util import inside_polygon, log, polygon_mask, smoothstep

WEIGHT_NAMES = ["jaw", "lowerLip", "upperLip", "cornerL", "cornerR",
                "lidUpperL", "lidLowerL", "lidUpperR", "lidLowerR", "browL", "browR"]


@dataclass
class Mesh:
    positions: np.ndarray          # (N, 3) px
    triangles: np.ndarray          # (T, 3) int
    weights: dict                  # name -> (N,) float
    edge: np.ndarray               # (N,) distance to the silhouette boundary (px)
    face: np.ndarray               # (N,) 1 inside the face oval, 0 outside (smooth)
    landmark_vertex: np.ndarray    # (478,) mesh vertex index of each MediaPipe landmark
    boundary: np.ndarray           # vertex indices of the outline, in order
    slit_upper: list
    slit_lower: list
    cavity: dict
    rig: dict
    info: dict = field(default_factory=dict)


# ------------------------------------------------------------------------------------------------
# sampling
# ------------------------------------------------------------------------------------------------

def resample_closed(poly: np.ndarray, spacing: float) -> np.ndarray:
    """Resample a closed polyline at (approximately) uniform arc-length spacing."""
    p = np.asarray(poly, np.float64)
    seg = np.linalg.norm(np.diff(np.vstack([p, p[:1]]), axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1]
    n = max(8, int(round(total / spacing)))
    t = np.linspace(0, total, n, endpoint=False)
    closed = np.vstack([p, p[:1]])
    x = np.interp(t, cum, closed[:, 0])
    y = np.interp(t, cum, closed[:, 1])
    return np.stack([x, y], 1)


def _smooth_closed(poly: np.ndarray, sigma: float) -> np.ndarray:
    from scipy.ndimage import gaussian_filter1d
    return np.stack([gaussian_filter1d(poly[:, 0], sigma, mode="wrap"),
                     gaussian_filter1d(poly[:, 1], sigma, mode="wrap")], 1)


def _lattice(x0, y0, x1, y1, spacing):
    pts = []
    row_h = spacing * np.sqrt(3) / 2
    r = 0
    y = y0
    while y <= y1:
        off = (spacing / 2) if (r % 2) else 0.0
        xs = np.arange(x0 + off, x1 + 1e-6, spacing)
        pts.append(np.stack([xs, np.full_like(xs, y)], 1))
        y += row_h
        r += 1
    return np.concatenate(pts, 0)


def _min_dist(points: np.ndarray, others: np.ndarray) -> np.ndarray:
    from scipy.spatial import cKDTree
    if len(others) == 0:
        return np.full(len(points), np.inf)
    d, _ = cKDTree(others).query(points, k=1)
    return d


# ------------------------------------------------------------------------------------------------
# triangulation
# ------------------------------------------------------------------------------------------------

def triangulate(points: np.ndarray, segments: np.ndarray, holes: np.ndarray, outline: np.ndarray,
                slit_poly: np.ndarray, slit_upper: list, slit_lower: list):
    """Constrained Delaunay (Shewchuk's Triangle) with a fallback to filtered scipy Delaunay."""
    try:
        import triangle as tr
        data = {"vertices": points.astype(np.float64), "segments": segments.astype(np.int32)}
        if len(holes):
            data["holes"] = holes.astype(np.float64)
        res = tr.triangulate(data, "pQ")
        verts = res["vertices"]
        if len(verts) != len(points):
            # Triangle inserted Steiner points (crossing segments); fall back for determinism.
            raise RuntimeError(f"triangle added {len(verts) - len(points)} vertices")
        tris = res["triangles"].astype(np.int64)
        method = "triangle (constrained Delaunay)"
    except Exception as e:  # pragma: no cover - fallback path
        log(f"  constrained triangulation unavailable ({e}); using filtered Delaunay")
        from scipy.spatial import Delaunay
        tris = Delaunay(points).simplices.astype(np.int64)
        cen = points[tris].mean(1)
        keep = inside_polygon(cen, outline) & ~inside_polygon(cen, slit_poly)
        up, lo = set(slit_upper), set(slit_lower)
        crosses = np.array([any(v in up for v in t) and any(v in lo for v in t) for t in tris])
        tris = tris[keep & ~crosses]
        method = "scipy Delaunay + filtering"
    # Consistent winding (counter-clockwise in a y-up frame == clockwise in image space).
    a, b, c = points[tris[:, 0]], points[tris[:, 1]], points[tris[:, 2]]
    cross = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    flip = cross > 0       # image space y-down: positive cross = clockwise when y is up
    tris[flip] = tris[flip][:, [0, 2, 1]]
    # Drop degenerate slivers.
    area = 0.5 * np.abs(cross)
    tris = tris[area > 1e-3]
    return tris, method


# ------------------------------------------------------------------------------------------------
# depth
# ------------------------------------------------------------------------------------------------

def _neighbors(tris: np.ndarray, n: int):
    nb = [set() for _ in range(n)]
    for a, b, c in tris:
        nb[a].update((b, c))
        nb[b].update((a, c))
        nb[c].update((a, b))
    return [np.array(sorted(s), np.int64) for s in nb]


def compute_depth(pts, solid, lm, lm_vertex, tris, face_h, chin_y):
    """Depth (px, toward camera): inflated silhouette for the head, MediaPipe z for the face."""
    H, W = solid.shape
    dist = cv2.distanceTransform(solid.astype(np.uint8), cv2.DIST_L2, 5)
    xi = np.clip(np.round(pts[:, 0]).astype(int), 0, W - 1)
    yi = np.clip(np.round(pts[:, 1]).astype(int), 0, H - 1)
    d = dist[yi, xi].astype(np.float64)
    # Circular inflation profile: z = sqrt(D^2 - (D - d)^2) for d < D.
    D = 0.47 * face_h
    dd = np.minimum(d, D)
    z_inf = np.sqrt(np.maximum(0.0, D * D - (D - dd) ** 2))
    # The neck sits behind the jaw: flatten the inflation below the chin.
    below = smoothstep(chin_y - 0.06 * face_h, chin_y + 0.12 * face_h, pts[:, 1])
    z_inf *= 1.0 - 0.45 * below

    # MediaPipe depth (z negative = toward camera) -> toward-camera positive. Its global curvature
    # does not match the inflated silhouette (the face oval sits well inside the head outline), so
    # only the facial *detail* is used: z_mp minus a quadratic trend fitted over the landmarks,
    # added on top of the inflated dome. This keeps nose / eye sockets / lips without ridges.
    z_mp_lm = -lm[:, 2].astype(np.float64)
    X = lm[:, 0].astype(np.float64)
    Y = lm[:, 1].astype(np.float64)

    def quad_basis(xx, yy):
        u = (xx - X.mean()) / face_h
        v = (yy - Y.mean()) / face_h
        return np.c_[np.ones_like(u), u, v, u * u, u * v, v * v]

    coef, *_ = np.linalg.lstsq(quad_basis(X, Y), z_mp_lm, rcond=None)
    detail_lm = z_mp_lm - quad_basis(X, Y) @ coef
    lin = LinearNDInterpolator(lm[:, :2], detail_lm)
    near = NearestNDInterpolator(lm[:, :2], detail_lm)
    detail = lin(pts)
    bad = np.isnan(detail)
    detail[bad] = near(pts[bad])
    a = 0.85                                   # slightly softened MediaPipe relief
    oval = np.array(LM.FACE_OVAL)
    z_face = z_inf + a * detail
    o = 0.0

    # Signed distance inside the face oval -> blend weight.
    oval_mask = polygon_mask((H, W), lm[oval, :2]) > 0.5
    din = cv2.distanceTransform(oval_mask.astype(np.uint8), cv2.DIST_L2, 5)[yi, xi]
    w_face = smoothstep(0.0, 0.07 * face_h, din)
    z = w_face * z_face + (1.0 - w_face) * z_inf

    # Harmonic smoothing of the transition band only (deep face, cranium dome and the outline
    # stay fixed, otherwise the dome would be flattened).
    nb = _neighbors(tris, len(pts))
    dout = cv2.distanceTransform((~oval_mask).astype(np.uint8), cv2.DIST_L2, 5)[yi, xi]
    free = (w_face < 0.999) & (dout < 0.06 * face_h) & (d > 1.5)
    idx = np.nonzero(free)[0]
    for _ in range(60):
        z_new = z.copy()
        for i in idx:
            if len(nb[i]):
                z_new[i] = 0.5 * z[i] + 0.5 * z[nb[i]].mean()
        z = z_new
    face_w = smoothstep(-0.01 * face_h, 0.02 * face_h, din)  # for effects, not depth
    return z.astype(np.float32), {"inflateRadius": float(D), "faceDepthScale": a, "faceDepthOffset": o}, \
        d.astype(np.float32), face_w.astype(np.float32)


# ------------------------------------------------------------------------------------------------
# rig weights
# ------------------------------------------------------------------------------------------------

def _poly_y(curve: np.ndarray, x: np.ndarray) -> np.ndarray:
    order = np.argsort(curve[:, 0])
    return np.interp(x, curve[order, 0], curve[order, 1])


def compute_weights(pts, lm, slit_line, face_h, chin_y, solid_shape, slit_upper_v, slit_lower_v):
    H, W = solid_shape
    x, y = pts[:, 0].astype(np.float64), pts[:, 1].astype(np.float64)
    n = len(pts)
    w = {k: np.zeros(n, np.float64) for k in WEIGHT_NAMES}
    fh = face_h

    # --- mouth ---------------------------------------------------------------------------------
    cl, cr = slit_line[0], slit_line[-1]
    mcx = 0.5 * (cl[0] + cr[0])
    hw = 0.5 * (cr[0] - cl[0])
    ear_l = lm[132, :2]
    ear_r = lm[361, :2]
    # Jaw boundary: ear -> outer mouth corner -> slit -> outer corner -> ear.
    boundary_curve = np.vstack([ear_l, lm[LM.MOUTH_CORNER_OUTER_L, :2] * 0.5 + cl * 0.5, slit_line,
                                lm[LM.MOUTH_CORNER_OUTER_R, :2] * 0.5 + cr * 0.5, ear_r])
    yb = _poly_y(boundary_curve, x)
    dy = y - yb
    near_mouth = np.abs(x - mcx) < hw * 1.05
    band = np.where(near_mouth, 0.012 * fh, 0.05 * fh)
    jaw = smoothstep(-band, band, dy)
    # Lips: hard split along the slit, lens-shaped opening (the lips stay joined at the corners
    # and part most at the centre); below the lower lip the chin moves rigidly with the jaw.
    upper_lip = np.concatenate([lm[LM.LIPS_OUTER_UPPER, :2], lm[LM.LIPS_INNER_UPPER[::-1], :2]])
    lower_lip = np.concatenate([lm[LM.LIPS_OUTER_LOWER, :2], lm[LM.LIPS_INNER_LOWER[::-1], :2]])
    in_ul = inside_polygon(pts, upper_lip, margin=0.75)
    in_ll = inside_polygon(pts, lower_lip, margin=0.75)
    lo_outer_y = _poly_y(lm[LM.LIPS_OUTER_LOWER, :2], x)
    slit_y = _poly_y(slit_line, x)
    t = np.clip(np.abs(x - mcx) / max(hw, 1.0), 0.0, 1.0)
    lens = np.sqrt(np.clip(1.0 - t ** 2, 0.0, 1.0)) ** 0.75
    below_lip = smoothstep(0.0, 0.075 * fh, y - lo_outer_y)
    jaw_lens = (lens + (1.0 - lens) * below_lip) * (y >= slit_y)
    zone = 1.0 - smoothstep(hw * 1.1, hw * 1.6, np.abs(x - mcx))
    jaw = zone * jaw_lens + (1.0 - zone) * jaw
    jaw[in_ul] = 0.0
    if len(slit_upper_v):
        jaw[slit_upper_v] = 0.0
        jaw[slit_lower_v] = lens[slit_lower_v]
        jaw[[slit_upper_v[0], slit_upper_v[-1]]] = 0.0     # corners stay closed
    # Fade toward the neck and outside the jaw line.
    jaw *= 1.0 - smoothstep(chin_y + 0.01 * fh, chin_y + 0.16 * fh, y)
    oval_mask = polygon_mask((H, W), lm[LM.FACE_OVAL, :2]) > 0.5
    dist_out = cv2.distanceTransform((~oval_mask).astype(np.uint8), cv2.DIST_L2, 5)
    xi = np.clip(np.round(x).astype(int), 0, W - 1)
    yi = np.clip(np.round(y).astype(int), 0, H - 1)
    jaw *= 1.0 - smoothstep(0.0, 0.09 * fh, dist_out[yi, xi])
    w["jaw"] = jaw

    # Lower / upper lip own weights (extra lip motion on top of the jaw), same lens profile.
    up_outer_y = _poly_y(lm[LM.LIPS_OUTER_UPPER, :2], x)
    lat = 1.0 - smoothstep(hw * 0.85, hw * 1.25, np.abs(x - mcx))
    below_slit = (y >= slit_y - 0.5)
    lower = np.where(in_ll, 1.0, (1.0 - smoothstep(0, 0.05 * fh, y - lo_outer_y)) * below_slit)
    lower *= lat * lens
    if len(slit_upper_v):
        lower[slit_upper_v] = 0.0
        lower[slit_lower_v] = lens[slit_lower_v]
    w["lowerLip"] = np.clip(lower, 0, 1)
    nose_y = float(lm[LM.NOSE_BOTTOM, 1])
    upper = np.where(in_ul, 1.0, (1.0 - smoothstep(0, max(4.0, up_outer_y.mean() - nose_y), up_outer_y - y))
                     * (y <= slit_y + 0.5))
    upper *= lat * (0.25 + 0.75 * lens)
    if len(slit_upper_v):
        upper[slit_lower_v] = 0.0
        upper[slit_upper_v] = (0.25 + 0.75 * lens[slit_upper_v])
        corners = [slit_upper_v[0], slit_upper_v[-1]]
        upper[corners] = 0.0
        w["lowerLip"][corners] = 0.0
    w["upperLip"] = np.clip(upper, 0, 1)

    # Mouth corners (wide / round / smile): radial falloff around the outer corners.
    for key, idx in (("cornerL", LM.MOUTH_CORNER_OUTER_L), ("cornerR", LM.MOUTH_CORNER_OUTER_R)):
        c = lm[idx, :2]
        r = np.hypot(x - c[0], (y - c[1]) * 1.15)
        w[key] = np.exp(-0.5 * (r / (0.55 * hw)) ** 2)
        # Corners spread toward the centre line weaker on the other side of the mouth.
        side = np.sign(c[0] - mcx)
        w[key] *= smoothstep(-hw * 0.9, hw * 0.2, (x - mcx) * side)

    # --- eyelids -------------------------------------------------------------------------------
    for key, upper_idx, lower_idx in (("L", LM.EYE_L_UPPER, LM.EYE_L_LOWER), ("R", LM.EYE_R_UPPER, LM.EYE_R_LOWER)):
        U = lm[upper_idx, :2]
        Lw = lm[lower_idx, :2]
        xa, xb = float(min(U[:, 0].min(), Lw[:, 0].min())), float(max(U[:, 0].max(), Lw[:, 0].max()))
        ew = xb - xa
        uy = _poly_y(U, np.clip(x, xa, xb))
        ly = _poly_y(Lw, np.clip(x, xa, xb))
        height = np.maximum(ly - uy, 0.0)
        hmax = float(height.max()) if height.size else 1.0
        eh = max(1.0, float((Lw[:, 1].max() - U[:, 1].min())))
        close_y = uy + 0.72 * height                 # where the lids meet when closed
        lat = 1.0 - smoothstep(0.0, 0.18 * ew, np.maximum(xa - x, x - xb))
        travel_u = (close_y - uy)                    # upper lid travel at this x
        travel_l = (ly - close_y)
        inside = (y >= uy) & (y <= ly) & (x >= xa) & (x <= xb)
        up_w = np.zeros(n)
        lo_w = np.zeros(n)
        # inside the aperture: collapse onto the closure line
        up_w = np.where(inside & (y < close_y), (close_y - y), up_w)
        lo_w = np.where(inside & (y >= close_y), (y - close_y), lo_w)
        # lid skin above the upper lid follows with decay; below the lower lid likewise.
        above = (y < uy)
        fall_up = 1.0 - smoothstep(0.0, 1.1 * eh, uy - y)
        up_w = np.where(above, travel_u * fall_up, up_w)
        below = (y > ly)
        fall_lo = 1.0 - smoothstep(0.0, 0.7 * eh, y - ly)
        lo_w = np.where(below, travel_l * fall_lo, lo_w)
        up_w *= lat
        lo_w *= lat
        w[f"lidUpper{key}"] = np.clip(up_w / max(hmax, 1.0), 0, 1)
        w[f"lidLower{key}"] = np.clip(lo_w / max(hmax, 1.0), 0, 1)

    # --- brows -----------------------------------------------------------------------------------
    for key, idx, eye_upper in (("L", LM.BROW_L, LM.EYE_L_UPPER), ("R", LM.BROW_R, LM.EYE_R_UPPER)):
        B = lm[idx, :2]
        bx0, bx1 = B[:, 0].min(), B[:, 0].max()
        by = _poly_y(B[:5], np.clip(x, bx0, bx1))
        lat = 1.0 - smoothstep(0.0, 0.25 * (bx1 - bx0), np.maximum(bx0 - x, x - bx1))
        dyb = y - by
        eye_top = _poly_y(lm[eye_upper, :2], np.clip(x, bx0, bx1))
        down = 1.0 - smoothstep(0.0, np.maximum(4.0, (eye_top - by) * 0.85), dyb)   # toward the lid
        up = np.exp(-0.5 * (np.minimum(dyb, 0) / (0.16 * fh)) ** 2)                 # forehead
        w[f"brow{key}"] = np.where(dyb >= 0, down, up) * lat

    rig = {
        "mouth": {"center": [float(mcx), float(np.interp(mcx, slit_line[:, 0], slit_line[:, 1]))],
                  "cornerL": [float(cl[0]), float(cl[1])], "cornerR": [float(cr[0]), float(cr[1])],
                  "halfWidth": float(hw)},
    }
    return {k: np.clip(v, 0, 1).astype(np.float32) for k, v in w.items()}, rig


# ------------------------------------------------------------------------------------------------
# cavity
# ------------------------------------------------------------------------------------------------

def build_cavity(tex, z_lips_min, face_h, weights_fn):
    """Back quad (upper jaw: cavity + upper teeth) and lower-teeth strip (moves with the jaw)."""
    x0, y0, w, h = tex.mouth_rect
    slit = tex.slit_line
    positions, uvs, layer, idx = [], [], [], []
    # Back quad: a coarse grid so the head rotation stays smooth.
    nx, ny = 12, 4
    z_back = float(z_lips_min - 0.05 * face_h)
    for j in range(ny + 1):
        for i in range(nx + 1):
            px = x0 + w * i / nx
            py = y0 + h * j / ny
            positions.append([px, py, z_back])
            uvs.append([i / nx, 0.5 + 0.5 * (1 - j / ny)])   # top half of the atlas (v up)
            layer.append(0)
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            b, c, d = a + 1, a + nx + 1, a + nx + 2
            idx += [a, c, b, b, c, d]
    # Lower-teeth strip: follows the slit, spans the teeth band above the lower lip (jaw space).
    band = tex.info["mouth"]["lowerBandPx"]
    base = len(positions)
    cols = 20
    xs = np.linspace(slit[0, 0] + 2, slit[-1, 0] - 2, cols)
    sy = np.interp(xs, slit[:, 0], slit[:, 1])
    z_strip = float(z_lips_min - 0.018 * face_h)
    for k, (px, py) in enumerate(zip(xs, sy)):
        for t, off in enumerate(band):
            yy = py + off
            positions.append([px, yy, z_strip])
            u = (px - x0) / w
            v = (yy - y0) / h
            uvs.append([u, 0.5 * (1 - v)])             # bottom half of the atlas
            layer.append(1)
    for k in range(cols - 1):
        a = base + 2 * k
        b, c, d = a + 1, a + 2, a + 3
        idx += [a, b, c, c, b, d]
    positions = np.array(positions, np.float32)
    # Weights: back quad is rigid (upper jaw); the strip copies the lower lip just below the slit.
    wts = {k: np.zeros(len(positions), np.float32) for k in WEIGHT_NAMES}
    strip = np.arange(base, len(positions))
    probe = positions[strip].copy()
    probe[:, 1] = np.interp(probe[:, 0], slit[:, 0], slit[:, 1]) + 2.0
    sampled = weights_fn(probe)
    for k in ("jaw", "lowerLip", "cornerL", "cornerR"):
        wts[k][strip] = sampled[k]
    return {"positions": positions, "uvs": np.array(uvs, np.float32), "indices": np.array(idx, np.int64),
            "layer": np.array(layer, np.int64), "weights": wts, "zBack": z_back, "zStrip": z_strip}


# ------------------------------------------------------------------------------------------------
# main entry
# ------------------------------------------------------------------------------------------------

def build_mesh(info, lm_raw, tex, grid=17.0, debug_dir=None) -> Mesh:
    log("building relief mesh")
    lm = tex.lm.astype(np.float64)
    H, W = tex.height, tex.width
    face_h = float(lm[LM.CHIN, 1] - lm[LM.FOREHEAD_TOP, 1])
    chin_y = float(lm[LM.CHIN, 1])

    # 1) outline samples (smoothed contour of the coverage region)
    outline = _smooth_closed(tex.boundary.astype(np.float64), 2.0)
    outline = resample_closed(outline, grid * 0.85)
    # 2) landmarks (all 478). Inner lips already snapped to the slit.
    lm_pts = lm[:, :2].copy()
    # 3) interior lattice
    lat = _lattice(0, 0, W, H, grid)
    inside = inside_polygon(lat, outline)
    lat = lat[inside]
    d_out = _min_dist(lat, outline)
    d_lm = _min_dist(lat, lm_pts)
    slit_poly = np.concatenate([lm[LM.LIPS_INNER_UPPER, :2], lm[LM.LIPS_INNER_LOWER[::-1], :2]])
    near_slit = inside_polygon(lat, slit_poly, margin=1.5) | (_min_dist(lat, slit_poly) < 0.6 * grid)
    lat = lat[(d_out > 0.55 * grid) & (d_lm > 0.5 * grid) & ~near_slit]
    # landmarks must be inside the outline (they always are for this kind of footage)
    lm_in = inside_polygon(lm_pts, outline, margin=0.25)
    if not lm_in.all():
        log(f"  warning: {int((~lm_in).sum())} landmarks outside the outline (kept)")

    # Densify the slit (2 extra points per landmark segment) so the opening is a smooth lens.
    n_lm = len(lm_pts)
    extra = []

    def chain(idx):
        out = [idx[0]]
        for a, b in zip(idx[:-1], idx[1:]):
            for k in (1, 2):
                extra.append(lm_pts[a] + (lm_pts[b] - lm_pts[a]) * (k / 3.0))
                out.append(n_lm + len(extra) - 1)
            out.append(b)
        return out

    slit_upper_v = chain(LM.LIPS_INNER_UPPER)
    slit_lower_v = chain(LM.LIPS_INNER_LOWER)
    extra = np.array(extra, np.float64)
    points = np.vstack([lm_pts, extra, outline, lat])
    n_ex, n_out = len(extra), len(outline)
    lm_vertex = np.arange(n_lm)
    boundary = np.arange(n_lm + n_ex, n_lm + n_ex + n_out)

    # segments: outline loop + slit loop + eyelid curves (keep edges along the lids)
    segs = [[boundary[i], boundary[(i + 1) % n_out]] for i in range(n_out)]
    slit_loop = slit_upper_v + slit_lower_v[-2:0:-1]
    segs += [[slit_loop[i], slit_loop[(i + 1) % len(slit_loop)]] for i in range(len(slit_loop))]
    for curve in (LM.EYE_L_UPPER, LM.EYE_L_LOWER, LM.EYE_R_UPPER, LM.EYE_R_LOWER):
        segs += [[curve[i], curve[i + 1]] for i in range(len(curve) - 1)]
    hole = 0.5 * (lm[13, :2] + lm[14, :2])
    tris, method = triangulate(points, np.array(segs), np.array([hole]), outline, slit_poly,
                               slit_upper_v[1:-1], slit_lower_v[1:-1])
    # Drop vertices that ended up unused (e.g. stray points inside the slit hole).
    used = np.zeros(len(points), bool)
    used[tris.ravel()] = True
    if not used[:n_lm].all():
        log(f"  note: {int((~used[:n_lm]).sum())} landmark vertices unused by the triangulation")
    log(f"  {len(points)} vertices, {len(tris)} triangles via {method}")

    z, depth_info, edge, face_w = compute_depth(points, tex.solid, lm, lm_vertex, tris, face_h, chin_y)
    weights, rig = compute_weights(points, lm, tex.slit_line, face_h, chin_y, (H, W),
                                   slit_upper_v, slit_lower_v)
    positions = np.c_[points, z].astype(np.float32)

    def weights_at(p):
        ww, _ = compute_weights(np.asarray(p, np.float64)[:, :2], lm, tex.slit_line, face_h, chin_y, (H, W), [], [])
        return ww

    z_lips = float(np.min(z[slit_upper_v + slit_lower_v]))
    cavity = build_cavity(tex, z_lips, face_h, weights_at)

    # Rig geometry (px, plate space).
    eyes = tex.info["eyes"]
    ear_y = float(0.5 * (lm[234, 1] + lm[454, 1]))
    rig.update({
        "eyes": {k: {"center": e["center"], "irisRadius": e["irisRadius"], "width": e["width"],
                     "height": e["height"], "box": e["box"],
                     "centerZ": float(z[LM.IRIS_L[0] if k == "L" else LM.IRIS_R[0]])}
                 for k, e in eyes.items()},
        "eyeHeightMax": {k: float(e["height"]) for k, e in eyes.items()},
        # Temporomandibular joint: ear level, well behind the face surface.
        "jawPivot": [float(rig["mouth"]["center"][0]), float(lm[234, 1] * 0.5 + lm[454, 1] * 0.5),
                     float(np.min(z[[234, 454]]) - 0.10 * face_h)],
        "headPivot": [float(rig["mouth"]["center"][0]), ear_y, float(-0.05 * face_h)],
        "faceHeight": face_h,
        "chinY": chin_y,
        "noseTip": [float(lm[1, 0]), float(lm[1, 1]), float(z[1])],
        "forehead": [float(lm[10, 0]), float(lm[10, 1]), float(z[10])],
        "depth": depth_info,
        "lipZ": z_lips,
    })
    mesh = Mesh(positions=positions, triangles=tris, weights=weights, edge=edge, face=face_w,
                landmark_vertex=lm_vertex, boundary=boundary, slit_upper=slit_upper_v,
                slit_lower=slit_lower_v, cavity=cavity, rig=rig,
                info={"method": method, "grid": grid, "vertices": int(len(points)), "triangles": int(len(tris))})
    return mesh
