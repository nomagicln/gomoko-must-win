/**
 * 棋形评分核心（AI 的评估基础）。
 *
 * 思路：为「7 格窗口」预计算一张查找表（7 格 × 2 bit = 14 bit = 16384 项），
 * 表中存该窗口内黑/白各自形成的最强棋形分值。评估局面时只需求出四个方向上
 * 所有 7 格窗口的编码并累加查表结果 —— 15 路棋盘一次评估约 900 次查表，
 * 因此可以在搜索树的每个叶子节点上放心地做全盘评估。
 *
 * 局面编码：0 = 空，1 = 黑，2 = 白，3 = 墙（棋盘外）。
 */

import type { Player } from '../core/types';

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const WALL = 3;

/** 棋形枚举 */
export const Shape = {
  NONE: 0,
  ONE: 1,
  SLEEP_TWO: 2,
  OPEN_TWO: 3,
  SLEEP_THREE: 4,
  OPEN_THREE: 5,
  FOUR: 6,
  OPEN_FOUR: 7,
  FIVE: 8,
} as const;
export type ShapeKind = (typeof Shape)[keyof typeof Shape];

export const SHAPE_NAME: Record<number, string> = {
  [Shape.NONE]: '无',
  [Shape.ONE]: '单子',
  [Shape.SLEEP_TWO]: '眠二',
  [Shape.OPEN_TWO]: '活二',
  [Shape.SLEEP_THREE]: '眠三',
  [Shape.OPEN_THREE]: '活三',
  [Shape.FOUR]: '冲四',
  [Shape.OPEN_FOUR]: '活四',
  [Shape.FIVE]: '五连',
};

/** 棋形分值：量级差异保证取舍顺序符合棋理 */
export const SHAPE_SCORE: Record<number, number> = {
  [Shape.NONE]: 0,
  [Shape.ONE]: 30,
  [Shape.SLEEP_TWO]: 240,
  [Shape.OPEN_TWO]: 1_100,
  [Shape.SLEEP_THREE]: 2_800,
  [Shape.OPEN_THREE]: 26_000,
  [Shape.FOUR]: 130_000,
  [Shape.OPEN_FOUR]: 1_100_000,
  [Shape.FIVE]: 10_000_000,
};

export const WIN_SCORE = 9_000_000;
export const WIN = WIN_SCORE;

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

const WIN_LEN = 7;
const TABLE_SIZE = 1 << (WIN_LEN * 2);
const MASK = TABLE_SIZE - 1;

/* ------------------------------------------------------------------ */
/* 单窗口棋形判定                                                      */
/* ------------------------------------------------------------------ */

interface RunInfo {
  len: number;
  start: number;
  stones: number;
  hasOpp: boolean;
}

function analyze(w: readonly number[], color: number): RunInfo {
  const opp = color === BLACK ? WHITE : BLACK;
  let len = 0;
  let start = -1;
  let cur = 0;
  let curStart = -1;
  let stones = 0;
  let hasOpp = false;
  for (let i = 0; i < w.length; i++) {
    const v = w[i];
    if (v === color) {
      stones++;
      if (cur === 0) curStart = i;
      cur++;
      if (cur > len) {
        len = cur;
        start = curStart;
      }
    } else {
      cur = 0;
      if (v === opp) hasOpp = true;
    }
  }
  return { len, start, stones, hasOpp };
}

/** 落一子即成五？ */
function completesFive(w: number[], color: number): boolean {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== EMPTY) continue;
    w[i] = color;
    let run = 1;
    for (let j = i - 1; j >= 0 && w[j] === color; j--) run++;
    for (let j = i + 1; j < w.length && w[j] === color; j++) run++;
    w[i] = EMPTY;
    if (run >= 5) return true;
  }
  return false;
}

