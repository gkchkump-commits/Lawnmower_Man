"""Make pip-installed NVIDIA libraries visible to CTranslate2 and onnxruntime.

Why this exists (verified against the published wheels, see docs/VOICE.md):

* CTranslate2 4.8 loads cuBLAS 12 *dynamically* at first use: on Windows with
  ``LoadLibraryA("cublas64_12.dll")`` (after ``SetDllDirectoryA(%CUDA_PATH%\\bin)``), on Linux
  with ``dlopen("libcublas.so.12")``. Neither honours ``os.add_dll_directory`` /
  ``site-packages``. A library whose module name is already loaded wins, so we pre-load
  cuBLAS from the ``nvidia-cublas-cu12`` wheel by full path (and also prepend its folder to
  ``PATH``). This also stops an older CUDA toolkit referenced by ``%CUDA_PATH%`` from being
  picked up (old cuBLAS has no Blackwell kernels -> ``CUBLAS_STATUS_NOT_SUPPORTED``).
* onnxruntime-gpu >= 1.27 is built for CUDA 13 and ships ``onnxruntime.preload_dlls()``, which
  loads cuBLAS/cuDNN/cudart 13 from the ``nvidia-*`` wheels.
* On Windows the CTranslate2 wheel bundles its own ``cudnn64_9.dll`` (CUDA 12 build) and
  loads it on import. Because the Windows loader resolves imports by module name, onnxruntime's
  CUDA provider could bind to that copy. So onnxruntime's libraries (and its CUDA provider
  DLL) are loaded *before* CTranslate2 is imported.

:func:`prepare` is idempotent and never raises; it returns a report for ``/health`` and
``doctor``. It is a no-op on macOS.
"""

from __future__ import annotations

import contextlib
import ctypes
import importlib.util
import logging
import os
import site
import sys
import threading
from pathlib import Path

log = logging.getLogger("lawnmower_voice.cuda")

_lock = threading.Lock()
_report: dict | None = None
_keep: list = []  # keep add_dll_directory handles and CDLL objects alive


def _site_dirs() -> list[Path]:
    dirs: list[Path] = []
    seen: set[str] = set()
    candidates: list[str] = []
    with contextlib.suppress(Exception):
        candidates += site.getsitepackages()
    with contextlib.suppress(Exception):
        candidates.append(site.getusersitepackages())
    candidates += [p for p in sys.path if p and ("site-packages" in p or "dist-packages" in p)]
    for c in candidates:
        try:
            p = Path(c).resolve()
        except OSError:
            continue
        if str(p) in seen or not p.is_dir():
            continue
        seen.add(str(p))
        dirs.append(p)
    return dirs


def nvidia_lib_dirs(platform: str | None = None, roots: list[Path] | None = None) -> list[Path]:
    """Folders holding NVIDIA runtime libraries installed from PyPI (``nvidia-*`` wheels).

    CUDA <= 12 wheels use ``nvidia/<component>/{bin,lib}``; CUDA 13 consolidated them into
    ``nvidia/cu13/bin/x86_64`` (Windows) and ``nvidia/cu13/lib`` (Linux).
    """
    platform = platform or sys.platform
    out: list[Path] = []
    for root in roots if roots is not None else _site_dirs():
        nv = root / "nvidia"
        if not nv.is_dir():
            continue
        for comp in sorted(nv.iterdir()):
            if not comp.is_dir():
                continue
            if platform == "win32":
                for d in (comp / "bin", comp / "bin" / "x86_64"):
                    if d.is_dir() and any(d.glob("*.dll")):
                        out.append(d)
            else:
                d = comp / "lib"
                if d.is_dir() and any(d.glob("*.so*")):
                    out.append(d)
    return out


def _find(dirs: list[Path], name: str) -> Path | None:
    for d in dirs:
        p = d / name
        if p.is_file():
            return p
    return None


def _ort_is_gpu_build() -> bool:
    """True when the installed onnxruntime distribution is the CUDA build (without importing it)."""
    try:
        from importlib import metadata

        metadata.distribution("onnxruntime-gpu")
        return importlib.util.find_spec("onnxruntime") is not None
    except Exception:
        return False


