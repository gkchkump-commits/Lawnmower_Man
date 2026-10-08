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
#
# Installed app (resources/app.asar next to resources/voice, e.g. an AppImage): the install
# folder is read-only or replaced on update, so the venv, the models and a writable copy of the
# package go to ${XDG_DATA_HOME:-~/.local/share}/lawnmower-man/voice instead (the app looks there).
#
# Every run (except --check-only) writes its full output - each command, everything pip printed,
# the step headers and the summary - to <voice folder>/setup.log (setup.prev.log keeps the run
# before). That is the file to send when the setup fails. On a failure the status file's "error"
# is the failed step plus the last lines of its output (pip prints its reason there).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-voice.sh [options]

  --cpu              CPU-only install (no CUDA/cuDNN wheels)
  --no-models        do not download models (they download on first use instead)
  --torch-tts        also install the optional PyTorch Kokoro backend (torch from PyPI, CUDA 13; ~3 GB)
  --misaki           also install misaki (Kokoro's English G2P; pulls spaCy)
  --python PATH      Python interpreter to build the venv with (default: python3.12, then 3.11)
  --recreate         delete and rebuild the venv
  --stt-model NAME   Whisper model to pre-download and smoke-test (default: large-v3-turbo)
  --models-dir DIR   model cache (default: voice/models, or $LAWNMOWER_VOICE_MODELS); recorded in
                     the venv so the app and later runs use it too
  --skip-smoke       skip the final load-and-run smoke test
  --pause-at-end     wait for Enter before exiting (the app opens this script in a terminal)
  --status-file FILE write the result as JSON to FILE when done (the app watches it;
                     {ok, error, errorTail, log, voiceHome, venv, python, ...})
  --check-only       only report where the voice would be installed, then exit (changes nothing)
  -h, --help         show this help
EOF
}

CPU=0; NO_MODELS=0; TORCH_TTS=0; MISAKI=0; RECREATE=0; SKIP_SMOKE=0; PAUSE=0; CHECK_ONLY=0
PYTHON_ARG=""; STT_MODEL="large-v3-turbo"; MODELS_DIR="${LAWNMOWER_VOICE_MODELS:-}"; STATUS_FILE=""
FLAGS="$*"  # for the log
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) CPU=1 ;;
    --no-models) NO_MODELS=1 ;;
    --torch-tts) TORCH_TTS=1 ;;
    --misaki) MISAKI=1 ;;
    --recreate) RECREATE=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --pause-at-end) PAUSE=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --status-file) STATUS_FILE="${2:?--status-file needs a path}"; shift ;;
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
# Must match electron/voice-sidecar.js packagedVoiceHome().
PACKAGED=0; [ -e "$ROOT/app.asar" ] && PACKAGED=1
if [ "$PACKAGED" = 1 ]; then
  VOICE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/lawnmower-man/voice"
  VENV="$VOICE_HOME/.venv"
  PKG_DIR="$VOICE_HOME/src"
else
  VOICE_HOME="$VOICE_DIR"
  VENV="$VOICE_DIR/.venv"
  PKG_DIR="$VOICE_DIR"
fi
VPY="$VENV/bin/python"
# The full output of every run (the app's "Open setup log"; the previous run is kept as
# setup.prev.log). Must match electron/main.js (setup log path).
SETUP_LOG="$VOICE_HOME/setup.log"
SETUP_LOG_PREV="$VOICE_HOME/setup.prev.log"
# The models folder the app should use is recorded here (read by lawnmower_voice.config).
POINTER="$VENV/lawnmower-models-dir.txt"
ORT_GPU_SPEC='onnxruntime-gpu[cuda,cudnn]>=1.27,<2'
# Linux: torch from PyPI is the CUDA 13 build (nvidia-cudnn-cu13, like onnxruntime-gpu). The
# cu128 index would pull nvidia-cudnn-cu12, which overwrites the same nvidia/cudnn files.
TORCH_INDEX_CPU="https://download.pytorch.org/whl/cpu"

