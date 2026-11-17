// Web Audio playback + waveform peaks. Decodes any browser-supported format
// (mp3/wav/ogg/m4a) via decodeAudioData - no FFmpeg, so the one-click install
// stays intact. An AudioBufferSourceNode can only play once, so we recreate it
// on every play and track position against the AudioContext clock.
//
// For live Auto it also reports how bright the sound is (bands().bright, for
// sweeps) and, through a left and a right tap, which side it sits on (lean()).

// analyser byte (dB between -100 and -30) -> amplitude and its square root
const AMP = new Float32Array(256), ROOT = new Float32Array(256);
for (let i = 1; i < 256; i++) { const db = -100 + (i / 255) * 70; AMP[i] = 10 ** (db / 20); ROOT[i] = 10 ** (db / 40); }
const SIDE_EDGES = [250, 1000, 4000, 10000, 16000]; // Hz: the bands a side is judged in (above the bass)

export class AudioEngine {
  constructor() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.buffer = null;
    this.source = null;
    this.playing = false;
    this.name = '';
    this._startCtxTime = 0; // ctx.currentTime when playback (re)started
    this._startOffset = 0;  // buffer offset at that moment

    // Spectrum tap for frequency-reactive effects (source -> analyser -> out).
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.7;
    this.analyser.connect(this.ctx.destination);
    this._freq = new Uint8Array(this.analyser.frequencyBinCount);

