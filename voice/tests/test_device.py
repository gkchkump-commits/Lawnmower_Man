from __future__ import annotations

import subprocess
import types

import pytest

from lawnmower_voice import cuda_libs, device
from lawnmower_voice.device import DeviceMonitor, DeviceReport, GpuInfo, compat_warnings, detect_device, resolve_device


def _fail(*_a, **_k):
    raise OSError("not available")


ALL_MISSING = {
    "nvml": _fail,
    "nvidia-smi": _fail,
    "ctranslate2": lambda: {"installed": False},
    "onnxruntime": lambda: {"installed": False},
    "torch": lambda: {"installed": False},
}

RTX5070 = GpuInfo(0, "NVIDIA GeForce RTX 5070 Laptop GPU", "12.0", 8151, 7400)


def test_everything_missing_reports_cpu():
    rep = detect_device(probe_libs=True, probe_torch_too=True, probes=ALL_MISSING)
    assert rep.cuda is False
    assert rep.gpus == [] and rep.warnings == [] and rep.sources == []
    h = rep.to_health()
    assert h["cuda"] is False and h["capability"] is None
    assert h["vramTotalMB"] == 0 and h["vramFreeMB"] == 0
    assert isinstance(h["name"], str) and h["name"]
    assert resolve_device("auto", rep) == "cpu"
    assert resolve_device("cuda", rep) == "cuda"  # explicit request is honoured (engines fall back)
    assert resolve_device("cpu", rep) == "cpu"


def test_probe_exceptions_never_escape():
    def boom():
        raise RuntimeError("driver exploded")

    rep = detect_device(probes={**ALL_MISSING, "ctranslate2": boom, "onnxruntime": boom})
    assert rep.backends["ctranslate2"]["error"] == "driver exploded"
    assert rep.cuda is False


def test_nvidia_smi_used_when_nvml_missing():
    rep = detect_device(probe_libs=False, probes={**ALL_MISSING, "nvidia-smi": lambda: ([RTX5070], "581.57", "13.0")})
    assert rep.cuda and rep.sources == ["nvidia-smi"]
    assert rep.to_health()["capability"] == "12.0"
    assert resolve_device("auto", rep) == "cuda"


def test_healthy_blackwell_stack_has_no_warnings():
    probes = {
        **ALL_MISSING,
        "nvml": lambda: ([RTX5070], "581.57", "13.0"),
        "ctranslate2": lambda: {"installed": True, "version": "4.8.2", "cudaDevices": 1, "cudaComputeTypes": ["float16", "int8_float16"]},
        "onnxruntime": lambda: {"installed": True, "version": "1.30.0", "distribution": "onnxruntime-gpu", "providers": ["CUDAExecutionProvider", "CPUExecutionProvider"], "cudaBuild": "13.0"},
    }
    rep = detect_device(probes=probes)
    assert rep.cuda and rep.warnings == []
    assert rep.to_health()["vramTotalMB"] == 8151


def test_blackwell_with_old_builds_warns():
    rep = DeviceReport(cuda=True, gpus=[RTX5070], driver_version="566.36", cuda_driver_version="12.7")
    rep.backends = {
        "ctranslate2": {"installed": True, "version": "4.5.0", "cudaDevices": 1},
        "onnxruntime": {"installed": True, "version": "1.20.1", "providers": ["CUDAExecutionProvider"], "cudaBuild": "12.4"},
        "torch": {"installed": True, "version": "2.5.1+cu124", "cudaAvailable": True, "archList": ["sm_80", "sm_86", "sm_90"]},
    }
    text = "\n".join(compat_warnings(rep))
    assert "R570" in text  # driver too old for CUDA 12.8
    assert "ctranslate2>=4.7" in text
    assert "no sm_120 kernels" in text and "onnxruntime-gpu>=1.27" in text
    assert "download.pytorch.org/whl/cu128" in text


