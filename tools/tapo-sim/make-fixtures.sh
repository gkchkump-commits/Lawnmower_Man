#!/usr/bin/env bash
# Regenerate the camera simulator's video fixtures (tests/fixtures/tapo/). Needs Node 22 and
# ffmpeg with libx264 (Ubuntu: apt install ffmpeg). The outputs are committed: the simulator,
# the tests and CI never run ffmpeg. Details: tools/tapo-sim/README.md.
#
#   tools/tapo-sim/make-fixtures.sh
#   node tools/tapo-sim/capture-go2rtc-sample.mjs     # tests/fixtures/tapo/go2rtc-sample.mp4 (needs go2rtc)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed" >&2; exit 1; }
encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"   # not piped into grep -q: SIGPIPE + pipefail
[[ "$encoders" == *libx264* ]] || { echo "this ffmpeg has no libx264" >&2; exit 1; }
exec node "$here/make-fixtures.mjs" "$@"
