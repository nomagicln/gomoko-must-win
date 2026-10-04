// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inkDiceCube, rollInkDice } from '../src/ui/dice';

afterEach(() => vi.restoreAllMocks());
describe('水墨骰子', () => {
  it('转动六面骰子后落定到抽中的点数', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    const scene = inkDiceCube(), cube = scene.querySelector<HTMLElement>('.dice-cube')!;
    const spin = vi.fn(() => ({ finished: Promise.resolve() }));
    const bounce = vi.fn(() => ({ finished: Promise.resolve() }));
    Object.defineProperty(cube, 'animate', { value: spin });
    Object.defineProperty(scene, 'animate', { value: bounce });
    expect(cube.querySelectorAll('.dice-face')).toHaveLength(6);
    await rollInkDice(scene, 3);
    expect(cube.dataset.face).toBe('3');
    expect(cube.style.transform).toBe('rotateX(0deg) rotateY(-90deg)');
    expect(spin).toHaveBeenCalledWith([
      { transform: 'rotateX(0deg) rotateY(0deg)' },
      { transform: 'rotateX(720deg) rotateY(630deg)' },
    ], expect.objectContaining({ duration: 640 }));
    expect(bounce).toHaveBeenCalledTimes(1);
    await rollInkDice(scene, 1);
    expect(spin).toHaveBeenNthCalledWith(2, [
      { transform: 'rotateX(0deg) rotateY(-90deg)' },
      { transform: 'rotateX(810deg) rotateY(720deg)' },
    ], expect.objectContaining({ duration: 640 }));
  });
  it('减少动态模式直接呈现点数，不播放转动', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const scene = inkDiceCube(), cube = scene.querySelector<HTMLElement>('.dice-cube')!;
    const spin = vi.fn(); Object.defineProperty(cube, 'animate', { value: spin });
    await rollInkDice(scene, 6);
    expect(cube.dataset.face).toBe('6'); expect(spin).not.toHaveBeenCalled();
  });
});
