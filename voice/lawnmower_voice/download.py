"""Model download helpers (used by the setup scripts and on first use).

    python -m lawnmower_voice.download [--stt-model large-v3-turbo] [--cpu-stt-model base.en]
                                       [--tts-model kokoro-v1.0.onnx] [--models-dir DIR]
                                       [--skip-stt] [--skip-tts]

* Whisper models come from the Hugging Face Hub through faster-whisper's ``download_model``
  (CTranslate2 conversions; ``large-v3-turbo`` is ``mobiuslabsgmbh/faster-whisper-large-v3-turbo``).
* Kokoro ONNX files come from the kokoro-onnx GitHub release ``model-files-v1.1`` (that export
  has the ``duration`` output used for exact lip-sync timings). Override the base URL with
  ``LAWNMOWER_VOICE_KOKORO_URL`` (e.g. an internal mirror).

Downloads go to a ``.part`` file and are renamed when complete; existing files are skipped.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m lawnmower_voice.download", description="Pre-download the voice models.")
    ap.add_argument("--models-dir", default=None, help="model cache (default: $LAWNMOWER_VOICE_MODELS or voice/models)")
    ap.add_argument("--stt-model", default=DEFAULT_STT_MODEL)
    ap.add_argument("--cpu-stt-model", default=DEFAULT_STT_CPU_MODEL, help="small model for the CPU fallback ('none' to skip)")
    ap.add_argument("--tts-model", default=DEFAULT_KOKORO_MODEL)
    ap.add_argument("--tts-voices-file", default=DEFAULT_KOKORO_VOICES)
    ap.add_argument("--skip-stt", action="store_true")
    ap.add_argument("--skip-tts", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)

    models_dir = Path(args.models_dir).expanduser() if args.models_dir else default_models_dir()
    cfg = VoiceConfig(models_dir=models_dir, tts_model=args.tts_model, tts_voices_file=args.tts_voices_file)
    result: dict = {"modelsDir": str(models_dir), "ok": True, "items": []}
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

    if not args.skip_stt:
        run("stt", args.stt_model, lambda: download_whisper(args.stt_model, models_dir, args.quiet))
        if args.cpu_stt_model and args.cpu_stt_model not in ("none", "same", args.stt_model):
            run("stt", args.cpu_stt_model, lambda: download_whisper(args.cpu_stt_model, models_dir, args.quiet))
    if not args.skip_tts:
        run("tts", args.tts_model, lambda: download_kokoro(cfg, args.quiet))
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
