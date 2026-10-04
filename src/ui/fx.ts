/**
 * 全屏特效：墨晕、朱砂印章、定式横幅、泼墨杀字、承让 / 败北。
 *
 * 「泼墨」不是贴图，而是每次现画的：以种子随机数生成不规则墨团与飞溅墨点，
 * 逐帧向外扩散，因此每一局的杀字飞溅都不一样。
 */

import { el } from './dom';
import { sound } from './audio';

let layer: HTMLElement | null = null;

export function fxLayer(): HTMLElement {
  if (!layer || !layer.isConnected) {
    layer = el('div', { class: 'fx-layer', 'aria-hidden': 'true' });
    document.body.appendChild(layer);
  }
  return layer;
}

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* 泼墨绘制                                                            */
/* ------------------------------------------------------------------ */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 185, g: 58, b: 43 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SplashCluster {
  /** 相对视口的中心 0~1 */
  x: number;
  y: number;
  /** 相对短边的扩散半径 */
  scale: number;
  /** 墨点数量倍率 */
  density?: number;
  /** 墨团方向（弧度），用于生成拉长的笔触 */
  angle?: number;
}

interface SplashOptions {
  color: string;
  clusters: SplashCluster[];
  /** 0~1 */
  progress: number;
  seed: number;
}

/** 在 2D 画布上绘制一帧泼墨（画布按半分辨率渲染，天然带一点柔边） */
function paintSplash(canvas: HTMLCanvasElement, opts: SplashOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const scale = 0.5;
  const pw = Math.max(2, Math.round(w * scale));
  const ph = Math.max(2, Math.round(h * scale));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const p = Math.min(1, Math.max(0, opts.progress));
  const ease = 1 - Math.pow(1 - p, 3);
  const rng = mulberry32(opts.seed);
  const rgb = hexToRgb(opts.color);
  const paint = (alpha: number): string =>
    `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  const base = Math.min(w, h);

  for (const cluster of opts.clusters) {
    const cx = w * cluster.x;
    const cy = h * cluster.y;
    const spread = base * cluster.scale;
    const dir = cluster.angle ?? 0;

    // 1) 主墨团：三层由大到小叠加，形成边缘晕开的湿墨感
    for (let k = 0; k < 3; k++) {
      const ox = (rng() - 0.5) * spread * (0.5 - k * 0.12);
      const oy = (rng() - 0.5) * spread * (0.4 - k * 0.1);
      const R = spread * (0.24 + rng() * 0.16) * (0.55 + 0.45 * k * 0.5) * ease;
      const pts = 30;
      const radii: number[] = [];
      for (let i = 0; i < pts; i++) radii.push(0.66 + rng() * 0.46);
      ctx.beginPath();
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2 + dir;
        const rr = radii[i % pts] * R;
        const x = cx + ox + Math.cos(a) * rr * 1.12;
        const y = cy + oy + Math.sin(a) * rr * 0.94;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = paint((0.34 - k * 0.08) * ease);
      ctx.fill();
    }

    // 2) 飞溅墨点：越远越小、越淡，并沿径向拉长
    const drops = Math.round((80 + rng() * 45) * (cluster.density ?? 1) * cluster.scale * 2.1);
    for (let i = 0; i < drops; i++) {
      const a = rng() * Math.PI * 2;
      const d = spread * (0.05 + Math.pow(rng(), 0.62) * 1.02) * ease;
      const size = spread * (0.004 + Math.pow(rng(), 3.1) * 0.05) * (0.5 + 0.6 * ease);
      const x = cx + Math.cos(a) * d;
      const y = cy + Math.sin(a) * d;
      const alpha = 0.9 * Math.max(0, 1 - d / (spread * 1.02)) ** 1.35 * ease;
      if (alpha <= 0.01) continue;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.ellipse(0, 0, size * (1 + rng() * 1.7), size * 0.78, 0, 0, Math.PI * 2);
      ctx.fillStyle = paint(alpha);
      ctx.fill();
      ctx.restore();
    }

    // 3) 放射笔触：几道甩出去的墨线
    const streaks = 5 + Math.floor(rng() * 5);
    for (let i = 0; i < streaks; i++) {
      const a = rng() * Math.PI * 2;
      const len = spread * (0.45 + rng() * 0.7) * ease;
      const wid = spread * (0.004 + rng() * 0.014) * (0.6 + 0.5 * ease);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * spread * 0.12, cy + Math.sin(a) * spread * 0.1);
      ctx.quadraticCurveTo(
        cx + Math.cos(a + 0.24) * len * 0.55,
        cy + Math.sin(a + 0.24) * len * 0.55,
        cx + Math.cos(a) * len,
        cy + Math.sin(a) * len,
      );
      ctx.strokeStyle = paint(0.38 * ease);
      ctx.lineWidth = wid;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
}

function runSplash(canvas: HTMLCanvasElement, options: Omit<SplashOptions, 'progress'>, duration: number, delay = 0): void {
  if (reducedMotion()) {
    paintSplash(canvas, { ...options, progress: 1 });
    return;
  }
  const start = performance.now() + delay;
  const step = (): void => {
    if (!canvas.isConnected) return;
    const p = (performance.now() - start) / duration;
    if (p < 0) {
      requestAnimationFrame(step);
      return;
    }
    paintSplash(canvas, { ...options, progress: Math.min(1, p) });
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 全屏轻微震屏（配合泼墨的冲击感） */
function shake(strength = 1): void {
  if (reducedMotion()) return;
  const body = document.body;
  body.style.setProperty('--shake', String(strength));
  body.classList.remove('ink-shake');
  void body.offsetWidth;
  body.classList.add('ink-shake');
  window.setTimeout(() => body.classList.remove('ink-shake'), 460);
}

/* ------------------------------------------------------------------ */
/* 常用特效                                                            */
/* ------------------------------------------------------------------ */

/** 墨晕：从指定位置（默认屏幕中心）荡开一圈颜色 */
export function inkBloom(opts: { x?: number; y?: number; color?: string; scale?: number } = {}): void {
  const host = fxLayer();
  const node = el('div', { class: 'fx-bloom' });
  node.style.left = `${opts.x ?? window.innerWidth / 2}px`;
  node.style.top = `${opts.y ?? window.innerHeight / 2}px`;
  if (opts.color) node.style.setProperty('--bloom-color', opts.color);
  if (opts.scale) node.style.width = node.style.height = `${opts.scale}px`;
  host.appendChild(node);
  window.setTimeout(() => node.remove(), 1200);
}

/** 朱砂印章：如「五连」「禁手」 */
export function sealStamp(text: string, sub?: string, ms = 1600): void {
  const host = fxLayer();
  const node = el(
    'div',
    { class: 'fx-seal' },
    el('div', { class: 'fx-seal__frame' }),
    el('div', { class: 'fx-seal__text', text }),
  );
  if (sub) node.appendChild(el('div', { class: 'fx-seal__sub', text: sub }));
  host.appendChild(node);
  window.setTimeout(() => node.remove(), ms);
}

/** 定式识别横幅 */
export function openingBanner(opts: { seal: string; title: string; sub: string }): void {
  const host = fxLayer();
  const node = el(
    'div',
    { class: 'fx-banner', role: 'status' },
    el('div', { class: 'fx-banner__seal', text: opts.seal }),
    el(
      'div',
      { class: 'fx-banner__text' },
      el('div', { class: 'fx-banner__title', text: opts.title }),
      el('div', { class: 'fx-banner__sub', text: opts.sub }),
    ),
  );
  host.appendChild(node);
  window.setTimeout(() => node.remove(), 3800);
}

let slashNode: HTMLElement | null = null;

/**
 * 泼墨大字：一笔写就 + 四散飞溅。用于「杀」与「承让 / 败北」。
 * @param char 要写的字
 * @param sub  右下小注
 * @param opts 位置 / 尺寸 / 颜色
 */
export function inkGlyph(
  char: string,
  sub?: string,
  opts: {
    color?: string;
    size?: 'slash' | 'victory' | 'second';
    x?: number;
    y?: number;
    spread?: number;
    angle?: number;
    delay?: number;
    /** 是否替换上一个「杀」字 */
    replace?: boolean;
    holdMs?: number;
  } = {},
): HTMLElement {
  const host = fxLayer();
  if (opts.replace && slashNode?.isConnected) slashNode.remove();

  const size = opts.size ?? 'slash';
  const color = opts.color ?? '#b93a2b';
  const node = el('div', { class: `fx-glyph fx-glyph--${size}` });
  node.style.setProperty('--glyph-color', color);
  node.style.setProperty('--glyph-x', `${(opts.x ?? 0.5) * 100}%`);
  node.style.setProperty('--glyph-y', `${(opts.y ?? 0.42) * 100}%`);
  if (opts.angle) node.style.setProperty('--glyph-angle', `${opts.angle}deg`);
  if (opts.delay) node.style.setProperty('--glyph-delay', `${opts.delay}ms`);

  const canvas = el('canvas', { class: 'fx-glyph__ink' });
  const glyph = el('div', { class: 'fx-glyph__char', text: char });
  const bleed = el('div', { class: 'fx-glyph__char fx-glyph__char--bleed', text: char });
  const stage = el(
    'div',
    { class: 'fx-glyph__stage' },
    el('div', { class: 'fx-glyph__wrap' }, bleed, glyph),
    sub ? el('div', { class: 'fx-glyph__sub', text: sub }) : null,
  );
  node.append(canvas, stage);
  host.appendChild(node);

  const delay = opts.delay ?? 0;
  const cx = opts.x ?? 0.5;
  const cy = opts.y ?? 0.42;
  runSplash(
    canvas,
    {
      color,
      seed: Math.floor(Math.random() * 1e9),
      clusters: [
        { x: cx, y: cy, scale: opts.spread ?? (size === 'second' ? 0.2 : 0.32), density: size === 'second' ? 0.65 : 1 },
      ],
    },
    620,
    delay,
  );
  window.setTimeout(() => node.remove(), opts.holdMs ?? (size === 'victory' ? 3200 : 2200));
  return node;
}

/** 杀局：泼墨红「杀」 */
export function killSlash(label: string, opts: { who?: string } = {}): void {
  sound.play('brush');
  shake(1);
  inkBloom({ x: window.innerWidth / 2, y: window.innerHeight * 0.42, color: 'rgba(185,58,43,0.34)' });
  const sub = [opts.who, label].filter(Boolean).join(' · ');
  slashNode = inkGlyph('杀', sub, { color: '#c0392b', size: 'slash', x: 0.5, y: 0.42, angle: -7, replace: true });
  window.setTimeout(() => sound.play('seal'), 240);
}

/** 胜利：泼墨「承让」+ 角落「败北」 */
export function victorySplash(opts: { winner: string; loser: string; humanWon: boolean }): void {
  sound.play('brush');
  shake(1.4);
  inkBloom({ color: 'rgba(200,169,81,0.32)' });
  inkGlyph('承让', `${opts.winner} 五连`, {
    color: '#b93a2b',
    size: 'victory',
    x: 0.5,
    y: 0.31,
    spread: 0.3,
    angle: -5,
    delay: 260,
  });
  window.setTimeout(() => {
    sound.play('brush');
    inkGlyph('败北', opts.loser, {
      color: '#5a4c3a',
      size: 'second',
      x: 0.5,
      y: 0.74,
      spread: 0.17,
      angle: 6,
      holdMs: 3000,
    });
  }, 620);
  window.setTimeout(() => sound.play('win'), 700);
}

/** 兼容旧调用：形成杀局 */
export function forcedWinFX(label: string, who?: string): void {
  killSlash(label, { who });
}

/** 兼容旧调用：胜利 */
export function victoryFX(opts: { winner: string; loser: string; humanWon: boolean }): void {
  victorySplash(opts);
}

/** 禁手提示（轻微，不打断操作） */
export function forbiddenFX(): void {
  sound.play('undo');
  inkBloom({ color: 'rgba(185,58,43,0.28)' });
}
