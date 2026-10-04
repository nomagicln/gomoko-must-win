import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BLACK, WHITE } from '../src/core/types';
import { Clock, clockConfigOf, clockModeLabel, formatClock } from '../src/ui/clock';

describe('棋钟', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('格式化输出为 mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(-5)).toBe('00:00');
  });

  it('四种模式的换算正确', () => {
    expect(clockConfigOf('none')).toMatchObject({ limited: false });
    expect(clockConfigOf('5+5')).toMatchObject({ baseMs: 300_000, incrementMs: 5_000, limited: true });
    expect(clockConfigOf('30+10')).toMatchObject({ baseMs: 1_800_000, incrementMs: 10_000, limited: true });
    expect(clockModeLabel('15+5')).toContain('15');
  });

  it('只计时：累计双方用时，不判超时', () => {
    const clock = new Clock(clockConfigOf('none'));
    const states: number[] = [];
    clock.onChange(() => undefined);
    clock.switchTo(BLACK);
    vi.advanceTimersByTime(2000);
    clock.commit();
    states.push(clock.state.used.black);
    expect(clock.state.used.black).toBeGreaterThanOrEqual(2000);
    expect(clock.state.remaining).toBeNull();

    clock.switchTo(WHITE);
    vi.advanceTimersByTime(3000);
    clock.commit();
    expect(clock.state.used.white).toBeGreaterThanOrEqual(3000);
    expect(states.length).toBe(1);
  });

  it('限时：扣减时间并发放加秒', () => {
    const clock = new Clock(clockConfigOf('5+5'));
    clock.switchTo(BLACK);
    vi.advanceTimersByTime(10_000);
    clock.commit(); // 用掉 10s，再补 5s
    const remaining = clock.state.remaining!;
    // 300s 基础 - 10s 用时 + 5s 加秒 = 295s
    expect(remaining.black).toBe(295_000);
    expect(remaining.white).toBe(300_000);
  });

  it('限时：归零触发超时回调且只触发一次', () => {
    const clock = new Clock({ baseMs: 1000, incrementMs: 0, limited: true });
    const onTimeout = vi.fn();
    clock.onChange(() => undefined, onTimeout);
    clock.switchTo(BLACK);
    vi.advanceTimersByTime(1500);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(BLACK);
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it('切换行棋方时暂停上一方', () => {
    const clock = new Clock(clockConfigOf('none'));
    clock.switchTo(BLACK);
    vi.advanceTimersByTime(1000);
    clock.switchTo(WHITE);
    const afterSwitch = clock.state.used.black;
    vi.advanceTimersByTime(5000);
    expect(clock.state.used.black).toBe(afterSwitch);
    expect(clock.state.used.white).toBeGreaterThanOrEqual(5000);
    clock.stop();
    clock.dispose();
  });

  it('对手用时可以同步进来', () => {
    const clock = new Clock(clockConfigOf('none'));
    clock.addExternal(WHITE, 4200);
    expect(clock.state.used.white).toBe(4200);
  });
});
