/**
 * 棋钟：记录黑白双方用时，可选限时判负。
 *
 * · 只计时模式：累计双方用时，不判超时（默认，适合休闲）
 * · 限时模式：每方基础时间 + 每手加秒（Fischer 加秒），归零判负
 *
 * 计时基于时间戳而非 tick 计数，因此浏览器后台节流也不会走偏。
 */

import { BLACK, WHITE, type Player } from '../core/types';

export type ClockMode = 'none' | '5+5' | '15+5' | '30+10';

export interface ClockConfig {
  baseMs: number;
  incrementMs: number;
  /** 是否会在归零时判负 */
  limited: boolean;
}

export interface ClockState {
  /** 双方累计用时（毫秒） */
  used: { black: number; white: number };
  /** 限时模式下的剩余时间；只计时模式为 null */
  remaining: { black: number; white: number } | null;
  /** 当前正在计时的一方；暂停时为 null */
  active: Player | null;
}

export const CLOCK_PRESETS: ReadonlyArray<{ id: ClockMode; label: string; desc: string }> = [
  { id: 'none', label: '只计时', desc: '记录双方用时，不判超时' },
  { id: '5+5', label: '5 分 + 5 秒', desc: '每方 5 分钟，每落一子加 5 秒' },
  { id: '15+5', label: '15 分 + 5 秒', desc: '每方 15 分钟，每落一子加 5 秒' },
  { id: '30+10', label: '30 分 + 10 秒', desc: '每方 30 分钟，每落一子加 10 秒' },
];

export function clockConfigOf(mode: ClockMode): ClockConfig {
  switch (mode) {
    case '5+5':
      return { baseMs: 5 * 60_000, incrementMs: 5_000, limited: true };
    case '15+5':
      return { baseMs: 15 * 60_000, incrementMs: 5_000, limited: true };
    case '30+10':
      return { baseMs: 30 * 60_000, incrementMs: 10_000, limited: true };
    default:
      return { baseMs: 0, incrementMs: 0, limited: false };
  }
}

export const clockModeLabel = (mode: ClockMode): string =>
  CLOCK_PRESETS.find((p) => p.id === mode)?.label ?? '只计时';

/**
 * 用 Date.now() 而非 performance.now()：
 * 棋钟只需要毫秒精度，且 Date.now 可被测试框架的假时钟接管，便于单元测试。
 */
const now = (): number => Date.now();

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class Clock {
  private config: ClockConfig;
  private usedMs = { [BLACK]: 0, [WHITE]: 0 } as Record<Player, number>;
  private budgetMs = { [BLACK]: 0, [WHITE]: 0 } as Record<Player, number>;
  private active: Player | null = null;
  private since = 0;
  private handle: ReturnType<typeof setInterval> | null = null;
  private listener: ((state: ClockState) => void) | null = null;
  private onTimeout: ((color: Player) => void) | null = null;
  private stopped = false;

  constructor(config: ClockConfig) {
    this.config = config;
    this.budgetMs[BLACK] = config.baseMs;
    this.budgetMs[WHITE] = config.baseMs;
  }

  get limited(): boolean {
    return this.config.limited;
  }

  onChange(listener: (state: ClockState) => void, onTimeout?: (color: Player) => void): void {
    this.listener = listener;
    this.onTimeout = onTimeout ?? null;
    this.emit();
  }

  reset(config = this.config): void {
    this.config = config;
    this.usedMs[BLACK] = 0;
    this.usedMs[WHITE] = 0;
    this.budgetMs[BLACK] = config.baseMs;
    this.budgetMs[WHITE] = config.baseMs;
    this.active = null;
    this.since = 0;
    this.stopped = false;
    this.stopTicker();
    this.emit();
  }

  /** 切换到某方行棋；传 null 表示暂停（例如对局结束、等待对手落座） */
  switchTo(color: Player | null): void {
    this.settle();
    this.active = this.stopped ? null : color;
    this.since = now();
    if (this.active) this.startTicker();
    else this.stopTicker();
    this.emit();
  }

  /** 当前方落子：结算用时并发放加秒 */
  commit(): void {
    const mover = this.active;
    this.settle();
    if (mover) {
      this.budgetMs[mover] += this.config.incrementMs;
      this.checkTimeout();
    }
    this.emit();
  }

  /** 联机时对手把它的用时同步过来 */
  addExternal(color: Player, ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.usedMs[color] += ms;
    if (ms > 0) this.budgetMs[color] += this.config.incrementMs;
    this.emit();
  }

  /** 本手已用时间（联机时随落子发出） */
  currentMoveMs(): number {
    if (!this.active) return 0;
    return now() - this.since;
  }

  stop(): void {
    this.settle();
    this.active = null;
    this.stopped = true;
    this.stopTicker();
    this.emit();
  }

  dispose(): void {
    this.stopTicker();
    this.listener = null;
    this.onTimeout = null;
  }

  get state(): ClockState {
    return this.snapshot();
  }

  /* ---------------- 内部 ---------------- */

  private settle(): void {
    if (!this.active) return;
    const t = now();
    this.usedMs[this.active] += Math.max(0, t - this.since);
    this.since = t;
  }

  private snapshot(): ClockState {
    const live = this.active ? this.usedMs[this.active] + Math.max(0, now() - this.since) : null;
    const used = {
      black: this.usedMs[BLACK] + (this.active === BLACK && live !== null ? live - this.usedMs[BLACK] : 0),
      white: this.usedMs[WHITE] + (this.active === WHITE && live !== null ? live - this.usedMs[WHITE] : 0),
    };
    return {
      used,
      remaining: this.config.limited
        ? {
            black: Math.max(0, this.budgetMs[BLACK] - used.black),
            white: Math.max(0, this.budgetMs[WHITE] - used.white),
          }
        : null,
      active: this.active,
    };
  }

  private emit(): void {
    this.listener?.(this.snapshot());
  }

  private startTicker(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      if (this.checkTimeout()) return;
      this.emit();
    }, 200);
  }

  private stopTicker(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }

  private checkTimeout(): boolean {
    if (!this.config.limited || !this.active || this.stopped) return false;
    const state = this.snapshot();
    const left = this.active === BLACK ? state.remaining!.black : state.remaining!.white;
    if (left > 0) return false;
    const loser = this.active;
    this.active = null;
    this.stopped = true;
    this.stopTicker();
    this.emit();
    this.onTimeout?.(loser);
    return true;
  }
}