# Python children (venv, pip, the doctor): UTF-8 output whatever the locale, and unbuffered, so
# their output shows up line by line while it is also written to the log.
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1
# The NVIDIA wheels are hundreds of MB: let pip ride out a slow or flaky connection (pip's own
# defaults are 5 retries and a 15 s timeout). A user's own values win.
export PIP_RETRIES="${PIP_RETRIES:-10}" PIP_TIMEOUT="${PIP_TIMEOUT:-60}"

# Result for the app (--status-file): written once, when the script ends (success or not).
# RESULT_ERROR: the message (for a failed command: the command, then the last lines of its
# output); RESULT_TAIL: those lines; LOG_FILE: the setup log of this run ("" when there is none).
RESULT_OK=false; RESULT_ERROR=""; RESULT_PYTHON=""; RESULT_TAIL=(); LOG_FILE=""; CMD_OUT=""
json_str() { # JSON string literal of $1 (paths may contain spaces, quotes, non-ASCII)
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\n'/\\n}; s=${s//$'\r'/}
  # other control characters (a bell, colour codes) are not allowed in JSON strings: drop them
  s=${s//[$'\001'-$'\010'$'\013'$'\014'$'\016'-$'\037'$'\177']/}
  printf '"%s"' "$s"
}
write_status() {
  [ -n "$STATUS_FILE" ] || return 0
  mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null || true
  local cpu=false check=false packaged=false
  [ "$CPU" = 1 ] && cpu=true
  [ "$CHECK_ONLY" = 1 ] && check=true
  [ "${PACKAGED:-0}" = 1 ] && packaged=true
  local tail='[' line sep=''
  for line in ${RESULT_TAIL[@]+"${RESULT_TAIL[@]}"}; do tail="$tail$sep$(json_str "$line")"; sep=','; done
  tail="$tail]"
  printf '{"ok":%s,"check":%s,"cpu":%s,"packaged":%s,"voiceHome":%s,"venv":%s,"python":%s,"error":%s,"errorTail":%s,"log":%s,"finishedAt":%s}\n' \
    "$RESULT_OK" "$check" "$cpu" "$packaged" "$(json_str "${VOICE_HOME:-}")" "$(json_str "${VENV:-}")" \
    "$(json_str "$RESULT_PYTHON")" "$(json_str "$RESULT_ERROR")" "$tail" "$(json_str "$LOG_FILE")" \
    "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" \
    > "$STATUS_FILE" 2>/dev/null || printf 'WARNING: could not write %s\n' "$STATUS_FILE" >&2
}
finish() {
  local code=$?
  trap - EXIT
  if [ "$code" = 0 ]; then RESULT_OK=true; elif [ -z "$RESULT_ERROR" ]; then RESULT_ERROR="setup failed (exit $code)"; fi
  write_status
  if [ -n "$LOG_FILE" ]; then
    { echo; echo "Finished: $([ "$code" = 0 ] && echo OK || echo FAILED) (exit $code) at $(date '+%Y-%m-%d %H:%M:%S %z')"
      [ -n "$STATUS_FILE" ] && [ -f "$STATUS_FILE" ] && printf 'Status:   %s\n' "$(cat "$STATUS_FILE" 2>/dev/null)"
    } >> "$LOG_FILE" 2>/dev/null || true
    if [ "$code" != 0 ]; then
      printf '\nThe full output is in %s\n  (Settings > Voice > "Open setup log" in Lawnmower Man). Send that file when you report the problem.\n' "$LOG_FILE" >&2
    fi
  fi
  [ -n "$CMD_OUT" ] && rm -f "$CMD_OUT"
  if [ "$PAUSE" = 1 ] && [ -t 0 ]; then
    echo
    if [ "$code" = 0 ]; then echo "Lawnmower Man starts the local voice by itself now."; fi
    read -r -p "Press Enter to close this window " _ || true
  fi
  exit "$code"
}
trap finish EXIT

# --- setup log ---------------------------------------------------------------------------------
log_line() { [ -z "$LOG_FILE" ] || printf '%s\n' "$*" >> "$LOG_FILE" 2>/dev/null || true; }
# copy stdin to the console and the log
log_tee() { if [ -n "$LOG_FILE" ]; then tee -a "$LOG_FILE"; else cat; fi; }

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; log_line ""; log_line "==> $*"; }
info() { printf '%s\n' "$*"; log_line "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*" >&2; log_line "WARNING: $*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; log_line ""; log_line "ERROR: $*"; [ -n "$RESULT_ERROR" ] || RESULT_ERROR="$*"; exit 1; }

# Start the log of this run: keep the previous one as setup.prev.log, write a header with what is
# needed to make sense of it (when, which script, which shell and Python, which switches).
start_log() {
  mkdir -p "$VOICE_HOME" 2>/dev/null || true
  if [ -f "$SETUP_LOG" ]; then mv -f "$SETUP_LOG" "$SETUP_LOG_PREV" 2>/dev/null || true; fi
  if ! : >> "$SETUP_LOG" 2>/dev/null; then warn "Could not write the setup log $SETUP_LOG"; return 0; fi
  LOG_FILE="$SETUP_LOG"
  # each command's output, for the error tail (no tail without mktemp; the log has everything)
  if command -v mktemp >/dev/null 2>&1; then CMD_OUT="$(mktemp "${TMPDIR:-/tmp}/lawnmower-setup.XXXXXX" 2>/dev/null || true)"; fi
  local version="" hash="" where="repository" line
  while IFS= read -r line; do
    case "$line" in version*=*) version="${line#*\"}"; version="${version%%\"*}"; break ;; esac
  done < "$VOICE_DIR/pyproject.toml"
  if command -v sha256sum >/dev/null 2>&1; then hash="$(sha256sum "${BASH_SOURCE[0]}" 2>/dev/null || true)"; hash="${hash:0:12}"; fi
  [ "$PACKAGED" = 1 ] && where="installed app"
  {
    echo "=== Lawnmower Man - local voice setup ==="
    echo "Started:  $(date '+%Y-%m-%d %H:%M:%S %z') (UTC $(date -u +%Y-%m-%dT%H:%M:%SZ))"
    echo "Script:   $SCRIPT_DIR/${BASH_SOURCE[0]##*/} (lawnmower-voice ${version:-?}${hash:+, sha256 $hash})"
    echo "Shell:    bash $BASH_VERSION on $(uname -srm 2>/dev/null || echo '?')"
    echo "Flags:    ${FLAGS:-(none)}"
    echo "Python:   ${PY:-not found}${PYV:+ (Python $PYV)}${PYTHON_ARG:+ [--python $PYTHON_ARG]}"
    echo "Voice:    $VOICE_HOME ($where)"
    echo "Venv:     $VENV"
    echo "Models:   ${MODELS_DIR:-default}"
    echo "Log:      $SETUP_LOG (previous run: $SETUP_LOG_PREV)"
  } >> "$LOG_FILE"
}

