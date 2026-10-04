import { describe, expect, it } from 'vitest';
import { Board } from '../src/core/board';
import { BLACK, WHITE } from '../src/core/types';
import { forbiddenAt } from '../src/core/renju';
import { evaluate, SHAPE_SCORE, Shape } from '../src/ai/shapes';
import { analyzeDefense, analyzePoint, findWinningMoves, threatMap } from '../src/ai/analyze';
import { detectForcedWin, search } from '../src/ai/search';
import { DIFFICULTIES, difficultyById } from '../src/ai/engine';

function emptyCells(size = 15): Int8Array {
  return new Int8Array(size * size);
}
function put(cells: Int8Array, size: number, x: number, y: number, v: number): void {
  cells[y * size + x] = v;
}

describe('棋盘与胜负判定', () => {
  it('横向五连判胜', () => {
    const b = new Board();
    const blacks = [
      [3, 7],
      [4, 7],
      [5, 7],
      [6, 7],
    ];
    for (let i = 0; i < 4; i++) {
      b.place(blacks[i][0], blacks[i][1], BLACK);
      b.place(i, 0, WHITE);
    }
    const r = b.place(7, 7, BLACK);
    expect(r.ok).toBe(true);
    expect(r.win?.player).toBe(BLACK);
    expect(r.win?.line.length).toBe(5);
    expect(b.status).toBe('black-win');
  });

  it('斜向五连判胜（白棋）', () => {
    const b = new Board();
    // 黑棋陪衬，避免提前结束
    const blacks = [
      [0, 0],
      [14, 0],
      [0, 14],
      [14, 14],
    ];
    for (let i = 0; i < 4; i++) {
      b.place(blacks[i][0], blacks[i][1]);
      b.place(3 + i, 3 + i, WHITE);
    }
    const r = b.place(7, 7, WHITE);
    expect(r.win?.player).toBe(WHITE);
    expect(r.win?.overline).toBe(false);
  });

  it('无禁手规则下长连也算胜', () => {
    const b = new Board({ rules: 'freestyle' });
    // 先用跳子搭出「2,3,4,5 + 7」，落于 6 时一次成六（长连）
    for (const x of [2, 3, 4, 5, 7]) {
      b.place(x, 5, BLACK);
      b.place(x, 9, WHITE);
    }
    const r = b.place(6, 5, BLACK);
    expect(r.win?.overline).toBe(true);
    expect(b.status).toBe('black-win');
  });

  it('悔棋后状态可恢复', () => {
    const b = new Board();
    b.place(0, 0);
    b.place(10, 10);
    b.place(1, 0);
    b.place(11, 10);
    b.place(2, 0);
    b.place(12, 10);
    b.place(3, 0);
    b.place(13, 10);
    b.place(4, 0);
    expect(b.isOver).toBe(true);
    b.undo();
    expect(b.status).toBe('playing');
    expect(b.turn).toBe(BLACK);
  });

  it('拒绝在已有棋子的点落子', () => {
    const b = new Board();
    b.place(7, 7);
    const r = b.place(7, 7);
    expect(r.ok).toBe(false);
  });
});

