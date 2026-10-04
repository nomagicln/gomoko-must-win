/**
 * 棋盘与规则引擎。
 *
 * 支持两套规则：
 *  - freestyle：无禁手自由规则，先连成 5 子（含长连）者胜
 *  - renju：连珠规则，黑棋有「三三 / 四四 / 长连」禁手，白棋无禁手。
 *    禁手点在对局中直接不可落子（UI 会以朱砂标记提示），避免误触即负。
 */

import {
  BLACK,
  EMPTY,
  WHITE,
  other,
  pointKey,
  type Cell,
  type ForbiddenInfo,
  type GameStatus,
  type Move,
  type Player,
  type Point,
  type RuleSet,
  type WinInfo,
} from './types';
import { DIRS, inBounds, maxRunThrough, runLine } from './patterns';
import { Zobrist, hashKey, type ZobristKey } from './zobrist';
import { forbiddenAt } from './renju';

export interface PlaceResult {
  ok: boolean;
  move?: Move;
  win?: WinInfo;
  forbidden?: ForbiddenInfo;
  status: GameStatus;
  /** 落子失败原因（用于 UI 提示） */
  reason?: string;
}

export interface BoardOptions {
  size?: number;
  rules?: RuleSet;
}

export class Board {
  readonly size: number;
  readonly rules: RuleSet;
  readonly cells: Int8Array;
  readonly moves: Move[] = [];

  private readonly zob: Zobrist;
  private readonly key: ZobristKey = { lo: 0, hi: 0 };
  private hashCache = '';
  private statusCache: GameStatus = 'playing';

  constructor(options: BoardOptions = {}) {
    this.size = options.size ?? 15;
    this.rules = options.rules ?? 'freestyle';
    this.cells = new Int8Array(this.size * this.size);
    this.zob = new Zobrist(this.size);
    this.hashCache = hashKey(this.key);
  }

  get turn(): Player {
    return this.moves.length % 2 === 0 ? BLACK : WHITE;
  }

  get moveCount(): number {
    return this.moves.length;
  }

  get lastMove(): Move | undefined {
    return this.moves[this.moves.length - 1];
  }

  get isFull(): boolean {
    return this.moves.length >= this.size * this.size;
  }

  get status(): GameStatus {
    return this.statusCache;
  }

  get isOver(): boolean {
    return this.statusCache !== 'playing';
  }

  get hash(): string {
    return this.hashCache;
  }

  at(x: number, y: number): Cell {
    return this.cells[y * this.size + x] as Cell;
  }

  inBounds(x: number, y: number): boolean {
    return inBounds(this.size, x, y);
  }

  isLegal(x: number, y: number, player: Player = this.turn): { ok: boolean; reason?: string } {
    if (!this.inBounds(x, y)) return { ok: false, reason: '超出棋盘范围' };
    if (this.at(x, y) !== EMPTY) return { ok: false, reason: '该点已有棋子' };
    if (this.isOver) return { ok: false, reason: '对局已结束' };
    if (player === BLACK && this.rules === 'renju') {
      const f = this.forbiddenAt(x, y);
      if (f) return { ok: false, reason: forbiddenText(f) };
    }
    return { ok: true };
  }

  /** 落子。默认按当前行棋方。 */
  place(x: number, y: number, player: Player = this.turn): PlaceResult {
    if (!this.inBounds(x, y)) return { ok: false, status: this.statusCache, reason: '超出棋盘范围' };
    if (this.at(x, y) !== EMPTY) return { ok: false, status: this.statusCache, reason: '该点已有棋子' };
    if (this.isOver) return { ok: false, status: this.statusCache, reason: '对局已结束' };

    if (player === BLACK && this.rules === 'renju') {
      const forbidden = this.forbiddenAt(x, y);
      if (forbidden) {
        return { ok: false, status: this.statusCache, forbidden, reason: forbiddenText(forbidden) };
      }
    }

    const idx = y * this.size + x;
    this.cells[idx] = player;
    this.zob.toggle(this.key, idx, player);
    this.zob.toggleTurn(this.key);
    this.hashCache = hashKey(this.key);
    const move: Move = { x, y, player, index: this.moves.length + 1 };
    this.moves.push(move);

    const win = this.checkWinAt(x, y);
    if (win) {
      this.statusCache = win.player === BLACK ? 'black-win' : 'white-win';
      return { ok: true, move, win, status: this.statusCache };
    }
    if (this.isFull) {
      this.statusCache = 'draw';
      return { ok: true, move, status: 'draw' };
    }
    this.statusCache = 'playing';
    return { ok: true, move, status: 'playing' };
  }

