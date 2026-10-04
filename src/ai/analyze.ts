/**
 * 威胁分析：把「棋形」翻译成人类能读懂的战术结论。
 *
 * 这是 UI 的「大脑」——热力图、必杀提示、必胜侦测、禁手高亮所需的
 * 全部结论都由本模块产出；同时它也服务于搜索模块的强制着法生成。
 */

import {
  DIRS,
  countFourPointsOnLine,
  isOpenFourAt,
  isOpenThreeOnLine,
  makesFive,
  maxRunThrough,
} from '../core/patterns';
import { BLACK, other, type Player } from '../core/types';
import { SHAPE_SCORE, Shape, pointHeuristic } from './shapes';

export interface PointAnalysis {
  x: number;
  y: number;
  /** 四个方向上形成的最强棋形 */
  shapes: number[];
  /** 该点最强棋形 */
  best: number;
  /** 综合分值（用于热力图） */
  score: number;
  /** 落子即五连 */
  five: boolean;
  /** 四个方向中「四」的个数（含活四） */
  fours: number;
  /** 四个方向中「活三」的个数 */
  openThrees: number;
  /** 双威胁判定：双四 / 四三 / 双活三 —— 这些都是「必胜手」 */
  doubleThreat: 'none' | 'double-four' | 'four-three' | 'double-three';
  /** 排序启发值 */
  heuristic: number;
}

export function analyzePoint(cells: Int8Array, size: number, x: number, y: number, color: Player): PointAnalysis {
  const idx = y * size + x;
  const save = cells[idx];
  cells[idx] = color;

  const shapes: number[] = [Shape.NONE, Shape.NONE, Shape.NONE, Shape.NONE];
  let best: number = Shape.NONE;
  let fours = 0;
  let openThrees = 0;
  let five = false;

  for (let d = 0; d < 4; d++) {
    const dx = DIRS[d][0];
    const dy = DIRS[d][1];
    let s: number = Shape.NONE;
    if (maxRunThrough(cells, size, x, y, dx, dy, color) >= 5) {
      s = Shape.FIVE;
      five = true;
    } else if (isOpenFourAt(cells, size, x, y, dx, dy, color)) {
      s = Shape.OPEN_FOUR;
    } else if (countFourPointsOnLine(cells, size, x, y, dx, dy, color) > 0) {
      s = Shape.FOUR;
    } else if (isOpenThreeOnLine(cells, size, x, y, dx, dy, color)) {
      s = Shape.OPEN_THREE;
    } else {
      const run = maxRunThrough(cells, size, x, y, dx, dy, color);
      if (run === 2) s = Shape.OPEN_TWO;
      else if (run >= 3) s = Shape.SLEEP_THREE;
      else if (run === 1) s = Shape.ONE;
    }
    shapes[d] = s;
    if (s > best) best = s;
    if (s === Shape.FOUR || s === Shape.OPEN_FOUR || s === Shape.FIVE) fours++;
    if (s === Shape.OPEN_THREE) openThrees++;
  }

  cells[idx] = save;

  let doubleThreat: PointAnalysis['doubleThreat'] = 'none';
  if (fours >= 2) doubleThreat = 'double-four';
  else if (fours >= 1 && openThrees >= 1) doubleThreat = 'four-three';
  else if (openThrees >= 2) doubleThreat = 'double-three';

  let score = SHAPE_SCORE[best];
  if (doubleThreat === 'double-three') score += SHAPE_SCORE[Shape.OPEN_THREE] * 1.6;
  if (doubleThreat === 'four-three') score += SHAPE_SCORE[Shape.FOUR] * 1.4;
  if (doubleThreat === 'double-four') score += SHAPE_SCORE[Shape.OPEN_FOUR] * 0.8;

  return {
    x,
    y,
    shapes,
    best,
    score,
    five,
    fours,
    openThrees,
    doubleThreat,
    heuristic: pointHeuristic(cells, size, x, y, color),
  };
}

export interface ThreatMapOptions {
  radius?: number;
  /** 只保留分值高于该阈值的点 */
  minScore?: number;
  limit?: number;
}

/**
 * 防守价值：对手若占据此点会形成多强的棋形。
 * 用于「必须封堵」的提示与热力图的防守侧。
 */
