// Whole-song analysis for the pregenerated Auto show. Live Auto only ever
// hears "now"; with the decoded song we can look at all of it at once and
// find its shape the way a lighting designer listens to it:
//
//   - how loud each bar is, and *what* is loud: sub/bass, mids, highs, air;
//     how bright or dark it sounds (spectral centroid), how noisy (risers,
//     white-noise sweeps) and how fast the snares / hats hit (a snare roll
//     speeding up from 1/4 to 1/16 notes is the sound of a build)
//   - tension per bar (fast hits + noise + highs + missing bass)
//   - drops: the exact downbeat where the bass slams back in, and from them
//     which beat of the bar is "one" (drops land on downbeats)
//   - sections, cut where the sound changes (novelty) on the 4-bar phrase
//     grid, then named: intro, verse, build, drop, break, outro
//   - fills (a burst of hits on a phrase's last beat), repeats (the chorus
//     coming back) and a mood per section: energy × dark/bright → euphoric,
//     aggressive, dreamy or dark
//
// Cheap on purpose: one 1024-point FFT per 23 ms frame (our own radix-2, no
// dependency) plus two one-pole filters; everything else is per-bar averages
// on the song's beat grid. Values are normalised to the song itself (its loud
// parts ≈ 1), so a quiet master and a loud one give the same show.
//
// Works on anything shaped like an AudioBuffer: { sampleRate, length,
// numberOfChannels, getChannelData() }. No DOM; Node-testable.

const HOP = 1024; // samples per analysis frame (~23 ms at 44.1 kHz); also the FFT size

// ------------------------------------------------------------------ FFT

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / n); sin[i] = Math.sin((-2 * Math.PI * i) / n); }
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
  t = { rev, cos, sin, win };
  fftCache.set(n, t);
  return t;
}

/** In-place iterative radix-2 FFT of (re, im); n a power of two. */
export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step], si = sin[k * step];
        const a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// ------------------------------------------------------- frame features

/** The spectral bands we listen to, in Hz (bass below 150 comes from the one-pole filter). */
export const BANDS = [
  { key: 'low', lo: 40, hi: 250 },
  { key: 'lowmid', lo: 250, hi: 1000 },
  { key: 'mid', lo: 1000, hi: 4000 },
  { key: 'hi', lo: 4000, hi: 10000 },
  { key: 'air', lo: 10000, hi: 22050 },
];

/**
 * Frame features at sr/HOP fps (Float32Arrays): rms, bass, high, onset (the
 * cheap filters) and from the FFT: one array per BANDS key, centroid (Hz),
 * fluxLo / fluxHi (spectral flux below 250 Hz / above 2 kHz — kicks / snares
 * and hats), flat (spectral flatness above 2 kHz: ~0 tonal, → 1 noise).
 */
export function frameFeatures(buffer) {
  const sr = buffer.sampleRate;
  const chs = Math.min(2, buffer.numberOfChannels || 1);
  const a = buffer.getChannelData(0);
  const b = chs > 1 ? buffer.getChannelData(1) : null;
  const n = Math.floor(a.length / HOP);
  const arr = () => new Float32Array(n);
  const F = { rms: arr(), bass: arr(), high: arr(), onset: arr(), centroid: arr(), fluxLo: arr(), fluxHi: arr(), flat: arr(), fps: sr / HOP };
  for (const band of BANDS) F[band.key] = arr();
  // one-pole low-passes: ~150 Hz (bass) and ~2.5 kHz (highs = signal − that)
  const kB = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  const kH = 1 - Math.exp((-2 * Math.PI * 2500) / sr);
  const { win } = fftTables(HOP);
  const re = new Float64Array(HOP), im = new Float64Array(HOP);
  const H = HOP / 2;
  const mag = new Float32Array(H), prevMag = new Float32Array(H);
  const binHz = sr / HOP;
  const bin = (hz) => Math.max(1, Math.min(H, Math.round(hz / binHz)));
  const bandBins = BANDS.map((x) => [bin(x.lo), bin(x.hi)]);
  const k250 = bin(250), k2k = bin(2000);
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
      re[j] = s * win[j];
      im[j] = 0;
    }
    F.rms[f] = Math.sqrt(s2 / HOP);
    F.bass[f] = Math.sqrt(b2 / HOP);
    F.high[f] = Math.sqrt(h2 / HOP);
    F.onset[f] = F.rms[f] > prev ? F.rms[f] - prev : 0;
    prev = F.rms[f];

    fft(re, im);
    let sm = 0, smf = 0, fl = 0, fh = 0, logSum = 0, linSum = 0;
    for (let k = 1; k < H; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / HOP;
      mag[k] = m;
      sm += m; smf += m * k;
      const d = m - prevMag[k];
      if (d > 0) { if (k < k250) fl += d; else if (k >= k2k) fh += d; }
      if (k >= k2k) { logSum += Math.log(m + 1e-9); linSum += m; }
      prevMag[k] = m;
    }
    F.centroid[f] = sm > 1e-9 ? (smf / sm) * binHz : 0;
    F.fluxLo[f] = fl;
    F.fluxHi[f] = fh;
    const nh = H - k2k;
    F.flat[f] = linSum > 1e-7 && nh > 0 ? Math.exp(logSum / nh) / (linSum / nh) : 0;
    bandBins.forEach(([lo, hi], i) => {
      let e = 0;
      for (let k = lo; k < hi; k++) e += mag[k] * mag[k];
      F[BANDS[i].key][f] = Math.sqrt(e);
    });
  }
  return F;
}

