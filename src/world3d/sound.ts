// Procedural sound — all synthesised with the Web Audio API, no asset files, so
// it ships in the bundle and works offline on the Pi. A tiny envelope helper
// drives short oscillator/noise blips for the game's key beats, plus a low
// ambient plant drone. The context is created lazily and resumed on the first
// user gesture (autoplay policy).
export class SoundKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: { gain: GainNode; nodes: AudioNode[] } | null = null;
  muted = false;

  /** Call from a user gesture so the browser lets audio start. */
  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }
  private init() {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    this.ctx = ctx; this.master = master;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
  }

  private noiseBuffer(dur: number): AudioBuffer {
    const ctx = this.ctx!; const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** One oscillator with an attack/decay gain envelope. */
  private blip(type: OscillatorType, f0: number, f1: number, t0: number, dur: number, peak: number) {
    const ctx = this.ctx!, master = this.master!;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /** Filtered noise burst (whooshes, rumbles, impacts). */
  private noise(t0: number, dur: number, peak: number, filterType: BiquadFilterType, f0: number, f1: number) {
    const ctx = this.ctx!, master = this.master!;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(dur);
    const bp = ctx.createBiquadFilter(); bp.type = filterType;
    bp.frequency.setValueAtTime(f0, t0); bp.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.05, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(master); src.start(t0); src.stop(t0 + dur + 0.02);
  }

  private go(fn: (t: number) => void) {
    if (this.muted) return;
    this.resume(); if (!this.ctx) return;
    fn(this.ctx.currentTime);
  }

  // ---- weather ambience -------------------------------------------------------
  private rainGain: GainNode | null = null;
  /** Continuous rain hiss whose level tracks the weather (0 = off). */
  setRain(level: number) {
    this.resume(); if (!this.ctx || !this.master) return;
    if (!this.rainGain) {
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(2); src.loop = true;
      const bp = this.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1300; bp.Q.value = 0.5;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.master); src.start();
      this.rainGain = g;
    }
    this.rainGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.6); // smooth fade in/out
  }
  /** A low rolling thunder boom (storms). */
  thunder() { this.go((t) => { this.blip("sine", 90, 26, t, 1.3, 0.6); this.noise(t, 1.2, 0.5, "lowpass", 420, 70); }); }

  // ---- operations loops (hum + pour rush) -------------------------------------
  private humGain: GainNode | null = null;
  /** Low mechanical hum while the operation runs. */
  setHum(level: number) {
    this.resume(); if (!this.ctx || !this.master) return;
    if (!this.humGain) {
      const g = this.ctx.createGain(); g.gain.value = 0;
      const lp = this.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 220;
      for (const [type, f] of [["sine", 55], ["sawtooth", 82]] as [OscillatorType, number][]) {
        const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(lp); o.start();
      }
      lp.connect(g).connect(this.master); this.humGain = g;
    }
    this.humGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.9);
  }
  private rushGain: GainNode | null = null;
  /** Slurry rush loop while a pour is running. */
  setPourRush(level: number) {
    this.resume(); if (!this.ctx || !this.master) return;
    if (!this.rushGain) {
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuffer(2); src.loop = true;
      const bp = this.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 520; bp.Q.value = 0.7;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(bp).connect(g).connect(this.master); src.start();
      this.rushGain = g;
    }
    this.rushGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.4);
  }

  // ---- the game's palette -----------------------------------------------------
  build() { this.go((t) => { this.blip("sine", 150, 70, t, 0.16, 0.5); this.noise(t, 0.12, 0.25, "lowpass", 900, 200); }); }
  select() { this.go((t) => this.blip("triangle", 520, 520, t, 0.05, 0.2)); }
  pourStart() { this.go((t) => this.noise(t, 0.7, 0.28, "bandpass", 240, 700)); }      // slurry whoosh rising
  burst() { this.go((t) => { this.blip("sawtooth", 320, 60, t, 0.5, 0.5); this.noise(t, 0.5, 0.4, "highpass", 1200, 300); }); } // alarm + crack
  pass() { this.go((t) => { this.blip("sine", 660, 660, t, 0.12, 0.4); this.blip("sine", 880, 880, t + 0.11, 0.18, 0.4); }); } // rising chime
  fail() { this.go((t) => { this.blip("sine", 440, 330, t, 0.28, 0.35); }); }
  cash() { this.go((t) => { this.blip("square", 1180, 1180, t, 0.05, 0.22); this.blip("square", 1580, 1580, t + 0.06, 0.09, 0.22); }); } // ching
  damRaise() { this.go((t) => { this.noise(t, 0.6, 0.35, "lowpass", 400, 90); this.blip("sine", 90, 60, t, 0.6, 0.4); }); } // rumble
  event() { this.go((t) => { this.blip("triangle", 500, 500, t, 0.14, 0.35); this.blip("triangle", 500, 500, t + 0.2, 0.14, 0.35); }); } // attention ping

  /** Low ambient plant drone (detuned sines + airy noise) — toggle on/off. */
  toggleAmbient(on: boolean) {
    this.resume(); if (!this.ctx || !this.master) return;
    if (on && !this.ambient) {
      const ctx = this.ctx; const g = ctx.createGain(); g.gain.value = 0.06; g.connect(this.master);
      const nodes: AudioNode[] = [];
      for (const f of [55, 55.4, 82.5]) { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; o.connect(g); o.start(); nodes.push(o); }
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(2); src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 220;
      const ng = ctx.createGain(); ng.gain.value = 0.4; src.connect(lp).connect(ng).connect(g); src.start(); nodes.push(src);
      this.ambient = { gain: g, nodes };
    } else if (!on && this.ambient) {
      this.ambient.nodes.forEach((n) => { try { (n as OscillatorNode).stop?.(); } catch { /* already stopped */ } (n as AudioNode).disconnect(); });
      this.ambient.gain.disconnect(); this.ambient = null;
    }
  }
}
