"""Unit tests for the procedural head pipeline helpers (synthetic meshes, no assets needed)."""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from headbuild import mesh_ops as mo  # noqa: E402
from headbuild.curves import catmull_rom, chunk, resample  # noqa: E402
from headbuild.mouth import shortcut_path, split_seam  # noqa: E402
from headbuild.raster import ScreenView  # noqa: E402
from headbuild.shading import convexity, polygon_sdf  # noqa: E402
from headbuild.warp import Controls, rbf_warp  # noqa: E402


def grid_mesh(n=12, size=0.2):
    """Flat n x n vertex grid in the xy plane facing +z (counter-clockwise triangles)."""
    xs = np.linspace(-size / 2, size / 2, n)
    X, Y = np.meshgrid(xs, xs)
    V = np.c_[X.ravel(), Y.ravel(), np.zeros(n * n)]
    F = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i
            F += [(a, b, c), (a, c, d)]
    return V, np.array(F)


def test_vertex_normals_face_plus_z():
    V, F = grid_mesh()
    N = mo.vertex_normals(V, F)
    assert np.allclose(N[:, 2], 1.0)


def test_split_seam_separates_upper_and_lower():
    n = 12
    V, F = grid_mesh(n)
    row = n // 2
    path = np.array([row * n + i for i in range(2, n - 2)])        # horizontal seam, left -> right
    V2, F2, lower = split_seam(V, F, path)
    assert len(V2) == len(V) + len(path) - 2
    assert lower[0] == path[0] and lower[-1] == path[-1]          # corners stay shared
    seam_y = V[path[0], 1]
    for k in range(1, len(path) - 1):
        up, lo = path[k], lower[k]
        faces_up = F2[(F2 == up).any(1)]
        faces_lo = F2[(F2 == lo).any(1)]
        assert len(faces_up) and len(faces_lo)
        assert (V2[faces_up].mean(1)[:, 1] > seam_y).all()
        assert (V2[faces_lo].mean(1)[:, 1] < seam_y).all()
    # every vertex is still used and no face references a missing vertex
    assert F2.max() < len(V2)
    assert len(np.unique(F2)) == len(V2)


def test_shortcut_path_removes_detours():
    V, F = grid_mesh(6)
    A = mo.adjacency(V, F)
    path = np.array([0, 1, 7, 8, 2, 3])          # hops up to the second row and back
    assert all(A[path[i], path[i + 1]] for i in range(len(path) - 1))
    p = shortcut_path(path, A)
    assert len(p) < len(path)
    assert p[0] == 0 and p[-1] == 3
    assert all(A[p[i], p[i + 1]] for i in range(len(p) - 1))
    # nothing left to shortcut: no vertex whose path neighbours share an edge
    assert not any(A[p[k - 1], p[k + 1]] for k in range(1, len(p) - 1))


def test_polygon_sdf_sign():
    sq = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], float)
    d = polygon_sdf(np.array([[0.5, 0.5], [2.0, 0.5], [0.5, -0.25]]), sq)
    assert d[0] == pytest.approx(-0.5)
    assert d[1] == pytest.approx(1.0)
    assert d[2] == pytest.approx(0.25)


def test_convexity_marks_a_bump_as_ridge():
    V, F = grid_mesh(25, 0.4)
    r = np.linalg.norm(V[:, :2], axis=1)
    V[:, 2] = 0.03 * np.exp(-(r / 0.04) ** 2)                      # a "nose" on a flat face
    N = mo.vertex_normals(V, F)
    c = convexity(V, F, N, scales=(4, 12))
    tip = np.argmin(r)
    assert c[tip] > 0.3
    assert c[tip] > np.median(c) + 0.2