describe('禁手判定（连珠规则）', () => {
  const size = 15;
  it('长连禁手', () => {
    const cells = emptyCells(size);
    for (const x of [2, 3, 4, 6, 7]) put(cells, size, x, 7, BLACK);
    const f = forbiddenAt(cells, size, 5, 7);
    expect(f?.kind).toBe('overline');
  });

  it('三三禁手', () => {
    const cells = emptyCells(size);
    for (const p of [
      [6, 7],
      [8, 7],
      [7, 6],
      [7, 8],
    ]) {
      put(cells, size, p[0], p[1], BLACK);
    }
    const f = forbiddenAt(cells, size, 7, 7);
    expect(f?.kind).toBe('double-three');
  });

  it('四四禁手', () => {
    const cells = emptyCells(size);
    // 横三 4,5,6 与 竖三 4,5,6 —— 落在 (7,7) 同时形成两个活四
    for (const x of [4, 5, 6]) put(cells, size, x, 7, BLACK);
    for (const y of [4, 5, 6]) put(cells, size, 7, y, BLACK);
    const f = forbiddenAt(cells, size, 7, 7);
    expect(f?.kind).toBe('double-four');
  });

  it('五连优先于禁手', () => {
    const cells = emptyCells(size);
    for (const x of [3, 4, 5, 6]) put(cells, size, x, 7, BLACK);
    put(cells, size, 7, 6, BLACK);
    put(cells, size, 7, 8, BLACK);
    // 落在 (7,7) 既成五连也形成双三 —— 判为胜，不算禁手
    const f = forbiddenAt(cells, size, 7, 7);
    expect(f).toBeNull();
  });
});

describe('棋形评估', () => {
  const size = 15;
  it('识别五连、活四、活三', () => {
    const five = emptyCells(size);
    for (const x of [4, 5, 6, 7, 8]) put(five, size, x, 7, BLACK);
    expect(analyzePoint(five, size, 9, 7, BLACK).best).toBe(Shape.FIVE);

    // 三子 + 两侧空位：落子即活四
    const three = emptyCells(size);
    for (const x of [5, 6, 7]) put(three, size, x, 7, BLACK);
    expect(analyzePoint(three, size, 8, 7, BLACK).best).toBe(Shape.OPEN_FOUR);
    expect(analyzePoint(three, size, 4, 7, BLACK).best).toBe(Shape.OPEN_FOUR);
    // 活三（对手视角：此处若不封堵，黑棋成四）
    const def = analyzeDefense(three, size, 8, 7, WHITE);
    expect(def.best).toBe(Shape.OPEN_FOUR);
  });

  it('评估函数偏向占优一方', () => {
    const cells = emptyCells(size);
    for (const x of [5, 6, 7]) put(cells, size, x, 7, BLACK);
    expect(evaluate(cells, size, BLACK)).toBeGreaterThan(0);
    expect(evaluate(cells, size, WHITE)).toBeLessThan(0);
    expect(evaluate(cells, size, BLACK)).toBeGreaterThan(SHAPE_SCORE[Shape.OPEN_TWO]);
  });

  it('热力图能标出成五点', () => {
    const cells = emptyCells(size);
    for (const x of [4, 5, 6, 7]) put(cells, size, x, 7, BLACK);
    const map = threatMap(cells, size, BLACK);
    expect(map[0].five).toBe(true);
    expect(findWinningMoves(cells, size, BLACK).length).toBeGreaterThan(0);
  });
});

describe('AI 搜索', () => {
  const size = 15;

  it('空盘落天元', () => {
    const out = search(emptyCells(size), BLACK, { size, maxDepth: 2, timeMs: 300 });
    expect(out.move).toEqual({ x: 7, y: 7 });
  });

  it('能抓住一步成五', () => {
    const cells = emptyCells(size);
    for (const x of [4, 5, 6, 7]) put(cells, size, x, 7, BLACK);
    const out = search(cells, BLACK, { size, maxDepth: 4, timeMs: 800 });
    expect(out.forcedWin?.kind).toBe('five');
    expect([8, 3]).toContain(out.move?.x);
  });

  it('会封堵对手的成五点', () => {
    const cells = emptyCells(size);
    for (const x of [4, 5, 6, 7]) put(cells, size, x, 7, WHITE);
    put(cells, size, 0, 0, BLACK);
    const out = search(cells, BLACK, { size, maxDepth: 4, timeMs: 800 });
    expect([[8, 7], [3, 7]]).toContainEqual([out.move?.x, out.move?.y]);
  });

  it('能侦测 VCF 必胜', () => {
    const cells = emptyCells(size);
    // 黑棋三个连子，走 (4,7) 即成活四
    for (const x of [5, 6, 7]) put(cells, size, x, 7, BLACK);
    put(cells, size, 7, 9, WHITE);
    put(cells, size, 6, 9, WHITE);
    const win = detectForcedWin(cells, BLACK, { size });
    expect(win).not.toBeNull();
  });

  it('能侦测双活三必胜手', () => {
    const cells = emptyCells(size);
    for (const p of [
      [5, 7],
      [8, 7],
      [7, 5],
      [7, 8],
    ]) {
      put(cells, size, p[0], p[1], BLACK);
    }
    const a = analyzePoint(cells, size, 7, 7, BLACK);
    expect(a.doubleThreat).not.toBe('none');
    const win = detectForcedWin(cells, BLACK, { size });
    expect(win?.kind).toBe('double');
  });
});

