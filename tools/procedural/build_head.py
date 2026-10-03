#!/usr/bin/env python3
"""Build the procedural hologram head model (public/assets/models/head.json + head.bin).

    python tools/procedural/build_head.py                    # uses the committed landmark cache
    python tools/procedural/build_head.py --landmarker face_landmarker.task --debug out/procdbg

Inputs: tools/procedural/source/LeePerrySmith.glb (head scan, CC BY 3.0) and
docs/reference/neutral.jpg (only its geometry is measured: landmarks + outline).
See tools/procedural/README.md.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from headbuild import __version__  # noqa: E402
from headbuild import mesh_ops as mo  # noqa: E402
from headbuild.curves import CURVE_DIST_RANGE, build_curves, chunk, curve_distance  # noqa: E402
from headbuild.eyes import eye_params  # noqa: E402
from headbuild.geometry import CAMERA_DIST, FOV_DEG, build_geometry  # noqa: E402
from headbuild.landmarks import LM, LIP_OUTER_LOWER, LIP_OUTER_UPPER, LandmarkCache  # noqa: E402
from headbuild.mouth import build_bag, find_seam, smooth_seam, split_seam  # noqa: E402
from headbuild.outline import silhouette  # noqa: E402
from headbuild.pack import write_model  # noqa: E402
from headbuild.reference import measure  # noqa: E402
from headbuild.rig import RIG_CHANNELS, anchors, compute_weights, inner_mouth_mask  # noqa: E402
from headbuild.shading import ambient_occlusion, convexity, ear_mask, lips_mask, shell_normals  # noqa: E402

ATTRIBUTION = "Lee Perry-Smith head scan, Infinite-Realities, CC BY 3.0"


def r5(x):
    """Round floats (recursively) for a compact JSON."""
    if isinstance(x, dict):
        return {k: r5(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [r5(v) for v in x]
    if isinstance(x, np.ndarray):
        return r5(x.tolist())
    if isinstance(x, (float, np.floating)):
        return round(float(x), 5)
    if isinstance(x, np.integer):
        return int(x)
    return x


def build(args):
    t0 = time.time()
    log = (lambda *a: print("[build_head]", *a)) if not args.quiet else (lambda *a: None)
    cache = LandmarkCache(args.cache, args.landmarker)
    ref_img = cv2.imread(str(args.reference))
    if ref_img is None:
        raise SystemExit(f"cannot read reference image {args.reference}")
    ref = measure(ref_img, cache.get("reference_neutral", ref_img))

    g = build_geometry(args.source, ref, cache)
    cache.save()
    V, F, lm, view = g.V, g.F, g.src_landmarks, g.view
    log("geometry", g.info)

    # --- mouth: seam split + rig ------------------------------------------------------------------
    path = find_seam(V, F, lm)
    V = smooth_seam(V, F, path)
    # Shading attributes come from the WELDED surface: smoothing-based measures would see the
    # split lips as an open hole and pull its rim apart. Seam copies inherit their originals.
    N0 = mo.vertex_normals(V, F)
    ao = ambient_occlusion(V, F, N0, n_dirs=args.ao_rays)
    conv01 = 0.5 + 0.5 * convexity(V, F, N0)
    shell = shell_normals(V, F)
    lips = lips_mask(V, lm, LIP_OUTER_UPPER, LIP_OUTER_LOWER)
    ear = ear_mask(V)
    n_welded = len(V)
    V, F, lower = split_seam(V, F, path)
    src = np.r_[np.arange(n_welded), path[1:-1]]          # copy k of the seam <- path[k]
    ao, conv01, shell, lips, ear = (x[src] for x in (ao, conv01, shell, lips, ear))
    from headbuild.mouth import Seam
    seam = Seam(path, lower, (int(path[0]), int(path[-1])))
    skin_n = len(V)
    A = anchors(V, lm, path)
    N = mo.vertex_normals(V, F)
    log(f"seam: {len(path)} vertices, skin verts {skin_n}")
    W = compute_weights(V, F, skin_n, seam, lm, A)
    log(f"shading attributes + rig weights done ({time.time() - t0:.1f}s)")

    # --- mouth cavity (separate vertices, same draw call) --------------------------------------
    bv, bf, _bjaw, bprm = build_bag(V, path, lower)
    m = len(path)
    rim_i = np.clip(np.round(bprm[:, 0] * (m - 1)).astype(int), 0, m - 1)
    s = bprm[:, 1]
    rim_up, rim_lo = path[rim_i], lower[rim_i]
    rim = np.where(bprm[:, 2] >= 0.75, rim_up, rim_lo)
    # ring 0 must move exactly like the lip edge it is welded to (no gaps near the corners);
    # deeper rings blend toward the throat (half way between skull and jaw)
    BW = W[rim] * (1 - s)[:, None]
    BW[:, 0] = W[rim, 0] * (1 - s * s) + 0.5 * s * s
    BW[:, 5:7] = 0                                         # no brows in the mouth
    BW[s == 0] = W[rim[s == 0]]                            # exact copy on the weld
    V_all = np.vstack([V, bv])
    F_all = np.vstack([F, bf + skin_n])
    rig = np.vstack([W, BW])
    aux = np.vstack([np.c_[ao, conv01, lips, ear], np.tile([0.3, 0.5, 0.0, 0.0], (len(bv), 1))])
    # skin vertices: cavity.y = distance to the nearest gold curve / CURVE_DIST_RANGE (lets the
    # shader skip the curve search far from every line)
    cav = np.vstack([np.zeros((skin_n, 4)), np.c_[np.ones(len(bv)), bprm]])
    inner = inner_mouth_mask(V, F, N, path, lower, A)
    shell4 = np.vstack([np.c_[shell * 0.5 + 0.5, inner], np.tile([0.5, 0.5, 1.0, 1.0], (len(bv), 1))])

    # --- eyes, curves, outline ------------------------------------------------------------------
    eyes = eye_params(V, F, ref, view)
    curves = build_curves(V, F, lm, V[path], ref, view)
    pts, chunks, groups = chunk(curves)
    outline = silhouette(V, F, view)
    cav[:skin_n, 1] = np.clip(curve_distance(V, pts[:, :3], chunks) / CURVE_DIST_RANGE, 0, 1)
    log(f"eyes / {len(curves)} curves ({len(pts)} points, {len(chunks)} chunks) / outline {len(outline)} pts")

    # --- metadata ----------------------------------------------------------------------------------
    up = V[V[:, 1] > 0.0]
    cranium_c = 0.5 * (up.min(0) + up.max(0))
    chin_y = float(lm[LM["chin"], 1])
    so = view.project(V)
    head_top = float(so[:, 1].max())
    face_h = float(lm[LM["forehead"], 1] - chin_y)
    ob = np.asarray(outline)
    upper_ob = ob[ob[:, 1] > chin_y]
    meta = {
        "generator": f"tools/procedural/build_head.py {__version__}",
        "source": {
            "name": Path(args.source).name, "attribution": ATTRIBUTION, "license": "CC BY 3.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
            "sha256": hashlib.sha256(Path(args.source).read_bytes()).hexdigest(),
            "modifications": "cropped to head and neck, smoothed, subdivided, warped toward the reference "
                             "proportions, ears tucked, mouth split along the lip seam, mouth cavity added",
        },
        "curveDistanceRange": CURVE_DIST_RANGE,
        "camera": {"fov": FOV_DEG, "distance": float(CAMERA_DIST), "viewHeight": 1.0,
                   "viewWidth": ref.width / ref.height},
        "skinVertexCount": int(skin_n),
        "rigChannels": RIG_CHANNELS,
        "rig": {
            "jawPivot": A["jawPivot"], "headPivot": [0.0, float(A["jawPivot"][1] - 0.1), float(A["jawPivot"][2] - 0.06)],
            "mouthCenter": A["mouthCenter"], "cornerL": A["cornerL"], "cornerR": A["cornerR"],
            "mouthHalfWidth": A["mouthHalfWidth"], "faceHeight": face_h, "chinY": chin_y,
        },
        "features": {
            "noseTip": lm[LM["noseTip"]], "noseBridge": lm[LM["noseBridge"]],
            "glabella": lm[[9, 8]].mean(0), "forehead": lm[LM["forehead"]],
            "crown": V[np.argmax(V[:, 1])], "craniumCenter": cranium_c, "headTop": head_top,
        },
        "neck": {"fadeTop": chin_y - 0.01, "fadeBottom": -0.43, "cutY": float(V[:, 1].min())},
        "eyes": eyes,
        "curves": {"names": [c["name"] for c in curves], "points": pts.reshape(-1), "chunks": chunks,
                   "groups": groups},
        "outline": ob.reshape(-1),
        "particleAnchors": {
            "center": [0.0, float(0.5 * (upper_ob[:, 1].max() + chin_y))],
            "radius": [float(0.5 * (upper_ob[:, 0].max() - upper_ob[:, 0].min()) * 0.94),
                       float(0.5 * (upper_ob[:, 1].max() - chin_y))],
            "neckX": 0.0, "neckTop": chin_y + 0.02, "neckBottom": -0.5,
            "neckHalfWidth": 0.15, "depth": 0.3,
        },
    }
    doc = write_model(args.out, "head", V_all, F_all, rig, aux, cav, shell4, r5(meta))
    size = (Path(args.out) / "head.bin").stat().st_size + (Path(args.out) / "head.json").stat().st_size
    log(f"wrote {args.out}/head.json + head.bin: {doc['vertexCount']} verts, {doc['indexCount'] // 3} tris, "
        f"{size / 1024:.0f} KiB ({time.time() - t0:.1f}s)")
    if args.debug:
        from headbuild.debug import write_debug
        write_debug(Path(args.debug), V_all, F_all, skin_n, rig, aux, view, ref_img, lm, path, curves, eyes, outline)
    return doc


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", type=Path, default=HERE / "source" / "LeePerrySmith.glb")
    p.add_argument("--reference", type=Path, default=ROOT / "docs" / "reference" / "neutral.jpg")
    p.add_argument("--out", type=Path, default=ROOT / "public" / "assets" / "models")
    p.add_argument("--cache", type=Path, default=HERE / "data" / "landmarks.json")
    p.add_argument("--landmarker", type=Path, default=None, help="MediaPipe face_landmarker.task (only on cache miss)")
    p.add_argument("--ao-rays", type=int, default=64)
    p.add_argument("--debug", type=Path, default=None, help="write diagnostic renders here")
    p.add_argument("--quiet", action="store_true")
    build(p.parse_args(argv))


if __name__ == "__main__":
    main()