/** 是否已存在活四（连续四子、两端皆空） */
function hasOpenFour(w: readonly number[], color: number): boolean {
  const { len, start } = analyze(w, color);
  if (len !== 4) return false;
  const l = start - 1;
  const r = start + 4;
  if (l < 0 || r >= w.length) return false;
  return w[l] === EMPTY && w[r] === EMPTY;
}

/** 落一子即成活四？ */
function canMakeOpenFour(w: number[], color: number): boolean {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== EMPTY) continue;
    w[i] = color;
    const ok = hasOpenFour(w, color);
    w[i] = EMPTY;
    if (ok) return true;
  }
  return false;
}

/** 落一子后「仍差一子成五」？即先手可造出冲四（眠三的定义） */
function canBuildFour(w: number[], color: number): boolean {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== EMPTY) continue;
    w[i] = color;
    const ok = completesFive(w, color);
    w[i] = EMPTY;
    if (ok) return true;
  }
  return false;
}

/** 含跳子的三（如 BB_B / B_BB）也算数 */
function classify(w: readonly number[], color: number, scratch: number[]): number {
  const info = analyze(w, color);
  if (info.hasOpp || info.stones === 0) return Shape.NONE;

  if (info.len >= 5) return Shape.FIVE;

  if (info.len === 4) {
    const l = info.start - 1;
    const r = info.start + 4;
    const lOpen = l >= 0 && w[l] === EMPTY;
    const rOpen = r < w.length && w[r] === EMPTY;
    return lOpen && rOpen ? Shape.OPEN_FOUR : Shape.FOUR;
  }

  for (let i = 0; i < w.length; i++) scratch[i] = w[i];

  if (info.stones >= 4) {
    return completesFive(scratch, color) ? Shape.FOUR : Shape.NONE;
  }

  if (info.stones === 3) {
    if (canMakeOpenFour(scratch, color)) return Shape.OPEN_THREE;
    if (canBuildFour(scratch, color)) return Shape.SLEEP_THREE;
    // 三子无法成四（多为散落分布）
    if (info.len === 3) {
      const l = info.start - 1;
      const r = info.start + 3;
      if (l >= 0 && r < w.length && w[l] === EMPTY && w[r] === EMPTY) return Shape.OPEN_TWO;
    }
    return Shape.SLEEP_TWO;
  }

  if (info.stones === 2) {
    if (info.len === 2) {
      const l = info.start - 1;
      const r = info.start + 2;
      if (l >= 0 && r < w.length && w[l] === EMPTY && w[r] === EMPTY) {
        const spaceLeft = l - 1 >= 0 && w[l - 1] === EMPTY;
        const spaceRight = r + 1 < w.length && w[r + 1] === EMPTY;
        if (spaceLeft || spaceRight) return Shape.OPEN_TWO;
      }
    }
    return Shape.SLEEP_TWO;
  }

  return Shape.ONE;
}

/* ------------------------------------------------------------------ */
/* 查表构建（一次，约数毫秒）                                          */
/* ------------------------------------------------------------------ */

function buildTable(): Int32Array {
  const table = new Int32Array(TABLE_SIZE * 2);
  const w: number[] = new Array<number>(WIN_LEN).fill(EMPTY);
  const scratch: number[] = new Array<number>(WIN_LEN).fill(EMPTY);
  for (let code = 0; code < TABLE_SIZE; code++) {
    let c = code;
    for (let i = 0; i < WIN_LEN; i++) {
      w[i] = c & 3;
      c >>= 2;
    }
    table[code] = SHAPE_SCORE[classify(w, BLACK, scratch)];
    table[TABLE_SIZE + code] = SHAPE_SCORE[classify(w, WHITE, scratch)];
  }
  return table;
}

export const WINDOW_TABLE: Int32Array = buildTable();

/** 对一段格子做棋形判定（UI / 分析使用） */
export function classifyCells(cells: readonly number[], color: number): number {
  const scratch: number[] = new Array<number>(cells.length).fill(EMPTY);
  return classify(cells, color, scratch);
}

