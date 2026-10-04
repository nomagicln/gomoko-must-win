/**
 * 棋盘渲染器：Canvas 2D 手绘。
 *
 * 视觉语言：
 *  · 棋盘 = 宣纸（程序化纸纹 + 淡墨栏线 + 朱砂星位）
 *  · 黑子 = 黑曜石，白子 = 羊脂玉，均有高光、暗部与投影
 *  · 落子、五连、必胜、定式识别都有独立动效
 *  · 移动端支持「放大镜」精确点选（手指不遮挡落点）
 */

import { isStar } from '../core/coords';
import type { Move, Player, Point } from '../core/types';
import { BLACK, WHITE } from '../core/types';

export interface HeatCell {
  x: number;
  y: number;
  /** 归一化 0~1 */
  weight: number;
  kind: 'attack' | 'defense' | 'win';
  /** 该热区属于哪一方（据此着色） */
  side?: Player;
}

export type MarkerKind = 'three' | 'four' | 'open-four' | 'win' | 'block' | 'book' | 'forbidden';

export interface MarkerCell {
  x: number;
  y: number;
  kind: MarkerKind;
  /** 该暗示属于哪一方：黑棋朱砂、白棋青玉 */
  side?: Player;
}

export interface RenderState {
  size: number;
  cells: Int8Array;
  moves: ReadonlyArray<Move>;
  lastMove: Move | null;
  winLine: Point[] | null;
  heat: HeatCell[];
  markers: MarkerCell[];
  /** 定式预览的虚子 */
  ghost: (Point & { player: Player }) | null;
  /** 必胜路线（按顺序编号，用于连珠动画） */
  winPath: Point[] | null;
  showCoords: boolean;
  showNumbers: boolean;
  interactive: boolean;
}

export interface RendererOptions {
  onPlace?: (x: number, y: number) => void;
  onHover?: (p: Point | null) => void;
  reducedMotion?: boolean;
}

const TAU = Math.PI * 2;
const MAX_DPR = 2.5;

interface StoneAnim {
  start: number;
  player: Player;
  fresh: boolean;
}

interface Ripple {
  x: number;
  y: number;
  start: number;
  color: string;
}