def test_cuda13_onnxruntime_needs_r580_driver():
    rep = DeviceReport(cuda=True, gpus=[RTX5070], cuda_driver_version="12.9")
    rep.backends = {"onnxruntime": {"installed": True, "version": "1.30.0", "providers": ["CUDAExecutionProvider"], "cudaBuild": "13.0"}}
    assert any("R580" in w for w in compat_warnings(rep))


def test_gpu_onnxruntime_without_cuda_provider_warns():
    rep = DeviceReport(cuda=True, gpus=[RTX5070], cuda_driver_version="13.0")
    rep.backends = {"onnxruntime": {"installed": True, "version": "1.30.0", "distribution": "onnxruntime-gpu", "providers": ["CPUExecutionProvider"]}}
    assert any("CUDA execution provider is unavailable" in w for w in compat_warnings(rep))


def test_gpu_present_but_ctranslate2_cannot_use_it():
    probes = {**ALL_MISSING, "nvml": lambda: ([RTX5070], "581.57", "13.0"), "ctranslate2": lambda: {"installed": True, "version": "4.8.2", "cudaDevices": 0}}
    rep = detect_device(probes=probes)
    assert any("CTranslate2 reports no usable CUDA device" in w for w in rep.warnings)


def test_torch_is_used_as_last_resort_for_gpu_info():
    probes = {**ALL_MISSING, "torch": lambda: {"installed": True, "cudaAvailable": True, "name": "RTX", "capability": "12.0", "vramTotalMB": 8000, "vramFreeMB": 7000, "archList": ["sm_120"]}}
    rep = detect_device(probe_torch_too=True, probes=probes)
    assert rep.cuda and rep.primary.name == "RTX" and "torch" in rep.sources


def test_library_probes_report_missing_modules(monkeypatch):
    monkeypatch.setattr(device, "_installed", lambda _m: False)
    assert device.probe_ctranslate2() == {"installed": False}
    assert device.probe_onnxruntime() == {"installed": False}
    assert device.probe_torch() == {"installed": False}


def test_nvidia_smi_parsing(monkeypatch):
    monkeypatch.setattr(device.shutil, "which", lambda _n: "/usr/bin/nvidia-smi")
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        if len(cmd) == 1:
            return subprocess.CompletedProcess(cmd, 0, "| NVIDIA-SMI 581.57   Driver Version: 581.57   CUDA Version: 13.0 |", "")
        return subprocess.CompletedProcess(cmd, 0, "0, NVIDIA GeForce RTX 5070 Laptop GPU, 12.0, 8151, 7123, 581.57\n", "")

    monkeypatch.setattr(device.subprocess, "run", fake_run)
    gpus, driver, cuda = device.probe_nvidia_smi()
    assert gpus == [GpuInfo(0, "NVIDIA GeForce RTX 5070 Laptop GPU", "12.0", 8151, 7123)]
    assert driver == "581.57" and cuda == "13.0"


def test_nvidia_smi_missing(monkeypatch):
    monkeypatch.setattr(device.shutil, "which", lambda _n: None)
    with pytest.raises(FileNotFoundError):
        device.probe_nvidia_smi()


def test_real_detection_does_not_crash_here():
    rep = detect_device(probe_libs=True)
    assert isinstance(rep.to_health(), dict)


def test_device_monitor_refreshes_free_vram():
    rep = DeviceReport(cuda=True, gpus=[GpuInfo(0, "GPU", "12.0", 8000, 7000)], sources=["nvml"])
    free = iter([6000, 5000])
    mon = DeviceMonitor(rep, refresh_sec=0.0, nvml_query=lambda: ([GpuInfo(0, "GPU", "12.0", 8000, next(free))], None, None))
    assert mon.health()["vramFreeMB"] == 6000
    assert mon.health()["vramFreeMB"] == 5000


def test_is_blackwell():
    assert device.is_blackwell("12.0") and device.is_blackwell("10.0")
    assert not device.is_blackwell("8.9") and not device.is_blackwell(None)


# --- cuda_libs ---------------------------------------------------------------------------------


def _touch(p):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"")


