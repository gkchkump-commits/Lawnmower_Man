#!/usr/bin/env bash
# Lawnmower Man - set up the local GPU voice server on Linux.
#
#   scripts/setup-voice.sh            # NVIDIA GPU install (RTX 50-series ready) + models
#   scripts/setup-voice.sh --cpu      # CPU-only install (no NVIDIA downloads)
#
# Creates voice/.venv with Python 3.12 (3.11 works), installs faster-whisper + Kokoro with the
# CUDA wheels that support Blackwell (CTranslate2 >= 4.7 + cuBLAS 12.9 wheels, onnxruntime-gpu
# >= 1.27 built for CUDA 13), verifies CUDA, downloads the models and runs a smoke test.
# Safe to re-run; needs no root. See docs/VOICE.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-voice.sh [options]

  --cpu              CPU-only install (no CUDA/cuDNN wheels)
  --no-models        do not download models (they download on first use instead)
  --torch-tts        also install the optional PyTorch Kokoro backend (torch cu128, ~3 GB)
  --misaki           also install misaki (Kokoro's English G2P; pulls spaCy)
  --python PATH      Python interpreter to build the venv with (default: python3.12, then 3.11)
  --recreate         delete and rebuild voice/.venv
  --stt-model NAME   Whisper model to pre-download (default: large-v3-turbo)
  --models-dir DIR   model cache (default: voice/models, or $LAWNMOWER_VOICE_MODELS)
  --skip-smoke       skip the final load-and-run smoke test
  -h, --help         show this help
EOF
}

CPU=0; NO_MODELS=0; TORCH_TTS=0; MISAKI=0; RECREATE=0; SKIP_SMOKE=0
PYTHON_ARG=""; STT_MODEL="large-v3-turbo"; MODELS_DIR="${LAWNMOWER_VOICE_MODELS:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) CPU=1 ;;
    --no-models) NO_MODELS=1 ;;
    --torch-tts) TORCH_TTS=1 ;;
    --misaki) MISAKI=1 ;;
    --recreate) RECREATE=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --python) PYTHON_ARG="${2:?--python needs a path}"; shift ;;
    --stt-model) STT_MODEL="${2:?--stt-model needs a name}"; shift ;;
    --models-dir) MODELS_DIR="${2:?--models-dir needs a directory}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
VOICE_DIR="$ROOT/voice"
VENV="$VOICE_DIR/.venv"
VPY="$VENV/bin/python"
ORT_GPU_SPEC='onnxruntime-gpu[cuda,cudnn]>=1.27,<2'
TORCH_INDEX_GPU="https://download.pytorch.org/whl/cu128"
TORCH_INDEX_CPU="https://download.pytorch.org/whl/cpu"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$VOICE_DIR/pyproject.toml" ] || die "voice/pyproject.toml not found next to this script ($VOICE_DIR)."
[ "$(uname -s)" = "Linux" ] || warn "This script targets Linux; on Windows use scripts\\setup-voice.ps1."

# ---------------------------------------------------------------------------------------------
say "Looking for Python 3.12"
py_version() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true; }
PY=""; PYV=""
if [ -n "$PYTHON_ARG" ]; then
  PYV="$(py_version "$PYTHON_ARG")"
  [ -n "$PYV" ] || die "'$PYTHON_ARG' is not a working Python interpreter."
  PY="$PYTHON_ARG"
else
  # Prefer 3.12; otherwise the first 3.11, then the first 3.10 found.
  PY311=""; PY310=""
  for cand in python3.12 python3 python python3.11 python3.10; do
    command -v "$cand" >/dev/null 2>&1 || continue
    v="$(py_version "$cand")"
    case "$v" in
      3.12) PY="$(command -v "$cand")"; PYV="3.12"; break ;;
      3.11) [ -n "$PY311" ] || PY311="$(command -v "$cand")" ;;
      3.10) [ -n "$PY310" ] || PY310="$(command -v "$cand")" ;;
    esac
  done
  if [ -z "$PY" ] && [ -n "$PY311" ]; then PY="$PY311"; PYV="3.11"; fi
  if [ -z "$PY" ] && [ -n "$PY310" ]; then PY="$PY310"; PYV="3.10"; fi
