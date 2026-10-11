// The Home camera's security worker (module worker, created by src/tapo/main.js). It decodes
// the camera's video, draws the live view on the page's canvas, and runs local motion and
// person detection whether or not the window is shown (the camera window stays alive hidden
// for this). The logic lives in pipeline.js; this file only wires it to the worker:
//
//   page → worker  { t: 'port' } + a transferred MessagePort to main (main's protocol, §9.3)
//                  { t: 'canvas', canvas: OffscreenCanvas } (transferred)
//                  { t: 'view', visible } · { t: 'resize', width, height, dpr } · { t: 'overlay', show }
//                  { t: 'snap', id, maxSide, quality }   (Space: a picture for the clipboard)
//   worker → page  { t: 'video', width, height } · { t: 'det-view', persons } · { t: 'stats', … }
//                  { t: 'snap-ok', id, jpeg, width, height } | { t: 'snap-err', id, message }
//
// MediaPipe (the person detector) is only loaded when main asks for it (hello.detector
// 'mediapipe'); the test stub needs nothing.

/* global self, createImageBitmap, OffscreenCanvas, VideoDecoder, EncodedVideoChunk */
import { SecurityPipeline } from './pipeline.js';

const pipeline = new SecurityPipeline({
  postPage: (msg, transfer) => /** @type {any} */ (self).postMessage(msg, transfer || []),
  createImageBitmap: (image, o) => createImageBitmap(image, o),
  OffscreenCanvas: typeof OffscreenCanvas === 'function' ? OffscreenCanvas : undefined,
  VideoDecoder: typeof VideoDecoder === 'function' ? VideoDecoder : undefined,
  EncodedVideoChunk: typeof EncodedVideoChunk === 'function' ? EncodedVideoChunk : undefined,
  loadDetector: async (o) => (await import('./detector.js')).createPersonDetector(o),
});

self.addEventListener('message', (e) => {
  const msg = /** @type {MessageEvent} */ (e).data;
  if (msg && msg.t === 'port') {
    const port = /** @type {MessageEvent} */ (e).ports?.[0] || msg.port;
    if (port) pipeline.attachPort(port);
    return;
  }
  pipeline.onPage(msg);
});
