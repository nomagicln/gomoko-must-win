import { describe, expect, it } from 'vitest';
import { SearchPosition } from '../src/ai/position';
import { DIRS, eachLine, Shape, SHAPE_SCORE, WINDOW_TABLE } from '../src/ai/shapes';
import { makesFive } from '../src/core/patterns';

function fullScore(cells: Int8Array, size: number): number {
  let score = 0;
  eachLine(size, (x, y, dx, dy, length) => {
    for (let start = 0; start <= length - 7; start++) {
      let code = 0;
      for (let j = start; j < start + 7; j++) code = (code << 2) | cells[(y + j * dy) * size + x + j * dx];
      score += WINDOW_TABLE[code] - WINDOW_TABLE[(1 << 14) + code];
    }
  });
  return score;
}

describe('增量搜索局面', () => {
  for (const size of [15, 19]) {
    it(`${size} 路随机试走与完整重算一致，撤销后恢复初始局面`, () => {
      const cells = new Int8Array(size * size);
      const position = new SearchPosition(cells, size);
      let seed = 17;
      const moves: number[] = [];
      for (let ply = 0; ply < 40; ply++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        let idx = seed % cells.length;
        while (cells[idx]) idx = (idx + 1) % cells.length;
        const color = (ply % 2 + 1) as 1 | 2;
        cells[idx] = color;
        position.update(idx, 0, color);
        moves.push(idx);
        const rebuilt = new SearchPosition(cells, size);
        expect(position.evaluate(1)).toBe(fullScore(cells, size));
        expect(position.evaluate(2)).toBe(-position.evaluate(1));
        expect(position.neighbors).toEqual(rebuilt.neighbors);
        for (let p = 0; p < cells.length; p++) {
          if (cells[p]) continue;
          for (const side of [1, 2] as const) {
            expect(position.attack[side - 1][p]).toBe(rebuilt.attack[side - 1][p]);
            expect(position.attack[side - 1][p] >= SHAPE_SCORE[Shape.FIVE])
              .toBe(makesFive(cells, size, p % size, (p / size) | 0, side));
          }
        }
      }
      while (moves.length) {
        const idx = moves.pop()!;
        const color = cells[idx];
        cells[idx] = 0;
        position.update(idx, color, 0);
        expect(position.evaluate(1)).toBe(fullScore(cells, size));
        const rebuilt = new SearchPosition(cells, size);
        for (let p = 0; p < cells.length; p++) {
          if (cells[p]) continue;
          expect(position.attack[0][p]).toBe(rebuilt.attack[0][p]);
          expect(position.attack[1][p]).toBe(rebuilt.attack[1][p]);
        }
      }
      expect(position.evaluate(1)).toBe(0);
      expect(position.neighbors.every(v => v === 0)).toBe(true);
    });
  }

  it('四个方向的边缘四连与跳四都进入最高战术优先级', () => {
    for (const [dx, dy] of DIRS) {
      for (const gap of [0, 2, 4]) {
        const cells = new Int8Array(225);
        for (let j = 0; j < 5; j++) {
          if (j !== gap) cells[(7 + j * dy) * 15 + 3 + j * dx] = 1;
        }
        const position = new SearchPosition(cells, 15);
        const idx = (7 + gap * dy) * 15 + 3 + gap * dx;
        expect(position.attack[0][idx]).toBeGreaterThanOrEqual(SHAPE_SCORE[Shape.FIVE]);
      }
    }
  });

  it('邻近对手的棋子不会掩盖另一侧的活四', () => {
    const cells = new Int8Array(225);
    cells[7 * 15 + 3] = 2;
    for (const x of [5, 6, 7]) cells[7 * 15 + x] = 1;
    const position = new SearchPosition(cells, 15);
    expect(position.attack[0][7 * 15 + 8]).toBeGreaterThanOrEqual(SHAPE_SCORE[Shape.OPEN_FOUR]);
  });
});