# How many non-empty output lines of a failed command go into the error (pip prints its reason,
# "ERROR: ...", in the last few).
TAIL_LINES=20

# Run a command with its output shown live AND appended to the setup log; sets RUN_RC (never
# exits: the caller decides). Options before the command:
#   --quiet        log only (nothing on the console)
#   --stdout FILE  stdout (e.g. a JSON report) to FILE; stderr is shown and logged
run_logged() {
  local quiet=0 out_file="" start=$SECONDS
  while [ $# -gt 0 ]; do
    case "$1" in
      --quiet) quiet=1; shift ;;
      --stdout) out_file="$2"; shift 2 ;;
      *) break ;;
    esac
  done
  log_line "> $*"
  local files=()
  [ -n "$CMD_OUT" ] && : > "$CMD_OUT" && files+=("$CMD_OUT")
  [ -n "$LOG_FILE" ] && files+=("$LOG_FILE")
  local st=()
  set +e
  if [ -n "$out_file" ]; then
    if [ "$quiet" = 1 ]; then
      "$@" 2>&1 >"$out_file" | tee -a ${files[@]+"${files[@]}"} >/dev/null; st=("${PIPESTATUS[@]}")
    else
      "$@" 2>&1 >"$out_file" | tee -a ${files[@]+"${files[@]}"}; st=("${PIPESTATUS[@]}")
    fi
  elif [ "$quiet" = 1 ]; then
    "$@" 2>&1 | tee -a ${files[@]+"${files[@]}"} >/dev/null; st=("${PIPESTATUS[@]}")
  else
    "$@" 2>&1 | tee -a ${files[@]+"${files[@]}"}; st=("${PIPESTATUS[@]}")
  fi
  set -e
  RUN_RC=${st[0]}
  log_line "(exit $RUN_RC, $((SECONDS - start)) s)"
  return 0
}

