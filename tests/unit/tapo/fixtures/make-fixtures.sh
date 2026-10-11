#!/usr/bin/env bash
# Regenerate the small video fixtures of tests/unit/tapo (needs ffmpeg with libx264; the outputs
# are committed, so the tests themselves never need ffmpeg).
#   clip-160x90.h264   3 s, 15 fps, 1-second GOPs, one slice per frame, AUD + SPS/PPS before
#                      every keyframe: what the in-test RTSP server streams (Tapo-like layout)
#   bframes.mp4        2 s with B-frames, fragmented (one moof per frame): parser edge cases
#   go2rtc-sample.mp4  is captured from go2rtc 1.9.14 fed by that RTSP server:
#                      node tests/unit/tapo/fixtures/capture-go2rtc-sample.mjs
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
x264=(-c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p -r 15 -g 15 -keyint_min 15 -sc_threshold 0)

ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=160x90:rate=15:duration=3" \
  "${x264[@]}" -bf 0 -x264-params sliced-threads=0:slices=1:repeat-headers=1 \
  -bsf:v h264_metadata=aud=insert -f h264 "$here/clip-160x90.h264"

ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=160x90:rate=15:duration=2" \
  "${x264[@]}" -bf 2 -movflags frag_every_frame+empty_moov+default_base_moof -f mp4 "$here/bframes.mp4"

ls -l "$here"
