"""Model download helpers (used by the setup scripts and on first use).

    python -m lawnmower_voice.download [--stt-model large-v3-turbo] [--cpu-stt-model base.en]
                                       [--tts-model kokoro-v1.0.onnx] [--models-dir DIR]
                                       [--skip-stt] [--skip-tts] [--kws | --skip-kws | --kws-only]
                                       [--check] [--json]

* Whisper models come from the Hugging Face Hub through faster-whisper's ``download_model``
  (CTranslate2 conversions; ``large-v3-turbo`` is ``mobiuslabsgmbh/faster-whisper-large-v3-turbo``).
* Kokoro ONNX files come from the kokoro-onnx GitHub release ``model-files-v1.1`` (that export
  has the ``duration`` output used for exact lip-sync timings). Override the base URL with
  ``LAWNMOWER_VOICE_KOKORO_URL`` (e.g. an internal mirror).
* The "Hey Jade" wake word's extra keyword model (sherpa-onnx's zh-en KWS model, "model A") comes
  from k2-fsa's GitHub release ``kws-models`` and goes to ``<models>/kws/zh-en-3m/``. It has no
  stated licence, so the app does not ship it: this downloader fetches it on the user's PC, with
  pinned SHA-256 hashes. ``--kws`` is the default (the setup scripts need no change); the app runs
  ``--kws-only --check --json`` and, when it is missing, ``--kws-only --json``. Override the base
  URL with ``LAWNMOWER_VOICE_KWS_URL``. A failed wake-word download does not fail a full run (Jade
  works with the shipped model alone); with ``--kws-only`` it does.

Downloads go to a ``.part`` file and are renamed when complete; existing files are skipped.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

from .config import (
    DEFAULT_KOKORO_MODEL,
    DEFAULT_KOKORO_VOICES,
    DEFAULT_STT_CPU_MODEL,
    DEFAULT_STT_MODEL,
    VoiceConfig,
    default_models_dir,
)

log = logging.getLogger("lawnmower_voice.download")

KOKORO_BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
#: Lower bounds (bytes) used to reject truncated or error-page downloads.
KOKORO_MIN_SIZES = {
    "kokoro-v1.0.onnx": 250_000_000,
    "kokoro-v1.0.fp16.onnx": 120_000_000,
    "kokoro-v1.0.int8.onnx": 60_000_000,
    "voices-v1.0.bin": 20_000_000,
}


def _progress(name: str, quiet: bool):
    state = {"last": 0.0}

    def hook(done: int, total: int) -> None:
        if quiet:
            return
        now = time.monotonic()
        if now - state["last"] < 0.5 and done != total:
            return
        state["last"] = now
        if total > 0:
            pct = 100.0 * done / total
            sys.stderr.write(f"\r  {name}: {done / 1e6:7.1f} / {total / 1e6:.1f} MB ({pct:5.1f}%)")
        else:
            sys.stderr.write(f"\r  {name}: {done / 1e6:7.1f} MB")
        sys.stderr.flush()

    return hook


def download_file(url: str, dest: Path, min_bytes: int = 0, quiet: bool = False, retries: int = 3, timeout: float = 60.0) -> Path:
    """Download ``url`` to ``dest`` atomically (skip if it already exists and is big enough)."""
    dest = Path(dest)
    if dest.is_file() and dest.stat().st_size >= max(1, min_bytes):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lawnmower-voice/0.1"})
            with urllib.request.urlopen(req, timeout=timeout) as resp, open(tmp, "wb") as out:
                total = int(resp.headers.get("Content-Length") or 0)
                hook = _progress(dest.name, quiet)
                done = 0
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    done += len(chunk)
                    hook(done, total)
            if not quiet:
                sys.stderr.write("\n")
            size = tmp.stat().st_size
            if total and size != total:
                raise OSError(f"incomplete download ({size} of {total} bytes)")
            if size < min_bytes:
                raise OSError(f"downloaded file is too small ({size} bytes); expected at least {min_bytes}")
            os.replace(tmp, dest)
            return dest
        except Exception as exc:  # network errors, HTTP errors, short reads
            last_exc = exc
            log.warning("download of %s failed (attempt %d/%d): %s", url, attempt, retries, exc)
            time.sleep(min(10.0, 1.5 * attempt))
        finally:
            if tmp.exists():
                try:
                    tmp.unlink()
                except OSError:
                    pass
    raise OSError(f"could not download {url}: {last_exc}")


def download_kokoro(config: VoiceConfig, quiet: bool = False) -> list[Path]:
    base = os.environ.get("LAWNMOWER_VOICE_KOKORO_URL", KOKORO_BASE_URL)
    if not base.endswith("/"):
        base += "/"
    out = []
    for path in (config.kokoro_model_path(), config.kokoro_voices_path()):
        if path.is_file():
            out.append(path)
            continue
        name = path.name
        if name not in KOKORO_MIN_SIZES:
            raise FileNotFoundError(f"{path} does not exist and '{name}' is not a known Kokoro release file")
        if not quiet:
            sys.stderr.write(f"Downloading {name} -> {path}\n")
        out.append(download_file(base + name, path, KOKORO_MIN_SIZES[name], quiet=quiet))
    return out


def download_whisper(name: str, models_dir: Path, quiet: bool = False) -> str:
    if Path(name).expanduser().is_dir():
        return str(Path(name).expanduser())
    from faster_whisper.utils import download_model  # noqa: PLC0415

    cache = str(Path(models_dir) / "whisper")
    try:
        return download_model(name, local_files_only=True, cache_dir=cache)
    except Exception:
        pass
    if not quiet:
        sys.stderr.write(f"Downloading Whisper model {name} -> {cache}\n")
    return download_model(name, cache_dir=cache)


# ---- "Hey Jade" (wake word; docs/WAKE.md): the zh-en keyword-spotting model ----------------------
KWS_BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
KWS_KEY = "zh-en-3m"
#: The release archive and the four members the app uses (installed under shorter names). The same
#: hashes are pinned in electron/wake/config.js (tests/unit/wake-engine/config.test.js checks it).
KWS_ZHEN = {
    "archive": "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2",
    "sha256": "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6",
    "size": 32_885_699,
    "members": {
        "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx": (
            "encoder.int8.onnx", "408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48", 4_599_656),
        "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/decoder-epoch-13-avg-2-chunk-16-left-64.onnx": (
            "decoder.onnx", "63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21", 759_829),
        "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx": (
            "joiner.int8.onnx", "190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1", 86_629),
        "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/tokens.txt": (
            "tokens.txt", "2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0", 1_928),
    },
}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def kws_dir(models_dir: Path) -> Path:
    """Where the wake word's zh-en model lives: ``<models>/kws/zh-en-3m``."""
    return Path(models_dir) / "kws" / KWS_KEY


