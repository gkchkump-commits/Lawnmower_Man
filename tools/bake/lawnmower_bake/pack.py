"""Write the avatar pack (images + mesh.json + pack.json) and debug overlays."""

from __future__ import annotations

import json
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from . import PACK_FORMAT, PACK_VERSION, __version__
from . import landmarks as LM
from .mesh import WEIGHT_NAMES
from .util import ensure_dir, log, round_list

WEIGHT_SCALE = 255


def _u8(img):
    return (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)


def _save_webp(path: Path, rgb01: np.ndarray, quality: int) -> None:
    Image.fromarray(_u8(rgb01), "RGB").save(path, "WEBP", quality=quality, method=6)


def _save_png(path: Path, rgb01: np.ndarray) -> None:
    Image.fromarray(_u8(rgb01), "RGB").save(path, "PNG", optimize=True)


def _save_jpg(path: Path, bgr_u8: np.ndarray, quality: int = 86) -> None:
    Image.fromarray(cv2.cvtColor(bgr_u8, cv2.COLOR_BGR2RGB), "RGB").save(path, "JPEG", quality=quality,
                                                                        optimize=True, progressive=True)


def _write_json(path: Path, obj, compact=False) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def mesh_to_json(mesh, W, H) -> dict:
    n = len(mesh.positions)
    q = lambda a: [int(v) for v in np.clip(np.round(np.asarray(a) * WEIGHT_SCALE), 0, WEIGHT_SCALE)]  # noqa: E731
    cav = mesh.cavity
    return {
        "format": "lawnmower-relief-mesh",
        "version": 1,
        "units": "plate-px (x right, y down, z toward camera)",
        "plate": [W, H],
        "vertexCount": n,
        "triangleCount": int(len(mesh.triangles)),
        "weightScale": WEIGHT_SCALE,
        "weightNames": WEIGHT_NAMES,
        "positions": round_list(mesh.positions, 2),
        "indices": round_list(mesh.triangles, 0),
        "weights": {k: q(mesh.weights[k]) for k in WEIGHT_NAMES},
        "edge": round_list(mesh.edge, 1),
        "face": q(mesh.face),
        "groups": {
            "landmarks": round_list(mesh.landmark_vertex, 0),
            "outline": round_list(mesh.boundary, 0),
            "slitUpper": [int(v) for v in mesh.slit_upper],
            "slitLower": [int(v) for v in mesh.slit_lower],
        },
        "cavity": {
            "vertexCount": int(len(cav["positions"])),
            "positions": round_list(cav["positions"], 2),
            "uvs": round_list(cav["uvs"], 4),
            "indices": round_list(cav["indices"], 0),
            "layer": round_list(cav["layer"], 0),
            "weights": {k: q(cav["weights"][k]) for k in WEIGHT_NAMES},
        },
    }


