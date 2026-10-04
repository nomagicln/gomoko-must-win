import { describe, expect, it } from 'vitest';
import { search, detectForcedWin } from '../src/ai/search';
import { findWinningMoves } from '../src/ai/analyze';
import { forbiddenAt } from '../src/core/renju';
import { DIFFICULTIES } from '../src/ai/engine';
import { WIN } from '../src/ai/shapes';
const cellsOf = (stones: number[][]) => {
  const cells = new Int8Array(225);
  for (const [x, y, color] of stones) cells[y * 15 + x] = color;
  return cells;
};
const chain = [[6,7,1],[9,6,2],[6,10,1],[10,9,2],[7,6,1],[7,9,2],[4,6,1],[5,5,2],[8,9,1],[10,6,2],[9,9,1],[9,4,2],[8,7,1],[9,7,2],[4,5,1],[5,6,2],[5,7,1],[8,4,2]];

describe('AI 战术与搜索回归', () => {
  it('连续冲四杀法优先于对手活四诱点，试走不污染输入', () => {
    const cells = cellsOf(chain), original = cells.slice();
    const result = search(cells, 1, { maxDepth: 1, timeMs: 150, vcfDepth: 10 });
    expect(result.forcedWin?.kind).toBe('vcf');
    expect(result.move).toEqual(result.forcedWin!.line[0]);
    expect(result.move).toEqual({ x: 4, y: 7 });
    expect(cells).toEqual(original);
    const path = result.forcedWin!.line;
    expect(path.length).toBeGreaterThanOrEqual(4);
    // 前两手是冲四与唯一应手；第三手形成至少两个成五点。
    cells[path[0].y * 15 + path[0].x] = 1;
    expect(findWinningMoves(cells, 15, 1)).toEqual([path[1]]);
    cells[path[1].y * 15 + path[1].x] = 2;
    cells[path[2].y * 15 + path[2].x] = 1;
    expect(findWinningMoves(cells, 15, 1).length).toBeGreaterThanOrEqual(2);
  });

  it('算杀侦测在存在对手一步成五时不会误报双活三必胜', () => {
    const cells = cellsOf([[5,7,1],[8,7,1],[7,5,1],[7,8,1],[1,2,2],[2,2,2],[3,2,2],[4,2,2]]);
    expect(detectForcedWin(cells, 1, { timeMs: 80 })).toBeNull();
    expect(search(cells, 1, { timeMs: 80 }).move?.y).toBe(2);
  });

  it('对手活三将形成活四时，浅层搜索优先防守', () => {
    const cells = cellsOf([[5,7,2],[6,7,2],[7,7,2],[7,10,1],[8,10,1]]);
    const result = search(cells, 1, { maxDepth: 2, timeMs: 150, useVcf: false });
    expect([{ x: 4, y: 7 }, { x: 8, y: 7 }]).toContainEqual(result.move);
  });

  it('连珠白棋可以落在黑棋禁手点成五', () => {
    const cells = cellsOf([[2,2,1],[6,7,1],[8,7,1],[7,6,1],[7,8,1],[3,3,2],[4,4,2],[5,5,2],[6,6,2]]);
    expect(forbiddenAt(cells, 15, 7, 7)?.kind).toBe('double-three');
    const result = search(cells, 2, { rules: 'renju', timeMs: 80 });
    expect(result.move).toEqual({ x: 7, y: 7 });
    expect(result.forcedWin?.kind).toBe('five');
  });

  it('白棋的双三进攻着法不会被黑棋禁手筛掉', () => {
    const cells = cellsOf([[6,7,1],[8,7,1],[7,6,1],[7,8,1],[6,6,2],[8,8,2],[6,8,2],[8,6,2]]);
    expect(forbiddenAt(cells, 15, 7, 7)?.kind).toBe('double-three');
    const result = search(cells, 2, { rules: 'renju', maxDepth: 2, timeMs: 350, useVcf: false });
    expect(result.candidates.some(p => p.x === 7 && p.y === 7)).toBe(true);
    expect(cells[result.move!.y * 15 + result.move!.x]).toBe(0);
  });

  it('黑棋长连不是获胜手，对手黑棋长连也不触发假封堵', () => {
    const cells = cellsOf([[2,7,1],[3,7,1],[4,7,1],[6,7,1],[7,7,1],[1,7,2],[8,7,2],[7,10,2]]);
    expect(forbiddenAt(cells, 15, 5, 7)?.kind).toBe('overline');
    const black = search(cells, 1, { rules: 'renju', maxDepth: 2, timeMs: 150 });
    expect(black.move).not.toEqual({ x: 5, y: 7 });
    expect(black.forcedWin?.kind).not.toBe('five');
    const white = search(cells, 2, { rules: 'renju', maxDepth: 2, timeMs: 150 });
    expect(white.depth).toBeGreaterThan(0);
  });

  it('被迫封堵点是黑棋禁手时，仍返回合法着法', () => {
    const cells = cellsOf([[6,7,1],[8,7,1],[7,6,1],[7,8,1],[3,3,2],[4,4,2],[5,5,2],[6,6,2],[2,2,1]]);
    const result = search(cells, 1, { rules: 'renju', timeMs: 150 });
    expect(result.move).not.toBeNull();
    expect(forbiddenAt(cells, 15, result.move!.x, result.move!.y)).toBeNull();
  });

  it('19 路边角短斜线上的成五点不会漏算', () => {
    const cells = new Int8Array(361);
    for (let j = 0; j < 4; j++) cells[j * 19 + 4 - j] = 2;
    expect(search(cells, 2, { size: 19, timeMs: 50 }).move).toEqual({ x: 0, y: 4 });
  });

  it('超时保留最后完整搜索结果，输入棋盘和主变化保持合法', () => {
    const cells = cellsOf([[7,7,1],[7,8,2],[8,6,1],[6,8,2]]), before = cells.slice();
    const result = search(cells, 1, { maxDepth: 20, timeMs: 35, useVcf: false });
    expect(result.move).not.toBeNull();
    expect(result.elapsedMs).toBeLessThan(200);
    expect(cells).toEqual(before);
    expect(result.pv[0]).toEqual(result.move);
    for (const point of result.pv) {
      const idx = point.y * 15 + point.x;
      expect(cells[idx]).toBe(0);
      cells[idx] = 1;
    }
    expect(Number.isFinite(result.score)).toBe(true);
    expect(Math.abs(result.score)).toBeLessThanOrEqual(WIN);
  });

  it('高难度取消随机失误，扩大候选和算杀深度且缩短等待预算', () => {
    const hard = DIFFICULTIES.find(d => d.id === 'hard')!.config;
    const master = DIFFICULTIES.find(d => d.id === 'master')!.config;
    expect(hard.randomness).toBe(0); expect(master.randomness).toBe(0);
    expect(hard.maxDepth).toBeGreaterThan(8); expect(master.maxDepth).toBeGreaterThan(hard.maxDepth!);
    expect(master.branchLimit).toBeGreaterThan(14); expect(master.vcfDepth).toBeGreaterThan(16);
    expect(hard.timeMs).toBeLessThanOrEqual(1800); expect(master.timeMs).toBeLessThanOrEqual(4200);
  });
});