    // Left / right taps (source -> splitter -> one analyser each; not to the
    // speakers, the main analyser already plays the song).
    this._split = this.ctx.createChannelSplitter(2);
    this._sides = [0, 1].map((ch) => {
      const an = this.ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.5;
      this._split.connect(an, ch);
      return { an, freq: new Uint8Array(an.frequencyBinCount) };
    });
    this._sideRef = SIDE_EDGES.slice(1).map(() => 0); // each band's recent loud level
  }

  /**
   * Normalised low/mid/high band levels (0..1) of the audio playing now, plus
   * bright: where the sound's weight sits above the bass, in octaves (log2 Hz;
   * 0 = too quiet to tell).
   */
  bands() {
    if (!this.playing || !this.buffer) return { bass: 0, mid: 0, high: 0, bright: 0 };
    return this._bands(this.analyser, this._freq);
  }

  /**
   * Which side the song sits on right now: −1 all left … 0 centred … 1 all
   * right, judged above the bass, each band against its own recent loud level
   * (the same measure as the whole-song analysis). 0 for a mono song.
   */
  lean() {
    if (!this.playing || !this.buffer || this.buffer.numberOfChannels < 2) return 0;
    const [l, r] = this._sides;
    l.an.getByteFrequencyData(l.freq);
    r.an.getByteFrequencyData(r.freq);
    const binHz = this.ctx.sampleRate / l.an.fftSize;
    let d = 0, w = 0;
    for (let b = 0; b + 1 < SIDE_EDGES.length; b++) {
      const i0 = Math.max(1, Math.round(SIDE_EDGES[b] / binHz)), i1 = Math.min(l.freq.length, Math.round(SIDE_EDGES[b + 1] / binHz));
      let sl = 0, sr = 0;
      for (let i = i0; i < i1; i++) { sl += AMP[l.freq[i]]; sr += AMP[r.freq[i]]; }
      const ref = this._sideRef[b] = Math.max(this._sideRef[b] * 0.999, sl + sr); // the loud level fades over ~10 s
      if (ref > 0) { d += (sr - sl) / ref; w += (sr + sl) / ref; }
    }
    return w / this._sideRef.length >= 0.2 ? d / w : 0; // too quiet: no side
  }

  _bands(analyser, freq) {
    analyser.getByteFrequencyData(freq);
    const binHz = this.ctx.sampleRate / analyser.fftSize;
    const band = (lo, hi, gain) => {
      const i0 = Math.max(1, Math.floor(lo / binHz));
      const i1 = Math.min(freq.length - 1, Math.ceil(hi / binHz));
      let sum = 0;
      for (let i = i0; i <= i1; i++) sum += freq[i];
      const avg = i1 >= i0 ? sum / (i1 - i0 + 1) / 255 : 0;
      return Math.min(1, avg * gain); // highs are quieter -> more gain
    };
    const k0 = Math.max(1, Math.round(150 / binHz)), k1 = Math.min(freq.length, Math.round(16000 / binHz));
    let w = 0, o = 0, loud = 0;
    for (let i = k0; i < k1; i++) { const m = ROOT[freq[i]]; w += m; o += m * Math.log2(i * binHz); if (freq[i] > loud) loud = freq[i]; }
    return { bass: band(20, 150, 1.5), mid: band(150, 2000, 2.2), high: band(2000, 9000, 3.0), bright: loud > 60 ? o / w : 0 };
  }

  // ---- sound input (microphone / line-in) for live Auto: analysed only,
  // never played back (no feedback). Asks for permission on first use.
  get inputOn() { return !!this._input; }

  async startInput() {
    if (this._input) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('sound input is not available here');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.6;
    src.connect(an); // not to the speakers
    this._input = { stream, src, an, freq: new Uint8Array(an.frequencyBinCount), label: stream.getAudioTracks()[0]?.label || 'Sound input' };
  }

  stopInput() {
    if (!this._input) return;
    for (const t of this._input.stream.getTracks()) t.stop();
    this._input.src.disconnect();
    this._input = null;
  }

  get inputLabel() { return this._input?.label || ''; }

  /** Band levels of the sound input (zeros when it's off). */
  inputBands() {
    return this._input ? this._bands(this._input.an, this._input.freq) : { bass: 0, mid: 0, high: 0, bright: 0 };
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  get currentTime() {
    if (!this.buffer) return 0;
    if (this.playing) {
      return Math.min(this._startOffset + (this.ctx.currentTime - this._startCtxTime), this.duration);
    }
    return this._startOffset;
  }

  async load(file) {
    const arr = await file.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arr);
    this.name = file.name;
    this._startOffset = 0;
    this.playing = false;
  }

  /** Load a pre-built AudioBuffer (used by synthesized test tracks). */
  setBuffer(buffer, name = 'synth') {
    this.buffer = buffer;
    this.name = name;
    this._startOffset = 0;
    this.playing = false;
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.analyser); // analyser -> destination (set up in ctor)
    if (this.buffer.numberOfChannels > 1) this.source.connect(this._split);
    this._startCtxTime = this.ctx.currentTime;
    this.source.start(0, Math.min(this._startOffset, this.duration));
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._startOffset = this.currentTime;
    this._stopSource();
    this.playing = false;
  }

  stop() {
    this._stopSource();
    this.playing = false;
    this._startOffset = 0;
  }

  seek(t) {
    const wasPlaying = this.playing;
    this._stopSource();
    this.playing = false;
    this._startOffset = Math.max(0, Math.min(t, this.duration || 0));
    if (wasPlaying) this.play();
  }

  _stopSource() {
    if (!this.source) return;
    try { this.source.onended = null; this.source.stop(); } catch (_) {}
    this.source.disconnect();
    this.source = null;
  }

  /** min/max peak pairs (length count*2) for waveform drawing. */
  /**
   * Min/max pairs for `count` columns covering [t0, t1) seconds — the zoomed
   * timeline asks for just the visible slice. Columns outside the song are 0.
   */
  peaksRange(t0, t1, count) {
    if (!this.buffer || count <= 0 || t1 <= t0) return null;
    const ch = this.buffer.getChannelData(0);
    const sr = this.buffer.sampleRate;
    const out = new Float32Array(count * 2);
    const per = ((t1 - t0) * sr) / count;
    for (let i = 0; i < count; i++) {
      const start = Math.max(0, Math.floor((t0 * sr) + i * per));
      const end = Math.min(ch.length, Math.floor((t0 * sr) + (i + 1) * per));
      let min = 0, max = 0;
      // Long columns are sampled with a stride — plenty for a waveform outline.
      const step = Math.max(1, Math.floor((end - start) / 256));
      for (let j = start; j < end; j += step) {
        const v = ch[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      out[i * 2] = min;
      out[i * 2 + 1] = max;
    }
    return out;
  }

  peaks(count) {
    if (!this.buffer || count <= 0) return null;
    const ch = this.buffer.getChannelData(0);
    const block = Math.max(1, Math.floor(ch.length / count));
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      let min = 1, max = -1;
      const start = i * block;
      const end = Math.min(start + block, ch.length);
      for (let j = start; j < end; j++) {
        const v = ch[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      out[i * 2] = min;
      out[i * 2 + 1] = max;
    }
    return out;
  }
}
