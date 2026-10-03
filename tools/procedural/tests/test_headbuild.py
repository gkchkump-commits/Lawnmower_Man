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
