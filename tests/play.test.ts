// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app';
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, detect: vi.fn(), think: vi.fn() }));
vi.mock('../src/ui/renderer', () => ({ BoardRenderer: class {
  constructor(_canvas: unknown, state: Record<string, unknown>) { Object.assign(mocks.state, state); }
  setState(state: Record<string, unknown>) { Object.assign(mocks.state, state); }
  registerStone() {}
  destroy() {}
} }));
vi.mock('../src/ai/engine', async importOriginal => ({
  ...await importOriginal<typeof import('../src/ai/engine')>(),
  AIClient: class { detect = mocks.detect; think = mocks.think; cancel() {} dispose() {} },
}));
vi.mock('../src/ui/audio', () => ({ sound: { play: vi.fn(), unlock: vi.fn() } }));
vi.mock('../src/ui/fx', () => ({ clearEffects: vi.fn(), killSlash: vi.fn(), openingBanner: vi.fn(), victoryFX: vi.fn() }));
import { GameController } from '../src/ui/controller';
import { PlayView } from '../src/views/play';
let view: PlayView, ctx: AppContext;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.state = {}; mocks.detect.mockResolvedValue(null);
  ctx = { prefs: { size: 15, rules: 'freestyle', clock: 'none', difficulty: 'easy', humanColor: 1, hints: true, showCoords: true, showNumbers: false },
    savePrefs: vi.fn(), recordResult: vi.fn() } as unknown as AppContext;
});
afterEach(() => { view?.destroy(); vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });
const mount = () => { view = new PlayView(ctx, { mode: 'local' }); const root = view.mount(); document.body.append(root); return root; };
const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent === label)!;

describe('对局重开与落子提示', () => {
  it('败北后确认重开关闭弹窗、清空棋谱并重新允许落子', () => {
    const root = mount(); view.game!.play(7, 7); view.forceResign(1);
    expect(view.game!.isOver).toBe(true);
    button(root, '重开').click(); button(document, '重新开局').click();
    expect(document.querySelector('.modal')).toBeNull();
    expect(view.game!.isOver).toBe(false); expect(view.game!.board.moveCount).toBe(0);
    expect(mocks.state.interactive).toBe(true); expect(view.game!.play(7, 7)).toBe(true);
  });
  it('关闭提示立即隐藏战术落点和下一手谱着；重新开启无需再落子', () => {
    const root = mount();
    view.game!.applySequence([{ x: 7, y: 7 }, { x: 7, y: 6 }, { x: 6, y: 8 }, { x: 7, y: 8 }, { x: 5, y: 8 }]);
    const visible = [...mocks.state.markers as unknown[]];
    expect(visible.length).toBeGreaterThan(0);
    const toggle = root.querySelector<HTMLInputElement>('[aria-label="落子提示"]')!;
    toggle.checked = false; toggle.dispatchEvent(new Event('change'));
    expect(ctx.prefs.hints).toBe(false); expect(ctx.savePrefs).toHaveBeenCalled();
    expect(mocks.state.markers).toEqual([]); expect(mocks.state.ghost).toBeNull(); expect(mocks.state.winPath).toBeNull();
    expect(root.querySelector('.note-list')?.textContent).toContain('已关闭');
    toggle.checked = true; toggle.dispatchEvent(new Event('change'));
    expect(mocks.state.markers).toEqual(visible); expect(root.querySelector('.note-list')?.textContent).not.toContain('已关闭');
  });
  it('用户关闭后下一局保持关闭', () => {
    ctx.prefs.hints = false; const root = mount();
    expect(root.querySelector<HTMLInputElement>('[aria-label="落子提示"]')!.checked).toBe(false);
    view.game!.play(7, 7); button(root, '重开').click(); button(document, '重新开局').click();
    expect(ctx.prefs.hints).toBe(false); expect(mocks.state.ghost).toBeNull();
  });
});

it('重开时废弃上一局的 AI 结果，新一局照常思考', async () => {
  let resolveOld!: (result: unknown) => void;
  mocks.think.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  mocks.think.mockResolvedValue({ move: { x: 7, y: 7 }, candidates: [], score: 0 });
  const c = new GameController({ size: 15, rules: 'freestyle', clockMode: 'none', difficulty: 'easy', black: 'ai', white: 'human', humanColor: 2 });
  c.start(); expect(c.isThinking).toBe(true); c.start();
  await Promise.resolve(); expect(c.board.moveCount).toBe(1);
  resolveOld({ move: { x: 0, y: 0 }, candidates: [], score: 0 }); await Promise.resolve();
  expect(c.board.moveCount).toBe(1); expect(c.board.lastMove).toMatchObject({ x: 7, y: 7 }); c.dispose();
});

it('AI 落子优先于动画侦测，分析面板复用同一轮搜索', async () => {
  mocks.think.mockImplementation(() => new Promise(() => {}));
  const c = new GameController({ size: 15, rules: 'freestyle', clockMode: 'none', difficulty: 'master', black: 'human', white: 'ai', humanColor: 1 });
  c.start();
  c.applySequence([{ x: 7, y: 7 }, { x: 7, y: 8 }, { x: 8, y: 6 }]);
  expect(c.isThinking).toBe(true);
  expect(mocks.think.mock.invocationCallOrder[0]).toBeLessThan(mocks.detect.mock.invocationCallOrder[0]);
  await c.refreshAnalysis();
  expect(mocks.think).toHaveBeenCalledTimes(1);
  c.dispose();
});