export class BoardRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: RendererOptions;

  private state: RenderState;
  private dpr = 1;
  private cssSize = 0;
  private cell = 0;
  private origin = 0;

  private base: HTMLCanvasElement | null = null;
  private baseKey = '';

  private readonly stoneAnims = new Map<number, StoneAnim>();
  private ripples: Ripple[] = [];
  private winAnim: { line: Point[]; start: number } | null = null;
  private pathAnim: { path: Point[]; start: number } | null = null;
  private heatAnimStart = 0;
  private hoverPoint: Point | null = null;
  private magnifier: Point | null = null;

  private raf = 0;
  private dirty = true;
  private reduced = false;
  private ro: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, state: RenderState, opts: RendererOptions = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
    this.canvas = canvas;
    this.ctx = ctx;
    this.state = state;
    this.opts = opts;
    this.reduced =
      opts.reducedMotion ??
      (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this.bindEvents();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
    this.ensureLoop();
  }

  /* ------------------------------------------------------------------ */
  /* 外部接口                                                            */
  /* ------------------------------------------------------------------ */

  setState(patch: Partial<RenderState>): void {
    const prevMoves = this.state.moves.length;
    Object.assign(this.state, patch);
    if (patch.cells && this.state.moves.length > prevMoves) {
      const last = this.state.moves[this.state.moves.length - 1];
      if (last) this.registerStone(last);
    }
    if (patch.heat) this.heatAnimStart = now();
    if (patch.winLine) this.flashWin(patch.winLine);
    if (patch.winPath) this.animatePath(patch.winPath);
    this.dirty = true;
    this.ensureLoop();
  }

  getState(): RenderState {
    return this.state;
  }

  /** 当前几何参数（供外部叠加手数等） */
  get metrics(): { origin: number; cell: number; cssSize: number } {
    return { origin: this.origin, cell: this.cell, cssSize: this.cssSize };
  }

  /** 播放落子动画与涟漪 */
  registerStone(move: Move): void {
    this.stoneAnims.set(move.y * this.state.size + move.x, { start: now(), player: move.player, fresh: true });
    this.ripples.push({
      x: move.x,
      y: move.y,
      start: now(),
      color: 'rgba(222, 226, 230, 0.8)',
    });
  }

  flashWin(line: Point[]): void {
    this.winAnim = { line: [...line], start: now() };
    for (const p of line) this.ripples.push({ x: p.x, y: p.y, start: now() + 200, color: 'rgba(236, 240, 244, 0.85)' });
    this.ensureLoop();
  }

  animatePath(path: Point[]): void {
    this.pathAnim = { path: [...path], start: now() };
    this.ensureLoop();
  }

  setHover(p: Point | null): void {
    if (this.hoverPoint?.x === p?.x && this.hoverPoint?.y === p?.y) return;
    this.hoverPoint = p;
    this.dirty = true;
    this.ensureLoop();
  }

  /** 棋盘坐标 → 画布 CSS 坐标 */
  toCanvas(p: Point): { x: number; y: number } {
    return { x: this.origin + p.x * this.cell, y: this.origin + p.y * this.cell };
  }

  /** 指针位置 → 最近交叉点（超出容差返回 null） */
  hitTest(clientX: number, clientY: number): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    const scale = rect.width / this.cssSize || 1;
    const x = (clientX - rect.left) / scale;
    const y = (clientY - rect.top) / scale;
    const gx = Math.round((x - this.origin) / this.cell);
    const gy = Math.round((y - this.origin) / this.cell);
    if (gx < 0 || gy < 0 || gx >= this.state.size || gy >= this.state.size) return null;
    const snapped = this.toCanvas({ x: gx, y: gy });
    const dist = Math.hypot(snapped.x - x, snapped.y - y);
    if (dist > this.cell * 0.72) return null;
    return { x: gx, y: gy };
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.ro = null;
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  private bindEvents(): void {
    const c = this.canvas;

    c.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const p = this.hitTest(e.clientX, e.clientY);
      this.setHover(this.state.interactive ? p : null);
      this.opts.onHover?.(p);
    });
    c.addEventListener('pointerleave', () => {
      this.setHover(null);
      this.opts.onHover?.(null);
    });
    c.addEventListener('pointerdown', (e) => {
      if (!this.state.interactive) return;
      if (e.pointerType === 'touch') {
        const p = this.hitTest(e.clientX, e.clientY);
        this.magnifier = p;
        this.setHover(p);
        this.dirty = true;
        this.ensureLoop();
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (!this.state.interactive) return;
      const p = this.hitTest(e.clientX, e.clientY);
      this.magnifier = null;
      this.dirty = true;
      if (p) this.opts.onPlace?.(p.x, p.y);
      this.ensureLoop();
    });
    c.addEventListener('pointercancel', () => {
      this.magnifier = null;
      this.dirty = true;
      this.ensureLoop();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ------------------------------------------------------------------ */
  /* 尺寸与底图                                                          */
  /* ------------------------------------------------------------------ */

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssSize = Math.max(160, Math.round(Math.min(rect.width, rect.height || rect.width)));
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (cssSize === this.cssSize && dpr === this.dpr && this.base) return;

    this.cssSize = cssSize;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssSize * dpr);
    this.canvas.height = Math.round(cssSize * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const n = this.state.size;
    const base = cssSize * (this.state.showCoords ? 0.058 : 0.045);
    this.cell = (cssSize - base * 2) / (n - 1);
    this.origin = base;

    this.base = null;
    this.buildBase();
    this.dirty = true;
    this.ensureLoop();
  }

  private buildBase(): void {
    const key = `${this.cssSize}|${this.dpr}|${this.state.size}|${this.state.showCoords}`;
    if (this.baseKey === key && this.base) return;
    this.baseKey = key;

    const size = this.cssSize;
    const off = document.createElement('canvas');
    off.width = Math.round(size * this.dpr);
    off.height = Math.round(size * this.dpr);
    const g = off.getContext('2d');
    if (!g) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // 1) 宣纸底
    const grad = g.createRadialGradient(size * 0.42, size * 0.32, size * 0.05, size * 0.5, size * 0.5, size * 0.78);
    grad.addColorStop(0, '#f4ecd6');
    grad.addColorStop(0.55, '#ece0c4');
    grad.addColorStop(1, '#d9c8a5');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    // 2) 纸纤维噪点
    g.save();
    g.globalAlpha = 0.5;
    const tile = this.noiseTile();
    const pat = g.createPattern(tile, 'repeat');
    if (pat) {
      g.fillStyle = pat;
      g.fillRect(0, 0, size, size);
    }
    g.restore();

    // 3) 四角微微加深（做旧）
    const vg = g.createRadialGradient(size / 2, size / 2, size * 0.34, size / 2, size / 2, size * 0.75);
    vg.addColorStop(0, 'rgba(120,96,58,0)');
    vg.addColorStop(1, 'rgba(112,88,50,0.24)');
    g.fillStyle = vg;
    g.fillRect(0, 0, size, size);

    // 4) 墨线格
    const n = this.state.size;
    const lw = Math.max(1, this.cell * 0.026);
    const inner = this.origin;
    const outer = this.origin + this.cell * (n - 1);
    g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const pos = this.origin + i * this.cell;
      const edge = i === 0 || i === n - 1;
      g.strokeStyle = edge ? 'rgba(38, 42, 47, 0.74)' : 'rgba(48, 53, 59, 0.5)';
      g.lineWidth = edge ? lw * 1.5 : lw;
      g.beginPath();
      g.moveTo(inner, pos);
      g.lineTo(outer, pos);
      g.stroke();
      g.beginPath();
      g.moveTo(pos, inner);
      g.lineTo(pos, outer);
      g.stroke();
    }

    // 5) 星位
    g.fillStyle = 'rgba(38, 42, 47, 0.78)';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!isStar(x, y, n)) continue;
        g.beginPath();
        g.arc(this.origin + x * this.cell, this.origin + y * this.cell, Math.max(1.6, this.cell * 0.075), 0, TAU);
        g.fill();
      }
    }
    // 天元用焦墨点出，作为「眼」
    const c0 = (n - 1) / 2;
    g.fillStyle = 'rgba(24, 27, 31, 0.8)';
    g.beginPath();
    g.arc(this.origin + c0 * this.cell, this.origin + c0 * this.cell, Math.max(2, this.cell * 0.085), 0, TAU);
    g.fill();

    // 6) 坐标
    if (this.state.showCoords) {
      g.font = `500 ${Math.max(8, this.cell * 0.3)}px "IBM Plex Mono", ui-monospace, monospace`;
      g.fillStyle = 'rgba(74,60,42,0.78)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // 列号只画在下侧、行号只画在左侧 —— 避免画面噪杂，也给顶部留出浮层空间
      const bottom = this.origin + this.cell * (n - 1) + this.cell * 0.56;
      for (let i = 0; i < n; i++) {
        const pos = this.origin + i * this.cell;
        g.fillText(String.fromCharCode(65 + i), pos, bottom);
        g.fillText(String(n - i), this.origin - this.cell * 0.56, pos);
      }
    }

    this.base = off;
  }

  private noiseCanvas: HTMLCanvasElement | null = null;

  private noiseTile(): HTMLCanvasElement {
    if (this.noiseCanvas) return this.noiseCanvas;
    const t = document.createElement('canvas');
    const S = 96;
    t.width = S;
    t.height = S;
    const g = t.getContext('2d')!;
    const img = g.createImageData(S, S);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 90;
      img.data[i] = v;
      img.data[i + 1] = v * 0.96;
      img.data[i + 2] = v * 0.86;
      img.data[i + 3] = 16;
    }
    g.putImageData(img, 0, 0);
    // 几缕纤维（随机走向、极淡，避免与棋盘格线混淆）
    g.strokeStyle = 'rgba(150,128,92,0.05)';
    g.lineWidth = 0.8;
    for (let i = 0; i < 10; i++) {
      const x0 = Math.random() * S;
      const y0 = Math.random() * S;
      const ang = Math.random() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo(
        x0 + Math.cos(ang) * S * 0.3 + (Math.random() - 0.5) * 8,
        y0 + Math.sin(ang) * S * 0.3 + (Math.random() - 0.5) * 8,
        x0 + Math.cos(ang) * S * 0.6,
        y0 + Math.sin(ang) * S * 0.6,
      );
      g.stroke();
    }
    this.noiseCanvas = t;
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* 绘制主循环                                                          */
  /* ------------------------------------------------------------------ */

  private ensureLoop(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    this.raf = 0;
    const active = this.hasActiveAnimation();
    if (this.dirty || active) {
      this.draw();
      this.dirty = false;
    }
    this.pruneAnimations();
    if (this.dirty || this.hasActiveAnimation()) this.ensureLoop();
  };

  private hasActiveAnimation(): boolean {
    if (this.ripples.length > 0) return true;
    if (this.winAnim && now() - this.winAnim.start < 2600) return true;
    if (this.pathAnim && now() - this.pathAnim.start < 2400) return true;
    if (this.state.markers.length > 0 || this.state.heat.length > 0) return true;
    if (this.stoneAnims.size > 0) return true;
    if (this.magnifier) return true;
    return false;
  }

  private pruneAnimations(): void {
    const t = now();
    this.ripples = this.ripples.filter((r) => t - r.start < 900);
    for (const [k, a] of this.stoneAnims) {
      if (t - a.start > 700) this.stoneAnims.delete(k);
    }
    if (this.winAnim && t - this.winAnim.start > 3000) this.winAnim = null;
    if (this.pathAnim && t - this.pathAnim.start > 2600) this.pathAnim = null;
  }

  private draw(): void {
    const ctx = this.ctx;
    const s = this.cssSize;
    ctx.clearRect(0, 0, s, s);
    if (this.base) ctx.drawImage(this.base, 0, 0, s, s);
    this.drawHeat(ctx);
    this.drawMarkers(ctx);
    this.drawStones(ctx, true);
    this.drawLastMove(ctx);
    this.drawHover(ctx);
    this.drawWinLine(ctx);
    this.drawWinPath(ctx);
    if (this.magnifier) this.drawMagnifier(ctx);
  }

  /* ------------------------------------------------------------------ */
  /* 图层：热力图 / 标记                                                  */
  /* ------------------------------------------------------------------ */

  private drawHeat(ctx: CanvasRenderingContext2D): void {
    const heat = this.state.heat;
    if (heat.length === 0) return;
    const t = this.reduced ? 1 : Math.min(1, (now() - this.heatAnimStart) / 420);
    const ease = 1 - Math.pow(1 - t, 3);
    ctx.save();
    for (const h of heat) {
      const { x, y } = this.toCanvas(h);
      const r = this.cell * (0.32 + h.weight * 0.54) * (0.62 + 0.38 * ease);
      const rgb = SIDE_RGB[h.side ?? BLACK];
      const color = `${rgb[0]},${rgb[1]},${rgb[2]}`;
      if (h.kind === 'defense') {
        // 对方（白方）势力：空心墨环
        ctx.globalAlpha = (0.3 + h.weight * 0.42) * ease;
        ctx.strokeStyle = `rgba(${color},0.9)`;
        ctx.lineWidth = Math.max(1.4, this.cell * 0.1);
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        continue;
      }
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const strong = h.kind === 'win' ? 1.4 : 1;
      g.addColorStop(0, `rgba(${color},${Math.min(0.42, 0.3 * ease * (0.4 + h.weight * 0.6) * strong)})`);
      g.addColorStop(0.65, `rgba(${color},${0.1 * ease * strong})`);
      g.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMarkers(ctx: CanvasRenderingContext2D): void {
    const markers = this.state.markers;
    if (markers.length === 0) return;
    const phase = this.reduced ? 0 : (now() % 1600) / 1600;
    const pulse = 0.5 + 0.5 * Math.sin(phase * TAU);
    ctx.save();
    for (const m of markers) {
      const { x, y } = this.toCanvas(m);
      const color = markerColor(m.kind, m.side ?? BLACK);
      if (m.kind === 'forbidden') {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.6, this.cell * 0.09);
        const r = this.cell * 0.24;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
        ctx.stroke();
        continue;
      }
      const r = this.cell * (m.kind === 'win' ? 0.44 : 0.34) * (0.92 + 0.08 * pulse);
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.4, this.cell * (m.kind === 'win' ? 0.095 : 0.07));
      ctx.globalAlpha = 0.55 + 0.45 * pulse;
      if (m.kind === 'three' || m.kind === 'block' || sideDashed(m.side ?? BLACK)) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      if (m.kind === 'win') {
        ctx.globalAlpha = 0.42 * pulse;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.35, 0, TAU);
        ctx.lineWidth = Math.max(1, this.cell * 0.05);
        ctx.stroke();
      }
      if (m.kind === 'four' || m.kind === 'open-four' || m.kind === 'win') {
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.8, this.cell * (m.kind === 'win' ? 0.13 : 0.09)), 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
      }
      if (m.kind === 'book') {
        ctx.globalAlpha = 0.5 + 0.3 * pulse;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(x, y, this.cell * 0.46, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* 图层：棋子                                                          */
  /* ------------------------------------------------------------------ */

  private drawStones(ctx: CanvasRenderingContext2D, animate: boolean): void {
    const n = this.state.size;
    const cells = this.state.cells;
    const t = now();
    const r = this.cell * 0.455;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = cells[y * n + x];
        if (v === 0) continue;
        const anim = animate ? this.stoneAnims.get(y * n + x) : undefined;
        let scale = 1;
        let alpha = 1;
        let shadow = 1;
        if (anim && !this.reduced) {
          const p = Math.min(1, (t - anim.start) / 260);
          const eased = 1 - Math.pow(1 - p, 3);
          scale = 1.28 - 0.28 * eased;
          alpha = Math.min(1, p * 2.4);
          shadow = 0.4 + 0.6 * eased;
          if (p < 1) {
            // 轻微回弹
            scale += Math.sin(p * Math.PI) * 0.04;
          }
        }
        const c = this.toCanvas({ x, y });
        this.drawStone(ctx, c.x, c.y, r * scale, v as Player, alpha, shadow);
      }
    }
    // 涟漪
    for (const rp of this.ripples) {
      const p = Math.min(1, (t - rp.start) / 700);
      if (p < 0) continue;
      const c = this.toCanvas(rp);
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.75;
      ctx.strokeStyle = rp.color;
      ctx.lineWidth = Math.max(1, this.cell * 0.05 * (1 - p));
      ctx.beginPath();
      ctx.arc(c.x, c.y, this.cell * (0.34 + p * 0.85), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawStone(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    player: Player,
    alpha = 1,
    shadow = 1,
  ): void {
    ctx.save();
    ctx.globalAlpha = alpha;

    // 投影
    if (shadow > 0.01) {
      ctx.save();
      ctx.globalAlpha = alpha * 0.5 * shadow;
      ctx.fillStyle = 'rgba(40,30,18,0.55)';
      ctx.beginPath();
      ctx.ellipse(x + r * 0.08, y + r * 0.22, r * 0.98, r * 0.86, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.08, x, y, r * 1.1);
    if (player === BLACK) {
      g.addColorStop(0, '#8b857b');
      g.addColorStop(0.16, '#4a453e');
      g.addColorStop(0.5, '#1e1c19');
      g.addColorStop(1, '#070605');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.38, '#f7f1e0');
      g.addColorStop(0.78, '#e2d8bd');
      g.addColorStop(1, '#b8a983');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    // 内阴影 / 内高光
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.clip();
    const rim = ctx.createRadialGradient(x + r * 0.3, y + r * 0.4, r * 0.2, x, y, r);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, player === BLACK ? 'rgba(0,0,0,0.75)' : 'rgba(120,100,66,0.32)');
    ctx.fillStyle = rim;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);

    const spec = ctx.createRadialGradient(x - r * 0.34, y - r * 0.4, 0, x - r * 0.34, y - r * 0.4, r * 0.72);
    spec.addColorStop(0, player === BLACK ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.95)');
    spec.addColorStop(0.5, player === BLACK ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.25)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.restore();

    // 边缘描边
    ctx.strokeStyle = player === BLACK ? 'rgba(0,0,0,0.6)' : 'rgba(140,120,84,0.4)';
    ctx.lineWidth = Math.max(0.6, r * 0.045);
    ctx.beginPath();
    ctx.arc(x, y, r - ctx.lineWidth / 2, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* 图层：标记与提示                                                    */
  /* ------------------------------------------------------------------ */

  private drawLastMove(ctx: CanvasRenderingContext2D): void {
    const last = this.state.lastMove;
    if (!last || this.state.winLine) return;
    // 黑子上用纸白环、白子上用焦墨环：不依赖颜色也能看清
    const onBlack = last.player === BLACK;
    const ring = onBlack ? 'rgba(246, 244, 238, 0.92)' : 'rgba(24, 27, 31, 0.92)';
    const core = onBlack ? 'rgba(255, 255, 255, 0.95)' : 'rgba(10, 11, 13, 0.95)';
    const c = this.toCanvas(last);
    const r = this.cell * 0.455;
    const phase = this.reduced ? 0 : (now() % 1800) / 1800;
    const a = 0.72 + 0.28 * Math.sin(phase * TAU);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = ring;
    ctx.lineWidth = Math.max(1.6, this.cell * 0.075);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * 0.66, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(1.6, this.cell * 0.075), 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  private drawHover(ctx: CanvasRenderingContext2D): void {
    const h = this.hoverPoint;
    if (!h || !this.state.interactive) return;
    if (this.state.cells[h.y * this.state.size + h.x] !== 0) return;
    const c = this.toCanvas(h);
    const r = this.cell * 0.455;
    ctx.save();
    ctx.globalAlpha = 0.34;
    this.drawStone(ctx, c.x, c.y, r, this.state.moves.length % 2 === 0 ? BLACK : WHITE, 0.6, 0);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = 'rgba(226, 230, 234, 0.75)';
    ctx.lineWidth = Math.max(1, this.cell * 0.045);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 胜利笔锋：沿五连方向画一道两端收细、边缘毛糙的毛笔笔触。
   * 先铺一层纸白的托底，再压上焦墨，这样压在黑子上也看得见。
   */
  private drawWinLine(ctx: CanvasRenderingContext2D): void {
    if (!this.winAnim) return;
    const { line, start } = this.winAnim;
    if (line.length < 2) return;
    const t = this.reduced ? 1 : Math.min(1, (now() - start) / 760);
    const eased = 1 - Math.pow(1 - t, 4);
    const a = this.toCanvas(line[0]);
    const b = this.toCanvas(line[line.length - 1]);

    const stroke = (color: string, width: number, grow: number): void => {
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      const ex = a.x + (b.x - a.x) * eased;
      const ey = a.y + (b.y - a.y) * eased;
      const steps = 46;
      const top: Array<[number, number]> = [];
      const bot: Array<[number, number]> = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const px = a.x + (ex - a.x) * u;
        const py = a.y + (ey - a.y) * u;
        // 两端收锋、中段饱满；再用一点确定性抖动做出毛边
        const profile = Math.pow(Math.sin(Math.PI * Math.min(0.999, u * 0.9 + 0.05)), 0.6);
        const j = Math.sin(i * 12.9898) * 43758.5453;
        const noise = (j - Math.floor(j)) - 0.45;
        const w = width * profile * (1 + noise * 0.34) + grow;
        top.push([px + nx * w, py + ny * w]);
        bot.push([px - nx * w, py - ny * w]);
      }
      ctx.beginPath();
      ctx.moveTo(top[0][0], top[0][1]);
      for (let i = 1; i < top.length; i++) ctx.lineTo(top[i][0], top[i][1]);
      for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };

    const half = this.cell * 0.24;
    ctx.save();
    ctx.globalAlpha = 0.92;
    stroke('rgba(249, 247, 241, 0.85)', half * 1.5, this.cell * 0.09); // 纸白托底
    ctx.globalAlpha = 1;
    stroke('rgba(18, 20, 23, 0.95)', half, 0); // 焦墨笔锋
    // 笔锋扫过时的高光，像湿墨未干
    stroke('rgba(120, 126, 132, 0.35)', half * 0.5, 0);
    ctx.restore();
  }

  private drawWinPath(ctx: CanvasRenderingContext2D): void {
    if (!this.pathAnim) return;
    const { path, start } = this.pathAnim;
    if (path.length === 0) return;
    const elapsed = now() - start;
    const per = 260;
    const shown = this.reduced ? path.length : Math.max(1, Math.floor(elapsed / per) + 1);
    ctx.save();
    ctx.strokeStyle = 'rgba(210, 216, 222, 0.6)';
    ctx.setLineDash([5, 6]);
    ctx.lineWidth = Math.max(1.2, this.cell * 0.05);
    ctx.beginPath();
    const first = this.toCanvas(path[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < Math.min(shown, path.length); i++) {
      const c = this.toCanvas(path[i]);
      ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const pulse = this.reduced ? 0.6 : 0.55 + 0.45 * Math.sin((now() / 420) * TAU);
    for (let i = 0; i < Math.min(shown, path.length); i++) {
      const c = this.toCanvas(path[i]);
      const r = this.cell * 0.3;
      ctx.globalAlpha = i === shown - 1 ? pulse : 0.9;
      ctx.fillStyle = i % 2 === 0 ? 'rgba(20,18,15,0.92)' : 'rgba(250,246,235,0.95)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(226, 230, 234, 0.9)';
      ctx.lineWidth = Math.max(1.2, this.cell * 0.05);
      ctx.stroke();
      ctx.fillStyle = i % 2 === 0 ? '#f2e3b6' : '#3a3126';
      ctx.font = `700 ${Math.max(8, this.cell * 0.3)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), c.x, c.y + 0.5);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* 移动端放大镜                                                        */
  /* ------------------------------------------------------------------ */

  private drawMagnifier(ctx: CanvasRenderingContext2D): void {
    const p = this.magnifier;
    if (!p) return;
    const target = this.toCanvas(p);
    const R = this.cell * 1.55;
    const zoom = 1.9;
    // 位置：手指上方，靠近边缘时自动翻转
    let my = target.y - this.cell * 2.5;
    if (my - R < 0) my = target.y + this.cell * 2.5;
    if (my + R > this.cssSize) my = Math.min(this.cssSize - R - 2, Math.max(R + 2, target.y - this.cell * 2.5));
    const mx = Math.min(this.cssSize - R - 2, Math.max(R + 2, target.x));

    ctx.save();
    ctx.beginPath();
    ctx.arc(mx, my, R, 0, TAU);
    ctx.clip();
    ctx.fillStyle = '#eee3c9';
    ctx.fillRect(mx - R, my - R, R * 2, R * 2);
    ctx.translate(mx, my);
    ctx.scale(zoom, zoom);
    ctx.translate(-target.x, -target.y);
    if (this.base) ctx.drawImage(this.base, 0, 0, this.cssSize, this.cssSize);
    this.drawStones(ctx, false);
    this.drawHover(ctx);
    ctx.restore();

    // 指示十字与圆环
    ctx.save();
    ctx.strokeStyle = 'rgba(232, 236, 240, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, R, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(18, 20, 23, 0.9)';
    ctx.lineWidth = Math.max(1, this.cell * 0.05);
    ctx.beginPath();
    ctx.arc(mx, my, this.cell * 0.44, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 阵营语义色：
 *   黑棋 = 朱砂（暖红）　白棋 = 青玉（冷绿）
 * 威胁等级则交给「形状 + 明度」表达：
 *   成五 / 必胜 → 实心粗环 + 内核
 *   冲四       → 实心环 + 内核
 *   活三       → 细虚线环
 * 定式谱着与禁手保持独立语义（金 / 朱砂叉）。
 */
export const SIDE_RGB: Record<Player, readonly [number, number, number]> = {
  /* 黑方 = 焦墨（实环），白方 = 淡墨（虚环）—— 明度与线型双重区分，不依赖颜色 */
  [BLACK]: [38, 42, 47],
  [WHITE]: [138, 144, 150],
};

export function sideColor(side: Player, alpha = 0.92): string {
  const [r, g, b] = SIDE_RGB[side];
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 白方的落位提示统一走虚环，避免与黑方混淆 */
const sideDashed = (side: Player): boolean => side === WHITE;

function markerColor(kind: MarkerKind, side: Player): string {
  switch (kind) {
    case 'win':
      return sideColor(side, 1);
    case 'open-four':
    case 'four':
      return sideColor(side, 0.9);
    case 'three':
    case 'block':
      return sideColor(side, 0.78);
    case 'book':
      return 'rgba(230,205,144,0.85)';
    case 'forbidden':
      return 'rgba(207,74,51,0.95)';
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 生成一个自娱自乐的演示棋局（首页动态棋盘使用） */
export function demoSequence(size = 15): Point[] {
  const c = (size - 1) >> 1;
  return [
    { x: c, y: c },
    { x: c + 1, y: c + 1 },
    { x: c - 1, y: c },
    { x: c, y: c - 1 },
    { x: c + 1, y: c - 1 },
    { x: c - 2, y: c + 1 },
    { x: c + 2, y: c },
    { x: c - 1, y: c - 1 },
    { x: c, y: c + 2 },
    { x: c + 1, y: c + 2 },
    { x: c - 2, y: c - 2 },
    { x: c + 2, y: c - 2 },
    { x: c - 3, y: c + 1 },
    { x: c + 3, y: c + 1 },
    { x: c - 1, y: c + 3 },
    { x: c + 2, y: c + 3 },
    { x: c - 2, y: c + 4 },
    { x: c + 3, y: c + 4 },
  ].filter((p) => p.x >= 0 && p.y >= 0 && p.x < size && p.y < size);
}

export { BLACK, WHITE };