def kws_present(models_dir: Path) -> bool:
    """All four files there, with the pinned size and SHA-256."""
    d = kws_dir(models_dir)
    for name, sha, size in KWS_ZHEN["members"].values():
        p = d / name
        if not p.is_file() or p.stat().st_size != size or _sha256_file(p) != sha:
            return False
    return True


def download_kws(models_dir: Path, quiet: bool = False, check: bool = False) -> dict:
    """Fetch the zh-en keyword model into ``<models>/kws/zh-en-3m`` (verified; skipped when present).

    Returns ``{"dir", "present", "downloaded"}``; raises on a failed or unverified download, and
    writes nothing then. With ``check`` it only reports.
    """
    d = kws_dir(models_dir)
    if kws_present(models_dir):
        return {"dir": str(d), "present": True, "downloaded": False}
    if check:
        return {"dir": str(d), "present": False, "downloaded": False}
    base = os.environ.get("LAWNMOWER_VOICE_KWS_URL", KWS_BASE_URL)
    if not base.endswith("/"):
        base += "/"
    d.parent.mkdir(parents=True, exist_ok=True)
    archive = d.parent / KWS_ZHEN["archive"]
    try:
        if not quiet:
            sys.stderr.write(f"Downloading the wake-word model {KWS_ZHEN['archive']} -> {d}\n")
        download_file(base + KWS_ZHEN["archive"], archive, KWS_ZHEN["size"], quiet=quiet)
        got = _sha256_file(archive)
        if got != KWS_ZHEN["sha256"] or archive.stat().st_size != KWS_ZHEN["size"]:
            raise OSError(f"SHA-256 mismatch for {KWS_ZHEN['archive']}: expected {KWS_ZHEN['sha256']}, got {got}")
        # read the four members into memory (5.5 MB), verify all, then install them together
        blobs: dict[str, bytes] = {}
        with tarfile.open(archive, "r:bz2") as tf:
            for member, (name, sha, size) in KWS_ZHEN["members"].items():
                info = tf.getmember(member)
                if not info.isfile():
                    raise OSError(f"{member} is not a file in {KWS_ZHEN['archive']}")
                f = tf.extractfile(info)
                data = f.read() if f else b""
                if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
                    raise OSError(f"unexpected {member} inside {KWS_ZHEN['archive']}")
                blobs[name] = data
        tmp = Path(tempfile.mkdtemp(prefix=".zh-en-3m-", dir=d.parent))
        try:
            for name, data in blobs.items():
                (tmp / name).write_bytes(data)
            d.mkdir(parents=True, exist_ok=True)
            for name in blobs:
                os.replace(tmp / name, d / name)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    finally:
        try:
            archive.unlink()
        except OSError:
            pass
    return {"dir": str(d), "present": kws_present(models_dir), "downloaded": True}