def test_rbf_warp_moves_controls_and_keeps_far_points():
    V, F = grid_mesh(15, 0.4)
    ctrl = Controls()
    ctrl.add([0, 0, 0], [0.01, 0.0], 0.05, front=False)
    W, info = rbf_warp(V, ctrl, z_face=1.0, z_ear=-1.0)
    centre = np.argmin(np.linalg.norm(V[:, :2], axis=1))
    assert W[centre, 0] - V[centre, 0] == pytest.approx(0.01, abs=1e-3)
    far = np.argmax(np.linalg.norm(V[:, :2], axis=1))
    assert np.abs(W[far] - V[far]).max() < 1e-4
    assert info["scale"] == 1.0


def test_screen_view_round_trip():
    view = ScreenView(4.0)
    p = np.array([[0.1, -0.2, 0.3]])
    s = view.project(p)
    assert np.allclose(view.unproject(s, p[:, 2]), p[:, :2])
    o, d = view.ray(s)
    t = (p[0, 2] - o[0, 2]) / d[0, 2]
    assert np.allclose(o[0] + d[0] * t, p[0])


def test_curve_chunks_cover_points_and_partition():
    P = resample(catmull_rom(np.array([[0, 0, 0], [0.05, 0.02, 0], [0.1, 0, 0.01]], float), 10), 0.004)
    curves = [{"name": "a", "intensity": 1.0, "closed": False, "points": P},
              {"name": "b", "intensity": 0.5, "closed": False, "points": P + [0, 0.1, 0]}]
    pts, chunks, groups = chunk(curves, max_seg=8)
    assert pts.shape[1] == 4
    assert sum(g["chunkCount"] for g in groups) == len(chunks)
    for c in chunks:
        Q = pts[c["start"]:c["start"] + c["count"] + 1, :3]
        assert np.linalg.norm(Q - np.array(c["center"]), axis=1).max() <= c["radius"] + 1e-9
        assert 1 <= c["count"] <= 8
    # open curves taper to zero intensity at their ends
    assert pts[0, 3] == 0.0


# --- look rework: lens-shaped mouth, seam fit, orbit loops, neck mask, measured eyes ----------

def test_lens_profile_closes_the_corners():
    from headbuild.rig import lens_profile
    dx = np.linspace(-0.1, 0.1, 41)
    w = lens_profile(dx, 0.08)
    assert w[20] == pytest.approx(1.0)
    assert lens_profile(0.08, 0.08) == pytest.approx(0.0)
    assert (w >= 0).all() and (w <= 1).all()
    half = w[20:]
    assert (np.diff(half) <= 1e-12).all()                         # monotone toward the corner


def test_seam_fit_recovers_a_symmetric_curve():
    from headbuild.rig import seam_fit
    x = np.linspace(-0.07, 0.07, 30)
    y = -0.14 + 2.0 * x ** 2 - 50.0 * x ** 4
    V = np.c_[x + 0.004, y, np.zeros_like(x)]
    c = seam_fit(V, np.arange(len(x)), np.array([0.004, -0.14, 0.0]))
    assert c == pytest.approx([-0.14, 2.0, -50.0], rel=1e-6, abs=1e-9)


def test_orbit_loops_are_open_toward_the_nose_and_brightest_below():
    from headbuild.curves import CX, ORBITS, orbit_points, orbit_profile
    th = np.linspace(0, 2 * np.pi, 400)
    p = orbit_profile(th)
    assert p.max() <= 1.0 + 1e-9
    bottom = p[np.argmin(np.abs(th - np.pi / 2))]
    top = p[np.argmin(np.abs(th - 3 * np.pi / 2))]
    assert bottom > 2 * top > 0
    for name, _, c, r, tilt in ORBITS:
        pts, prof = orbit_points(c, r, tilt, mirror=name.endswith("R"))
        assert prof[0] < 0.05 and prof[-1] < 0.05                 # faded ends
        w = pts[:, 0].max() - pts[:, 0].min()
        h = pts[:, 1].max() - pts[:, 1].min()
        assert w / h > 1.1                                         # an ellipse, wider than tall
        gap = 0.5 * (pts[0] + pts[-1])
        assert abs(gap[0] - CX) < abs(c[0] - CX)                   # the gap faces the nose
    # the fade is longer over the top-inner part (where the glabella lines come down)
    assert orbit_profile(np.array([5.6]))[0] < orbit_profile(np.array([0.6]))[0] + 0.2
    assert orbit_profile(np.array([5.6]))[0] < 0.5 * orbit_profile(np.array([4.7]))[0]