# The last non-empty lines of the last run_logged command (progress bars split at carriage
# returns, colour codes removed, very long lines cut).
cmd_tail() {
  [ -n "$CMD_OUT" ] && [ -s "$CMD_OUT" ] || return 0
  local esc
  esc="$(printf '\033')"
  # CSI sequences (colours, erase line, cursor moves): ESC [ params intermediates final. "|" as
  # the delimiter: "\/" inside a bracket is a backslash range in sed, which ate "ERROR: " after ESC[K.
  tr '\r' '\n' < "$CMD_OUT" | sed "s|${esc}\[[0-9;?]*[ -/]*[@-~]||g" | grep -v '^[[:space:]]*$' | tail -n "$TAIL_LINES" | cut -c1-400 || true
}

# Fail the setup for the last run_logged command: the summary, then the last lines of its output.
die_cmd() {
  local tail line
  tail="$(cmd_tail)"
  RESULT_TAIL=()
  if [ -n "$tail" ]; then
    while IFS= read -r line; do RESULT_TAIL+=("$line"); done <<< "$tail"
    RESULT_ERROR="$1"$'\n'"$tail"
  else
    RESULT_ERROR="$1"
  fi
  die "$RESULT_ERROR"
}

# Run a command (logged, see run_logged); fail the setup with its output's tail if it fails.
run_checked() {
  run_logged "$@"
  [ "$RUN_RC" = 0 ] || die_cmd "Command failed (exit $RUN_RC): $*"
}

[ -f "$VOICE_DIR/pyproject.toml" ] || die "voice/pyproject.toml not found next to this script ($VOICE_DIR)."
[ "$(uname -s)" = "Linux" ] || warn "This script targets Linux; on Windows use scripts\\setup-voice.ps1."
[ "$PACKAGED" = 1 ] && echo "Installed app detected: voice files go to $VOICE_HOME"

