"""GPU / CUDA detection without a hard dependency on torch.

Probes, cheapest first (each one optional and failure-tolerant):

1. NVML through ctypes (``nvml.dll`` / ``libnvidia-ml.so.1``, installed with every NVIDIA
   driver): GPU name, compute capability, VRAM total/free, driver and CUDA driver version.
2. ``nvidia-smi --query-gpu`` (when NVML could not be loaded).
3. CTranslate2: ``get_cuda_device_count()`` / ``get_supported_compute_types('cuda')``.
4. onnxruntime: available execution providers and the CUDA version it was built with.
5. torch (only when asked, it is slow to import): ``torch.cuda`` and the compiled arch list.

:func:`compat_warnings` turns the findings into actionable warnings, notably when a
Blackwell GPU (RTX 50-series, compute capability 12.0) meets a build without sm_120 support.
"""

from __future__ import annotations

import ctypes
import importlib.util
import logging
import os
import platform as _platform
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Callable

log = logging.getLogger("lawnmower_voice.device")


@dataclass
class GpuInfo:
    index: int
    name: str
    capability: str | None = None  # "12.0"
    vram_total_mb: int = 0
    vram_free_mb: int = 0


@dataclass
class DeviceReport:
    cuda: bool = False
    gpus: list[GpuInfo] = field(default_factory=list)
    driver_version: str | None = None
    cuda_driver_version: str | None = None  # highest CUDA version the driver supports, e.g. "13.0"
    sources: list[str] = field(default_factory=list)
    backends: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)

    @property
    def primary(self) -> GpuInfo | None:
        return self.gpus[0] if self.gpus else None

    def to_health(self) -> dict:
        """The ``device`` object of ``GET /health`` (contract section 6, plus extras)."""
        g = self.primary
        return {
            "cuda": bool(self.cuda),
            "name": g.name if g else (_cpu_name() or "CPU"),
            "capability": g.capability if g else None,
            "vramTotalMB": int(g.vram_total_mb) if g else 0,
            "vramFreeMB": int(g.vram_free_mb) if g else 0,
            "driverVersion": self.driver_version,
            "cudaDriverVersion": self.cuda_driver_version,
            "warnings": list(self.warnings),
        }

    def to_dict(self) -> dict:
        d = asdict(self)
        d["health"] = self.to_health()
        return d


def _cpu_name() -> str:
    """Human-readable CPU model name (best effort, no dependencies)."""
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/cpuinfo", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if line.lower().startswith("model name"):
                        return line.split(":", 1)[1].strip()
        if sys.platform == "win32":
            import winreg  # noqa: PLC0415

            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
        return _platform.processor() or ""
    except Exception:
        return _platform.processor() or ""


# --------------------------------------------------------------------------------------------
# NVML (ctypes)


class _NvmlMemory(ctypes.Structure):
    _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]


class _Nvml:
    """Minimal NVML binding; kept initialised for cheap repeated VRAM queries."""

    def __init__(self) -> None:
        self.lib = None
        self.lock = threading.Lock()

    def _candidates(self) -> list[str]:
        if sys.platform == "win32":
            out = ["nvml.dll"]
            for env in ("ProgramW6432", "ProgramFiles"):
                base = os.environ.get(env)
                if base:
                    out.append(os.path.join(base, "NVIDIA Corporation", "NVSMI", "nvml.dll"))
            windir = os.environ.get("WINDIR", r"C:\Windows")
            out.append(os.path.join(windir, "System32", "nvml.dll"))
            return out
        if sys.platform == "darwin":
            return []
        return ["libnvidia-ml.so.1", "libnvidia-ml.so"]

    def load(self):
        with self.lock:
            if self.lib is not None:
                return self.lib
            last = None
            for cand in self._candidates():
                try:
                    lib = ctypes.WinDLL(cand) if sys.platform == "win32" else ctypes.CDLL(cand)
                except OSError as exc:
                    last = exc
                    continue
                init = getattr(lib, "nvmlInit_v2", None) or getattr(lib, "nvmlInit", None)
                if init is None or init() != 0:
                    last = RuntimeError(f"nvmlInit failed for {cand}")
                    continue
                self.lib = lib
                return lib
            raise OSError(f"NVML not available ({last})")

    def query(self) -> tuple[list[GpuInfo], str | None, str | None]:
        lib = self.load()
        buf = ctypes.create_string_buffer(96)
        driver = None
        if lib.nvmlSystemGetDriverVersion(buf, 96) == 0:
            driver = buf.value.decode(errors="ignore")
        cuda_ver = None
        v = ctypes.c_int(0)
        fn = getattr(lib, "nvmlSystemGetCudaDriverVersion_v2", None) or getattr(lib, "nvmlSystemGetCudaDriverVersion", None)
        if fn is not None and fn(ctypes.byref(v)) == 0 and v.value > 0:
            cuda_ver = f"{v.value // 1000}.{(v.value % 1000) // 10}"
        count = ctypes.c_uint(0)
        get_count = getattr(lib, "nvmlDeviceGetCount_v2", None) or lib.nvmlDeviceGetCount
        if get_count(ctypes.byref(count)) != 0:
            return [], driver, cuda_ver
        gpus: list[GpuInfo] = []
        get_handle = getattr(lib, "nvmlDeviceGetHandleByIndex_v2", None) or lib.nvmlDeviceGetHandleByIndex
        for i in range(count.value):
            h = ctypes.c_void_p()
            if get_handle(ctypes.c_uint(i), ctypes.byref(h)) != 0:
                continue
            name = "NVIDIA GPU"
            if lib.nvmlDeviceGetName(h, buf, 96) == 0:
                name = buf.value.decode(errors="ignore") or name
            cap = None
            major, minor = ctypes.c_int(0), ctypes.c_int(0)
            fcap = getattr(lib, "nvmlDeviceGetCudaComputeCapability", None)
            if fcap is not None and fcap(h, ctypes.byref(major), ctypes.byref(minor)) == 0:
                cap = f"{major.value}.{minor.value}"
            mem = _NvmlMemory()
            total = free = 0
            if lib.nvmlDeviceGetMemoryInfo(h, ctypes.byref(mem)) == 0:
                total, free = mem.total // (1024 * 1024), mem.free // (1024 * 1024)
            gpus.append(GpuInfo(i, name, cap, int(total), int(free)))
        return gpus, driver, cuda_ver


