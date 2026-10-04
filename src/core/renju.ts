/**
 * 禁手判定（连珠规则）。与棋盘解耦，直接作用于格子数组，
 * 便于 AI 在搜索树中反复调用。
 */

import type { ForbiddenInfo } from './types';
import { DIRS, countFourPointsOnLine, isOpenThreeOnLine, maxRunThrough } from './patterns';
import { BLACK } from './types';

export function forbiddenAt(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
): ForbiddenInfo | null {
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  const idx = y * size + x;
  if (cells[idx] !== 0) return null;

  cells[idx] = BLACK;
  let exactFive = false;
  let overline = false;
  const fourDirs: number[] = [];
  const threeDirs: number[] = [];

  for (let d = 0; d < DIRS.length; d++) {
    const [dx, dy] = DIRS[d];
    const run = maxRunThrough(cells, size, x, y, dx, dy, BLACK);
    if (run === 5) exactFive = true;
    if (run >= 6) overline = true;
    if (run < 5 && countFourPointsOnLine(cells, size, x, y, dx, dy, BLACK) > 0) fourDirs.push(d);
  }

  if (!exactFive) {
    for (let d = 0; d < DIRS.length; d++) {
      if (fourDirs.includes(d)) continue;
      const [dx, dy] = DIRS[d];
      if (isOpenThreeOnLine(cells, size, x, y, dx, dy, BLACK)) threeDirs.push(d);
    }
  }

  cells[idx] = 0;

  if (exactFive) return null; // 五连优先
  if (overline) return { kind: 'overline', details: '长连禁手：黑棋不可连成六子以上' };
  if (fourDirs.length >= 2) return { kind: 'double-four', details: `四四禁手：同时形成 ${fourDirs.length} 个四` };
  if (threeDirs.length >= 2) return { kind: 'double-three', details: `三三禁手：同时形成 ${threeDirs.length} 个活三` };
  return null;
}

/** 快速判断是否禁手（只关心有无，不关心类型） */
export function isForbidden(cells: Int8Array, size: number, x: number, y: number): boolean {
  return forbiddenAt(cells, size, x, y) !== null;
}
