/**
 * 形状识别原语：五连、活四、冲四、活三的判定。
 *
 * 这些函数按「定义」实现，而非查表，因此可读性和正确性优先：
 *  - 五连：连子数 ≥ 5（无禁手规则下 ≥5 即胜；连珠规则下 >5 为长连禁手）
 *  - 活四：连续四子且两端皆空
 *  - 冲四：存在一个空点，落子即成五连
 *  - 活三：存在一个空点，落子即成「活四」
 *
 * 棋盘外一律视为墙（值为 3），因此所有比较天然安全。
 */

import type { Point } from './types';

export const WALL = 3;

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

export const DIR_NAME = ['横', '纵', '撇（↙↗）', '捺（↖↘）'] as const;

export function inBounds(size: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size && y < size;
}

/** 越界返回墙值 3 */
export function cellAt(cells: Int8Array, size: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= size || y >= size) return WALL;
  return cells[y * size + x];
}

/** 从 (x,y) 沿 (dx,dy) 方向同色连子数（不含起点自身则为 0） */
export function runLength(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  player: number,
): number {
  let n = 0;
  let cx = x + dx;
  let cy = y + dy;
  while (cellAt(cells, size, cx, cy) === player) {
    n++;
    cx += dx;
    cy += dy;
  }
  return n;
}

/** 穿过 (x,y) 的整条连子（含两端），用于高亮胜利连线 */
export function runLine(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  player: number,
): Point[] {
  const back = runLength(cells, size, x, y, -dx, -dy, player);
  const fwd = runLength(cells, size, x, y, dx, dy, player);
  const line: Point[] = [];
  for (let i = -back; i <= fwd; i++) line.push({ x: x + dx * i, y: y + dy * i });
  return line;
}

/** 该方向上的最长连子长度（含落点） */
export function maxRunThrough(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  player: number,
): number {
  return 1 + runLength(cells, size, x, y, dx, dy, player) + runLength(cells, size, x, y, -dx, -dy, player);
}

/** (px,py) 落子后能否形成 ≥5 连 */
export function makesFive(cells: Int8Array, size: number, px: number, py: number, player: number): boolean {
  for (const [dx, dy] of DIRS) {
    if (maxRunThrough(cells, size, px, py, dx, dy, player) >= 5) return true;
  }
  return false;
}

/** 恰好五连（用于「五连优先于长连」的判定） */
export function makesExactFive(
  cells: Int8Array,
  size: number,
  px: number,
  py: number,
  player: number,
): boolean {
  for (const [dx, dy] of DIRS) {
    if (maxRunThrough(cells, size, px, py, dx, dy, player) === 5) return true;
  }
  return false;
}

/** (px,py) 处是否存在「活四」（连续四子且两端皆空，且两侧空间足以延展） */
export function isOpenFourAt(
  cells: Int8Array,
  size: number,
  px: number,
  py: number,
  dx: number,
  dy: number,
  player: number,
): boolean {
  if (cellAt(cells, size, px, py) !== player) return false;
  const before = runLength(cells, size, px, py, -dx, -dy, player);
  const after = runLength(cells, size, px, py, dx, dy, player);
  if (before + after + 1 !== 4) return false;
  const front = { x: px + dx * (after + 1), y: py + dy * (after + 1) };
  const back = { x: px - dx * (before + 1), y: py - dy * (before + 1) };
  return cellAt(cells, size, front.x, front.y) === 0 && cellAt(cells, size, back.x, back.y) === 0;
}

/** 该方向是否存在「冲四或活四」：即落子后本方向已有成五点 */
export function hasFourOnLine(
  cells: Int8Array,
  size: number,
  px: number,
  py: number,
  dx: number,
  dy: number,
  player: number,
): boolean {
  // after 落子后：存在一个空点 e（含 px,py 所在五窗口）落子即五连
  for (let i = -4; i <= 4; i++) {
    const ex = px + dx * i;
    const ey = py + dy * i;
    if (cellAt(cells, size, ex, ey) !== 0) continue;
    const before = runLength(cells, size, ex, ey, -dx, -dy, player);
    const after = runLength(cells, size, ex, ey, dx, dy, player);
    if (before + after + 1 < 5) continue;
    const t = (0 - i) | 0; // (px,py) 相对 e 的步数
    if (t >= -before && t <= after) return true;
  }
  return false;
}

/**
 * (x,y) 落子后，本方向是否形成「活三」。
 * 定义：存在一个空点，落子后本方向形成活四。
 */
export function isOpenThreeOnLine(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  player: number,
): boolean {
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    const ex = x + dx * i;
    const ey = y + dy * i;
    if (cellAt(cells, size, ex, ey) !== 0) continue;
    // 试探：在 (ex,ey) 落子
    const idx = ey * size + ex;
    cells[idx] = player as 1 | 2;
    const ok = isOpenFourAt(cells, size, ex, ey, dx, dy, player);
    cells[idx] = 0;
    if (ok) return true;
  }
  return false;
}

/** 该方向是否存在「四」（含活四、冲四、跳四），用于计算成五点的数量 */
export function countFourPointsOnLine(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
  dx: number,
  dy: number,
  player: number,
): number {
  let count = 0;
  for (let i = -4; i <= 4; i++) {
    const ex = x + dx * i;
    const ey = y + dy * i;
    if (cellAt(cells, size, ex, ey) !== 0) continue;
    const before = runLength(cells, size, ex, ey, -dx, -dy, player);
    const after = runLength(cells, size, ex, ey, dx, dy, player);
    if (before + after + 1 < 5) continue;
    // 必须与落点 (x,y) 位于同一五窗口
    const t = -i;
    if (t >= -before && t <= after) count++;
  }
  return count;
}