fi
if [ -z "$PY" ]; then
  die "Python 3.12 was not found. Install it, then re-run this script:
    Ubuntu/Debian:  sudo apt install python3.12 python3.12-venv
    Fedora:         sudo dnf install python3.12
    Any distro:     curl -LsSf https://astral.sh/uv/install.sh | sh && uv python install 3.12
                    then: scripts/setup-voice.sh --python \"\$(uv python find 3.12)\""
fi
case "$PYV" in
  3.12) ;;
  3.11) warn "Using Python 3.11 ($PY). It works; 3.12 is recommended." ;;
  3.10) warn "Using Python 3.10 ($PY): the GPU build of onnxruntime needs >= 3.11, so the voice (TTS) will run on the CPU. Install Python 3.12 for full GPU support." ;;
  *) die "Python $PYV at $PY is not supported (need 3.10-3.12; 3.12 recommended)." ;;
esac
echo "Using $PY (Python $PYV)"

# ---------------------------------------------------------------------------------------------
say "Preparing the virtual environment ($VENV)"
if [ -d "$VENV" ]; then
  have="$(py_version "$VPY")"
  if [ "$RECREATE" = 1 ] || [ -z "$have" ] || [ "$have" != "$PYV" ]; then
    echo "Removing the existing venv (Python ${have:-broken}; want $PYV)"
    rm -rf "$VENV"
  else
    echo "Reusing the existing venv (Python $have)"
  fi
fi
if [ ! -x "$VPY" ]; then
  if ! "$PY" -m venv "$VENV"; then
    rm -rf "$VENV"
    die "Could not create the venv. On Debian/Ubuntu install the venv module: sudo apt install python${PYV}-venv"
  fi
fi
"$VPY" -m pip install --upgrade --disable-pip-version-check pip setuptools wheel

free_kb="$(df -Pk "$VOICE_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt $((8 * 1024 * 1024)) ]; then
  warn "Only $((free_kb / 1024 / 1024)) GB free on the drive holding $VOICE_DIR; the GPU install needs ~5 GB plus ~2.5 GB of models."
fi

# ---------------------------------------------------------------------------------------------
if [ "$CPU" = 1 ]; then
  say "Installing the CPU voice stack"
  "$VPY" -m pip install --disable-pip-version-check -e "${VOICE_DIR}[cpu]"
  # A previous GPU install leaves onnxruntime-gpu behind; make the CPU wheel the only one.
  if "$VPY" -m pip show onnxruntime-gpu >/dev/null 2>&1; then
    "$VPY" -m pip uninstall -y onnxruntime-gpu onnxruntime
    "$VPY" -m pip install --disable-pip-version-check --force-reinstall --no-deps "onnxruntime>=1.20"
  fi
else
  say "Installing the NVIDIA GPU voice stack (CUDA 12.8+/13 wheels for RTX 50-series; several GB)"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null || true
  else
    warn "nvidia-smi not found: is the NVIDIA driver installed? (R570+ for RTX 50-series, R580+ for GPU text-to-speech)"
  fi
  "$VPY" -m pip install --disable-pip-version-check -e "${VOICE_DIR}[gpu]"
  if [ "$PYV" != "3.10" ]; then
    # kokoro-onnx and faster-whisper depend on the CPU 'onnxruntime' wheel, which shares the
    # 'onnxruntime' folder with onnxruntime-gpu. Remove both, then reinstall the GPU wheel.
    say "Making onnxruntime-gpu the only onnxruntime"
    "$VPY" -m pip uninstall -y onnxruntime onnxruntime-gpu >/dev/null 2>&1 || true
    "$VPY" -m pip install --disable-pip-version-check --force-reinstall --no-deps "onnxruntime-gpu>=1.27,<2"
    "$VPY" -m pip install --disable-pip-version-check "$ORT_GPU_SPEC"
  fi
fi

