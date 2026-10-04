"""``python -m lawnmower_voice`` - start the local voice server.

Prints exactly one JSON line to stdout once the HTTP server is listening::

    {"event": "ready", "port": 50123, "device": "cuda", "gpu": "NVIDIA GeForce RTX 5070 Laptop GPU", ...}

(plus optional ``{"event": "status", "detail": "..."}`` lines before it). Everything else -
logs, library chatter, even C-level ``printf`` from native extensions - goes to stderr: file
descriptor 1 is re-pointed at stderr and the protocol uses a private duplicate of the original
stdout.

When the server's own Python packages are missing (a setup that failed halfway), it prints
``{"event": "not-installed", "missing": ["uvicorn", ...]}``, logs "Local voice is not fully
installed (missing: ...)" and exits with ``EXIT_NOT_INSTALLED`` (2): restarting cannot help,
the app waits for a new setup run instead.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import os
import secrets
import sys
import threading
import time
from pathlib import Path
from typing import TextIO

from . import __version__
from .config import (
    DEFAULT_CORS_ORIGINS,
    DEFAULT_KOKORO_MODEL,
    DEFAULT_KOKORO_VOICES,
    DEFAULT_STT_CPU_MODEL,
    DEFAULT_STT_MODEL,
    DEFAULT_TTS_VOICE,
    ENV_TOKEN,
    VoiceConfig,
    default_models_dir,
    prepare_process_env,
)

log = logging.getLogger("lawnmower_voice")

#: Exit code when the server's own packages are missing (electron/voice-sidecar.js EXIT_NOT_INSTALLED).
EXIT_NOT_INSTALLED = 2
#: What the HTTP server itself needs (pyproject.toml dependencies); the engines are optional.
CORE_MODULES = ("uvicorn", "fastapi", "starlette", "numpy")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="python -m lawnmower_voice", description="Lawnmower Man local voice server (faster-whisper + Kokoro).")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=0, help="TCP port (0 = pick a free one; reported in the ready line)")
    ap.add_argument("--token", default=None, help=f"bearer token (default: ${ENV_TOKEN}; generated and printed in the ready line if neither is set)")
    ap.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"))
    ap.add_argument("--models-dir", default=None, help="model cache (default: $LAWNMOWER_VOICE_MODELS or voice/models)")
    ap.add_argument("--no-download", action="store_true", help="never download models at runtime")
    ap.add_argument("--preload", action="store_true", help="load both engines in the background right after start-up")
    ap.add_argument("--fake", action="store_true", help="deterministic fake engines (tests / no models)")

    g = ap.add_argument_group("speech to text")
    g.add_argument("--stt-model", default=DEFAULT_STT_MODEL, help="faster-whisper model name or path (default large-v3-turbo)")
    g.add_argument("--stt-compute-type", default="auto", help="auto | float16 | int8_float16 | int8 | float32")
    g.add_argument("--stt-cpu-model", default=DEFAULT_STT_CPU_MODEL, help="model used on the CPU instead of a large one ('same' keeps --stt-model)")
    g.add_argument("--stt-language", default="en", help="default language, also picks the CPU fallback model ('auto' = detect; the app passes the user's setting)")
    g.add_argument("--stt-beam-size", type=int, default=0, help="1-10 (0 = auto: 5 on GPU, 1 on CPU)")
    g.add_argument("--stt-cpu-threads", type=int, default=0)
    g.add_argument("--stt-initial-prompt", default="", help="context prompt, e.g. names the user says often")
    g.add_argument("--stt-hotwords", default="", help="hotwords to bias recognition (faster-whisper >= 1.0)")

    g = ap.add_argument_group("text to speech")
    g.add_argument("--tts-backend", default="auto", choices=("auto", "onnx", "torch"))
    g.add_argument("--tts-voice", default=DEFAULT_TTS_VOICE)
    g.add_argument("--tts-model", default=DEFAULT_KOKORO_MODEL, help="kokoro-v1.0.onnx | kokoro-v1.0.fp16.onnx | kokoro-v1.0.int8.onnx | path")
    g.add_argument("--tts-voices-file", default=DEFAULT_KOKORO_VOICES)
    g.add_argument("--tts-gpu-mem-mb", type=int, default=2048, help="cap for onnxruntime's CUDA memory arena")
    g.add_argument("--tts-g2p", default="auto", choices=("auto", "espeak", "misaki"))

    g = ap.add_argument_group("server")
    g.add_argument("--max-upload-mb", type=float, default=64.0)
    g.add_argument("--max-audio-sec", type=float, default=180.0)
    g.add_argument("--max-queue", type=int, default=8)
    g.add_argument("--cors-origin", action="append", default=[], help="additional allowed CORS origin (repeatable)")
    g.add_argument("--log-level", default="info", choices=("debug", "info", "warning", "error"))
    g.add_argument("--no-exit-with-parent", action="store_true", help="keep running if the launching process dies")
    g.add_argument("--version", action="version", version=f"lawnmower_voice {__version__}")
    return ap


def config_from_args(args: argparse.Namespace) -> tuple[VoiceConfig, bool]:
    """Returns ``(config, token_was_generated)``."""
    token = args.token if args.token is not None else os.environ.get(ENV_TOKEN, "")
    generated = False
    if not token:
        token = secrets.token_hex(24)
        generated = True
    cfg = VoiceConfig(
        host=args.host,
        port=args.port,
        token=token,
        device=args.device,
        models_dir=Path(args.models_dir).expanduser() if args.models_dir else default_models_dir(),
        allow_download=not args.no_download,
        preload=args.preload,
        fake=args.fake,
        stt_model=args.stt_model,
        stt_compute_type=args.stt_compute_type,
        stt_cpu_model=args.stt_cpu_model,
        stt_language=args.stt_language,
        stt_beam_size=args.stt_beam_size,
        stt_cpu_threads=args.stt_cpu_threads,
        stt_initial_prompt=args.stt_initial_prompt,
        stt_hotwords=args.stt_hotwords,
        tts_backend=args.tts_backend,
        tts_voice=args.tts_voice,
        tts_model=args.tts_model,
        tts_voices_file=args.tts_voices_file,
        tts_gpu_mem_limit_mb=args.tts_gpu_mem_mb,
        tts_g2p=args.tts_g2p,
        max_upload_mb=args.max_upload_mb,
        max_audio_sec=args.max_audio_sec,
        max_queue=args.max_queue,
        cors_origins=tuple(DEFAULT_CORS_ORIGINS) + tuple(args.cors_origin or ()),
        log_level=args.log_level,
    )
    return cfg, generated


def detect(cfg: VoiceConfig):
    """Device detection, preparing the CUDA libraries first when a GPU may be used."""
    from . import cuda_libs
    from .device import detect_device

    if cfg.fake or cfg.device == "cpu":
        return detect_device(probe_libs=False)
    pre = detect_device(probe_libs=False)
    # Prepare before the library probes import ctranslate2 (Windows DLL order, see cuda_libs).
    if pre.gpus or cfg.device == "cuda" or cuda_libs.nvidia_lib_dirs():
        cuda_libs.prepare()
    return detect_device(probe_libs=True, probe_torch_too=cfg.tts_backend == "torch")


def build_engines(cfg: VoiceConfig, report):
    if cfg.fake:
        from .fake import FakeSTT, FakeTTS

        return FakeSTT(cfg), FakeTTS(cfg)
    from .stt import FasterWhisperSTT
    from .tts import create_tts

    return FasterWhisperSTT(cfg, report), create_tts(cfg, report)


# --------------------------------------------------------------------------------------------


def _protocol_stream() -> TextIO:
    """Keep a private handle on the real stdout and send fd 1 (and ``sys.stdout``) to stderr."""
    try:
        sys.stdout.flush()
        fd = os.dup(1)
        os.dup2(2, 1)
        stream = os.fdopen(fd, "w", encoding="utf-8", buffering=1, newline="\n")
        sys.stdout = sys.stderr
        return stream
    except (OSError, ValueError, AttributeError):
        return sys.stdout


def _emit(stream: TextIO, obj: dict) -> None:
    try:
        stream.write(json.dumps(obj, separators=(",", ":")) + "\n")
        stream.flush()
    except (OSError, ValueError):
        pass  # parent closed the pipe; keep serving


def _parent_alive_checker():
    """Return a zero-arg callable that is False once the launching process has exited."""
    ppid = os.getppid()
    if ppid <= 1:
        return None
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        SYNCHRONIZE = 0x00100000
        # Holding a handle keeps the check valid even if the PID is later reused.
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, ppid)
        if not handle:
            return None

        def alive_win() -> bool:
            return kernel32.WaitForSingleObject(handle, 0) != 0  # 0 = WAIT_OBJECT_0: the parent exited

        return alive_win

    def alive_posix() -> bool:
        return os.getppid() == ppid

    return alive_posix


def _watch_parent(server, interval: float = 2.0) -> None:
    alive = _parent_alive_checker()
    if alive is None:
        return

    def loop() -> None:
        while not server.should_exit:
            time.sleep(interval)
            if not alive():
                log.warning("parent process exited; shutting down")
                server.should_exit = True
                time.sleep(10)
                os._exit(0)  # graceful shutdown hung (e.g. stuck in CUDA)

    threading.Thread(target=loop, name="parent-watch", daemon=True).start()


def missing_core_modules(names: tuple[str, ...] = CORE_MODULES) -> list[str]:
    """The core packages that cannot be found (without importing them)."""
    missing = []
    for name in names:
        try:
            found = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(name)
    return missing


def _not_installed(proto: TextIO, missing: list[str], exc: BaseException | None = None) -> int:
    """Report missing packages (protocol line + log) and return EXIT_NOT_INSTALLED."""
    _emit(proto, {"event": "not-installed", "missing": missing})
    # no final full stop: the app appends its own sentence
    log.error(
        'Local voice is not fully installed (missing: %s)%s. Run the setup script again ("Set up local voice again" in the app)',
        ", ".join(missing),
        f" [{exc}]" if exc else "",
    )
    return EXIT_NOT_INSTALLED


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        stream=sys.stderr,
        force=True,
    )
    for name in ("uvicorn.access",):
        logging.getLogger(name).setLevel(logging.INFO if level == "debug" else logging.WARNING)
    for noisy in ("httpx", "httpcore", "urllib3", "huggingface_hub", "faster_whisper"):
        logging.getLogger(noisy).setLevel(logging.INFO if level == "debug" else logging.WARNING)
    # phonemizer warns "words count mismatch" for most sentences with punctuation; harmless.
    logging.getLogger("phonemizer").setLevel(logging.INFO if level == "debug" else logging.ERROR)


def main(argv: list[str] | None = None) -> int:
    prepare_process_env()  # before any engine library is imported (Windows OpenMP clash)
    args = build_parser().parse_args(argv)
    _configure_logging(args.log_level)
    proto = _protocol_stream()
    cfg, generated = config_from_args(args)

    missing = missing_core_modules()
    if missing:
        return _not_installed(proto, missing)
    try:
        import uvicorn
    except ModuleNotFoundError as exc:  # a dependency of uvicorn itself
        return _not_installed(proto, [(exc.name or "uvicorn").split(".")[0]], exc)

    _emit(proto, {"event": "status", "detail": "Detecting GPU…"})
    report = detect(cfg)
    for w in report.warnings:
        log.warning("%s", w)
    from .device import DeviceMonitor, resolve_device

    try:
        from .server import create_app
    except ModuleNotFoundError as exc:  # e.g. pydantic, a dependency of fastapi
        return _not_installed(proto, [(exc.name or "fastapi").split(".")[0]], exc)

    device = "cpu" if cfg.fake else resolve_device(cfg.device, report)
    g = report.primary
    log.info(
        "lawnmower_voice %s: device=%s%s, models=%s%s",
        __version__,
        device,
        f" ({g.name}, compute {g.capability}, {g.vram_total_mb} MB, driver {report.driver_version}, CUDA {report.cuda_driver_version})" if g else "",
        cfg.models_dir,
        " [fake engines]" if cfg.fake else "",
    )
    stt, tts = build_engines(cfg, report)
    app = create_app(cfg, stt, tts, DeviceMonitor(report))

    uv_config = uvicorn.Config(
        app,
        host=cfg.host,
        port=cfg.port,
        log_config=None,
        log_level=cfg.log_level,
        access_log=cfg.log_level == "debug",
        lifespan="off",
        ws="none",
        timeout_keep_alive=30,
        server_header=False,
    )

    class Server(uvicorn.Server):
        async def startup(self, sockets=None):  # type: ignore[override]
            await super().startup(sockets=sockets)
            if self.should_exit:
                return
            port = cfg.port
            for srv in getattr(self, "servers", None) or []:
                for sock in srv.sockets or ():
                    port = sock.getsockname()[1]
                    break
                break
            ready = {
                "event": "ready",
                "port": port,
                "device": device,
                "gpu": g.name if g else None,
                "version": __version__,
                "fake": bool(cfg.fake),
                "pid": os.getpid(),
            }
            if generated:
                ready["token"] = cfg.token
            _emit(proto, ready)
            log.info("listening on http://%s:%s", cfg.host, port)
            if cfg.preload:
                def preload() -> None:
                    tts.try_load()
                    stt.try_load()

                threading.Thread(target=preload, name="preload", daemon=True).start()

    server = Server(uv_config)
    if not args.no_exit_with_parent:
        _watch_parent(server)
    try:
        server.run()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    except SystemExit as exc:  # uvicorn exits(1) when the port cannot be bound
        return int(exc.code or 0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
