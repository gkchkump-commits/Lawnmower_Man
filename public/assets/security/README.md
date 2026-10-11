# Home camera: person detector model

`efficientdet_lite0_int8.tflite` is the MediaPipe Object Detector model **EfficientDet-Lite0
(int8)**, trained on COCO. The Home camera window's security worker (`src/tapo/worker/detector.js`)
runs it locally with the `@mediapipe/tasks-vision` runtime the app already ships
(`assets/vision/wasm/`), restricted to the COCO class `person`. Nothing is downloaded at runtime.

| | |
|---|---|
| Source | `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite` |
| Size | 4,602,795 bytes |
| SHA-256 | `0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb` |
| MD5 | `cebf64af6c35e5abd734494685064842` (matches the bucket's `x-goog-hash: md5=zr9kr2w15avXNElGhQZIQg==` and ETag) |
| Bucket `Last-Modified` | Thu, 27 Apr 2023 22:53:33 GMT |
| Fetched | 2026-10-10 |
| License | Apache-2.0 (MediaPipe model card; listed in THIRD_PARTY_NOTICES.md) |

To check a copy: `sha256sum public/assets/security/efficientdet_lite0_int8.tflite`.
