# Third-party notices

Lawnmower Man bundles or downloads the following third-party works. Each is used under its own license.

## Bundled in this repository

| Work | Where | License |
|---|---|---|
| **Lee Perry-Smith head scan**, Infinite-Realities, as distributed with the three.js examples (`LeePerrySmith.glb`) | `tools/procedural/source/LeePerrySmith.glb`; the derived model is `public/assets/models/head.{json,bin}`, which is cropped, smoothed, warped and re-rigged (details in `public/assets/models/README.md`) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| **three.js** | npm dependency, bundled into the renderer build | MIT |
| **Electron** | npm dev dependency; the runtime in packaged builds | MIT (Chromium components: see `LICENSES.chromium.html` in the Electron distribution) |
| Facial landmark coordinates produced with **MediaPipe Face Landmarker** | `tools/procedural/data/landmarks.json` and the mesh in `public/assets/avatars/reference/mesh.json` (coordinates only) | Model and runtime: Apache-2.0 |
| **MediaPipe Face Landmarker** model (`face_landmarker.task`), Google | `public/assets/vision/face_landmarker.task`: the camera's local face tracking ([docs/CAMERA.md](docs/CAMERA.md)); shipped in the app | [Apache-2.0](#apache-license-20) |
| **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision` 1.1.0), Google | npm dependency: its JavaScript is bundled into the renderer build and its WebAssembly runtime (`vision_wasm_module_internal.{js,wasm}`) is copied into `dist/assets/vision/wasm/` at build time; shipped in the app | [Apache-2.0](#apache-license-20) |
| **EfficientDet-Lite0 (int8)** object detection model of the MediaPipe Object Detector, Google; trained on COCO | `public/assets/security/efficientdet_lite0_int8.tflite`: the home camera's local person detector ([docs/TAPO.md](docs/TAPO.md)); shipped in the app. Unmodified, from `storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/` (SHA-256 in `public/assets/security/README.md`) | [Apache-2.0](#apache-license-20) (see the note below) |

### Statically linked into the MediaPipe WebAssembly runtime (`dist/assets/vision/wasm/`)

The `vision_wasm_module_internal.wasm` that the app ships contains these libraries, unmodified, as built by Google for `@mediapipe/tasks-vision`:

| Work | License |
|---|---|
| **TensorFlow Lite**, **Abseil**, **ruy**, **FlatBuffers**, **OpenCV** 4.x | [Apache-2.0](#apache-license-20) |
| **XNNPACK** — Copyright (c) Facebook, Inc. and its affiliates. All rights reserved. Copyright 2019 Google LLC | [BSD-3-Clause](#bsd-3-clause-license) |
| **Protocol Buffers** — Copyright 2008 Google Inc. All rights reserved. | [BSD-3-Clause](#bsd-3-clause-license) |
| **Eigen** 3.4 | [MPL-2.0](https://mozilla.org/MPL/2.0/); unmodified source: <https://gitlab.com/libeigen/eigen> |

The avatar pack in `public/assets/avatars/reference/` is derived from the project owner's own reference video. The frames in `docs/reference/` come from that video too.

Note on the EfficientDet-Lite0 model: Google distributes it as one of the MediaPipe Object Detector
models under Apache-2.0, like the Face Landmarker model above. The file itself carries MediaPipe
metadata (task "ObjectDetector", labels, metadata version 1.14.0) but no license field, and the
model card page could not be opened from the machine this was written on; check the wording at
<https://ai.google.dev/edge/mediapipe/solutions/vision/object_detector#models> when updating the
model.

## Shipped in the installer, fetched at build time (not committed)

| Work | Where | License |
|---|---|---|
| **go2rtc** 1.9.14 — Copyright (c) 2022 Alexey Khit (<https://github.com/AlexxIT/go2rtc>) | the home camera's video component ([docs/TAPO.md](docs/TAPO.md)): `scripts/fetch-go2rtc.mjs` downloads the official release binaries (`go2rtc_win64.zip`, `go2rtc_linux_amd64`), checks their pinned SHA-256 and puts them in `vendor/go2rtc/`; the installer ships them unmodified as `resources/tapo/go2rtc(.exe)`, with go2rtc's license as `resources/tapo/go2rtc-LICENSE.txt` | [MIT](#mit-license) |

### Statically linked into go2rtc 1.9.14

go2rtc is a Go program: the release binary contains the Go standard library and these Go modules
(the list is the module build information embedded in the official `go2rtc.exe` 1.9.14; each
license was checked in the module's repository at that version):

| Module | Version | License |
|---|---|---|
| Go standard library — Copyright 2009 The Go Authors | go 1.24 | [BSD-3-Clause](#bsd-3-clause-license) |
| `golang.org/x/crypto`, `golang.org/x/net`, `golang.org/x/sync`, `golang.org/x/sys`, `golang.org/x/time` — Copyright 2009 The Go Authors | v0.47.0, v0.49.0, v0.19.0, v0.40.0, v0.14.0 | [BSD-3-Clause](#bsd-3-clause-license) |
| `github.com/google/uuid` — Copyright (c) 2009,2014 Google Inc. All rights reserved. | v1.6.0 | [BSD-3-Clause](#bsd-3-clause-license) |
| `github.com/miekg/dns` — Copyright (c) 2009, The Go Authors. Extensions copyright (c) 2011, Miek Gieben. All rights reserved. | v1.1.70 | [BSD-3-Clause](#bsd-3-clause-license) |
| `github.com/wlynxg/anet` — Copyright (c) 2023, wlynxg | v0.0.5 | [BSD-3-Clause](#bsd-3-clause-license) |
| `github.com/gorilla/websocket` — Copyright (c) 2013 The Gorilla WebSocket Authors. All rights reserved. | v1.5.3 | [BSD-2-Clause](#bsd-2-clause-license) |
| `github.com/eclipse/paho.mqtt.golang` — Copyright (c) 2007, Eclipse Foundation, Inc. and its licensors. All rights reserved. | v1.5.1 | dual-licensed EPL-2.0 / [EDL-1.0](#bsd-3-clause-license) (the Eclipse Distribution License is the BSD-3-Clause license); used under EDL-1.0 |
| `github.com/pion/webrtc/v4`, `datachannel`, `dtls/v3`, `ice/v4`, `interceptor`, `logging`, `mdns/v2`, `randutil`, `rtcp`, `rtp`, `sctp`, `sdp/v3`, `srtp/v3`, `stun/v3`, `transport/v4`, `turn/v4` — Copyright (c) The Pion community <https://pion.ly> | v4.2.3, v1.6.0, v3.0.10, v4.2.0, v0.1.43, v0.2.4, v2.1.0, v0.1.0, v1.2.16, v1.10.0, v1.9.2, v3.0.17, v3.0.10, v3.1.1, v4.0.1, v4.1.4 | [MIT](#mit-license) |
| `github.com/expr-lang/expr` — Copyright (c) 2018 Anton Medvedev | v1.17.7 | [MIT](#mit-license) |
| `github.com/rs/zerolog` — Copyright (c) 2017 Olivier Poitrey | v1.34.0 | [MIT](#mit-license) |
| `github.com/mattn/go-colorable` — Copyright (c) 2016 Yasuhiro Matsumoto; `github.com/mattn/go-isatty` — Copyright (c) Yasuhiro MATSUMOTO | v0.1.14, v0.0.20 | [MIT](#mit-license) |
| `github.com/sigurn/crc16` — Copyright (c) 2015 sigurn, Copyright (c) 2021 r10r; `github.com/sigurn/crc8` — Copyright (c) 2015 sigurn | 2024-01-31 (83fcde1e29d1), 2022-01-07 (2243fe600f9f) | [MIT](#mit-license) |
| `gopkg.in/yaml.v3` — Copyright (c) 2006-2011 Kirill Simonov (the files ported from libyaml: MIT); Copyright (c) 2011-2019 Canonical Ltd (the rest: Apache-2.0) | v3.0.1 | [MIT](#mit-license) and [Apache-2.0](#apache-license-20) |
| `github.com/tadglines/go-pkgs` — Copyright 2013 Tad Glines | 2021-06-23 (b983b20f54f9) | [Apache-2.0](#apache-license-20) |

## Downloaded at setup or build time (not committed)

| Work | Used by | License |
|---|---|---|
| **MediaPipe Face Landmarker** model (`face_landmarker.task`) | `tools/bake`, `tools/procedural` (offline asset build; the app ships its own copy, see above) | Apache-2.0 |
| **Whisper** models (OpenAI), in CTranslate2 format | `voice/` speech to text | MIT |
| **faster-whisper**, **CTranslate2** | `voice/` speech to text | MIT |
| **Kokoro-82M** (hexgrad) model and voices | `voice/` text to speech | Apache-2.0 |
| **kokoro-onnx** | `voice/` text to speech | MIT |
| **ONNX Runtime** (`onnxruntime-gpu`) | `voice/` text to speech | MIT |
| **espeak-ng** (via `espeakng-loader` / phonemizer) | `voice/` grapheme-to-phoneme fallback | GPL-3.0 (a separate program; it is loaded dynamically and not modified) |
| **NVIDIA CUDA runtime, cuBLAS, cuDNN, cuFFT** (pip wheels) | `voice/` GPU inference | NVIDIA Software License Agreement / CUDA EULA |
| **FastAPI**, **Starlette**, **Uvicorn**, **NumPy**, **SciPy** | `voice/` server | MIT / BSD-3-Clause |

## Apache License 2.0

The MediaPipe works above (including the EfficientDet-Lite0 model), and the Apache-2.0 libraries in its WebAssembly runtime (TensorFlow Lite, Abseil, ruy, FlatBuffers: Google LLC and their authors; OpenCV: the OpenCV authors), are distributed under the Apache License, Version 2.0; they are used unmodified. So are the Apache-2.0 parts of go2rtc's Go modules (`gopkg.in/yaml.v3`: Copyright 2011-2016 Canonical Ltd.; `github.com/tadglines/go-pkgs`: Copyright 2013 Tad Glines). The full text of the license:

```text
                              Apache License
                        Version 2.0, January 2004
                     http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

   "License" shall mean the terms and conditions for use, reproduction,
   and distribution as defined by Sections 1 through 9 of this document.

   "Licensor" shall mean the copyright owner or entity authorized by
   the copyright owner that is granting the License.

   "Legal Entity" shall mean the union of the acting entity and all
   other entities that control, are controlled by, or are under common
   control with that entity. For the purposes of this definition,
   "control" means (i) the power, direct or indirect, to cause the
   direction or management of such entity, whether by contract or
   otherwise, or (ii) ownership of fifty percent (50%) or more of the
   outstanding shares, or (iii) beneficial ownership of such entity.

   "You" (or "Your") shall mean an individual or Legal Entity
   exercising permissions granted by this License.

   "Source" form shall mean the preferred form for making modifications,
   including but not limited to software source code, documentation
   source, and configuration files.

   "Object" form shall mean any form resulting from mechanical
   transformation or translation of a Source form, including but
   not limited to compiled object code, generated documentation,
   and conversions to other media types.

   "Work" shall mean the work of authorship, whether in Source or
   Object form, made available under the License, as indicated by a
   copyright notice that is included in or attached to the work
   (an example is provided in the Appendix below).

   "Derivative Works" shall mean any work, whether in Source or Object
   form, that is based on (or derived from) the Work and for which the
   editorial revisions, annotations, elaborations, or other modifications
   represent, as a whole, an original work of authorship. For the purposes
   of this License, Derivative Works shall not include works that remain
   separable from, or merely link (or bind by name) to the interfaces of,
   the Work and Derivative Works thereof.

   "Contribution" shall mean any work of authorship, including
   the original version of the Work and any modifications or additions
   to that Work or Derivative Works thereof, that is intentionally
   submitted to Licensor for inclusion in the Work by the copyright owner
   or by an individual or Legal Entity authorized to submit on behalf of
   the copyright owner. For the purposes of this definition, "submitted"
   means any form of electronic, verbal, or written communication sent
   to the Licensor or its representatives, including but not limited to
   communication on electronic mailing lists, source code control systems,
   and issue tracking systems that are managed by, or on behalf of, the
   Licensor for the purpose of discussing and improving the Work, but
   excluding communication that is conspicuously marked or otherwise
   designated in writing by the copyright owner as "Not a Contribution."

   "Contributor" shall mean Licensor and any individual or Legal Entity
   on behalf of whom a Contribution has been received by Licensor and
   subsequently incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   copyright license to reproduce, prepare Derivative Works of,
   publicly display, publicly perform, sublicense, and distribute the
   Work and such Derivative Works in Source or Object form.

