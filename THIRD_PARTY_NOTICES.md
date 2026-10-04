# Third-party notices

Lawnmower Man bundles or downloads the following third-party works. Each is used under its own license.

## Bundled in this repository

| Work | Where | License |
|---|---|---|
| **Lee Perry-Smith head scan**, Infinite-Realities, as distributed with the three.js examples (`LeePerrySmith.glb`) | `tools/procedural/source/LeePerrySmith.glb`; the derived model is `public/assets/models/head.{json,bin}`, which is cropped, smoothed, warped and re-rigged (details in `public/assets/models/README.md`) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| **three.js** | npm dependency, bundled into the renderer build | MIT |
| **Electron** | npm dev dependency; the runtime in packaged builds | MIT (Chromium components: see `LICENSES.chromium.html` in the Electron distribution) |
| Facial landmark coordinates produced with **MediaPipe Face Landmarker** | `tools/procedural/data/landmarks.json` and the mesh in `public/assets/avatars/reference/mesh.json` (coordinates only; the model itself is not bundled) | Model and runtime: Apache-2.0 |

The avatar pack in `public/assets/avatars/reference/` is derived from the project owner's own reference video. The frames in `docs/reference/` come from that video too.

## Downloaded at setup or build time (not committed)

| Work | Used by | License |
|---|---|---|
| **MediaPipe Face Landmarker** model (`face_landmarker.task`) | `tools/bake`, `tools/procedural` (offline asset build only) | Apache-2.0 |
| **Whisper** models (OpenAI), in CTranslate2 format | `voice/` speech to text | MIT |
| **faster-whisper**, **CTranslate2** | `voice/` speech to text | MIT |
| **Kokoro-82M** (hexgrad) model and voices | `voice/` text to speech | Apache-2.0 |
| **kokoro-onnx** | `voice/` text to speech | MIT |
| **ONNX Runtime** (`onnxruntime-gpu`) | `voice/` text to speech | MIT |
| **espeak-ng** (via `espeakng-loader` / phonemizer) | `voice/` grapheme-to-phoneme fallback | GPL-3.0 (a separate program; it is loaded dynamically and not modified) |
| **NVIDIA CUDA runtime, cuBLAS, cuDNN, cuFFT** (pip wheels) | `voice/` GPU inference | NVIDIA Software License Agreement / CUDA EULA |
| **FastAPI**, **Starlette**, **Uvicorn**, **NumPy**, **SciPy** | `voice/` server | MIT / BSD-3-Clause |