def debug_overlay(path: Path, plate, mesh, alpha):
    """Mesh wireframe + rig weights over the plate (for humans only)."""
    H, W = plate.shape[:2]
    base = (np.clip(plate * 0.55, 0, 1) * 255).astype(np.uint8)[..., ::-1].copy()
    p = mesh.positions[:, :2]
    panels = []
    for name, color, keys in (("mesh", (0, 255, 0), []),
                              ("jaw / lips", (0, 128, 255), ["jaw", "lowerLip", "upperLip"]),
                              ("lids / brows", (255, 0, 255), ["lidUpperL", "lidUpperR", "lidLowerL", "lidLowerR",
                                                              "browL", "browR"]),
                              ("corners / depth", (255, 255, 0), ["cornerL", "cornerR"])):
        img = base.copy()
        if keys:
            val = np.zeros(len(p))
            for k in keys:
                val = np.maximum(val, mesh.weights[k])
            for t in mesh.triangles:
                c = float(val[t].mean())
                if c > 0.01:
                    pts = np.round(p[t] * 4).astype(np.int32)
                    overlay = img.copy()
                    cv2.fillConvexPoly(overlay, pts, color, lineType=cv2.LINE_AA, shift=2)
                    img = cv2.addWeighted(overlay, 0.65 * c, img, 1 - 0.65 * c, 0)
        if name == "corners / depth":
            z = mesh.positions[:, 2]
            zn = (z - z.min()) / max(1e-6, np.ptp(z))
            for i in range(len(p)):
                cv2.circle(img, tuple(np.int32(p[i])), 2, (int(255 * zn[i]), int(255 * zn[i]), 255), -1)
        for t in mesh.triangles:
            pts = np.round(p[t] * 4).astype(np.int32)
            cv2.polylines(img, [pts], True, (60, 200, 60) if name == "mesh" else (90, 90, 90), 1,
                          lineType=cv2.LINE_AA, shift=2)
        for v in mesh.slit_upper:
            cv2.circle(img, tuple(np.int32(p[v])), 2, (0, 0, 255), -1)
        for v in mesh.slit_lower:
            cv2.circle(img, tuple(np.int32(p[v])), 2, (255, 0, 0), -1)
        cv2.putText(img, name, (12, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
        panels.append(img)
    sheet = np.hstack(panels)
    cv2.imwrite(str(path), sheet)
    # Zoomed mouth/eyes crops of the mesh panel for close inspection.
    lm = mesh.positions[mesh.landmark_vertex[:468], :2]
    mx0, my0 = lm[LM.LIPS_OUTER_UPPER + LM.LIPS_OUTER_LOWER].min(0) - 30
    mx1, my1 = lm[LM.LIPS_OUTER_UPPER + LM.LIPS_OUTER_LOWER].max(0) + 30
    crop = panels[0][int(my0):int(my1), int(mx0):int(mx1)]
    cv2.imwrite(str(path.with_name(path.stem + "_mouth.png")), cv2.resize(crop, None, fx=3, fy=3,
                                                                         interpolation=cv2.INTER_LINEAR))


def write_pack(out: Path, info, frames, sel, imgs, tex, mesh, video_hash: str, name: str, debug_dir=None):
    out = ensure_dir(out)
    W, H = tex.width, tex.height
    log(f"writing pack -> {out}")
    files = {
        "plate": "plate.webp",
        "eyesClosed": "eyes_closed.webp",
        "mouth": "mouth.webp",
        "masksA": "masks_a.png",
        "masksB": "masks_b.png",
        "masksC": "masks_c.png",
        "mesh": "mesh.json",
    }
    _save_webp(out / files["plate"], tex.plate, 94)
    _save_webp(out / files["eyesClosed"], tex.eyes_closed, 92)
    _save_webp(out / files["mouth"], tex.mouth, 92)
    _save_png(out / files["masksA"], tex.masks_a)
    _save_png(out / files["masksB"], tex.masks_b)
    _save_png(out / files["masksC"], tex.masks_c)
    _write_json(out / files["mesh"], mesh_to_json(mesh, W, H), compact=True)

    prev = ensure_dir(out / "preview")
    previews = {}
    for key, idx in (("neutral", sel.neutral), ("blink", sel.blink), ("teeth", sel.teeth), ("open", sel.open)):
        fn = f"preview/{key}.jpg"
        _save_jpg(out / fn, imgs[idx])
        previews[key] = {"file": fn, "frame": int(idx), "time": round(idx / info.fps, 3)}
    del prev

    sil = tex.info["silhouette"]
    ys, xs = np.nonzero(tex.alpha > 0.02)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    lm = tex.lm
    mx, my, mw, mh = tex.mouth_rect
    manifest = {
        "format": PACK_FORMAT,
        "version": PACK_VERSION,
        "name": name,
        "generator": f"tools/bake/bake_avatar.py {__version__}",
        "source": {"video": Path(info.path).name, "sha256": video_hash, "width": info.width,
                   "height": info.height, "fps": info.fps, "frames": info.frames},
        "plate": {"width": W, "height": H, "colorSpace": "srgb"},
        "files": files,
        "previews": previews,
        "frames": {"neutral": sel.neutral, "blink": sel.blink, "teeth": sel.teeth, "open": sel.open,
                   "aura": sel.aura, "median": sel.median},
        "selection": _rounded(sel.scores),
        "channels": {
            "masksA": {"r": "alpha", "g": "goldLines", "b": "sparkle"},
            "masksB": {"r": "eyeAperture", "g": "eyeRegion", "b": "mouthRegion"},
            "masksC": {"r": "lidCoord", "g": "upperLid", "b": "occlusion"},
            "mouth": {"top": "cavity + upper teeth (upper-jaw space)", "bottom": "lower teeth (jaw space)"},
        },
        "framing": {
            "center": [W / 2, H / 2],
            "height": H,
            "width": W,
            "silhouetteBox": bbox,
            "faceCenter": [float(lm[LM.NOSE_TIP, 0]), float(0.5 * (lm[LM.FOREHEAD_TOP, 1] + lm[LM.CHIN, 1]))],
            "headTop": int(ys.min()),
            "chinY": round(sil["chinY"], 2),
            "neckFade": [round(v, 2) for v in sil["neckFade"]],
            "neck": {k: round(float(v), 2) for k, v in sil.get("neck", {}).items()},
            "earBottomY": round(sil["earBottomY"], 2),
            "headEllipse": _head_ellipse(tex),
        },
        "mouthRect": [int(mx), int(my), int(mw), int(mh)],
        "mouth": tex.info["mouth"],
        "palette": tex.palette,
        "rig": _rig_json(mesh.rig, mesh, tex),
        "landmarks": {k: [round(float(lm[i, 0]), 2), round(float(lm[i, 1]), 2)] for k, i in (
            ("noseTip", LM.NOSE_TIP), ("noseBridge", LM.NOSE_BRIDGE), ("foreheadTop", LM.FOREHEAD_TOP),
            ("chin", LM.CHIN), ("mouthCornerL", LM.MOUTH_CORNER_OUTER_L), ("mouthCornerR", LM.MOUTH_CORNER_OUTER_R),
            ("lipUpper", 0), ("lipLower", 17), ("jawAngleL", LM.JAW_ANGLE_L), ("jawAngleR", LM.JAW_ANGLE_R),
            ("cheekL", LM.CHEEK_EDGE_L), ("cheekR", LM.CHEEK_EDGE_R))},
        "outline": round_list(tex.boundary[::6], 1),
        "visibleOutline": round_list(tex.visible_outline[::2], 1),
        "mesh": mesh.info,
        "license": "Derived from the user's own reference video; see tools/bake/README.md.",
    }
    _write_json(out / "pack.json", manifest)

    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    log(f"  pack size {total / 1e6:.2f} MB")
    for f in sorted(out.rglob("*")):
        if f.is_file():
            log(f"    {f.relative_to(out)}  {f.stat().st_size / 1024:.0f} KB")
    if debug_dir is not None:
        debug_overlay(Path(debug_dir) / "debug_overlay.png", tex.plate, mesh, tex.alpha)
        log(f"  debug overlay -> {Path(debug_dir) / 'debug_overlay.png'}")
    return manifest


def _head_ellipse(tex):
    """Ellipse (centre, radii) around cranium + face, in plate px (used by the particle aura)."""
    sil = tex.info["silhouette"]
    solid = tex.solid
    ys = np.nonzero(solid.any(axis=1))[0]
    top = float(ys.min())
    bottom = float(sil["chinY"])
    rows = solid[int(top):int(sil["earBottomY"])]
    widths = [(np.nonzero(r)[0].min(), np.nonzero(r)[0].max()) for r in rows if r.any()]
    x0 = float(min(w[0] for w in widths))
    x1 = float(max(w[1] for w in widths))
    return {"center": [round((x0 + x1) / 2, 2), round((top + bottom) / 2, 2)],
            "radius": [round((x1 - x0) / 2, 2), round((bottom - top) / 2, 2)]}


def _rounded(v, nd=3):
    """Recursively round floats (keeps the manifest stable across cached / fresh analyses)."""
    if isinstance(v, dict):
        return {k: _rounded(x, nd) for k, x in v.items()}
    if isinstance(v, (list, tuple, np.ndarray)):
        return [_rounded(x, nd) for x in v]
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (float, np.floating)):
        return round(float(v), nd)
    if isinstance(v, (int, np.integer)):
        return int(v)
    return v


def _lids_json(lids, n=17):
    """Lid curves resampled at ``n`` columns (plate px) - informational / tests; the engine uses
    the per-pixel lid coordinate in masks_c."""
    out = {}
    for key, d in lids.items():
        xs = np.linspace(float(d["x"][0]), float(d["x"][-1]), n)
        out[key] = {"x": round_list(xs, 2)}
        for k in ("upper", "closed", "lower"):
            out[key][k] = round_list(np.interp(xs, d["x"], d[k]), 2)
    return out


def _rig_json(rig, mesh, tex):
    out = _rounded(rig)
    for key, lid in _lids_json(tex.lids).items():
        out["eyes"][key]["lids"] = lid
    out["slitLine"] = round_list(tex.slit_line[::3], 2)
    out["cavity"] = {"zBack": round(float(mesh.cavity["zBack"]), 2), "zStrip": round(float(mesh.cavity["zStrip"]), 2)}
    return out