3. Grant of Patent License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   (except as stated in this section) patent license to make, have made,
   use, offer to sell, sell, import, and otherwise transfer the Work,
   where such license applies only to those patent claims licensable
   by such Contributor that are necessarily infringed by their
   Contribution(s) alone or by combination of their Contribution(s)
   with the Work to which such Contribution(s) was submitted. If You
   institute patent litigation against any entity (including a
   cross-claim or counterclaim in a lawsuit) alleging that the Work
   or a Contribution incorporated within the Work constitutes direct
   or contributory patent infringement, then any patent licenses
   granted to You under this License for that Work shall terminate
   as of the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the
   Work or Derivative Works thereof in any medium, with or without
   modifications, and in Source or Object form, provided that You
   meet the following conditions:

   (a) You must give any other recipients of the Work or
       Derivative Works a copy of this License; and

   (b) You must cause any modified files to carry prominent notices
       stating that You changed the files; and

   (c) You must retain, in the Source form of any Derivative Works
       that You distribute, all copyright, patent, trademark, and
       attribution notices from the Source form of the Work,
       excluding those notices that do not pertain to any part of
       the Derivative Works; and

   (d) If the Work includes a "NOTICE" text file as part of its
       distribution, then any Derivative Works that You distribute must
       include a readable copy of the attribution notices contained
       within such NOTICE file, excluding those notices that do not
       pertain to any part of the Derivative Works, in at least one
       of the following places: within a NOTICE text file distributed
       as part of the Derivative Works; within the Source form or
       documentation, if provided along with the Derivative Works; or,
       within a display generated by the Derivative Works, if and
       wherever such third-party notices normally appear. The contents
       of the NOTICE file are for informational purposes only and
       do not modify the License. You may add Your own attribution
       notices within Derivative Works that You distribute, alongside
       or as an addendum to the NOTICE text from the Work, provided
       that such additional attribution notices cannot be construed
       as modifying the License.

   You may add Your own copyright statement to Your modifications and
   may provide additional or different license terms and conditions
   for use, reproduction, or distribution of Your modifications, or
   for any such Derivative Works as a whole, provided Your use,
   reproduction, and distribution of the Work otherwise complies with
   the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise,
   any Contribution intentionally submitted for inclusion in the Work
   by You to the Licensor shall be under the terms and conditions of
   this License, without any additional terms or conditions.
   Notwithstanding the above, nothing herein shall supersede or modify
   the terms of any separate license agreement you may have executed
   with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade
   names, trademarks, service marks, or product names of the Licensor,
   except as required for reasonable and customary use in describing the
   origin of the Work and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or
   agreed to in writing, Licensor provides the Work (and each
   Contributor provides its Contributions) on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
   implied, including, without limitation, any warranties or conditions
   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
   PARTICULAR PURPOSE. You are solely responsible for determining the
   appropriateness of using or redistributing the Work and assume any
   risks associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory,
   whether in tort (including negligence), contract, or otherwise,
   unless required by applicable law (such as deliberate and grossly
   negligent acts) or agreed to in writing, shall any Contributor be
   liable to You for damages, including any direct, indirect, special,
   incidental, or consequential damages of any character arising as a
   result of this License or out of the use or inability to use the
   Work (including but not limited to damages for loss of goodwill,
   work stoppage, computer failure or malfunction, or any and all
   other commercial damages or losses), even if such Contributor
   has been advised of the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing
   the Work or Derivative Works thereof, You may choose to offer,
   and charge a fee for, acceptance of support, warranty, indemnity,
   or other liability obligations and/or rights consistent with this
   License. However, in accepting such obligations, You may act only
   on Your own behalf and on Your sole responsibility, not on behalf
   of any other Contributor, and only if You agree to indemnify,
   defend, and hold each Contributor harmless for any liability
   incurred by, or claims asserted against, such Contributor by reason
   of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

## BSD-3-Clause License

Applies to XNNPACK and Protocol Buffers (above), and to the Go standard library, `golang.org/x/*`, `github.com/google/uuid`, `github.com/miekg/dns`, `github.com/wlynxg/anet` and (as the Eclipse Distribution License 1.0) `github.com/eclipse/paho.mqtt.golang` in go2rtc, with their copyright notices as listed there:

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

  * Redistributions of source code must retain the above copyright notice,
    this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.
  * Neither the name of the copyright holder nor the names of its
    contributors may be used to endorse or promote products derived from this
    software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## BSD-2-Clause License

Applies to `github.com/gorilla/websocket` in go2rtc (Copyright (c) 2013 The Gorilla WebSocket Authors. All rights reserved.):

```text
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

  Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

  Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## MIT License

Applies to go2rtc (Copyright (c) 2022 Alexey Khit) and to its MIT-licensed Go modules, with their copyright notices as listed above:

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
