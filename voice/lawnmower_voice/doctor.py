"""Environment report and GPU smoke tests (used by the setup scripts).

    python -m lawnmower_voice.doctor            # device + library report (JSON on stdout)
    python -m lawnmower_voice.doctor --smoke    # also load both engines and time one request
    python -m lawnmower_voice.doctor --human    # readable summary on stderr as well

Checks that need no model files:

* CTranslate2: CUDA device count and supported compute types;
* onnxruntime: runs a tiny hand-built ONNX graph (MatMul + Conv) on the CUDA execution
  provider, which loads cuBLAS and cuDNN and needs real sm_120 kernels on RTX 50-series.

Exit codes: 0 = OK (GPU or CPU), 2 = the voice stack is not importable.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

from . import __version__

# --------------------------------------------------------------------------------------------
# Minimal protobuf writer for a tiny ONNX model (avoids depending on the 'onnx' package).


def _varint(n: int) -> bytes:
    out = bytearray()
    n &= (1 << 64) - 1
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field_varint(num: int, value: int) -> bytes:
    return _varint(num << 3) + _varint(value)


def _field_bytes(num: int, value: bytes | str) -> bytes:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return _varint((num << 3) | 2) + _varint(len(value)) + value


def _value_info(name: str, dims: list[int], elem_type: int = 1) -> bytes:
    shape = b"".join(_field_bytes(1, _field_varint(1, d)) for d in dims)  # Dimension.dim_value
    tensor = _field_varint(1, elem_type) + _field_bytes(2, shape)  # TypeProto.Tensor
    type_proto = _field_bytes(1, tensor)  # TypeProto.tensor_type
    return _field_bytes(1, name) + _field_bytes(2, type_proto)


def _node(op: str, inputs: list[str], outputs: list[str], name: str) -> bytes:
    return b"".join(_field_bytes(1, i) for i in inputs) + b"".join(_field_bytes(2, o) for o in outputs) + _field_bytes(3, name) + _field_bytes(4, op)


def tiny_onnx_model(n: int = 64) -> bytes:
    """ONNX model: ``Y = MatMul(A, B)`` (n x n) and ``Z = Conv(X[1,4,n], W[8,4,3])``."""
    graph = (
        _field_bytes(1, _node("MatMul", ["A", "B"], ["Y"], "mm"))
        + _field_bytes(1, _node("Conv", ["X", "W"], ["Z"], "conv"))
        + _field_bytes(2, "smoke")
        + _field_bytes(11, _value_info("A", [n, n]))
        + _field_bytes(11, _value_info("B", [n, n]))
        + _field_bytes(11, _value_info("X", [1, 4, n]))
        + _field_bytes(11, _value_info("W", [8, 4, 3]))
        + _field_bytes(12, _value_info("Y", [n, n]))
        + _field_bytes(12, _value_info("Z", [1, 8, n - 2]))
    )
    opset = _field_bytes(1, "") + _field_varint(2, 13)
    return _field_varint(1, 8) + _field_bytes(2, "lawnmower-voice") + _field_bytes(7, graph) + _field_bytes(8, opset)


def onnx_cuda_smoke() -> dict:
    """Run the tiny model on CUDA (if the provider exists) and compare with numpy."""
    import contextlib

    import numpy as np

    with contextlib.redirect_stdout(sys.stderr):
        import onnxruntime as ort
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        return {"ok": False, "skipped": True, "error": "CUDAExecutionProvider not available in this onnxruntime build"}
    so = ort.SessionOptions()
    so.log_severity_level = 3
    t0 = time.perf_counter()
    sess = ort.InferenceSession(tiny_onnx_model(), sess_options=so, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    active = sess.get_providers()
    if not active or active[0] != "CUDAExecutionProvider":
        return {"ok": False, "providers": active, "error": "onnxruntime fell back to the CPU (CUDA/cuDNN libraries could not be loaded)"}
    rng = np.random.default_rng(0)
    a = rng.standard_normal((64, 64)).astype(np.float32)
    b = rng.standard_normal((64, 64)).astype(np.float32)
    x = rng.standard_normal((1, 4, 64)).astype(np.float32)
    w = rng.standard_normal((8, 4, 3)).astype(np.float32)
    y, z = sess.run(["Y", "Z"], {"A": a, "B": b, "X": x, "W": w})
    ref_z = np.stack([sum(np.convolve(x[0, c], w[o, c][::-1], mode="valid") for c in range(4)) for o in range(8)])[None]
    ok = bool(np.allclose(y, a @ b, atol=1e-2) and np.allclose(z, ref_z, atol=1e-2))
    return {"ok": ok, "providers": active, "ms": round((time.perf_counter() - t0) * 1000), **({} if ok else {"error": "wrong results"})}


# --------------------------------------------------------------------------------------------


def _engine_smoke(kind: str, engine, run) -> dict:
    t0 = time.perf_counter()
    out: dict = {"kind": kind}
    try:
        engine.ensure_loaded(force=True)
        out["loadMs"] = round((time.perf_counter() - t0) * 1000)
        t1 = time.perf_counter()
        out["result"] = run()
        out["runMs"] = round((time.perf_counter() - t1) * 1000)
        out["ok"] = True
    except Exception as exc:
        out["ok"] = False
        out["error"] = f"{type(exc).__name__}: {exc}"
    out["status"] = engine.status()
    return out


def run_smoke(device: str = "auto", models_dir: str | None = None, stt_model: str | None = None, tts_model: str | None = None) -> dict:
    import numpy as np

    from .__main__ import detect
    from .config import VoiceConfig, default_models_dir
    from .stt import FasterWhisperSTT
    from .tts import create_tts

    cfg = VoiceConfig(token="doctor", device=device, models_dir=Path(models_dir) if models_dir else default_models_dir(), allow_download=False)
    if stt_model:
        cfg.stt_model = stt_model
    if tts_model:
        cfg.tts_model = tts_model
    rep = detect(cfg)
    stt = FasterWhisperSTT(cfg, rep)
    tts = create_tts(cfg, rep)
    t = np.arange(16000 * 2, dtype=np.float32) / 16000.0
    audio = (0.05 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    tts_res = _engine_smoke("tts", tts, lambda: {"durationSec": round(len(tts.synthesize("Hello, I am your holographic assistant.").audio) / 24000, 2)})
    stt_res = _engine_smoke("stt", stt, lambda: stt.transcribe(audio, "en"))
    return {"tts": tts_res, "stt": stt_res}


def espeak_data_check() -> dict:
    """Can espeak-ng (Kokoro's phonemizer) open its data folder? A non-ASCII (Windows) or very
    long venv path makes espeak-ng exit the whole process; the server then uses a short/ASCII
    path or a copy (tts.safe_espeak_data_path)."""
    try:
        import espeakng_loader  # noqa: PLC0415

        path = espeakng_loader.get_data_path()
    except Exception as exc:
        return {"ok": False, "skipped": True, "error": f"espeakng-loader unavailable: {type(exc).__name__}: {exc}"}
    from .tts import espeak_path_ok  # noqa: PLC0415

    ok = espeak_path_ok(path)
    out: dict = {"ok": ok, "path": path}
    if not ok:
        out["error"] = (
            "espeak-ng cannot open its data folder at this path (non-ASCII characters on Windows, or too long); "
            "the voice server works around it with a short path or a one-time copy"
        )
    return out


def cudnn_clash() -> str | None:
    """Both the CUDA 12 and CUDA 13 cuDNN wheels install into the same nvidia/cudnn folder with
    the same file names: the last one installed wins and onnxruntime's CUDA 13 provider may load
    a CUDA 12 cuDNN (typically after installing a cu12/cu128 torch build)."""
    from importlib import metadata  # noqa: PLC0415

    def has(dist: str) -> bool:
        try:
            metadata.version(dist)
            return True
        except metadata.PackageNotFoundError:
            return False

    if has("nvidia-cudnn-cu12") and has("nvidia-cudnn-cu13"):
        return (
            "nvidia-cudnn-cu12 and nvidia-cudnn-cu13 are both installed and overwrite each other's libraries "
            "(GPU text-to-speech may fall back to the CPU). Re-run the setup script with --recreate, "
            "or remove the torch backend's cu12 wheels."
        )
    return None


def collect(smoke: bool = False, device: str = "auto", models_dir: str | None = None, stt_model: str | None = None) -> dict:
    from . import cuda_libs
    from .__main__ import detect
    from .config import VoiceConfig

    cfg = VoiceConfig(token="doctor", device=device)
    if device == "cpu":
        from .device import detect_device

        report = detect_device(probe_libs=True)  # versions only; no CUDA library preloading
    else:
        report = detect(cfg)
    out: dict = {
        "version": __version__,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "platform": platform.platform(),
        "device": report.to_dict(),
        "cudaLibs": cuda_libs.report(),
        "checks": {},
    }
    ort = report.backends.get("onnxruntime") or {}
    if device != "cpu" and ort.get("installed") and "CUDAExecutionProvider" in (ort.get("providers") or []):
        try:
            out["checks"]["onnxruntimeCuda"] = onnx_cuda_smoke()
        except Exception as exc:
            out["checks"]["onnxruntimeCuda"] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    ct2 = report.backends.get("ctranslate2") or {}
    if device != "cpu" and ct2.get("installed"):
        out["checks"]["ctranslate2Cuda"] = {
            "ok": bool(ct2.get("cudaDevices")),
            "computeTypes": ct2.get("cudaComputeTypes", []),
            **({"error": ct2["error"]} if ct2.get("error") else {"error": "no CUDA device visible to CTranslate2"} if not ct2.get("cudaDevices") else {}),
        }
    warnings = list(report.warnings)
    esp = espeak_data_check()
    if not esp.get("skipped"):
        out["espeakData"] = esp  # informational: the server works around a bad path
        if not esp["ok"]:
            warnings.append(f"{esp['error']} ({esp['path']})")
    clash = cudnn_clash()
    if clash:
        warnings.append(clash)
    if smoke:
        out["smoke"] = run_smoke(device=device, models_dir=models_dir, stt_model=stt_model)
    out["summary"] = {
        "gpu": report.primary.name if report.primary else None,
        "cuda": report.cuda,
        "sttGpuReady": bool(ct2.get("cudaDevices")),
        "ttsGpuReady": bool(out["checks"].get("onnxruntimeCuda", {}).get("ok")),
        "warnings": warnings,
    }
    if smoke:
        s = out["smoke"]
        out["summary"]["sttDevice"] = s["stt"]["status"].get("device") if s["stt"].get("ok") else None
        out["summary"]["ttsDevice"] = s["tts"]["status"].get("device") if s["tts"].get("ok") else None
    return out


def _human(rep: dict) -> str:
    s = rep["summary"]
    lines = [f"lawnmower_voice {rep['version']} on Python {rep['python']} ({rep['platform']})"]
    dev = rep["device"]
    if dev["gpus"]:
        g = dev["gpus"][0]
        lines.append(f"GPU: {g['name']} (compute {g['capability']}, {g['vram_total_mb']} MB) driver {dev['driver_version']} / CUDA {dev['cuda_driver_version']}")
    else:
        lines.append("GPU: none detected (CPU mode)")
    for k, v in dev["backends"].items():
        lines.append(f"  {k}: {json.dumps(v)}")
    for k, v in rep["checks"].items():
        lines.append(f"check {k}: {'OK' if v.get('ok') else 'FAILED'} {v.get('error', '')}".rstrip())
    if "smoke" in rep:
        for k in ("stt", "tts"):
            r = rep["smoke"][k]
            st = r.get("status", {})
            if r.get("ok"):
                ct = f" ({st['computeType']})" if st.get("computeType") else ""
                note = f" - {st['note']}" if st.get("note") else ""
                lines.append(f"smoke {k}: OK on {st.get('device')}{ct}, load {r.get('loadMs')} ms, run {r.get('runMs')} ms{note}")
            else:
                lines.append(f"smoke {k}: FAILED {r.get('error')}")
    for w in s["warnings"]:
        lines.append(f"WARNING: {w}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m lawnmower_voice.doctor")
    ap.add_argument("--smoke", action="store_true", help="load the engines (models must be downloaded) and time one request each")
    ap.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"))
    ap.add_argument("--models-dir", default=None)
    ap.add_argument("--stt-model", default=None, help="Whisper model for the smoke test (default large-v3-turbo; use the one you downloaded)")
    ap.add_argument("--human", action="store_true", help="also print a readable summary to stderr")
    args = ap.parse_args(argv)
    from .config import prepare_process_env

    prepare_process_env()  # before any engine library is imported (Windows OpenMP clash)
    import logging

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr, format="%(levelname)s %(name)s: %(message)s")
    try:
        import fastapi  # noqa: F401
        import numpy  # noqa: F401
        import uvicorn  # noqa: F401
    except ImportError as exc:
        print(json.dumps({"ok": False, "error": f"core dependency missing: {exc}"}))
        return 2
    rep = collect(smoke=args.smoke, device=args.device, models_dir=args.models_dir, stt_model=args.stt_model)
    if args.human:
        sys.stderr.write(_human(rep) + "\n")
    print(json.dumps(rep, default=str))
    return 0



if __name__ == "__main__":
    sys.exit(main())
