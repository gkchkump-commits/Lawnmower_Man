// Camera harness (dev only): shows what the face tracker and the attention module see, to tune
// src/vision/attention.js on a real webcam. window.__obs collects every observation (tests).
/* global URLSearchParams, location */
import { AttentionTracker, faceGeometry } from '../vision/attention.js';
import { cameraConstraints } from '../vision/camera.js';
import { FaceTracker, visionAssetUrls } from '../vision/face-tracker.js';
import { PresenceMachine } from '../vision/presence.js';

const q = new URLSearchParams(location.search);
const out = /** @type {HTMLElement} */ (document.getElementById('out'));
const video = /** @type {HTMLVideoElement} */ (document.getElementById('v'));
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('c'));
const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const w = /** @type {any} */ (window);
w.__obs = [];

video.srcObject = await navigator.mediaDevices.getUserMedia(cameraConstraints(q.get('device') || ''));
await video.play();
canvas.width = video.videoWidth;
canvas.height = video.videoHeight;

// this page lives in /dev/: the assets are one level up
const urls = visionAssetUrls(new URL('../', location.href).href);
const tracker = new FaceTracker(q.get('main') ? { urls, createWorker: () => { throw new Error('main thread requested'); } } : { urls });
const attention = new AttentionTracker();
const presence = new PresenceMachine({}, performance.now());
let ready = '';
const events = [];
tracker.on('ready', (r) => { ready = JSON.stringify(r); });
tracker.on('error', (e) => { out.textContent = `error: ${e.message}`; });
tracker.on('observation', ({ obs, t, ms }) => {
  const s = attention.update(obs, t);
  for (const ev of presence.update(s.present, t, { idle: true, lastSeen: s.lastSeen })) events.unshift(`${Math.round(t / 1000)}s ${JSON.stringify(ev)}`);
  w.__obs.push({ face: !!obs, ms, obs, s: { ...s } });
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (obs) {
    g.fillStyle = '#ffb867';
    for (const [x, y] of Object.values(obs.points)) g.fillRect(x * canvas.width - 2, y * canvas.height - 2, 4, 4);
  }
  const geo = obs ? faceGeometry(obs) : null;
  const deg = (r) => `${((r * 180) / Math.PI).toFixed(1)}°`;
  out.textContent = [
    `tracker ${ready} · ${tracker.rate}/s · ${ms} ms`,
    `face ${obs ? 'yes' : 'no'} · present ${s.present} · looking ${s.looking} · smiling ${s.smiling} (${s.smile.toFixed(2)}) · talking ${s.talking} (jaw ${s.jaw.toFixed(2)})`,
    `centre (mirrored) ${s.x.toFixed(2)}, ${s.y.toFixed(2)} · ~${Number.isFinite(s.distanceCm) ? Math.round(s.distanceCm) : '?'} cm · yaw ${deg(s.yaw)} · pitch ${deg(s.pitch)}${geo ? ` · roll ${deg(geo.roll)}` : ''}`,
    obs ? `blendshapes ${Object.entries(obs.blend).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ')}` : '',
    '',
    ...events.slice(0, 8),
  ].join('\n');
});
tracker.setVideo(video);
tracker.setRate(Number(q.get('hz') || 12));
await tracker.start();
