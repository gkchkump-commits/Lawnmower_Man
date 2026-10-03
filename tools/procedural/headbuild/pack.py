"""Writer for the compact procedural-head model: head.json (metadata) + head.bin (buffers).

Binary layout (little endian, every block 4-byte aligned, offsets in head.json):
  position  uint16 x3   p = min + q / 65535 * (max - min)
  rig       uint8  x8   rig weights / 255 (channel order: headbuild.rig.RIG_CHANNELS)
  aux       uint8  x4   ao, convexity (0.5 = flat, 1 = ridge), lips, ear
  cavity    uint8  x4   part (255 = mouth cavity), u, v, side (255 = upper); on the skin (part 0)
                        y = distance to the nearest gold curve / curveDistanceRange
  shell     uint8  x4   smoothed "outer shell" normal (n * 0.5 + 0.5), inner-mouth mask
  index     uint16 or uint32 triangles
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

FORMAT = "lawnmower-procedural-head"
VERSION = 1


def _u8(x):
    return np.clip(np.round(np.asarray(x, float) * 255), 0, 255).astype(np.uint8)


def write_model(out_dir: Path, name: str, V, F, rig, aux, cav, shell, meta: dict):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    n = len(V)
    vmin, vmax = V.min(0), V.max(0)
    span = np.maximum(vmax - vmin, 1e-9)
    q = np.clip(np.round((V - vmin) / span * 65535), 0, 65535).astype("<u2")
    itype = "<u2" if n <= 65535 else "<u4"
    blocks = [
        ("position", q, {"type": "uint16", "components": 3, "min": vmin.tolist(), "max": vmax.tolist()}),
        ("rig", _u8(rig), {"type": "uint8", "components": rig.shape[1], "normalized": True}),
        ("aux", _u8(aux), {"type": "uint8", "components": 4, "normalized": True}),
        ("cavity", _u8(cav), {"type": "uint8", "components": 4, "normalized": True}),
        ("shell", _u8(shell), {"type": "uint8", "components": 4, "normalized": True}),
        ("index", np.asarray(F, itype).reshape(-1), {"type": "uint16" if itype == "<u2" else "uint32"}),
    ]
    buf = bytearray()
    layout = {}
    for key, arr, info in blocks:
        while len(buf) % 4:
            buf.append(0)
        b = np.ascontiguousarray(arr).tobytes()
        layout[key] = {**info, "offset": len(buf), "byteLength": len(b)}
        buf += b
    bin_name = f"{name}.bin"
    (out_dir / bin_name).write_bytes(bytes(buf))
    doc = {
        "format": FORMAT,
        "version": VERSION,
        **meta,
        "buffer": {"uri": bin_name, "byteLength": len(buf), "sha256": hashlib.sha256(bytes(buf)).hexdigest()},
        "vertexCount": int(n),
        "indexCount": int(F.size),
        "layout": layout,
    }
    (out_dir / f"{name}.json").write_text(json.dumps(doc, indent=1, default=_json_default))
    return doc


def _json_default(o):
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    raise TypeError(type(o))
