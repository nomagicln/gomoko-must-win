/**
 * 对局控制器：把「规则 + AI + 定式 + 特效」串成一条流水线。
 *
 * 人机对战、本地双人、在线联机三种玩法共用本控制器，
 * 区别仅在于每个座位（Seat）由谁驱动。
 */

import { analyzeDefense, analyzePoint, threatMap, type PointAnalysis, type PointNote } from '../ai/analyze';
import { bookLookup, type BookMatch } from '../ai/book';
import { AIClient, difficultyById, type Difficulty, type ForcedWin, type SearchOutcome } from '../ai/engine';
import { SHAPE_SCORE, Shape } from '../ai/shapes';
import { Board } from '../core/board';
import { BLACK, WHITE, other, type GameStatus, type Move, type Player, type Point, type RuleSet, type WinInfo } from '../core/types';
import { sound } from '../ui/audio';
import { toast } from '../ui/dom';
import { forcedWinFX, openingBanner, victoryFX } from '../ui/fx';
import type { HeatCell, MarkerCell } from '../ui/renderer';

export type Seat = 'human' | 'ai' | 'remote' | 'none';

export interface GameConfig {
  size: number;
  rules: RuleSet;
  difficulty: Difficulty;
  black: Seat;
  white: Seat;
  /** 本地玩家的棋子颜色（用于提示与文案） */
  humanColor: Player;
}

export interface MoveInfo {
  move: Move;
  book: BookMatch | null;
  forcedWin: ForcedWin | null;
}

export interface GameListeners {
  onMove?: (info: MoveInfo) => void;
  onForcedWin?: (win: ForcedWin) => void;
  onStateChange?: () => void;
  onThinking?: (thinking: boolean, message?: string) => void;
  onGameOver?: (status: GameStatus, win: WinInfo | null) => void;
  onBook?: (match: BookMatch | null) => void;
  onThreats?: (notes: PointNote[], markers: MarkerCell[]) => void;
  onAnalysis?: (heat: HeatCell[], candidates: SearchOutcome['candidates'] | null, score: number) => void;
  onForbidden?: (message: string, point: Point) => void;
}

const seatOf = (config: GameConfig, color: Player): Seat => (color === BLACK ? config.black : config.white);

export class GameController {
  board: Board;
  config: GameConfig;
  readonly ai: AIClient;
  private readonly listeners: GameListeners;

  private thinking = false;
  private disposed = false;
  private lastBookKey = '';
  private lastForceSignalPly = -99;
  private analysisOn = false;
  private lastHint: Point | null = null;
  private destroyed = false;

  constructor(config: GameConfig, listeners: GameListeners = {}) {
    this.config = config;
    this.listeners = listeners;
    this.board = new Board({ size: config.size, rules: config.rules });
    this.ai = new AIClient();
  }

  get size(): number {
    return this.board.size;
  }

  get turn(): Player {
    return this.board.turn;
  }

  get isThinking(): boolean {
    return this.thinking;
  }

  get isOver(): boolean {
    return this.board.isOver;
  }

  get analysisEnabled(): boolean {
    return this.analysisOn;
  }