_nvml = _Nvml()


def probe_nvml() -> tuple[list[GpuInfo], str | None, str | None]:
    return _nvml.query()


def probe_nvidia_smi(timeout: float = 6.0) -> tuple[list[GpuInfo], str | None, str | None]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        raise FileNotFoundError("nvidia-smi not found")
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
    fields = "index,name,compute_cap,memory.total,memory.free,driver_version"
    proc = subprocess.run(
        [exe, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=flags,
    )
    if proc.returncode != 0:
        # Old drivers do not know compute_cap; retry without it.
        fields = "index,name,memory.total,memory.free,driver_version"
        proc = subprocess.run(
            [exe, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=timeout, creationflags=flags,
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout).strip() or "nvidia-smi failed")
    keys = fields.split(",")
    gpus: list[GpuInfo] = []
    driver = None
    for line in proc.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != len(keys):
            continue
        row = dict(zip(keys, parts))

        def num(k: str) -> int:
            try:
                return int(float(row.get(k, "0")))
            except ValueError:
                return 0

        cap = row.get("compute_cap")
        gpus.append(GpuInfo(num("index"), row.get("name", "NVIDIA GPU"), cap if cap and cap[0].isdigit() else None, num("memory.total"), num("memory.free")))
        driver = row.get("driver_version") or driver
    cuda_ver = None
    try:
        head = subprocess.run([exe], capture_output=True, text=True, timeout=timeout, creationflags=flags).stdout
        m = re.search(r"CUDA Version:\s*([0-9]+\.[0-9]+)", head)
        cuda_ver = m.group(1) if m else None
    except Exception:
        pass
    return gpus, driver, cuda_ver


def _installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _dist_version(name: str) -> str | None:
    try:
        from importlib import metadata

        return metadata.version(name)
    except Exception:
        return None


def probe_ctranslate2() -> dict:
    if not _installed("ctranslate2"):
        return {"installed": False}
    import ctranslate2  # noqa: PLC0415 - lazy by design

    info: dict = {"installed": True, "version": getattr(ctranslate2, "__version__", None)}
    try:
        info["cudaDevices"] = int(ctranslate2.get_cuda_device_count())
    except Exception as exc:
        info["cudaDevices"] = 0
        info["error"] = str(exc)
    if info.get("cudaDevices"):
        try:
            info["cudaComputeTypes"] = sorted(ctranslate2.get_supported_compute_types("cuda"))
        except Exception as exc:
            info["error"] = str(exc)
    return info


def probe_onnxruntime() -> dict:
    if not _installed("onnxruntime"):
        return {"installed": False}
    import contextlib

    with contextlib.redirect_stdout(sys.stderr):
        import onnxruntime as ort  # noqa: PLC0415

    info: dict = {
        "installed": True,
        "version": getattr(ort, "__version__", None),
        "distribution": "onnxruntime-gpu" if _dist_version("onnxruntime-gpu") else ("onnxruntime" if _dist_version("onnxruntime") else None),
        # Both wheels own the same 'onnxruntime' folder; whichever was installed last wins.
        "bothDistributions": bool(_dist_version("onnxruntime-gpu") and _dist_version("onnxruntime")),
    }
    try:
        info["providers"] = list(ort.get_available_providers())
    except Exception as exc:
        info["providers"] = []
        info["error"] = str(exc)
    try:
        from onnxruntime.capi import build_and_package_info as bpi  # type: ignore

        info["cudaBuild"] = getattr(bpi, "cuda_version", None) or None
    except Exception:
        info["cudaBuild"] = None
    return info


def probe_torch() -> dict:
    if not _installed("torch"):
        return {"installed": False}
    import torch  # noqa: PLC0415

    info: dict = {"installed": True, "version": torch.__version__, "cudaBuild": getattr(torch.version, "cuda", None)}
    try:
        info["cudaAvailable"] = bool(torch.cuda.is_available())
        if info["cudaAvailable"]:
            info["archList"] = list(torch.cuda.get_arch_list())
            major, minor = torch.cuda.get_device_capability(0)
            info["capability"] = f"{major}.{minor}"
            info["name"] = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info(0)
            info["vramTotalMB"], info["vramFreeMB"] = total // 2**20, free // 2**20
    except Exception as exc:
        info["error"] = str(exc)
    return info


# --------------------------------------------------------------------------------------------


def _ver_tuple(v: str | None) -> tuple[int, ...]:
    if not v:
        return ()
    nums = re.findall(r"\d+", v)
    return tuple(int(x) for x in nums[:3])


def is_blackwell(capability: str | None) -> bool:
    t = _ver_tuple(capability)
    return bool(t) and t[0] >= 10


def compat_warnings(rep: DeviceReport) -> list[str]:
    """Actionable warnings for known-bad GPU/driver/library combinations."""
    out: list[str] = []
    g = rep.primary
    if not g:
        return out
    bw = is_blackwell(g.capability)
    drv_cuda = _ver_tuple(rep.cuda_driver_version)
    if bw and drv_cuda and drv_cuda < (12, 8):
        out.append(
            f"{g.name} (compute {g.capability}) needs an NVIDIA driver with CUDA 12.8+ support "
            f"(R570 or newer); this driver supports CUDA {rep.cuda_driver_version}. Update the driver."
        )
    ct2 = rep.backends.get("ctranslate2") or {}
    if bw and ct2.get("installed") and _ver_tuple(ct2.get("version")) < (4, 7):
        out.append(
            f"CTranslate2 {ct2.get('version')} predates the RTX 50-series fixes (CUDA 12.8 build, int8 on sm_120). "
            "Run: pip install -U \"ctranslate2>=4.7\""
        )
    ort = rep.backends.get("onnxruntime") or {}
    if ort.get("bothDistributions"):
        out.append(
            "Both 'onnxruntime' (CPU) and 'onnxruntime-gpu' are installed and overwrite each other. Fix: "
            "pip uninstall -y onnxruntime onnxruntime-gpu && pip install --no-deps --force-reinstall \"onnxruntime-gpu>=1.27\" "
            "(the setup script does this)."
        )
    if ort.get("installed") and "CUDAExecutionProvider" in (ort.get("providers") or []):
        build = _ver_tuple(ort.get("cudaBuild"))
        if bw and build and build < (12, 8):
            out.append(
                f"onnxruntime-gpu {ort.get('version')} is built with CUDA {ort.get('cudaBuild')}, which has no sm_120 kernels "
                "(expect 'no kernel image is available'). Install onnxruntime-gpu>=1.27 (CUDA 13 build)."
            )
        elif bw and _ver_tuple(ort.get("version")) < (1, 27):
            out.append(
                f"onnxruntime-gpu {ort.get('version')} may lack native sm_120 kernels; onnxruntime-gpu>=1.27 is recommended for RTX 50-series."
            )
        if build and build >= (13, 0) and drv_cuda and drv_cuda < (13, 0):
            out.append(
                f"onnxruntime-gpu is built for CUDA {ort.get('cudaBuild')} but the driver only supports CUDA {rep.cuda_driver_version}; "
                "Kokoro will run on the CPU until the driver is updated to R580 or newer."
            )
    elif ort.get("installed") and ort.get("distribution") == "onnxruntime-gpu":
        out.append("onnxruntime-gpu is installed but the CUDA execution provider is unavailable (missing CUDA/cuDNN DLLs?); TTS will use the CPU.")
    torch_info = rep.backends.get("torch") or {}
    if bw and torch_info.get("installed") and torch_info.get("cudaAvailable"):
        arch = torch_info.get("archList") or []
        if arch and not any(a in ("sm_120", "compute_120") for a in arch):
            out.append(
                f"PyTorch {torch_info.get('version')} has no sm_120 kernels (arch list {arch}); reinstall from "
                "https://download.pytorch.org/whl/cu128."
            )
    if g.vram_total_mb and g.vram_total_mb < 4000:
        out.append(f"{g.name} has {g.vram_total_mb} MB of VRAM; use --stt-compute-type int8_float16 or a smaller Whisper model.")
    return out


Probe = Callable[[], object]


def detect_device(
    probe_libs: bool = True,
    probe_torch_too: bool = False,
    probes: dict[str, Probe] | None = None,
) -> DeviceReport:
    """Run the probes and assemble a :class:`DeviceReport`. Never raises."""
    p: dict[str, Probe] = {
        "nvml": probe_nvml,
        "nvidia-smi": probe_nvidia_smi,
        "ctranslate2": probe_ctranslate2,
        "onnxruntime": probe_onnxruntime,
        "torch": probe_torch,
    }
    if probes:
        p.update(probes)
    rep = DeviceReport()

    for key in ("nvml", "nvidia-smi"):
        try:
            gpus, driver, cuda_ver = p[key]()  # type: ignore[misc]
        except Exception as exc:
            log.debug("%s probe failed: %s", key, exc)
            continue
        rep.sources.append(key)
        rep.gpus = list(gpus)
        rep.driver_version = driver
        rep.cuda_driver_version = cuda_ver
        break

    if probe_libs:
        for key in ("ctranslate2", "onnxruntime"):
            try:
                rep.backends[key] = p[key]()
            except Exception as exc:
                rep.backends[key] = {"installed": True, "error": str(exc)}
    if probe_torch_too:
        try:
            rep.backends["torch"] = p["torch"]()
        except Exception as exc:
            rep.backends["torch"] = {"installed": True, "error": str(exc)}

    ct2 = rep.backends.get("ctranslate2") or {}
    torch_info = rep.backends.get("torch") or {}
    if not rep.gpus and torch_info.get("cudaAvailable") and torch_info.get("name"):
        rep.gpus = [GpuInfo(0, torch_info["name"], torch_info.get("capability"), int(torch_info.get("vramTotalMB", 0)), int(torch_info.get("vramFreeMB", 0)))]
        rep.sources.append("torch")
    if not rep.gpus and ct2.get("cudaDevices"):
        rep.gpus = [GpuInfo(0, "CUDA GPU")]
        rep.sources.append("ctranslate2")

    rep.cuda = bool(rep.gpus) or bool(ct2.get("cudaDevices")) or bool(torch_info.get("cudaAvailable"))
    if rep.gpus and ct2.get("installed") and "cudaDevices" in ct2 and not ct2.get("cudaDevices") and not torch_info.get("cudaAvailable"):
        # A GPU exists but this CTranslate2 build/driver combination cannot use it.
        rep.warnings.append("An NVIDIA GPU was found but CTranslate2 reports no usable CUDA device (driver too old, or a CPU-only build).")
    rep.warnings.extend(compat_warnings(rep))
    return rep


class DeviceMonitor:
    """Holds the startup :class:`DeviceReport` and refreshes free VRAM cheaply (NVML only)."""

    def __init__(self, report: DeviceReport, refresh_sec: float = 2.0, nvml_query: Callable | None = None) -> None:
        self.report = report
        self._refresh_sec = refresh_sec
        self._last = time.monotonic()
        self._query = nvml_query if nvml_query is not None else (probe_nvml if "nvml" in report.sources else None)
        self._lock = threading.Lock()

    def health(self) -> dict:
        if self._query is not None and time.monotonic() - self._last >= self._refresh_sec:
            with self._lock:
                self._last = time.monotonic()
                try:
                    gpus, _driver, _cuda = self._query()
                    if gpus and self.report.gpus:
                        self.report.gpus[0].vram_free_mb = gpus[0].vram_free_mb
                except Exception as exc:  # pragma: no cover - driver hiccup
                    log.debug("VRAM refresh failed: %s", exc)
        return self.report.to_health()


def resolve_device(requested: str, report: DeviceReport) -> str:
    """``auto`` -> ``cuda`` when a CUDA device was found, else ``cpu``. Explicit values pass through."""
    r = (requested or "auto").lower()
    if r in ("cuda", "gpu"):
        return "cuda"
    if r == "cpu":
        return "cpu"
    return "cuda" if report.cuda else "cpu"