/** The p-th percentile of an array (0..1), ignoring silence. */
function pct(arr, p, fallback = 1) {
  const v = Array.from(arr).filter((x) => x > 1e-6).sort((x, y) => x - y);
  if (!v.length) return fallback;
  return v[Math.min(v.length - 1, Math.floor(p * v.length))] || fallback;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export const SECTION_NAMES = { intro: 'Intro', verse: 'Verse', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' };
export const MOOD_NAMES = { euphoric: 'Euphoric', aggressive: 'Aggressive', dreamy: 'Dreamy', dark: 'Dark' };

/** Energy and brightness (0..1) -> one of the four moods. */
export function moodOf(energy, bright) {
  if (energy >= 0.58) return bright >= 0.5 ? 'euphoric' : 'aggressive';
  return bright >= 0.5 ? 'dreamy' : 'dark';
}

// ---------------------------------------------------------------- song

/**
 * Analyse a decoded song on its beat grid.
 * Returns { bpm, offset, barLen, duration, phase (beats the bar grid was
 *           moved so drops land on "one"),
 *   bars:  [{ t, energy, bass, high, busy, bright, noise, rate, tension, fill, vec }],
 *   beats: [{ t, bass }],                                  (per beat, 0..1)
 *   drops: [{ bar, t, strength }],
 *   sections: [{ t, end, bar0, bar1, kind, name, energy, bright, tension,
 *                mood, group, repeat, hit }] }
 * `hit` = the section starts on a detected drop; `group` = sections that
 * sound alike share a number, `repeat` = how many times it came before.
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

  // ---- beats: kick strength (short window) and bass level (whole beat)
  const beats = [];
  const b0 = ((offset % beatLen) + beatLen) % beatLen;
  for (let t = b0; t < duration; t += beatLen) {
    beats.push({ t, bass: avg(F.bass, t - 0.03, t + Math.min(0.15, beatLen * 0.4)), level: avg(F.bass, t, t + beatLen) });
  }
  const nK = pct(beats.map((b) => b.bass), 0.9);
  const nL = pct(beats.map((b) => b.level), 0.9);
  for (const b of beats) { b.bass = clamp01(b.bass / nK); b.level = clamp01(b.level / nL); }

  // ---- which beat is "one": drops (bass slamming back in) land on downbeats
  const phase = downbeatPhase(beats, offset, beatLen);
  const first = ((((offset + phase * beatLen) % barLen) + barLen) % barLen);

  // ---- hits: peaks of the high flux (snares, claps, hats)
  const thrHi = 1.5 * pct(F.fluxHi, 0.5, 0);
  const peak = new Uint8Array(F.fluxHi.length);
  let lastPeak = -9;
  for (let i = 1; i < F.fluxHi.length - 1; i++) {
    const v = F.fluxHi[i];
    if (v > thrHi && v >= F.fluxHi[i - 1] && v > F.fluxHi[i + 1] && i - lastPeak >= 2) { peak[i] = 1; lastPeak = i; }
  }
  const count = (t0, t1) => {
    let c = 0;
    for (let i = Math.max(0, Math.floor(t0 * F.fps)); i < Math.min(peak.length, Math.ceil(t1 * F.fps)); i++) c += peak[i];
    return c;
  };
  // high-band flatness, weighted by how loud the highs are (silence isn't noise)
  const flatW = (t0, t1) => {
    let s = 0, w = 0;
    for (let i = Math.max(0, Math.floor(t0 * F.fps)); i < Math.min(F.flat.length, Math.ceil(t1 * F.fps)); i++) { s += F.flat[i] * F.high[i]; w += F.high[i]; }
    return w > 1e-9 ? s / w : 0;
  };

  // ---- bars on the grid. The bit before the first downbeat joins the first bar.
  const raw = [];
  for (let t = first; t < duration - 0.25 * barLen; t += barLen) {
    const t0 = raw.length ? t : 0;
    const t1 = Math.min(duration, t + barLen);
    const r = { t: t0, rms: avg(F.rms, t0, t1), bass: avg(F.bass, t0, t1), high: avg(F.high, t0, t1), busy: avg(F.onset, t0, t1),
      centroid: avg(F.centroid, t0, t1), flat: flatW(t0, t1), hits: count(t, t1), fluxHi: avg(F.fluxHi, t0, t1),
      lastBeatFlux: avg(F.fluxHi, t1 - beatLen, t1 - 1.5 / F.fps) }; // stop short of the next downbeat
    for (const band of BANDS) r[band.key] = avg(F[band.key], t0, t1);
    raw.push(r);
  }
  // normalise each feature to the song's loud bars (its ~90th percentile bar = 1)
  const norm = (k) => pct(raw.map((b) => b[k]), 0.9);
  const N = {};
  for (const k of ['rms', 'bass', 'high', 'busy', ...BANDS.map((x) => x.key)]) N[k] = norm(k);
  const span = (k) => {
    const lo = pct(raw.map((b) => b[k]), 0.1, 0), hi = pct(raw.map((b) => b[k]), 0.9, 1);
    return (v) => (hi - lo > 1e-9 ? clamp01((v - lo) / (hi - lo)) : 0.5);
  };
  const relC = span('centroid'), relF = span('flat');
  const bars = raw.map((b, i) => {
    const rms = clamp01(b.rms / N.rms), bass = clamp01(b.bass / N.bass), high = clamp01(b.high / N.high), busy = clamp01(b.busy / N.busy);
    const energy = clamp01(0.45 * rms + 0.3 * bass + 0.1 * high + 0.15 * busy);
    // bright: half relative to this song, half absolute (≈ 600 Hz dark .. 3.6 kHz bright)
    const bright = clamp01(0.5 * relC(b.centroid) + 0.5 * clamp01((b.centroid - 600) / 3000));
    const noise = relF(b.flat) * clamp01(high / 0.3); // flatness of near-silent highs means nothing
    const rate = b.hits / 4; // hits per beat
    const tension = clamp01(0.35 * Math.min(1, rate / 4) + 0.25 * noise + 0.2 * high + 0.2 * (1 - bass));
    // a fill: the bar's last beat hits much harder than the last beat of the
    // bars before it (so a clap on every 4th beat isn't one)
    const prevLast = mean(raw.slice(Math.max(0, i - 3), i).map((x) => x.lastBeatFlux));
    const fill = i >= 2 && b.lastBeatFlux > 1.8 * prevLast && b.lastBeatFlux > 1.5 * b.fluxHi && rms > 0.15;
    const vec = [bass, ...BANDS.map((x) => clamp01(b[x.key] / N[x.key])), bright, energy, Math.min(1, rate / 4), noise];
    return { t: b.t, energy, bass, high, busy, bright, noise, rate, tension, fill, vec };
  });
  if (!bars.length) bars.push({ t: 0, energy: 0.5, bass: 0.5, high: 0.5, busy: 0.5, bright: 0.5, noise: 0, rate: 0, tension: 0.3, fill: false, vec: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0] });

  const drops = findDrops(bars);
  const sections = findSections(bars, duration, drops);
  return { bpm, offset, barLen, duration, phase, bars, beats: beats.map(({ t, bass }) => ({ t, bass })), drops, sections };
}

/**
 * Which beat of the given bar grid is really "one" (0..3)? Find where the bass
 * jumps up and stays (a drop), and vote with the jumps' beat-in-bar. Without
 * clear drops, keep the grid as it is.
 */
export function downbeatPhase(beats, offset, beatLen) {
  const lv = beats.map((b) => b.level);
  const lift = lv.map((_, j) => (j < 4 || j + 4 > lv.length ? 0 : mean(lv.slice(j, j + 4)) - mean(lv.slice(j - 4, j))));
  const votes = [0, 0, 0, 0];
  let strong = 0;
  for (let j = 4; j < lift.length - 4; j++) {
    const v = lift[j];
    if (v < 0.3) continue;
    let isMax = true;
    for (let k = j - 4; k <= j + 4; k++) if (k !== j && lift[k] > v) { isMax = false; break; }
    if (!isMax) continue;
    const pos = (((Math.round((beats[j].t - offset) / beatLen)) % 4) + 4) % 4;
    votes[pos] += v;
    strong++;
  }
  const total = votes.reduce((x, y) => x + y, 0);
  if (!strong || total <= 0) return 0;
  const best = votes.indexOf(Math.max(...votes));
  return votes[best] >= 0.6 * total ? best : 0;
}

/** Drops: bars where the bass (and the energy) jump up and stay up. */
export function findDrops(bars) {
  const n = bars.length;
  const lift = bars.map((b, i) => {
    if (i < 1 || i + 1 > n) return 0;
    const pre = bars.slice(Math.max(0, i - 2), i), post = bars.slice(i, i + 2);
    const bassLift = mean(post.map((x) => x.bass)) - mean(pre.map((x) => x.bass));
    const eLift = mean(post.map((x) => x.energy)) - mean(pre.map((x) => x.energy));
    return 0.6 * bassLift + 0.4 * eLift;
  });
  const cands = [];
  for (let i = 1; i < n; i++) {
    const post = bars.slice(i, i + 2);
    if (lift[i] > 0.22 && mean(post.map((x) => x.bass)) > 0.55 && bars[i].energy > 0.5) cands.push(i);
  }
  // one drop per 8 bars: keep the strongest
  const out = [];
  for (const i of cands.sort((a, b) => lift[b] - lift[a])) {
    if (out.some((d) => Math.abs(d.bar - i) < 8)) continue;
    out.push({ bar: i, t: bars[i].t, strength: Math.round(lift[i] * 1000) / 1000 });
  }
  return out.sort((a, b) => a.bar - b.bar);
}

const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / a.length);
const meanVec = (rows) => rows[0].map((_, i) => mean(rows.map((r) => r[i])));

/**
 * Cut the bars into sections and name them. Music changes on phrases, so
 * cuts land on the 4-bar grid that the first drop sits on: wherever the sound
 * of the next 4 bars differs clearly from the last 4 (novelty), at every drop,
 * and where the build before a drop starts. Then name each section from its
 * energy, its tension and what comes next.
 */
export function findSections(bars, duration, drops = []) {
  const n = bars.length;
  const PH = 4;
  const origin = drops.length ? drops[0].bar % PH : 0;
  const novelty = new Array(n).fill(0);
  for (let i = 2; i < n - 1; i++) {
    const a = bars.slice(Math.max(0, i - PH), i), b = bars.slice(i, Math.min(n, i + PH));
    novelty[i] = dist(meanVec(a.map((x) => x.vec)), meanVec(b.map((x) => x.vec))) + 0.5 * Math.abs(mean(b.map((x) => x.energy)) - mean(a.map((x) => x.energy)));
  }
  const grid = [];
  for (let i = origin; i < n; i += PH) if (i > 0 && i < n - 1) grid.push(i);
  const med = grid.length ? grid.map((i) => novelty[i]).sort((x, y) => x - y)[Math.floor(grid.length / 2)] : 0;
  const thr = Math.max(0.07, med * 1.4);
  const cuts = new Map(); // bar -> strength (forced cuts are Infinity)
  for (const i of grid) if (novelty[i] > thr && novelty[i] >= (novelty[i - PH] ?? 0) * 0.8) cuts.set(i, novelty[i]);
  for (const d of drops) if (d.bar > 0) cuts.set(d.bar, Infinity);
  // the build before each drop: the last 16 / 8 / 4 bars whose tension climbs
  // step by step into it (a flat calm stretch followed by a short build isn't
  // a 16-bar build: every quarter of the window has to climb)
  drops.forEach((d, di) => {
    const floor = di ? drops[di - 1].bar + PH : 1; // never reach back into the previous drop
    for (const k of [16, 8, 4]) {
      const s = d.bar - k;
      if (s < floor) continue;
      const q = [0, 1, 2, 3].map((j) => mean(bars.slice(s + (j * k) / 4, s + ((j + 1) * k) / 4).map((x) => x.tension)));
      const climbs = q[1] - q[0] > 0.015 && q[2] - q[1] > -0.02 && q[3] - q[2] > -0.02 && q[3] - q[0] > 0.1;
      // ...and doesn't start in something louder (the tail of a drop isn't a build)
      const e0 = mean(bars.slice(s, s + k / 4).map((x) => x.energy)), e3 = mean(bars.slice(d.bar - k / 4, d.bar).map((x) => x.energy));
      if (climbs && mean(q) > 0.3 && e0 <= e3 + 0.1) {
        for (const c of [...cuts.keys()]) if (c > s && c < d.bar && cuts.get(c) !== Infinity) cuts.delete(c);
        cuts.set(s, Infinity);
        break;
      }
    }
  });
  // cuts at least 4 bars apart (forced and stronger ones win), sections at most 32 bars
  let list = [...cuts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const [bar] of list) if (!kept.some((k) => Math.abs(k - bar) < PH) || cuts.get(bar) === Infinity) kept.push(bar);
  list = [0, ...kept.filter((b) => b > 0).sort((a, b) => a - b)];
  list = list.filter((b, i) => i === 0 || b !== list[i - 1]);
  const secs = [];
  list.forEach((b0, i) => {
    const b1 = list[i + 1] ?? n;
    for (let s = b0; s < b1; s += 32) secs.push({ bar0: s, bar1: Math.min(b1, s + 32) });
  });
  // a lone short tail joins the section before it
  if (secs.length > 1 && secs.at(-1).bar1 - secs.at(-1).bar0 < PH && !drops.some((d) => d.bar === secs.at(-1).bar0)) {
    const tail = secs.pop();
    secs.at(-1).bar1 = tail.bar1;
  }
  for (const s of secs) {
    const sl = bars.slice(s.bar0, s.bar1);
    s.energy = mean(sl.map((x) => x.energy));
    s.bright = mean(sl.map((x) => x.bright));
    s.tension = mean(sl.map((x) => x.tension));
    s.vec = meanVec(sl.map((x) => x.vec));
    s.hit = drops.some((d) => d.bar === s.bar0);
    const h = Math.floor(sl.length / 2);
    s.rise = sl.length >= 2 ? mean(sl.slice(h).map((x) => x.tension)) - mean(sl.slice(0, h).map((x) => x.tension)) : 0;
  }

  const es = secs.map((s) => s.energy).sort((a, b) => a - b);
  const hiCut = es[Math.floor(es.length * 0.66)] ?? 0.6;
  const loCut = es[Math.floor(es.length * 0.34)] ?? 0.3;
  secs.forEach((s, i) => {
    const prev = secs[i - 1], next = secs[i + 1];
    const high = s.energy >= hiCut && s.energy > 0.45;
    const low = s.energy <= loCut || s.energy < 0.3;
    if (s.hit || (high && !(next?.hit && s.rise > 0.05))) s.kind = 'drop';
    else if (next && (next.hit || next.energy - s.energy > 0.12) && s.rise > 0.05 && s.tension > 0.3) s.kind = 'build';
    else if (low && i === 0) s.kind = 'intro';
    else if (low && i === secs.length - 1) s.kind = 'outro';
    else if (low && prev && prev.energy - s.energy > 0.1) s.kind = 'break'; // a break comes down from something
    else s.kind = i === 0 ? 'intro' : 'verse';
  });
  // a drop that runs on past a cut is still the same drop
  for (let i = secs.length - 1; i > 0; i--) {
    const a = secs[i - 1], b = secs[i];
    if (a.kind === 'drop' && b.kind === 'drop' && !b.hit && b.bar1 - a.bar0 <= 32) {
      const wa = a.bar1 - a.bar0, wb = b.bar1 - b.bar0;
      a.energy = (a.energy * wa + b.energy * wb) / (wa + wb);
      a.bright = (a.bright * wa + b.bright * wb) / (wa + wb);
      a.tension = (a.tension * wa + b.tension * wb) / (wa + wb);
      a.vec = a.vec.map((x, k) => (x * wa + b.vec[k] * wb) / (wa + wb));
      a.bar1 = b.bar1;
      secs.splice(i, 1);
    }
  }
  // repeats: sections that sound alike (the chorus coming back) share a group
  const groups = [];
  for (const s of secs) {
    let g = groups.findIndex((x) => x.kind === s.kind && dist(x.vec, s.vec) < 0.12);
    if (g < 0) { g = groups.length; groups.push({ kind: s.kind, vec: s.vec, n: 0 }); }
    s.group = g;
    s.repeat = groups[g].n++;
  }

  const count = {};
  const total = {};
  for (const s of secs) total[s.kind] = (total[s.kind] || 0) + 1;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return secs.map((s, i) => {
    count[s.kind] = (count[s.kind] || 0) + 1;
    const name = SECTION_NAMES[s.kind] + (total[s.kind] > 1 ? ` ${count[s.kind]}` : '');
    const t = bars[s.bar0].t;
    const end = i + 1 < secs.length ? bars[secs[i + 1].bar0].t : duration;
    return { t, end, bar0: s.bar0, bar1: s.bar1, kind: s.kind, name, energy: r3(s.energy), bright: r3(s.bright), tension: r3(s.tension),
      mood: moodOf(s.energy, s.bright), group: s.group, repeat: s.repeat, hit: s.hit };
  });
}