def _load(path: Path, report: dict) -> bool:
    try:
        if sys.platform == "win32":
            lib = ctypes.WinDLL(str(path))
        else:
            lib = ctypes.CDLL(str(path), mode=getattr(os, "RTLD_GLOBAL", 0) | getattr(os, "RTLD_NOW", 0))
        _keep.append(lib)
        report["loaded"].append(path.name)
        return True
    except OSError as exc:
        report["errors"].append(f"{path.name}: {exc}")
        return False


def _preload_onnxruntime(report: dict) -> None:
    if not _ort_is_gpu_build():
        return
    if "ctranslate2" in sys.modules and sys.platform == "win32":
        report["errors"].append("ctranslate2 was imported before onnxruntime's CUDA libraries; GPU TTS may bind to the wrong cuDNN")
    try:
        with contextlib.redirect_stdout(sys.stderr):  # preload_dlls() prints; stdout is our protocol pipe
            import onnxruntime as ort  # noqa: F401

            if hasattr(ort, "preload_dlls"):
                ort.preload_dlls()
                report["onnxruntimePreload"] = True
        if sys.platform == "win32":
            prov = Path(ort.__file__).parent / "capi" / "onnxruntime_providers_cuda.dll"
            if prov.is_file():
                _load(prov, report)
    except Exception as exc:  # pragma: no cover - depends on the local CUDA install
        report["errors"].append(f"onnxruntime preload: {exc}")


def _preload_cublas12(dirs: list[Path], report: dict) -> None:
    names = ("cublasLt64_12.dll", "cublas64_12.dll") if sys.platform == "win32" else ("libcublasLt.so.12", "libcublas.so.12")
    for name in names:
        p = _find(dirs, name)
        if p is None:
            report["missing"].append(name)
            continue
        _load(p, report)


def prepare(enable: bool = True) -> dict:
    """Configure library search paths and pre-load CUDA libraries once (see module docstring)."""
    global _report
    with _lock:
        if _report is not None:
            return _report
        report: dict = {"platform": sys.platform, "dirs": [], "loaded": [], "missing": [], "errors": [], "onnxruntimePreload": False}
        if not enable or sys.platform not in ("win32", "linux"):
            report["skipped"] = True
            _report = report
            return report

        # A larger JIT cache keeps CTranslate2's PTX (compiled for sm_86, JIT-compiled for sm_120 on
        # first use) cached between runs. Must be set before the CUDA driver initialises.
        os.environ.setdefault("CUDA_CACHE_MAXSIZE", str(1024 * 1024 * 1024))

        dirs = nvidia_lib_dirs()
        report["dirs"] = [str(d) for d in dirs]
        if sys.platform == "win32" and dirs:
            for d in dirs:
                with contextlib.suppress(OSError, AttributeError):
                    _keep.append(os.add_dll_directory(str(d)))
            path = os.environ.get("PATH", "")
            parts = [str(d) for d in dirs if str(d) not in path.split(os.pathsep)]
            if parts:
                os.environ["PATH"] = os.pathsep.join(parts + [path])
        elif dirs:
            # Child processes / late dlopen() calls by name also benefit.
            ld = os.environ.get("LD_LIBRARY_PATH", "")
            parts = [str(d) for d in dirs if str(d) not in ld.split(os.pathsep)]
            if parts:
                os.environ["LD_LIBRARY_PATH"] = os.pathsep.join(parts + ([ld] if ld else []))

        _preload_onnxruntime(report)  # before ctranslate2 is imported (Windows cuDNN name clash)
        _preload_cublas12(dirs, report)
        if report["errors"]:
            log.debug("CUDA library preload issues: %s", report["errors"])
        _report = report
        return report


def report() -> dict | None:
    """The last :func:`prepare` report (``None`` if never called)."""
    return _report


def _reset_for_tests() -> None:
    global _report
    with _lock:
        _report = None
