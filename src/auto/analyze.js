// Whole-song analysis for the pregenerated Auto show. Live Auto only ever
// hears "now"; with the decoded song we can look at all of it at once and
// find its shape: how loud each bar is (overall, bass, highs, how busy), where
// the sections change, which sections are builds, drops and breaks.
//
// Cheap on purpose (no FFT): two one-pole filters split bass and highs, a
// 23 ms RMS envelope gives loudness and onsets, and everything is then
// averaged per bar on the song's beat grid. A 4-minute song takes well under
// a second. Values are normalised to the song itself (its loud parts ≈ 1), so
// a quiet master and a loud one give the same show.
//
// Works on anything shaped like an AudioBuffer: { sampleRate, length,
// numberOfChannels, getChannelData() }. No DOM; Node-testable.

const HOP = 1024; // samples per analysis frame (~23 ms at 44.1 kHz)

/** Frame features: rms, bass, high, onset — Float32Arrays at sr/HOP fps. */
export function frameFeatures(buffer) {
  const sr = buffer.sampleRate;
  const chs = Math.min(2, buffer.numberOfChannels || 1);
  const a = buffer.getChannelData(0);
  const b = chs > 1 ? buffer.getChannelData(1) : null;
  const n = Math.floor(a.length / HOP);
  const rms = new Float32Array(n), bass = new Float32Array(n), high = new Float32Array(n), onset = new Float32Array(n);
  // one-pole low-passes: ~150 Hz (bass) and ~2.5 kHz (highs = signal − that)
  const kB = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  const kH = 1 - Math.exp((-2 * Math.PI * 2500) / sr);
  let lpB = 0, lpH = 0, prev = 0;
  for (let f = 0; f < n; f++) {
    let s2 = 0, b2 = 0, h2 = 0;
    const o = f * HOP;
    for (let j = 0; j < HOP; j++) {
      const s = b ? (a[o + j] + b[o + j]) * 0.5 : a[o + j];
      lpB += kB * (s - lpB);
      lpH += kH * (s - lpH);
      const hi = s - lpH;
      s2 += s * s; b2 += lpB * lpB; h2 += hi * hi;
    }
    rms[f] = Math.sqrt(s2 / HOP);
    bass[f] = Math.sqrt(b2 / HOP);
    high[f] = Math.sqrt(h2 / HOP);
    onset[f] = rms[f] > prev ? rms[f] - prev : 0;
    prev = rms[f];
  }
  return { rms, bass, high, onset, fps: sr / HOP };
}