export function analyzeDefense(
  cells: Int8Array,
  size: number,
  x: number,
  y: number,
  color: Player,
): PointAnalysis {
  return analyzePoint(cells, size, x, y, other(color));
}

/** 对候选点做完整威胁分析（约 1ms/百点，仅用于 UI 与根节点） */
export function threatMap(
  cells: Int8Array,
  size: number,
  color: Player,
  options: ThreatMapOptions = {},
): PointAnalysis[] {
  const { radius = 2, minScore = 0, limit = 400 } = options;
  const points = neighborPoints(cells, size, radius);
  const out: PointAnalysis[] = [];
  for (const p of points) {
    const a = analyzePoint(cells, size, p.x, p.y, color);
    if (a.score >= minScore) out.push(a);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** 与已有棋子邻近的空点 */
export function neighborPoints(cells: Int8Array, size: number, radius = 2): Array<{ x: number; y: number }> {
  const seen = new Uint8Array(size * size);
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cells[y * size + x] === 0) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= size) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= size) continue;
          if (cells[ny * size + nx] !== 0) continue;
          const k = ny * size + nx;
          if (seen[k]) continue;
          seen[k] = 1;
          out.push({ x: nx, y: ny });
        }
      }
    }
  }
  return out;
}

/** 能立刻成五的点（一步胜） */
export function findWinningMoves(cells: Int8Array, size: number, color: Player): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of neighborPoints(cells, size, 1)) {
    if (makesFive(cells, size, p.x, p.y, color)) out.push(p);
  }
  return out;
}

/** 能形成「四」（含活四、冲四）的点 */
export function findFourMoves(cells: Int8Array, size: number, color: Player): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of neighborPoints(cells, size, 2)) {
    const a = analyzePoint(cells, size, p.x, p.y, color);
    if (a.fours > 0) out.push(p);
  }
  return out;
}

/** 能形成「活三」的点 */
export function findOpenThreeMoves(cells: Int8Array, size: number, color: Player): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const p of neighborPoints(cells, size, 2)) {
    const a = analyzePoint(cells, size, p.x, p.y, color);
    if (a.openThrees > 0) out.push(p);
  }
  return out;
}

export interface PointNote {
  point: { x: number; y: number };
  text: string;
  tone: 'win' | 'must' | 'danger' | 'good';
  /** 该提示属于哪一方，UI 据此着色（黑=朱砂，白=青玉） */
  side?: Player;
}

/** 中文战况解说：把当前局面的战术要点讲给玩家听 */
export function describePoint(a: PointAnalysis, color: Player): PointNote | null {
  const who = color === BLACK ? '黑棋' : '白棋';
  if (a.five) return { point: a, text: `${who}落此即成五连`, tone: 'win' };
  if (a.doubleThreat === 'double-four') return { point: a, text: '双四禁型，两边成五不可兼顾', tone: 'win' };
  if (a.doubleThreat === 'four-three') return { point: a, text: `${who}四三双杀，胜负已分`, tone: 'win' };
  if (a.doubleThreat === 'double-three') return { point: a, text: `${who}双活三，形成必胜之势`, tone: 'win' };
  if (a.fours > 0) return { point: a, text: `${who}冲四，对手必须应对`, tone: 'must' };
  if (a.openThrees > 0) return { point: a, text: `${who}活三，先手在握`, tone: 'must' };
  return null;
}

/** 判断某个点是否属于「必须应对」的防守点（对手在此处能成五） */
export function isBlockingPoint(cells: Int8Array, size: number, x: number, y: number, defenseColor: Player): boolean {
  const attacker = other(defenseColor);
  const idx = y * size + x;
  if (cells[idx] !== 0) return false;
  cells[idx] = attacker;
  const five = maxRunThrough(cells, size, x, y, DIRS[0][0], DIRS[0][1], attacker) >= 5;
  cells[idx] = 0;
  return five;
}

export const DOUBLE_THREAT_LABEL: Record<PointAnalysis['doubleThreat'], string> = {
  none: '',
  'double-three': '双活三',
  'four-three': '四三',
  'double-four': '双四',
};
