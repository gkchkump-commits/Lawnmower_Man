"""Unit tests for the blink lid map / eye regions / occlusion helpers of the baker.

    python3 -m pytest tools/bake/tests -q
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

cv2 = pytest.importorskip("cv2")
from lawnmower_bake import textures as T  # noqa: E402


def synthetic_lids():
    xs = np.arange(100, 201, dtype=np.int32)
    s = (xs - 100) / 100.0
    dome = np.sin(np.pi * s)
    closed = np.full(len(xs), 150.0, np.float32)
    upper = (closed - 40.0 * dome - 0.5).astype(np.float32)
    lower = (closed + 8.0 * dome + 0.5).astype(np.float32)
    return {"L": {"x": xs, "upper": upper, "closed": closed, "lower": lower}}


def test_lid_coordinate_is_0_on_the_margins_1_on_the_closed_line_negative_outside():
    lids = synthetic_lids()
    w, up, almond = T.lid_maps((300, 300), lids)
    x = 150
    u, c, lo = lids["L"]["upper"][50], lids["L"]["closed"][50], lids["L"]["lower"][50]
    assert w[int(round(c)), x] == pytest.approx(1.0, abs=0.05)
    assert abs(w[int(np.ceil(u)), x]) < 0.05
    assert abs(w[int(np.floor(lo)), x]) < 0.1
    assert w[int(u) - 20, x] < -0.3          # brow / lid skin above
    assert w[int(lo) + 10, x] < -0.3         # cheek below
    assert w[150, 60] == -1.0                # far outside the eye
    assert w[150, 205] < 0                   # just past the tip
    # monotone wipe: a blink b covers exactly the rows between the upper margin and the edge
    col = w[:, x]
    rows = np.nonzero((col >= 0) & (col < 0.5) & (np.arange(300) < c))[0]
    assert rows.min() >= int(u) and rows.max() <= int(c)
    assert np.all(np.diff(col[int(np.ceil(u)):int(c)]) > 0)
    # upper-lid indicator: 1 above the closed line inside the eye's columns, 0 below
    assert up[int(u) + 5, x] == pytest.approx(1.0)
    assert up[int(c) + 3, x] == pytest.approx(0.0)
    assert almond[140, x] and not almond[100, x]


def test_eye_region_covers_the_almond_plus_a_halo_with_a_soft_edge():
    _, _, almond = T.lid_maps((300, 300), synthetic_lids())
    reg = T.eye_regions((300, 300), {"L": almond}, core_px=14.0, fall_px=26.0)["L"]
    assert reg[140, 150] == pytest.approx(1.0)
    assert reg[150, 100 - 10] == pytest.approx(1.0)        # 10 px past the tip: still the core
    assert 0.0 < reg[150, 100 - 30] < 1.0                  # soft edge
    assert reg[150, 100 - 45] == pytest.approx(0.0)


def test_occlusion_is_zero_on_the_fringe_and_dark_areas():
    H = W = 400
    alpha = np.zeros((H, W), np.float32)
    cv2.circle(alpha, (200, 200), 150, 1.0, -1)
    plate = np.zeros((H, W, 3), np.float32)
    cv2.circle(plate, (200, 200), 150, (0.5, 0.5, 0.5), -1)
    plate[:, :120] *= 0.05                                  # a dim side (like an ear)
    lm = np.zeros((478, 3), np.float32)
    lm[:, 0], lm[:, 1] = 200, 260                           # face oval collapsed, eyes/brows low
    occ = T.occlusion_mask(alpha, lm, 300.0, plate)
    assert occ[120, 200] > 0.9                              # bright cranium
    assert occ[200, 51] < 0.05                              # silhouette edge
    assert occ[200, 80] < 0.2                               # dim side
    assert occ[10, 10] == 0.0                               # outside