def test_nvidia_lib_dirs_windows_layouts(tmp_path):
    _touch(tmp_path / "nvidia" / "cublas" / "bin" / "cublas64_12.dll")
    _touch(tmp_path / "nvidia" / "cu13" / "bin" / "x86_64" / "cublas64_13.dll")
    _touch(tmp_path / "nvidia" / "cudnn" / "bin" / "cudnn64_9.dll")
    _touch(tmp_path / "nvidia" / "empty" / "bin" / "readme.txt")
    dirs = cuda_libs.nvidia_lib_dirs("win32", [tmp_path])
    rel = sorted(str(d.relative_to(tmp_path)).replace("\\", "/") for d in dirs)
    assert rel == ["nvidia/cu13/bin/x86_64", "nvidia/cublas/bin", "nvidia/cudnn/bin"]


def test_nvidia_lib_dirs_linux_layouts(tmp_path):
    _touch(tmp_path / "nvidia" / "cublas" / "lib" / "libcublas.so.12")
    _touch(tmp_path / "nvidia" / "cu13" / "lib" / "libcublas.so.13")
    dirs = cuda_libs.nvidia_lib_dirs("linux", [tmp_path])
    assert sorted(d.name for d in dirs) == ["lib", "lib"]
    assert cuda_libs._find(dirs, "libcublas.so.12") == tmp_path / "nvidia" / "cublas" / "lib" / "libcublas.so.12"


def test_prepare_is_idempotent_and_safe(monkeypatch):
    cuda_libs._reset_for_tests()
    monkeypatch.setattr(cuda_libs, "nvidia_lib_dirs", lambda *a, **k: [])
    monkeypatch.setattr(cuda_libs, "_ort_is_gpu_build", lambda: False)
    rep = cuda_libs.prepare()
    assert rep is cuda_libs.prepare()
    assert rep["errors"] == [] and rep["loaded"] == []
    cuda_libs._reset_for_tests()
    rep = cuda_libs.prepare(enable=False)
    assert rep.get("skipped")
    cuda_libs._reset_for_tests()


def test_prepare_preloads_cublas_by_full_path(monkeypatch, tmp_path):
    cuda_libs._reset_for_tests()
    lib = tmp_path / "nvidia" / "cublas" / "lib"
    _touch(lib / "libcublasLt.so.12")
    _touch(lib / "libcublas.so.12")
    loaded = []
    monkeypatch.setattr(cuda_libs, "nvidia_lib_dirs", lambda *a, **k: [lib])
    monkeypatch.setattr(cuda_libs, "_ort_is_gpu_build", lambda: False)
    monkeypatch.setattr(cuda_libs.sys, "platform", "linux")
    monkeypatch.setattr(cuda_libs, "_load", lambda p, rep: loaded.append(p.name) or rep["loaded"].append(p.name) or True)
    rep = cuda_libs.prepare()
    assert loaded == ["libcublasLt.so.12", "libcublas.so.12"]  # Lt first: libcublas depends on it
    assert str(lib) in rep["dirs"]
    cuda_libs._reset_for_tests()


def test_prepare_loads_onnxruntime_before_cublas(monkeypatch, tmp_path):
    cuda_libs._reset_for_tests()
    order = []
    fake_ort = types.SimpleNamespace(preload_dlls=lambda: order.append("ort"), __file__=str(tmp_path / "onnxruntime" / "__init__.py"))
    monkeypatch.setitem(__import__("sys").modules, "onnxruntime", fake_ort)
    monkeypatch.setattr(cuda_libs, "_ort_is_gpu_build", lambda: True)
    monkeypatch.setattr(cuda_libs, "nvidia_lib_dirs", lambda *a, **k: [])
    monkeypatch.setattr(cuda_libs, "_preload_cublas12", lambda dirs, rep: order.append("cublas"))
    monkeypatch.setattr(cuda_libs.sys, "platform", "linux")
    rep = cuda_libs.prepare()
    assert order == ["ort", "cublas"] and rep["onnxruntimePreload"] is True
    cuda_libs._reset_for_tests()