# ---- end "Hey Jade" ----


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m lawnmower_voice.download", description="Pre-download the voice models.")
    ap.add_argument("--models-dir", default=None, help="model cache (default: $LAWNMOWER_VOICE_MODELS or voice/models)")
    ap.add_argument("--stt-model", default=DEFAULT_STT_MODEL)
    ap.add_argument("--cpu-stt-model", default=DEFAULT_STT_CPU_MODEL, help="small model for the CPU fallback ('none' to skip)")
    ap.add_argument("--tts-model", default=DEFAULT_KOKORO_MODEL)
    ap.add_argument("--tts-voices-file", default=DEFAULT_KOKORO_VOICES)
    ap.add_argument("--skip-stt", action="store_true")
    ap.add_argument("--skip-tts", action="store_true")
    # ---- "Hey Jade" (wake word) ----
    kws = ap.add_mutually_exclusive_group()
    kws.add_argument("--kws", action="store_true", help="also fetch the wake word's zh-en keyword model (the default)")
    kws.add_argument("--skip-kws", action="store_true", help="do not fetch the wake-word model")
    kws.add_argument("--kws-only", action="store_true", help="only the wake-word model (no Whisper, no Kokoro)")
    ap.add_argument("--check", action="store_true", help="report whether the wake-word model is there; download nothing")
    ap.add_argument("--json", action="store_true", help="machine use: no progress output; the JSON result line on stdout")
    # ---- end "Hey Jade" ----
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    quiet = args.quiet or args.json

    models_dir = Path(args.models_dir).expanduser() if args.models_dir else default_models_dir()
    cfg = VoiceConfig(models_dir=models_dir, tts_model=args.tts_model, tts_voices_file=args.tts_voices_file)
    result: dict = {"modelsDir": str(models_dir), "ok": True, "items": []}
    # --kws-only / --check touch only the 5.5 MB wake-word model
    voice_models = not (args.kws_only or args.check)
    if voice_models:
        free = shutil.disk_usage(models_dir if models_dir.exists() else models_dir.parent if models_dir.parent.exists() else Path.home()).free
        if free < 4 * 1024**3:
            sys.stderr.write(f"WARNING: only {free / 1024**3:.1f} GB free near {models_dir}; the models need about 2.5 GB.\n")

    def run(kind: str, name: str, fn) -> None:
        t0 = time.monotonic()
        try:
            path = fn()
            result["items"].append({"kind": kind, "name": name, "path": str(path), "ok": True, "sec": round(time.monotonic() - t0, 1)})
        except Exception as exc:
            result["ok"] = False
            result["items"].append({"kind": kind, "name": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
            sys.stderr.write(f"ERROR: {kind} {name}: {exc}\n")

    if voice_models and not args.skip_stt:
        run("stt", args.stt_model, lambda: download_whisper(args.stt_model, models_dir, quiet))
        if args.cpu_stt_model and args.cpu_stt_model not in ("none", "same", args.stt_model):
            run("stt", args.cpu_stt_model, lambda: download_whisper(args.cpu_stt_model, models_dir, quiet))
    if voice_models and not args.skip_tts:
        run("tts", args.tts_model, lambda: download_kokoro(cfg, quiet))
    # ---- "Hey Jade" (wake word): optional in a full run, the point of --kws-only ----
    if not args.skip_kws:
        try:
            k = download_kws(models_dir, quiet=quiet, check=args.check)
        except Exception as exc:
            k = {"dir": str(kws_dir(models_dir)), "present": False, "downloaded": False, "error": f"{type(exc).__name__}: {exc}"}
            sys.stderr.write(f"{'ERROR' if args.kws_only else 'WARNING'}: the wake-word model could not be downloaded: {exc}\n")
            if args.kws_only:
                result["ok"] = False
        result["kws"] = {KWS_KEY: k}
    # ---- end "Hey Jade" ----
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