if [ "$MISAKI" = 1 ]; then
  say "Installing misaki (English G2P)"
  "$VPY" -m pip install --disable-pip-version-check -e "${VOICE_DIR}[misaki]"
fi

if [ "$TORCH_TTS" = 1 ]; then
  if [ "$CPU" = 1 ]; then idx="$TORCH_INDEX_CPU"; else idx="$TORCH_INDEX_GPU"; fi
  say "Installing PyTorch from $idx and the 'kokoro' package (optional backend)"
  "$VPY" -m pip install --disable-pip-version-check torch --index-url "$idx"
  "$VPY" -m pip install --disable-pip-version-check -e "${VOICE_DIR}[torch]"
fi

# ---------------------------------------------------------------------------------------------
say "Checking the installation"
DEVICE_ARG="auto"; [ "$CPU" = 1 ] && DEVICE_ARG="cpu"
REPORT="$VENV/doctor.json"
"$VPY" -m lawnmower_voice.doctor --device "$DEVICE_ARG" --human > "$REPORT" || die "The voice package does not import. See the messages above."

MODELS_ARGS=()
[ -n "$MODELS_DIR" ] && MODELS_ARGS=(--models-dir "$MODELS_DIR")
MODELS_OK=1
if [ "$NO_MODELS" = 0 ]; then
  say "Downloading models (Whisper $STT_MODEL + base.en fallback, Kokoro-82M); first time only"
  if ! "$VPY" -m lawnmower_voice.download --stt-model "$STT_MODEL" ${MODELS_ARGS[@]+"${MODELS_ARGS[@]}"} > "$VENV/download.json"; then
    MODELS_OK=0
    warn "Some models could not be downloaded (see above). They will be fetched on first use; re-run this script to retry."
  fi
fi

SMOKE=""
if [ "$NO_MODELS" = 0 ] && [ "$SKIP_SMOKE" = 0 ] && [ "$MODELS_OK" = 1 ]; then
  say "Smoke test: loading both engines and running one request each (first GPU run compiles kernels; can take a minute)"
  SMOKE="$VENV/smoke.json"
  "$VPY" -m lawnmower_voice.doctor --smoke --device "$DEVICE_ARG" --human ${MODELS_ARGS[@]+"${MODELS_ARGS[@]}"} > "$SMOKE" || warn "Smoke test failed to run."
fi

# ---------------------------------------------------------------------------------------------
say "Summary"
"$VPY" - "$REPORT" "$SMOKE" "$CPU" <<'PYEOF'
import json, sys
rep = json.load(open(sys.argv[1]))
smoke = json.load(open(sys.argv[2])) if sys.argv[2] else None
cpu = sys.argv[3] == "1"
s = rep["summary"]
print(f"  Python:         {rep['python']} ({rep['executable']})")
print(f"  GPU:            {s['gpu'] or 'none detected'}")
if not cpu:
    print(f"  STT on GPU:     {'ready' if s['sttGpuReady'] else 'NOT available (CPU fallback)'}  [CTranslate2]")
    print(f"  TTS on GPU:     {'ready' if s['ttsGpuReady'] else 'NOT available (CPU fallback)'}  [onnxruntime CUDA]")
if smoke:
    for k in ("stt", "tts"):
        r = smoke["smoke"][k]; st = r.get("status", {})
        if r.get("ok"):
            print(f"  {k.upper()} smoke test: OK on {st.get('device')} {st.get('computeType', '')}  (load {r.get('loadMs')} ms, run {r.get('runMs')} ms)")
        else:
            print(f"  {k.upper()} smoke test: FAILED - {r.get('error')}")
for w in s["warnings"]:
    print(f"  WARNING: {w}")
PYEOF
cat <<EOF

Done. The app starts the voice server automatically (Settings > Voice, or tray > Restart voice).
Manual run:   $VPY -m lawnmower_voice --port 8765 --token test --preload
Fake engines: $VPY -m lawnmower_voice --fake
Diagnostics:  $VPY -m lawnmower_voice.doctor --smoke --human
EOF
