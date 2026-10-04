/**
 * 核心类型：棋子、坐标、局面状态。
 *
 * 坐标约定：x 为列（0 在最左），y 为行（0 在最上）；天元 = (7,7)（15 路棋盘）。
 */

export const BLACK = 1;
export const WHITE = 2;
export type Player = typeof BLACK | typeof WHITE;
export const EMPTY = 0;
export type Cell = 0 | 1 | 2;

export interface Point {
  x: number;
  y: number;
}

export interface Move extends Point {
  /** 1 = 黑, 2 = 白 */
  player: Player;
  /** 第几手（从 1 开始） */
  index: number;
  /** 可选：该手的注释（定式讲解 / AI 评注） */
  note?: string;
}

/** 规则集：无禁手自由规则 / 有禁手（连珠）规则 */
export type RuleSet = 'freestyle' | 'renju';

export type GameStatus =
  | 'playing'
  | 'black-win'
  | 'white-win'
  | 'draw'
  /** 黑棋走禁手，判负 */
  | 'black-forbidden';

export interface WinInfo {
  player: Player;
  /** 构成胜利的连续棋子（至少 5 个） */
  line: Point[];
  /** 是否长连（>5 子），无禁手规则下长连亦算胜 */
  overline: boolean;
}

/** 禁手类型 */
export type ForbiddenKind = 'overline' | 'double-four' | 'double-three';

export interface ForbiddenInfo {
  kind: ForbiddenKind;
  /** 触发禁手的相关方向，便于 UI 高亮 */
  details: string;
}

export const PLAYER_NAME: Record<Player, string> = {
  [BLACK]: '黑棋',
  [WHITE]: '白棋',
};

export const other = (p: Player): Player => (p === BLACK ? WHITE : BLACK);

export const pointKey = (x: number, y: number): number => y * 32 + x;

export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