def test_neck_mask_follows_the_jaw_line_in_3d():
    from headbuild.shading import neck_mask
    # a jaw line on a cylinder of radius 0.3 around the z axis origin, lowest at the chin
    a = np.linspace(-1.0, 1.0, 17)
    J = np.c_[0.3 * np.sin(a), -0.3 + 0.15 * a ** 2, 0.3 * np.cos(a)]
    pts = np.array([
        [0.0, -0.25, 0.3],      # chin front, above the line -> face
        [0.0, -0.36, 0.25],     # under the chin -> neck
        [0.3 * np.sin(0.8), -0.3 + 0.15 * 0.64 + 0.03, 0.3 * np.cos(0.8)],   # side, above -> face
        [0.3 * np.sin(0.8), -0.3 + 0.15 * 0.64 - 0.03, 0.3 * np.cos(0.8)],   # side, below -> neck
    ])
    m = neck_mask(pts, J)
    assert m[0] == pytest.approx(0.0) and m[2] == pytest.approx(0.0)
    assert m[1] == pytest.approx(1.0) and m[3] == pytest.approx(1.0)
    # beyond the ends of the line it drops (below the ear lobe is jaw, not yet neck)
    side = np.array([[0.3 * np.sin(1.4), -0.3 + 0.15 - 0.04, 0.3 * np.cos(1.4)]])
    assert neck_mask(side, J)[0] < 0.5
    assert neck_mask(side, J, drop=0.0)[0] == pytest.approx(1.0)


def _glowing_eye(w=400, h=240, c=(200, 120), axes=(70, 30), pupil=8):
    """A glowing almond (sclera 200) with a brighter iris disc (250) and a dark pupil."""
    import cv2
    img = np.zeros((h, w), np.uint8)
    cv2.ellipse(img, c, axes, 0, 0, 360, 200, -1)
    cv2.circle(img, c, 24, 250, -1)
    cv2.circle(img, c, pupil, 60, -1)
    return img.astype(np.float32)


def test_measure_almond_finds_the_opening_around_a_dark_pupil():
    from headbuild.reference import measure_almond
    g = _glowing_eye()
    a = measure_almond(g, (200, 120))
    assert a is not None
    assert a["upper"][0, 0] == pytest.approx(130, abs=4)
    assert a["upper"][-1, 0] == pytest.approx(270, abs=4)
    assert a["upper"][:, 1].min() == pytest.approx(90, abs=4)
    assert a["lower"][:, 1].max() == pytest.approx(150, abs=4)
    assert measure_almond(np.zeros_like(g), (200, 120)) is None


def test_correct_eyes_moves_the_iris_landmarks_onto_the_pupil():
    import cv2
    from headbuild.reference import IRIS_CENTERS, correct_eyes
    g = _glowing_eye(c=(200, 120))
    img = cv2.cvtColor(g.astype(np.uint8), cv2.COLOR_GRAY2BGR)
    L = np.zeros((478, 3))
    L[:, :2] = [200, 400]                                          # far away: must not move
    L[IRIS_CENTERS[0], :2] = [190, 140]                            # 20 px below the pupil
    L[IRIS_CENTERS[1], :2] = [210, 400]
    out, off = correct_eyes(img, L)
    assert np.allclose(out[IRIS_CENTERS[0], :2], [200, 120], atol=3)
    assert np.linalg.norm(off[0]) == pytest.approx(np.hypot(10, 20), abs=3)
    assert np.allclose(out[0, :2], [200, 400], atol=0.5)