# Models folder: --models-dir > $LAWNMOWER_VOICE_MODELS > recorded by an earlier run > the
# per-user folder of an installed app > (empty) voice/models. Trailing slashes are dropped.
if [ -z "$MODELS_DIR" ] && [ -s "$POINTER" ]; then MODELS_DIR="$(head -n 1 "$POINTER")"; fi
if [ -z "$MODELS_DIR" ] && [ "$PACKAGED" = 1 ]; then MODELS_DIR="$VOICE_HOME/models"; fi
if [ -n "$MODELS_DIR" ]; then
  MODELS_DIR="${MODELS_DIR%\"}"; MODELS_DIR="${MODELS_DIR#\"}"
  while [ "${#MODELS_DIR}" -gt 1 ] && [ "${MODELS_DIR%/}" != "$MODELS_DIR" ]; do MODELS_DIR="${MODELS_DIR%/}"; done
  case "$MODELS_DIR" in /*) ;; ~*) MODELS_DIR="${HOME}${MODELS_DIR#\~}" ;; *) MODELS_DIR="$PWD/$MODELS_DIR" ;; esac
fi

# ---------------------------------------------------------------------------------------------
# Find Python (quietly: --check-only reports it; a real run logs it in the header).
py_version() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true; }
PY=""; PYV=""; PY_BAD=""
if [ -n "$PYTHON_ARG" ]; then
  # a bad --python fails a real run only once its log has started (the log is what gets sent)
  PYV="$(py_version "$PYTHON_ARG")"
  if [ -n "$PYV" ]; then PY="$PYTHON_ARG"; else PY_BAD="'$PYTHON_ARG' is not a working Python interpreter."; fi
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
if [ "$CHECK_ONLY" = 1 ]; then
  # changes nothing (no log either)
  [ -z "$PY_BAD" ] || die "$PY_BAD"
  RESULT_PYTHON="$PY"
  echo "Voice folder: $VOICE_HOME"
  echo "Venv:         $VENV"
  echo "Python:       ${PY:-not found}${PYV:+ (Python $PYV)}"
  exit 0
fi
start_log
if [ "$PACKAGED" = 1 ]; then log_line "Installed app detected: voice files go to $VOICE_HOME"; fi
if [ -n "$LOG_FILE" ]; then info "Setup log: $LOG_FILE"; fi
say "Looking for Python 3.12"
[ -z "$PY_BAD" ] || die "$PY_BAD"
if [ -z "$PY" ]; then
  RESULT_ERROR="python-missing"
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
info "Using $PY (Python $PYV)"
RESULT_PYTHON="$PY"

# ---------------------------------------------------------------------------------------------
say "Preparing the virtual environment ($VENV)"
if [ -d "$VENV" ]; then
  have="$(py_version "$VPY")"
  if [ "$RECREATE" = 1 ] || [ -z "$have" ] || [ "$have" != "$PYV" ]; then
    info "Removing the existing venv (Python ${have:-broken}; want $PYV)"
    rm -rf "$VENV"
  else
    info "Reusing the existing venv (Python $have)"
  fi
fi
if [ ! -x "$VPY" ]; then
  mkdir -p "$(dirname "$VENV")"
  run_logged "$PY" -m venv "$VENV"
  if [ "$RUN_RC" != 0 ]; then
    rm -rf "$VENV"
    die_cmd "Could not create the venv (exit $RUN_RC). On Debian/Ubuntu install the venv module: sudo apt install python${PYV}-venv"
  fi
fi
if [ -n "$MODELS_DIR" ]; then
  printf '%s\n' "$MODELS_DIR" > "$POINTER"
  info "Models folder: $MODELS_DIR"
fi
run_checked "$VPY" -m pip install --upgrade --disable-pip-version-check pip setuptools wheel

if [ "$PACKAGED" = 1 ]; then
  # pip writes build metadata next to the package: install from a writable copy
  rm -rf "$PKG_DIR"
  mkdir -p "$PKG_DIR"
  cp -R "$VOICE_DIR"/. "$PKG_DIR"/
  log_line "Copied the voice package to $PKG_DIR"
fi

free_kb="$(df -Pk "$(dirname "$VENV")" 2>/dev/null | awk 'NR==2 {print $4}')"
[ -z "${free_kb:-}" ] || log_line "Free space for $VENV: $((free_kb / 1024)) MB"
# Refuse to start when the packages cannot fit (pip running out of space half-way leaves a
# half-installed venv): ~5.5 GB for the GPU stack, ~1.5 GB for the CPU one. Models only warn.
need_mb=1536
[ "$CPU" = 1 ] || need_mb=5632
if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt $((need_mb * 1024)) ]; then
  die "Not enough free disk space: $((free_kb / 1024)) MB free on the drive holding $VENV, about $need_mb MB needed for the voice packages. Free up some space, then run the setup again."
fi
if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt $(((need_mb + 2560) * 1024)) ]; then
  warn "Only $((free_kb / 1024)) MB free on the drive holding $VENV; the voice packages need ~$need_mb MB plus ~2.5 GB of models."
fi

# ---------------------------------------------------------------------------------------------
if [ "$CPU" = 1 ]; then
  say "Installing the CPU voice stack"
  run_checked "$VPY" -m pip install --disable-pip-version-check -e "${PKG_DIR}[cpu]"
  # A previous GPU install leaves onnxruntime-gpu behind; make the CPU wheel the only one.
  run_logged --quiet "$VPY" -m pip show onnxruntime-gpu
  if [ "$RUN_RC" = 0 ]; then
    run_checked "$VPY" -m pip uninstall -y onnxruntime-gpu onnxruntime
    run_checked "$VPY" -m pip install --disable-pip-version-check --force-reinstall --no-deps "onnxruntime>=1.20"
  fi
else
  say "Installing the NVIDIA GPU voice stack (CUDA 12.8+/13 wheels for RTX 50-series; several GB)"
  if command -v nvidia-smi >/dev/null 2>&1; then
    run_logged nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
  else
    warn "nvidia-smi not found: is the NVIDIA driver installed? (R570+ for RTX 50-series, R580+ for GPU text-to-speech)"
  fi
  run_logged "$VPY" -m pip install --disable-pip-version-check -e "${PKG_DIR}[gpu]"
  if [ "$RUN_RC" != 0 ]; then
    # A dropped download of one of the big wheels is the usual one-off failure; pip keeps what it
    # already fetched in its cache, so a second attempt is quick. A real error fails again.
    warn "The GPU install failed (exit $RUN_RC); trying once more (already downloaded files are reused)."
    run_checked "$VPY" -m pip install --disable-pip-version-check -e "${PKG_DIR}[gpu]"
  fi
  if [ "$PYV" != "3.10" ]; then
    # kokoro-onnx and faster-whisper depend on the CPU 'onnxruntime' wheel, which shares the
    # 'onnxruntime' folder with onnxruntime-gpu. Remove both, then reinstall the GPU wheel.
    say "Making onnxruntime-gpu the only onnxruntime"
    run_logged --quiet "$VPY" -m pip uninstall -y onnxruntime onnxruntime-gpu
    run_checked "$VPY" -m pip install --disable-pip-version-check --force-reinstall --no-deps "onnxruntime-gpu>=1.27,<2"
    run_checked "$VPY" -m pip install --disable-pip-version-check "$ORT_GPU_SPEC"
  fi
fi

if [ "$MISAKI" = 1 ]; then
  say "Installing misaki (English G2P)"
  run_checked "$VPY" -m pip install --disable-pip-version-check -e "${PKG_DIR}[misaki]"
fi

if [ "$TORCH_TTS" = 1 ]; then
  if [ "$CPU" = 1 ]; then
    say "Installing PyTorch (CPU build) and the 'kokoro' package (optional backend)"
    run_checked "$VPY" -m pip install --disable-pip-version-check torch --index-url "$TORCH_INDEX_CPU"
  else
    say "Installing PyTorch (PyPI CUDA 13 build) and the 'kokoro' package (optional backend)"
    run_checked "$VPY" -m pip install --disable-pip-version-check torch
  fi
  run_checked "$VPY" -m pip install --disable-pip-version-check -e "${PKG_DIR}[torch]"
  if "$VPY" -m pip show nvidia-cudnn-cu12 >/dev/null 2>&1 && "$VPY" -m pip show nvidia-cudnn-cu13 >/dev/null 2>&1; then
    warn "nvidia-cudnn-cu12 and nvidia-cudnn-cu13 are both installed and share the nvidia/cudnn folder; GPU text-to-speech may fall back to the CPU. Re-run with --recreate."
  fi
fi

# ---------------------------------------------------------------------------------------------
say "Checking the installation"
DEVICE_ARG="auto"; [ "$CPU" = 1 ] && DEVICE_ARG="cpu"
REPORT="$VENV/doctor.json"
# stdout is the JSON report (logged, not shown); the human-readable report goes to stderr
run_logged --stdout "$REPORT" "$VPY" -m lawnmower_voice.doctor --device "$DEVICE_ARG" --human
[ "$RUN_RC" = 0 ] || die_cmd "The voice package does not import (lawnmower_voice.doctor: exit $RUN_RC)."
log_line "doctor report: $(cat "$REPORT" 2>/dev/null || true)"

MODELS_ARGS=()
[ -n "$MODELS_DIR" ] && MODELS_ARGS=(--models-dir "$MODELS_DIR")
MODELS_OK=1
if [ "$NO_MODELS" = 0 ]; then
  say "Downloading models (Whisper $STT_MODEL + base.en fallback, Kokoro-82M); first time only"
  # stderr (the download progress bars) goes straight to the terminal; the JSON result to the log
  log_line "> $VPY -m lawnmower_voice.download --stt-model $STT_MODEL ${MODELS_ARGS[*]-}"
  dl_rc=0
  "$VPY" -m lawnmower_voice.download --stt-model "$STT_MODEL" ${MODELS_ARGS[@]+"${MODELS_ARGS[@]}"} > "$VENV/download.json" || dl_rc=$?
  log_line "$(cat "$VENV/download.json" 2>/dev/null || true)"
  log_line "(exit $dl_rc)"
  if [ "$dl_rc" != 0 ]; then
    MODELS_OK=0
    warn "Some models could not be downloaded (see above). They will be fetched on first use; re-run this script to retry."
  fi
fi

SMOKE=""
if [ "$NO_MODELS" = 0 ] && [ "$SKIP_SMOKE" = 0 ] && [ "$MODELS_OK" = 1 ]; then
  say "Smoke test: loading both engines and running one request each (first GPU run compiles kernels; can take a minute)"
  SMOKE="$VENV/smoke.json"
  # A crash inside a native library leaves no (or partial) JSON: the summary must not die on it.
  run_logged --stdout "$SMOKE" "$VPY" -m lawnmower_voice.doctor --smoke --device "$DEVICE_ARG" --human --stt-model "$STT_MODEL" ${MODELS_ARGS[@]+"${MODELS_ARGS[@]}"}
  if [ "$RUN_RC" != 0 ]; then
    warn "Smoke test failed to run (see the messages above)."
    SMOKE=""
  else
    log_line "smoke report: $(cat "$SMOKE" 2>/dev/null || true)"
  fi
fi

# ---------------------------------------------------------------------------------------------
say "Summary"
"$VPY" - "$REPORT" "$SMOKE" "$CPU" <<'PYEOF' | log_tee
import json, sys

def load(path):
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as exc:
        print(f"  (could not read {path}: {exc})")
        return None

rep = load(sys.argv[1]) or {}
smoke = load(sys.argv[2])
cpu = sys.argv[3] == "1"
s = rep.get("summary") or {}
print(f"  Python:         {rep.get('python', '?')} ({rep.get('executable', '?')})")
print(f"  GPU:            {s.get('gpu') or 'none detected'}")
if not cpu:
    print(f"  STT on GPU:     {'ready' if s.get('sttGpuReady') else 'NOT available (CPU fallback)'}  [CTranslate2]")
    print(f"  TTS on GPU:     {'ready' if s.get('ttsGpuReady') else 'NOT available (CPU fallback)'}  [onnxruntime CUDA]")
if smoke:
    for k in ("stt", "tts"):
        r = (smoke.get("smoke") or {}).get(k) or {}
        st = r.get("status") or {}
        if r.get("ok"):
            print(f"  {k.upper()} smoke test: OK on {st.get('device')} {st.get('computeType', '')}  (load {r.get('loadMs')} ms, run {r.get('runMs')} ms)")
        else:
            print(f"  {k.upper()} smoke test: FAILED - {r.get('error', 'no result')}")
for w in s.get("warnings") or []:
    print(f"  WARNING: {w}")
PYEOF
cat <<EOF | log_tee

Done. The app starts the voice server automatically (or use tray > Restart voice).
Manual run:   $VPY -m lawnmower_voice --port 8765 --token test --preload
Fake engines: $VPY -m lawnmower_voice --fake
Diagnostics:  $VPY -m lawnmower_voice.doctor --smoke --human
EOF
if [ -n "$LOG_FILE" ]; then info "Setup log:    $LOG_FILE"; fi
