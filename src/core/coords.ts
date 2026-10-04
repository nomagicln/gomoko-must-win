/**
 * 棋盘坐标工具。
 * 采用五子棋通行记谱法：列用 A~O（自左向右），行用数字（自下向上），
 * 因此 15 路棋盘的天元记作 H8。
 */

import type { Point } from './types';

export const colLetter = (x: number): string => String.fromCharCode(65 + x);

/** 例如 (7,7) → H8 */
export const coordText = (p: Point, size = 15): string => `${colLetter(p.x)}${size - p.y}`;

/** 解析「H8」这样的坐标；失败返回 null */
export function parseCoord(text: string, size = 15): Point | null {
  const m = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const x = m[1].toUpperCase().charCodeAt(0) - 65;
  const y = size - Number(m[2]);
  if (x < 0 || x >= size || y < 0 || y >= size) return null;
  return { x, y };
}

export const isStar = (x: number, y: number, size: number): boolean => {
  if (size === 15) {
    return (
      (x === 3 || x === 7 || x === 11) && (y === 3 || y === 7 || y === 11)
    );
  }
  if (size === 19) {
    return (
      (x === 3 || x === 9 || x === 15) && (y === 3 || y === 9 || y === 15)
    );
  }
  return x === ((size - 1) >> 1) && y === ((size - 1) >> 1);
};
