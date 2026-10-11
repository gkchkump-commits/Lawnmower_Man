// The bench page's preload: the wake channels exactly as contract-wake §6.2 has them, plus the
// bench's own two. The audio port cannot cross contextBridge: it is forwarded with
// window.postMessage, like electron/preload-camera.cjs does for the camera's frames.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

ipcRenderer.on('lm:wake:port', (e, info) => window.postMessage({ type: 'lm:wake:port', gen: Number(info && info.gen) || 0 }, '*', e.ports));

contextBridge.exposeInMainWorld('bench', {
  requestPort: () => ipcRenderer.invoke('lm:wake:request-port'),
  status: () => ipcRenderer.invoke('lm:wake:status'),
  report: (st) => ipcRenderer.send('lm:wake:state', st),
  onPlan: (cb) => ipcRenderer.on('bench:plan', (_e, plan) => cb(plan)),
  progress: (p) => ipcRenderer.send('bench:progress', p),
  done: (r) => ipcRenderer.send('bench:done', r),
});