describe('难度预设', () => {
  it('四档难度齐全且强度递增', () => {
    expect(DIFFICULTIES).toHaveLength(4);
    const depths = DIFFICULTIES.map((d) => d.config.maxDepth ?? 0);
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeGreaterThan(depths[i - 1]);
    expect(difficultyById('master').config.randomness).toBe(0);
  });

  it('每档难度都能在时限内给出着法', () => {
    const cells = emptyCells(15);
    for (const p of [
      [7, 7],
      [7, 8],
      [8, 8],
      [6, 7],
      [8, 6],
    ]) {
      put(cells, 15, p[0], p[1], p[0] % 2 === 0 ? BLACK : WHITE);
    }
    for (const d of DIFFICULTIES) {
      const t0 = Date.now();
      const out = search(cells, BLACK, {
        size: 15,
        ...d.config,
        timeMs: d.id === 'master' ? 2000 : d.config.timeMs,
      });
      const elapsed = Date.now() - t0;
      expect(out.move).not.toBeNull();
      expect(elapsed).toBeLessThan((d.config.timeMs ?? 2000) + 1500);
    }
  });
});

describe('19 路棋盘与整局自对弈', () => {
  it('19 路棋盘天元与星位正确', () => {
    const out = search(emptyCells(19), BLACK, { size: 19, maxDepth: 2, timeMs: 300 });
    expect(out.move).toEqual({ x: 9, y: 9 });
  });

  it('19 路棋盘上 AI 能正常搜出着法', () => {
    const cells = emptyCells(19);
    const seed: Array<[number, number, number]> = [
      [9, 9, BLACK],
      [10, 10, WHITE],
      [8, 8, BLACK],
      [9, 10, WHITE],
      [10, 9, BLACK],
      [8, 10, WHITE],
    ];
    for (const [x, y, c] of seed) put(cells, 19, x, y, c);
    const out = search(cells, BLACK, { size: 19, maxDepth: 4, timeMs: 900 });
    expect(out.move).not.toBeNull();
    expect(cells[out.move!.y * 19 + out.move!.x]).toBe(0);
  });

  it('连珠规则下 19 路也能识别禁手点', () => {
    const cells = emptyCells(19);
    for (const p of [
      [8, 8],
      [10, 8],
      [9, 7],
      [9, 9],
    ]) {
      put(cells, 19, p[0], p[1], BLACK);
    }
    const f = forbiddenAt(cells, 19, 9, 8);
    expect(f?.kind).toBe('double-three');
  });

  it('入门档 AI 自对弈能整局下完且不崩溃', () => {
    const board = new Board({ size: 15 });
    let plies = 0;
    while (!board.isOver && plies < 225) {
      const out = search(board.rawCells(), board.turn, {
        size: 15,
        maxDepth: 2,
        timeMs: 120,
        branchLimit: 6,
        randomness: 0.7,
        useVcf: false,
        vcfDepth: 0,
      });
      expect(out.move).not.toBeNull();
      const r = board.place(out.move!.x, out.move!.y);
      expect(r.ok).toBe(true);
      plies++;
    }
    expect(board.isOver).toBe(true);
    expect(plies).toBeGreaterThan(8);
  }, 120000);
});
