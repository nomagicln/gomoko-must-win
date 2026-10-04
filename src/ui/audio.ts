/**
 * 音效引擎：全部用 WebAudio 现场合成，不依赖任何音频文件。
 * 落子为「木石相击」，印章为「闷响」，获胜为「古琴五声音阶」。
 */

export type SoundName =
  | 'place-black'
  | 'place-white'
  | 'undo'
  | 'win'
  | 'seal'
  | 'threat'
  | 'tick'
  | 'click'
  /** 毛笔泼墨：笔锋扫过 + 落纸闷响 */
  | 'brush'
  /** 败北：低沉的两声磬响 */
  | 'loss';

const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  /** 必须由用户手势触发一次，才能解锁音频上下文 */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
        this.noiseBuffer = this.createNoise(this.ctx);
      } catch {
        this.ctx = null;
      }
    }
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private createNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      data[i] = last * 3.2;
    }
    return buf;
  }

  private get ready(): boolean {
    return this.enabled && this.ctx !== null && this.master !== null;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** 噪声脉冲（落子、印章的「击」感） */
  private burst(at: number, freq: number, q: number, gain: number, dur: number): void {
    if (!this.ctx || !this.master || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  /** 有音高的拨弦（古琴质感） */
  private pluck(at: number, freq: number, gain: number, dur: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = freq * 2.01;
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.28;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq * 8, at);
    lp.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 1.6), at + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(lp);
    osc2.connect(g2).connect(lp);
    lp.connect(g).connect(this.master);
    osc.start(at);
    osc2.start(at);
    osc.stop(at + dur + 0.05);
    osc2.stop(at + dur + 0.05);
  }

  play(name: SoundName): void {
    if (!this.ready) return;
    const t = this.now() + 0.001;
    switch (name) {
      case 'place-black':
        this.burst(t, 1750, 1.1, 0.5, 0.09);
        this.pluck(t, 196, 0.16, 0.13);
        break;
      case 'place-white':
        this.burst(t, 2350, 1.3, 0.42, 0.07);
        this.pluck(t, 262, 0.14, 0.11);
        break;
      case 'undo':
        this.burst(t, 900, 0.8, 0.24, 0.12);
        break;
      case 'seal':
        this.burst(t, 320, 0.6, 0.6, 0.2);
        this.pluck(t, 98, 0.3, 0.35);
        this.burst(t + 0.05, 1200, 0.9, 0.18, 0.16);
        break;
      case 'threat':
        this.pluck(t, 392, 0.14, 0.3);
        this.pluck(t + 0.07, 523.25, 0.12, 0.32);
        break;
      case 'win':
        PENTATONIC.slice(0, 6).forEach((f, i) => {
          this.pluck(t + i * 0.085, f, 0.2 - i * 0.02, 1.1);
        });
        break;
      case 'tick':
        this.burst(t, 3200, 2.4, 0.12, 0.03);
        break;
      case 'click':
        this.burst(t, 1500, 1.6, 0.16, 0.04);
        break;
      case 'loss':
        this.pluck(t, 196, 0.26, 1.4);
        this.pluck(t + 0.26, 146.83, 0.22, 1.8);
        this.burst(t, 420, 0.6, 0.16, 0.5);
        break;
      case 'brush': {
        // 带通噪声由高频扫到低频 —— 笔锋划过纸面的沙沙声
        if (!this.ctx || !this.master || !this.noiseBuffer) break;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.05;
        bp.frequency.setValueAtTime(3600, t);
        bp.frequency.exponentialRampToValueAtTime(380, t + 0.34);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.34, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
        src.connect(bp).connect(g).connect(this.master);
        src.start(t);
        src.stop(t + 0.5);
        this.burst(t + 0.26, 220, 0.7, 0.5, 0.26);
        this.pluck(t + 0.26, 84, 0.32, 0.6);
        break;
      }
    }
  }
}

export const sound = new SoundEngine();
