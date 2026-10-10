// Summarise a tools/wake/bench/main.mjs report: hits per class, latency from the end of "Jade" to
// the hit arriving in the page, the utility's CPU per phase.
//   node tools/wake/bench/summarize.mjs <report.json>
import fs from 'node:fs';

const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (r.result.error) {
  console.log(JSON.stringify({ error: r.result.error }));
  process.exit(1);
}
const SR = 16000;
const speech = r.result.phases.find((p) => p.name === 'speech');
const silence = r.result.phases.find((p) => p.name === 'silence');
const byClass = {};
const lat = [];
for (const sp of r.spans) {
  const c = (byClass[sp.cls] ||= { n: 0, HEY_JADE: 0, HEY_JUDE: 0, JADE: 0 });
  c.n++;
  const mine = speech.hits.filter((h) => {
    const mid = (h.startAt + h.endAt) / 2 - speech.at0;
    return mid >= sp.s && mid <= sp.e;
  });
  for (const k of ['HEY_JADE', 'HEY_JUDE', 'JADE']) if (mine.some((h) => h.keyword === k)) c[k]++;
  const h = mine.find((x) => x.keyword === 'HEY_JADE');
  if (h && sp.jadeEnd > 0 && (sp.cls === 'pos' || sp.cls === 'pause')) {
    // the page posted each frame when its last sample "happened": sample i at t0 + i / 16 ms
    const jadeEndMs = speech.t0 + (sp.s + sp.jadeEnd * SR) / 16;
    lat.push(Math.round(h.arrival - jadeEndMs));
  }
}
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] : null; };
const cpu = (ph) => {
  const xs = r.samples.filter((s) => s.phase === ph && typeof s.cpu === 'number').map((s) => s.cpu);
  return xs.length ? { n: xs.length, meanPct: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100, maxPct: Math.round(Math.max(...xs) * 100) / 100 } : null;
};
const mem = r.samples.filter((s) => s.mem).map((s) => s.mem);
// the kernel's count: % of one core over each phase
const proc = Object.fromEntries(Object.entries(r.procCpu || {}).map(([k, v]) => {
  if (!v.start || !v.end || v.start.ticks === null || v.end.ticks === null) return [k, null];
  const sec = (v.end.t - v.start.t) / 1000;
  const cpuSec = (v.end.ticks - v.start.ticks) / (r.clkTck || 100);
  return [k, { wallSec: Math.round(sec * 10) / 10, cpuSec: Math.round(cpuSec * 100) / 100, pctOfOneCore: Math.round((cpuSec / sec) * 1000) / 10, msPerSecAudio: Math.round((cpuSec / sec) * 1000 * 10) / 10 }];
}));
const cum = (ph) => {
  const xs = r.samples.filter((s) => s.phase === ph && typeof s.cum === 'number');
  if (xs.length < 2) return null;
  const sec = (xs[xs.length - 1].t - xs[0].t) / 1000;
  return Math.round(((xs[xs.length - 1].cum - xs[0].cum) / sec) * 1000) / 10;
};
console.log(JSON.stringify({
  electron: r.electron, platform: r.platform, loadavg: r.loadavg.map((x) => Math.round(x * 10) / 10),
  engine: r.status.engine, models: r.result.ready.models, loadMs: r.status.loadMs, rttMs: { p50: pct(r.result.rttMs, 0.5), max: Math.max(...r.result.rttMs) },
  silenceSec: silence ? silence.samples / SR : 0, silenceHits: silence ? silence.hits.length : 0,
  speechSec: Math.round(speech.samples / SR), late: speech.late,
  classes: byClass,
  latencyMs: { n: lat.length, p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: lat.length ? Math.max(...lat) : null, all: lat },
  utilityCpuKernel: proc,
  utilityCpuAppMetricsPercent: { silence: cpu('silence'), speech: cpu('speech'), cumulativeSilencePct: cum('silence'), cumulativeSpeechPct: cum('speech') },
  stopMs: r.stopMs, utilityAfterStop: r.utilityAfterStop ?? 'gone',
  utilityStats: r.result.stats && { fedSec: r.result.stats.fedSec, activeSec: r.result.stats.activeSec, cpuMsPerSecSpeech: r.result.stats.cpuMsPerSecSpeech, cpuMsPerSecSilence: r.result.stats.cpuMsPerSecSilence, cpuMsPerSecAll: r.result.stats.cpuMsPerSecAll, streams: r.result.stats.streams, dropped: r.result.stats.dropped },
  utilityMemoryMB: mem.length ? { first: Math.round(mem[0] / 1024), max: Math.round(Math.max(...mem) / 1024), last: Math.round(mem[mem.length - 1] / 1024) } : null,
}, null, 1));