/** The p-th percentile of a typed array (0..1), ignoring silence. */
function pct(arr, p) {
  const v = Array.from(arr).filter((x) => x > 1e-6).sort((x, y) => x - y);
  if (!v.length) return 1;
  return v[Math.min(v.length - 1, Math.floor(p * v.length))] || 1;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const SECTION_NAMES = { intro: 'Intro', verse: 'Verse', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' };

/**
 * Analyse a decoded song on its beat grid.
 * Returns { bpm, offset, barLen, duration,
 *           bars: [{ t, energy, bass, high, busy }],      (0..1, per bar)
 *           beats: [{ t, bass }],                          (per beat, 0..1)
 *           sections: [{ t, end, bar0, bar1, kind, name, energy }] }
 */
export function analyzeSong(buffer, { bpm = 120, offset = 0 } = {}) {
  const duration = buffer.length / buffer.sampleRate;
  const F = frameFeatures(buffer);
  const beatLen = 60 / (bpm || 120);
  const barLen = beatLen * 4;
  const avg = (arr, t0, t1) => {
    const i0 = Math.max(0, Math.floor(t0 * F.fps)), i1 = Math.min(arr.length, Math.ceil(t1 * F.fps));
    if (i1 <= i0) return 0;
    let s = 0;
    for (let i = i0; i < i1; i++) s += arr[i];
    return s / (i1 - i0);
  };

  // Bars on the grid. The bit before the first downbeat joins the first bar.
  const first = ((offset % barLen) + barLen) % barLen;
  const raw = [];
  for (let t = first; t < duration - 0.25 * barLen; t += barLen) {
    const t0 = raw.length ? t : 0;
    const t1 = Math.min(duration, t + barLen);
    raw.push({ t: t0, rms: avg(F.rms, t0, t1), bass: avg(F.bass, t0, t1), high: avg(F.high, t0, t1), busy: avg(F.onset, t0, t1) });
  }
  // normalise each feature to the song's loud bars (its ~90th percentile bar = 1)
  const norm = (k) => pct(Float32Array.from(raw, (b) => b[k]), 0.9);
  const nR = norm('rms'), nB = norm('bass'), nH = norm('high'), nO = norm('busy');
  const bars = raw.map((b) => {
    const rms = clamp01(b.rms / nR), bass = clamp01(b.bass / nB), high = clamp01(b.high / nH), busy = clamp01(b.busy / nO);
    return { t: b.t, energy: clamp01(0.45 * rms + 0.3 * bass + 0.1 * high + 0.15 * busy), bass, high, busy };
  });
  if (!bars.length) bars.push({ t: 0, energy: 0.5, bass: 0.5, high: 0.5, busy: 0.5 });

  // per-beat kick strength, relative to the song's strong beats
  const beats = [];
  for (let t = ((offset % beatLen) + beatLen) % beatLen; t < duration; t += beatLen) {
    beats.push({ t, bass: avg(F.bass, t - 0.03, t + Math.min(0.15, beatLen * 0.4)) });
  }
  const nK = pct(Float32Array.from(beats, (b) => b.bass), 0.9);
  for (const b of beats) b.bass = clamp01(b.bass / nK);

  return { bpm, offset, barLen, duration, bars, beats, sections: findSections(bars, duration) };
}

/**
 * Group bars into sections. Music changes on phrases, so look at 4-bar
 * phrases: a new section starts where a phrase's energy differs clearly from
 * the running section. Then name each section from its energy relative to
 * the song and from what's around it.
 */
export function findSections(bars, duration) {
  const PH = 4;
  const phrases = [];
  for (let i = 0; i < bars.length; i += PH) {
    const sl = bars.slice(i, i + PH);
    const h = Math.max(1, Math.floor(sl.length / 2));
    const mean = (a) => (a.length ? a.reduce((x, b) => x + b.energy, 0) / a.length : 0);
    // slope: is the energy climbing inside the phrase? (a build)
    phrases.push({ bar0: i, bar1: i + sl.length, energy: mean(sl), slope: sl.length > 1 ? mean(sl.slice(h)) - mean(sl.slice(0, h)) : 0 });
  }
  // merge similar neighbouring phrases; consecutive climbing phrases stay one build
  const secs = [];
  phrases.forEach((p, pi) => {
    const cur = secs[secs.length - 1];
    const last = phrases[pi - 1];
    const similar = cur && Math.abs(p.energy - cur.energy) < 0.14 && Math.abs(p.energy - last.energy) < 0.12;
    const climbing = cur && p.slope > 0.04 && last.slope > 0.04 && p.energy > last.energy && p.energy - last.energy < 0.35;
    if (cur && (similar || climbing) && cur.bar1 - cur.bar0 < 32) {
      const w = cur.bar1 - cur.bar0, pw = p.bar1 - p.bar0;
      cur.energy = (cur.energy * w + p.energy * pw) / (w + pw);
      cur.bar1 = p.bar1;
    } else secs.push({ ...p });
  });
  // a lone short tail phrase joins the section before it
  if (secs.length > 1 && secs[secs.length - 1].bar1 - secs[secs.length - 1].bar0 < PH) {
    const tail = secs.pop();
    secs[secs.length - 1].bar1 = tail.bar1;
  }

  const es = secs.map((s) => s.energy).sort((a, b) => a - b);
  const hiCut = es[Math.floor(es.length * 0.66)] ?? 0.6;
  const loCut = es[Math.floor(es.length * 0.34)] ?? 0.3;
  const rising = (s) => {
    const sl = bars.slice(s.bar0, s.bar1);
    if (sl.length < 3) return false;
    const h = Math.floor(sl.length / 2);
    const a = sl.slice(0, h).reduce((x, b) => x + b.energy, 0) / h;
    const b = sl.slice(h).reduce((x, b2) => x + b2.energy, 0) / (sl.length - h);
    return b - a > 0.08;
  };
  secs.forEach((s, i) => {
    const prev = secs[i - 1], next = secs[i + 1];
    const high = s.energy >= hiCut && s.energy > 0.45;
    const low = s.energy <= loCut || s.energy < 0.3;
    if (high) s.kind = 'drop';
    else if (next && next.energy - s.energy > 0.12 && rising(s)) s.kind = 'build';
    else if (low && i === 0) s.kind = 'intro';
    else if (low && i === secs.length - 1) s.kind = 'outro';
    else if (low && prev) s.kind = 'break';
    else s.kind = i === 0 ? 'intro' : 'verse';
  });
  const count = {};
  const total = {};
  for (const s of secs) total[s.kind] = (total[s.kind] || 0) + 1;
  return secs.map((s, i) => {
    count[s.kind] = (count[s.kind] || 0) + 1;
    const name = SECTION_NAMES[s.kind] + (total[s.kind] > 1 ? ` ${count[s.kind]}` : '');
    const t = bars[s.bar0].t;
    const end = i + 1 < secs.length ? bars[secs[i + 1].bar0].t : duration;
    return { t, end, bar0: s.bar0, bar1: s.bar1, kind: s.kind, name, energy: s.energy };
  });
}