  undo(): Move | undefined {
    const move = this.moves.pop();
    if (!move) return undefined;
    const idx = move.y * this.size + move.x;
    this.cells[idx] = EMPTY;
    this.zob.toggle(this.key, idx, move.player);
    this.zob.toggleTurn(this.key);
    this.hashCache = hashKey(this.key);
    this.statusCache = 'playing';
    const last = this.lastMove;
    if (last) {
      const win = this.checkWinAt(last.x, last.y);
      if (win) this.statusCache = win.player === BLACK ? 'black-win' : 'white-win';
    }
    return move;
  }

  reset(): void {
    this.cells.fill(EMPTY);
    this.moves.length = 0;
    this.key.lo = 0;
    this.key.hi = 0;
    this.hashCache = hashKey(this.key);
    this.statusCache = 'playing';
  }

  /** 外部判定的终局（认输、超时、掉线等） */
  declareResult(status: GameStatus): void {
    this.statusCache = status;
  }

  clone(): Board {
    const b = new Board({ size: this.size, rules: this.rules });
    for (const m of this.moves) b.place(m.x, m.y, m.player);
    return b;
  }

  /** 以若干手棋重建棋盘 */
  static fromMoves(moves: readonly Point[], options: BoardOptions = {}): Board {
    const b = new Board(options);
    for (const m of moves) {
      const r = b.place(m.x, m.y);
      if (!r.ok) throw new Error(`非法棋谱：(${m.x},${m.y}) ${r.reason ?? ''}`);
    }
    return b;
  }

  /** (x,y) 处的胜利连线；无则 null */
  checkWinAt(x: number, y: number): WinInfo | null {
    const player = this.at(x, y);
    if (player === EMPTY) return null;
    let best: WinInfo | null = null;
    for (const [dx, dy] of DIRS) {
      const run = maxRunThrough(this.cells, this.size, x, y, dx, dy, player);
      if (run < 5) continue;
      const info: WinInfo = { player, line: runLine(this.cells, this.size, x, y, dx, dy, player), overline: run > 5 };
      // 恰好 5 连优先（连珠规则下长连为禁手，但五连优先于长连）
      if (run === 5) return info;
      if (!best) best = info;
    }
    return best;
  }

  /**
   * 黑棋在 (x,y) 是否构成禁手（连珠规则）。
   * 遵循「五连优先」：能成五则即便同时形成长连 / 双四也不算禁手。
   */
  forbiddenAt(x: number, y: number): ForbiddenInfo | null {
    if (this.rules !== 'renju') return null;
    return forbiddenAt(this.cells, this.size, x, y);
  }

  /** 全部禁手点（连珠规则下用于 UI 标记） */
  forbiddenPoints(): Point[] {
    if (this.rules !== 'renju' || this.turn !== BLACK || this.isOver) return [];
    const out: Point[] = [];
    for (const p of this.neighbors(2)) {
      if (this.forbiddenAt(p.x, p.y)) out.push(p);
    }
    return out;
  }

  /** 距离已有棋子切比雪夫半径内的空点（AI 候选点） */
  neighbors(radius = 2): Point[] {
    const seen = new Uint8Array(this.size * this.size);
    const out: Point[] = [];
    for (const m of this.moves) {
      for (let dy = -radius; dy <= radius; dy++) {
        const y = m.y + dy;
        if (y < 0 || y >= this.size) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const x = m.x + dx;
          if (x < 0 || x >= this.size) continue;
          if (this.cells[y * this.size + x] !== EMPTY) continue;
          const k = pointKey(x, y);
          if (seen[k]) continue;
          seen[k] = 1;
          out.push({ x, y });
        }
      }
    }
    return out;
  }

  stones(): Array<Point & { player: Player }> {
    return this.moves.map((m) => ({ x: m.x, y: m.y, player: m.player }));
  }

  toMatrix(): Cell[][] {
    const m: Cell[][] = [];
    for (let y = 0; y < this.size; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < this.size; x++) row.push(this.at(x, y));
      m.push(row);
    }
    return m;
  }

  /** 直接读取内部数组（热路径使用，调用方不得修改） */
  rawCells(): Int8Array {
    return this.cells;
  }
}

export function forbiddenText(f: ForbiddenInfo): string {
  switch (f.kind) {
    case 'overline':
      return '长连禁手';
    case 'double-four':
      return '四四禁手';
    case 'double-three':
      return '三三禁手';
  }
}

export const FORBIDDEN_LABEL: Record<ForbiddenInfo['kind'], string> = {
  overline: '长连',
  'double-four': '四四',
  'double-three': '三三',
};

export { BLACK, WHITE, EMPTY, other };