/* ------------------------------------------------------------------ */
/* 全盘评估                                                            */
/* ------------------------------------------------------------------ */

interface LineVisitor {
  (x0: number, y0: number, dx: number, dy: number, len: number): void;
}

/** 遍历全部行、列、斜线（含长度 < 7 的短斜线，内部会跳过） */
export function eachLine(size: number, visit: LineVisitor): void {
  for (let y = 0; y < size; y++) visit(0, y, 1, 0, size);
  for (let x = 0; x < size; x++) visit(x, 0, 0, 1, size);
  for (let y = 0; y < size; y++) visit(0, y, 1, 1, size - y);
  for (let x = 1; x < size; x++) visit(x, 0, 1, 1, size - x);
  for (let y = 0; y < size; y++) visit(0, y, 1, -1, y + 1);
  for (let x = 1; x < size; x++) visit(x, size - 1, 1, -1, size - x);
}

/**
 * 全盘静态评估，返回相对 `color` 的分差（正数表示 color 占优）。
 *
 * 说明：为了速度，窗口在棋盘边界处不做补墙 —— 因为滑窗本身在边界会
 * 自然截断，而「连续四子是否两端皆空」的判定要求两端都在窗口内，
 * 截断等价于该端被墙堵住，语义正确。
 */
export function evaluate(cells: Int8Array, size: number, color: Player): number {
  const off = color === BLACK ? 0 : TABLE_SIZE;
  const oppOff = color === BLACK ? TABLE_SIZE : 0;
  let mine = 0;
  let theirs = 0;

  eachLine(size, (x0, y0, dx, dy, len) => {
    if (len < WIN_LEN) return;
    let base = y0 * size + x0;
    const step = dy * size + dx;
    let code = 0;
    for (let i = 0; i < WIN_LEN; i++) code = (code << 2) | cells[base + step * i];
    mine += WINDOW_TABLE[off + code];
    theirs += WINDOW_TABLE[oppOff + code];
    for (let i = WIN_LEN; i < len; i++) {
      code = ((code << 2) | cells[base + step * i]) & MASK;
      mine += WINDOW_TABLE[off + code];
      theirs += WINDOW_TABLE[oppOff + code];
    }
  });

  return mine - theirs * 1.12;
}

/** 以 (x,y) 为中心取 7 格窗口编码（中心位于窗口正中，越界记墙） */
function centerCode(cells: Int8Array, size: number, x: number, y: number, dx: number, dy: number): number {
  let code = 0;
  for (let i = -3; i <= 3; i++) {
    const cx = x + dx * i;
    const cy = y + dy * i;
    let v = WALL;
    if (cx >= 0 && cy >= 0 && cx < size && cy < size) v = cells[cy * size + cx];
    code = (code << 2) | v;
  }
  return code;
}

/**
 * 单点启发式分值（候选着法排序用，成本约 8 次查表）。
 * 同时考虑「我在此落子的进攻价值」与「对手在此落子的防守价值」。
 */
export function pointHeuristic(cells: Int8Array, size: number, x: number, y: number, color: Player): number {
  const opp: Player = color === BLACK ? WHITE : BLACK;
  const off = color === BLACK ? 0 : TABLE_SIZE;
  const oppOff = color === BLACK ? TABLE_SIZE : 0;
  const idx = y * size + x;
  const save = cells[idx];
  let attack = 0;
  let defend = 0;
  cells[idx] = color;
  for (let d = 0; d < 4; d++) attack += WINDOW_TABLE[off + centerCode(cells, size, x, y, DIRS[d][0], DIRS[d][1])];
  cells[idx] = opp;
  for (let d = 0; d < 4; d++) defend += WINDOW_TABLE[oppOff + centerCode(cells, size, x, y, DIRS[d][0], DIRS[d][1])];
  cells[idx] = save;
  return attack + defend * 0.92;
}