  get hint(): Point | null {
    return this.lastHint;
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /** 开局 / 重开 */
  start(config?: Partial<GameConfig>): void {
    if (config) this.config = { ...this.config, ...config };
    this.board = new Board({ size: this.config.size, rules: this.config.rules });
    this.lastBookKey = '';
    this.lastForceSignalPly = -99;
    this.lastHint = null;
    this.listeners.onStateChange?.();
    this.afterMove(null, null);
  }

  /** 直接铺入一段着法（定式演练 / 导入棋谱），随后交由正常流程续下 */
  applySequence(points: readonly Point[]): void {
    for (const p of points) {
      const r = this.board.place(p.x, p.y);
      if (!r.ok) break;
      this.listeners.onMove?.({ move: r.move!, book: null, forcedWin: null });
    }
    this.listeners.onStateChange?.();
    this.lastBookKey = '';
    if (!this.board.isOver) this.afterMove(this.detectBook(), this.board.lastMove ?? null);
  }

  dispose(): void {
    this.disposed = true;
    this.destroyed = true;
    this.ai.dispose();
  }

  get isDisposed(): boolean {
    return this.destroyed;
  }

  /* ------------------------------------------------------------------ */
  /* 落子                                                                */
  /* ------------------------------------------------------------------ */

  canPlay(color: Player): boolean {
    if (this.board.isOver) return false;
    if (this.thinking) return false;
    if (this.board.turn !== color) return false;
    const seat = seatOf(this.config, color);
    return seat === 'human' || seat === 'remote';
  }

  /** 本地玩家落子 */
  play(x: number, y: number): boolean {
    if (!this.canPlay(this.board.turn)) return false;
    return this.commit(x, y, this.board.turn);
  }

  /** 对手（联机）落子 */
  playRemote(x: number, y: number, color: Player): boolean {
    if (this.board.isOver) return false;
    if (this.board.turn !== color) return false;
    return this.commit(x, y, color, true);
  }

  private commit(x: number, y: number, color: Player, remote = false): boolean {
    const result = this.board.place(x, y, color);
    if (!result.ok) {
      if (result.forbidden) {
        this.listeners.onForbidden?.(result.forbidden.details, { x, y });
        sound.play('undo');
      } else if (result.reason) {
        toast(result.reason, 'danger', 1600);
      }
      return false;
    }
    sound.play(color === BLACK ? 'place-black' : 'place-white');
    const move = result.move!;
    const win = result.win ?? null;

    // 若走的是 AI 提示点，消费掉提示
    if (this.lastHint && this.lastHint.x === x && this.lastHint.y === y) this.lastHint = null;

    const book = this.detectBook();
    this.listeners.onMove?.({ move, book, forcedWin: null });
    this.listeners.onStateChange?.();

    if (win) {
      this.handleGameOver(result.status, win);
      return true;
    }

    this.afterMove(book, move, remote);
    return true;
  }

  private detectBook(): BookMatch | null {
    if (this.board.moveCount > 14) return null;
    return bookLookup(this.board.moves);
  }

  private afterMove(book: BookMatch | null, lastMove: Move | null, remote = false): void {
    if (this.board.isOver) return;

    // 1. 定式识别与脱谱提示
    if (book) {
      const key = `${book.openingId}:${book.ply}`;
      if (book.ply >= 3 && key !== this.lastBookKey) {
        this.lastBookKey = key;
        openingBanner({
          seal: book.openingName.slice(0, 1),
          title: `定式 · ${book.openingName}（${book.category}）`,
          sub: `${book.variationName} · 第 ${book.ply} 手仍在谱中`,
        });
        sound.play('tick');
      }
      this.listeners.onBook?.(book);
    } else {
      if (this.lastBookKey && lastMove && this.board.moveCount <= 14) {
        this.lastBookKey = '';
        toast('脱谱：进入未知局面，开始真正的较量', 'info', 2200);
      }
      this.listeners.onBook?.(null);
    }

    // 2. 威胁提示
    this.emitThreats();

    // 3. 必胜侦测（异步，放在后台线程）
    const toMove = this.board.turn;
    if (this.board.moveCount >= 2) void this.detectWinSignal(toMove);

    // 4. 若轮到 AI，开始思考
    if (!remote || seatOf(this.config, toMove) === 'ai') this.maybeThink();

    if (this.analysisOn) void this.refreshAnalysis();
  }

  private emitThreats(): void {
    const toMove = this.board.turn;
    const notes: PointNote[] = [];
    const markers: MarkerCell[] = [];

    // 对手的必杀点（我必须应对）
    const defense = threatMap(this.board.rawCells(), this.size, other(toMove), { radius: 2 });
    const opp = defense[0];
    if (opp && (opp.five || opp.doubleThreat !== 'none' || opp.fours > 0 || opp.openThrees > 0)) {
      markers.push({
        x: opp.x,
        y: opp.y,
        kind: opp.five || opp.doubleThreat !== 'none' ? 'win' : opp.fours > 0 ? 'four' : 'three',
      });
      notes.push({
        point: opp,
        text: opp.five
          ? `对手在 ${coordName(opp, this.size)} 成五，必须封堵`
          : opp.doubleThreat !== 'none'
            ? `对手在 ${coordName(opp, this.size)} 形成双杀`
            : opp.fours > 0
              ? `对手在 ${coordName(opp, this.size)} 冲四，必须应对`
              : `对手在 ${coordName(opp, this.size)} 成活三，需要处理`,
        tone: 'must',
      });
    }

    // 我方的进攻点
    const attack = threatMap(this.board.rawCells(), this.size, toMove, { radius: 2 });
    for (const a of attack.slice(0, 3)) {
      if (a.five) {
        markers.push({ x: a.x, y: a.y, kind: 'win' });
        notes.push({ point: a, text: `${coordName(a, this.size)} 一步成五`, tone: 'win' });
      } else if (a.doubleThreat !== 'none') {
        markers.push({ x: a.x, y: a.y, kind: 'win' });
        notes.push({ point: a, text: `${coordName(a, this.size)} 形成必胜手`, tone: 'win' });
      } else if (a.fours > 0) {
        markers.push({ x: a.x, y: a.y, kind: 'four' });
        notes.push({ point: a, text: `${coordName(a, this.size)} 冲四抢手`, tone: 'must' });
      } else if (a.openThrees > 0 && notes.length < 4) {
        markers.push({ x: a.x, y: a.y, kind: 'three' });
        notes.push({ point: a, text: `${coordName(a, this.size)} 活三抢先`, tone: 'win' });
      }
    }

    const seen = new Set<string>();
    const unique = markers.filter((m) => {
      const k = `${m.x},${m.y}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.listeners.onThreats?.(notes.slice(0, 4), unique.slice(0, 6));
  }

  private async detectWinSignal(color: Player): Promise<void> {
    if (this.disposed || this.board.isOver) return;
    if (this.board.moveCount - this.lastForceSignalPly < 2) return;
    try {
      const win = await this.ai.detect({
        cells: this.board.rawCells(),
        size: this.size,
        turn: color,
        rules: this.config.rules,
      });
      if (this.disposed || !win || this.board.isOver) return;
      if (this.board.turn !== color) return;
      this.lastForceSignalPly = this.board.moveCount;
      const who = color === this.config.humanColor ? '你' : color === BLACK ? '黑棋' : '白棋';
      forcedWinFX(`${who} · ${win.label}`);
      toast(`${who}已找到制胜路线：${win.label}`, 'win', 3000);
      if (win.line.length > 1) this.listeners.onAnalysis?.([], null, 0);
      this.listeners.onForcedWin?.(win);
    } catch {
      /* 侦测失败不影响对局 */
    }
  }

  private async maybeThink(): Promise<void> {
    const toMove = this.board.turn;
    if (seatOf(this.config, toMove) !== 'ai') return;
    if (this.board.isOver || this.thinking) return;
    this.thinking = true;
    const spec = difficultyById(this.config.difficulty);
    this.listeners.onThinking?.(true, `${spec.name}思考中`);
    const startedAt = Date.now();
    try {
      const outcome = await this.ai.think({
        cells: this.board.rawCells(),
        size: this.size,
        turn: toMove,
        rules: this.config.rules,
        difficulty: this.config.difficulty,
      });
      if (this.disposed) return;
      this.thinking = false;
      this.listeners.onThinking?.(false);
      if (this.board.isOver || this.board.turn !== toMove) return;
      void startedAt;
      this.emitAnalysis(this.analysisOn ? [] : [], outcome.candidates, outcome.score, toMove);
      const move = outcome.move;
      if (!move) {
        toast('AI 选择停一手（无合适着法）', 'info');
        return;
      }
      this.commit(move.x, move.y, toMove);
    } catch (err) {
      this.thinking = false;
      this.listeners.onThinking?.(false);
      toast(`AI 出错：${err instanceof Error ? err.message : String(err)}`, 'danger', 3200);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 玩家操作                                                            */
  /* ------------------------------------------------------------------ */

  /** 请求 AI 提示（返回推荐点） */
  async requestHint(): Promise<Point | null> {
    if (this.board.isOver) return null;
    const toMove = this.board.turn;
    const spec = difficultyById('hard');
    const outcome = await this.ai.think({
      cells: this.board.rawCells(),
      size: this.size,
      turn: toMove,
      rules: this.config.rules,
      difficulty: 'hard',
      timeMs: Math.min(1200, spec.config.timeMs ?? 1200),
    });
    if (this.disposed || !outcome.move) return null;
    this.lastHint = outcome.move;
    this.emitAnalysis(this.analysisOn ? [] : [], outcome.candidates, outcome.score, toMove);
    this.listeners.onStateChange?.();
    sound.play('threat');
    return outcome.move;
  }

  /** 悔棋：AI 模式回退两手，人人模式回退一手 */
  undo(count?: number): boolean {
    if (this.board.moveCount === 0) return false;
    const n =
      count ??
      (this.config.black === 'ai' || this.config.white === 'ai' ? (this.board.moveCount >= 2 ? 2 : 1) : 1);
    for (let i = 0; i < n; i++) this.board.undo();
    this.lastHint = null;
    this.lastBookKey = '';
    this.lastForceSignalPly = -99;
    sound.play('undo');
    this.listeners.onStateChange?.();
    this.listeners.onBook?.(this.detectBook());
    this.emitThreats();
    if (this.analysisOn) void this.refreshAnalysis();
    return true;
  }

  resign(color: Player): void {
    if (this.board.isOver) return;
    const winner = other(color);
    this.board.declareResult(winner === BLACK ? 'black-win' : 'white-win');
    this.handleGameOver(winner === BLACK ? 'black-win' : 'white-win', null);
  }

  private handleGameOver(status: GameStatus, win: WinInfo | null): void {
    this.thinking = false;
    this.listeners.onThinking?.(false);
    const humanWon = win ? win.player === this.config.humanColor : false;
    if (status === 'draw') {
      toast('和棋：棋盘已满', 'info', 3000);
    } else if (win) {
      victoryFX(`${win.player === BLACK ? '黑棋' : '白棋'}连成五子${humanWon ? ' · 你赢了' : ''}`);
      toast(humanWon ? '五连成线，你赢了！' : '五连成线，这一局对手拿下', humanWon ? 'win' : 'danger', 3600);
    } else {
      const winner = status === 'black-win' ? BLACK : WHITE;
      toast(`${winner === BLACK ? '黑棋' : '白棋'}中盘胜（对方认输）`, 'info', 3000);
    }
    this.listeners.onGameOver?.(status, win);
    this.listeners.onStateChange?.();
  }

  /** 统一把搜索分数换算成黑方视角，避免 UI 猜正负号 */
  private emitAnalysis(
    heat: HeatCell[],
    candidates: SearchOutcome['candidates'] | null,
    score: number,
    color: Player,
  ): void {
    this.listeners.onAnalysis?.(heat, candidates, color === BLACK ? score : -score);
  }

  /* ------------------------------------------------------------------ */
  /* 分析模式                                                            */
  /* ------------------------------------------------------------------ */

  setAnalysis(on: boolean): void {
    this.analysisOn = on;
    if (on) void this.refreshAnalysis();
    else this.listeners.onAnalysis?.([], null, 0);
    this.listeners.onStateChange?.();
  }

  async refreshAnalysis(): Promise<void> {
    if (this.board.isOver) {
      this.listeners.onAnalysis?.([], null, 0);
      return;
    }
    const toMove = this.board.turn;
    const heat = this.computeHeat(toMove);
    this.listeners.onAnalysis?.(heat, null, 0);
    try {
      const outcome = await this.ai.think({
        cells: this.board.rawCells(),
        size: this.size,
        turn: toMove,
        rules: this.config.rules,
        difficulty: this.config.difficulty,
      });
      if (this.disposed) return;
      this.emitAnalysis(heat, outcome.candidates, outcome.score, toMove);
    } catch {
      /* 忽略 */
    }
  }

  /** 计算热力图：进攻（金）与防守（青）两侧 */
  computeHeat(color: Player): HeatCell[] {
    const cells = this.board.rawCells();
    const attack = threatMap(cells, this.size, color, { radius: 2, limit: 60 });
    if (attack.length === 0) return [];
    const max = Math.max(...attack.map((a) => a.score), 1);
    const out: HeatCell[] = [];
    for (const a of attack) {
      const weight = Math.pow(a.score / max, 0.42);
      out.push({
        x: a.x,
        y: a.y,
        weight,
        kind: a.five || a.doubleThreat !== 'none' ? 'win' : 'attack',
      });
    }
    const defend = threatMap(cells, this.size, other(color), { radius: 2, limit: 40 });
    const dmax = Math.max(...defend.map((a) => a.score), 1);
    for (const a of defend) {
      if (a.score < dmax * 0.28) continue;
      out.push({ x: a.x, y: a.y, weight: Math.pow(a.score / dmax, 0.42) * 0.9, kind: 'defense' });
    }
    return out;
  }

  /** 单点的中文战术评价（用于悬浮提示） */
  pointNote(p: Point, color: Player): string {
    const a = analyzePoint(this.board.rawCells(), this.size, p.x, p.y, color);
    const d = analyzeDefense(this.board.rawCells(), this.size, p.x, p.y, color);
    const parts: string[] = [];
    if (a.five) parts.push('落此成五');
    else if (a.doubleThreat !== 'none') parts.push(`形成${doubleLabel(a)}`);
    else if (a.fours > 0) parts.push('形成冲四');
    else if (a.openThrees > 0) parts.push('形成活三');
    else if (a.best === Shape.OPEN_TWO) parts.push('发展活二');
    if (d.five) parts.push('对手此处可成五');
    else if (d.doubleThreat !== 'none') parts.push(`对手此处${doubleLabel(d)}`);
    else if (d.fours > 0) parts.push('对手此处冲四');
    else if (d.openThrees > 0) parts.push('对手此处活三');
    return parts.length ? parts.join('｜') : '平淡的一手';
  }

  /** 局面评分 0~1（黑方视角），用于形势条 */
  evaluateBalance(): number {
    const cells = this.board.rawCells();
    let black = 0;
    let white = 0;
    for (const p of this.board.neighbors(2)) {
      const b = analyzePoint(cells, this.size, p.x, p.y, BLACK);
      const w = analyzePoint(cells, this.size, p.x, p.y, WHITE);
      black += Math.min(b.score, SHAPE_SCORE[Shape.OPEN_FOUR]);
      white += Math.min(w.score, SHAPE_SCORE[Shape.OPEN_FOUR]);
    }
    const total = black + white;
    if (total <= 0) return 0.5;
    return black / total;
  }

  markersFor(markers: MarkerCell[], extra: MarkerCell[] = []): MarkerCell[] {
    return [...markers, ...extra];
  }
}

function coordName(p: Point, size: number): string {
  return `${String.fromCharCode(65 + p.x)}${size - p.y}`;
}

function doubleLabel(a: PointAnalysis): string {
  switch (a.doubleThreat) {
    case 'double-three':
      return '双活三';
    case 'four-three':
      return '四三';
    case 'double-four':
      return '双四';
    default:
      return '强手';
  }
}
