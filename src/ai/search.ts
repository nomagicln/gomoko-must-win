/**
 * 搜索内核：Alpha-Beta（PVS）+ 置换表 + 迭代加深 + 强制着法延伸 + VCF 算杀。
 *
 * 设计要点
 *  1. 只更新落子经过的窗口与候选线，叶子节点直接读取增量评估。
 *  2. 每个节点先做「我能成五 / 对手能成五」的战术检查，保证不会漏杀漏防。
 *  3. 对手唯一成五点时只搜合法封堵，强制序列延伸到战术平静或时限。
 *  4. 走出「四」（对手必须应）的着法给予深度延伸，显著提升算杀能力。
 *  5. VCF（连续冲四取胜）独立搜索，用于「必胜」侦测与制胜路线动画。
 */

import { makesFive } from '../core/patterns';
import { isForbidden } from '../core/renju';
import { other, type Player, type Point, type RuleSet } from '../core/types';
import { Zobrist } from '../core/zobrist';
import { analyzePoint, type PointAnalysis } from './analyze';
import { DIRS, WIN, SHAPE_SCORE, Shape } from './shapes';
import { SearchPosition } from './position';

const INF = 1e9;
const MAX_PLY = 64;
const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ABORT = { abort: true } as const;

export interface SearchConfig {
  size: number;
  rules: RuleSet;
  /** 最大深度（迭代加深上限） */
  maxDepth: number;
  /** 时间上限（毫秒） */
  timeMs: number;
  /** 每层保留的候选着法数量 */
  branchLimit: number;
  /** 随机性 0~1：弱等级用它在接近最优的着法里随机挑选 */
  randomness: number;
  /** 是否启用 VCF 算杀 */
  useVcf: boolean;
  /** VCF 搜索深度（以「我走一手」为一层） */
  vcfDepth: number;
  /** 是否尊重禁手规则（黑棋） */
  honorForbidden: boolean;
}

export interface RootCandidate {
  x: number;
  y: number;
  score: number;
  analysis: PointAnalysis;
}

export interface ForcedWin {
  kind: 'five' | 'vcf' | 'double';
  label: string;
  /** 制胜路线，从当前局面起双方交替落子 */
  line: Point[];
}

export interface SearchOutcome {
  move: Point | null;
  score: number;
  depth: number;
  nodes: number;
  elapsedMs: number;
  /** 根节点的候选着法（按分值排序，供 UI 展示「AI 的思考」） */
  candidates: RootCandidate[];
  /** 主变化 */
  pv: Point[];
  forcedWin: ForcedWin | null;
}

export const DEFAULT_CONFIG: SearchConfig = {
  size: 15,
  rules: 'freestyle',
  maxDepth: 8,
  timeMs: 2000,
  branchLimit: 12,
  randomness: 0,
  useVcf: true,
  vcfDepth: 10,
  honorForbidden: true,
};

/* ------------------------------------------------------------------ */

class Searcher {
  private readonly size: number;
  private readonly cells: Int8Array;
  private readonly config: SearchConfig;

  private readonly zob: Zobrist;
  private readonly key = { lo: 0, hi: 0 };
  private stoneCount = 0;

  private readonly position: SearchPosition;
  private readonly moveStack: Int32Array[];
  private readonly killers = new Int32Array((MAX_PLY + 2) * 2).fill(-1);
  private readonly history: Int32Array;
  private readonly gatherBuf: Int32Array;
  private readonly scoreBuf: Int32Array;
  private readonly orderBuf: Int32Array;

  private readonly winBufA: Int32Array;
  private readonly winBufB: Int32Array;

  private readonly ttKey: Int32Array;
  private readonly ttLo: Int32Array;
  private readonly ttDepth: Int8Array;
  private readonly ttFlag: Int8Array;
  private readonly ttScore: Int32Array;
  private readonly ttMove: Int32Array;

  private nodes = 0;
  private deadline = 0;
  private vcfNodes = 0;
  private vcfBudget = 0;
  private vcfDeadline = 0;

  constructor(cells: Int8Array, size: number, config: SearchConfig) {
    this.size = size;
    this.cells = cells.slice();
    cells = this.cells;
    this.position = new SearchPosition(cells, size);
    this.moveStack = Array.from({ length: MAX_PLY + 2 }, () => new Int32Array(size * size));
    this.history = new Int32Array(size * size * 2);
    this.config = config;
    this.zob = new Zobrist(size);
    this.gatherBuf = new Int32Array(size * size);
    this.scoreBuf = new Int32Array(size * size);
    this.orderBuf = new Int32Array(size * size);
    this.winBufA = new Int32Array(64);
    this.winBufB = new Int32Array(64);
    this.ttKey = new Int32Array(TT_SIZE);
    this.ttLo = new Int32Array(TT_SIZE);
    this.ttDepth = new Int8Array(TT_SIZE).fill(-1);
    this.ttFlag = new Int8Array(TT_SIZE);
    this.ttScore = new Int32Array(TT_SIZE);
    this.ttMove = new Int32Array(TT_SIZE).fill(-1);

    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      if (v === 0) continue;
      const player = v as Player;
      this.zob.toggle(this.key, i, player);
      this.stoneCount++;
    }
  }

  /* ---------------- 基础操作 ---------------- */

  private place(idx: number, color: Player): void {
    this.cells[idx] = color;
    this.position.update(idx, 0, color);
    this.zob.toggle(this.key, idx, color);
    this.zob.toggleTurn(this.key);
    this.stoneCount++;
  }

  private undo(idx: number, color: Player): void {
    this.cells[idx] = 0;
    this.position.update(idx, color, 0);
    this.zob.toggle(this.key, idx, color);
    this.zob.toggleTurn(this.key);
    this.stoneCount--;
  }

  private forbidden(idx: number, color: Player): boolean {
    if (color !== 1 || !this.config.honorForbidden || this.config.rules !== 'renju') return false;
    const x = idx % this.size;
    const y = (idx / this.size) | 0;
    return isForbidden(this.cells, this.size, x, y);
  }

  /** 落子后是否形成「四」（含活四、冲四、双四） */
  private createsFour(idx: number, color: Player): boolean {
    const size = this.size;
    const x = idx % size;
    const y = (idx / size) | 0;
    for (let d = 0; d < 4; d++) {
      const dx = DIRS[d][0];
      const dy = DIRS[d][1];
      if (this.runThrough(x, y, dx, dy, color) >= 5) return true;
      if (this.fivePointsOnLine(x, y, dx, dy, color) > 0) return true;
    }
    return false;
  }

  private runThrough(x: number, y: number, dx: number, dy: number, color: Player): number {
    const size = this.size;
    const cells = this.cells;
    let n = 1;
    for (let i = 1; i < 5; i++) {
      const cx = x + dx * i;
      const cy = y + dy * i;
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) break;
      if (cells[cy * size + cx] !== color) break;
      n++;
    }
    for (let i = 1; i < 5; i++) {
      const cx = x - dx * i;
      const cy = y - dy * i;
      if (cx < 0 || cy < 0 || cx >= size || cy >= size) break;
      if (cells[cy * size + cx] !== color) break;
      n++;
    }
    return n;
  }

  /** 该方向上落子后能成五的空点数量 */
  private fivePointsOnLine(x: number, y: number, dx: number, dy: number, color: Player): number {
    const size = this.size;
    const cells = this.cells;
    let count = 0;
    for (let i = -4; i <= 4; i++) {
      const ex = x + dx * i;
      const ey = y + dy * i;
      if (ex < 0 || ey < 0 || ex >= size || ey >= size) continue;
      if (cells[ey * size + ex] !== 0) continue;
      let before = 0;
      for (let j = 1; j < 5; j++) {
        const cx = ex - dx * j;
        const cy = ey - dy * j;
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) break;
        if (cells[cy * size + cx] !== color) break;
        before++;
      }
      let after = 0;
      for (let j = 1; j < 5; j++) {
        const cx = ex + dx * j;
        const cy = ey + dy * j;
        if (cx < 0 || cy < 0 || cx >= size || cy >= size) break;
        if (cells[cy * size + cx] !== color) break;
        after++;
      }
      if (before + after + 1 < 5) continue;
      const t = -i;
      if (t >= -before && t <= after) count++;
    }
    return count;
  }

  /** 能立刻成五的点（写入 out，返回数量） */
  private winPoints(color: Player, out: Int32Array): number {
    let n = 0;
    const scores = this.position.attack[color - 1];
    for (let idx = 0; idx < this.cells.length; idx++) {
      if (this.cells[idx] || scores[idx] < SHAPE_SCORE[Shape.FIVE] || this.forbidden(idx, color)) continue;
      out[n++] = idx;
      if (n === out.length) break;
    }
    return n;
  }

  /** 分值随落子增量更新，节点只需扫描邻近空点。 */
  private gather(color: Player, ply = 0, foursOnly = false): number {
    let n = 0;
    const attack = this.position.attack[color - 1];
    const defend = this.position.attack[other(color) - 1];
    const offset = (color - 1) * this.cells.length;
    for (let idx = 0; idx < this.cells.length; idx++) {
      if (this.cells[idx] || !this.position.neighbors[idx]
        || (foursOnly && attack[idx] < SHAPE_SCORE[Shape.FOUR]) || this.forbidden(idx, color)) continue;
      this.gatherBuf[n] = idx;
      // 防守与进攻都参与排序；历史与杀手只打破较安静着法的平局。
      this.scoreBuf[n] = attack[idx] + defend[idx] * 1.08
        + Math.min(2000, this.history[offset + idx])
        + (this.killers[ply * 2] === idx ? 2000 : this.killers[ply * 2 + 1] === idx ? 1000 : 0);
      n++;
    }
    return n;
  }

  /** 取分值最高的前 limit 个候选（部分选择排序） */
  private orderTop(n: number, limit: number, ttMove: number): number {
    const buf = this.gatherBuf;
    const sc = this.scoreBuf;
    const out = this.orderBuf;
    // 置换表着法优先
    let count = 0;
    for (let i = 0; i < n && count < limit; i++) {
      if (buf[i] === ttMove) {
        out[count++] = ttMove;
        sc[i] = -1;
        break;
      }
    }
    for (let k = count; k < limit; k++) {
      let bestIdx = -1;
      let bestVal = -1;
      for (let i = 0; i < n; i++) {
        if (sc[i] > bestVal) {
          bestVal = sc[i];
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      out[k] = buf[bestIdx];
      sc[bestIdx] = -1;
      count++;
    }
    return count;
  }

  /* ---------------- 置换表 ---------------- */

  private ttProbe(depth: number, alpha: number, beta: number, ply: number): { hit: boolean; score: number; move: number } {
    const i = ((this.key.lo ^ this.key.hi) >>> 0) & TT_MASK;
    if (this.ttDepth[i] < 0 || this.ttKey[i] !== this.key.hi || this.ttLo[i] !== this.key.lo) return { hit: false, score: 0, move: -1 };
    const stored = this.ttScore[i];
    const score = stored >= WIN - MAX_PLY ? stored - ply : stored <= -WIN + MAX_PLY ? stored + ply : stored;
    const flag = this.ttFlag[i];
    const move = this.ttMove[i];
    if (this.ttDepth[i] >= depth) {
      if (flag === 0) return { hit: true, score, move };
      if (flag === 1 && score >= beta) return { hit: true, score, move };
      if (flag === 2 && score <= alpha) return { hit: true, score, move };
    }
    return { hit: false, score, move };
  }

  private ttStore(depth: number, score: number, flag: number, move: number, ply: number): void {
    const i = ((this.key.lo ^ this.key.hi) >>> 0) & TT_MASK;
    this.ttKey[i] = this.key.hi;
    this.ttLo[i] = this.key.lo;
    this.ttDepth[i] = Math.min(depth, 120);
    this.ttFlag[i] = flag;
    this.ttScore[i] = score >= WIN - MAX_PLY ? score + ply : score <= -WIN + MAX_PLY ? score - ply : Math.round(score);
    this.ttMove[i] = move;
  }

  /* ---------------- 主搜索 ---------------- */

  private negamax(depth: number, alpha: number, beta: number, color: Player, ply: number): number {
    this.nodes++;
    if (now() >= this.deadline) throw ABORT;

    const opp = other(color);

    if (this.winPoints(color, this.winBufA) > 0) return WIN - ply;
    const oppWins = this.winPoints(opp, this.winBufB);
    if (oppWins > 1) return -(WIN - ply - 2);
    if (this.stoneCount >= this.cells.length) return 0;

    const forced = oppWins === 1 ? this.winBufB[0] : -1;
    if (depth <= 0 && forced < 0) return this.position.evaluate(color);

    const tt = forced < 0 ? this.ttProbe(depth, alpha, beta, ply) : { hit: false, score: 0, move: -1 };
    if (tt.hit) return tt.score;

    const alphaOrig = alpha;
    let bestScore = -INF;
    let bestMove = -1;

    if (forced >= 0) {
      if (this.forbidden(forced, color)) return -(WIN - ply - 2);
      if (ply >= MAX_PLY) return this.position.evaluate(color);
      const idx = forced;
      this.place(idx, color);
      try {
        bestScore = -this.negamax(Math.max(depth - 1, 0) + 1, -beta, -alpha, opp, ply + 1);
      } finally {
        this.undo(idx, color);
      }
      bestMove = idx;
    } else {
      const n = this.gather(color, ply);
      if (n === 0) return 0;
      const ttMove = tt.move;
      const count = this.orderTop(n, this.config.branchLimit, ttMove);
      const moves = this.moveStack[ply];
      moves.set(this.orderBuf.subarray(0, count));
      let searched = 0;
      for (let k = 0; k < count; k++) {
        const idx = moves[k];
        if (this.forbidden(idx, color)) continue;
        const tactical = this.position.attack[color - 1][idx] >= SHAPE_SCORE[Shape.OPEN_THREE]
          || this.position.attack[opp - 1][idx] >= SHAPE_SCORE[Shape.OPEN_THREE];
        this.place(idx, color);
        let score: number;
        try {
          const x = idx % this.size;
          const y = (idx / this.size) | 0;
          if (makesFive(this.cells, this.size, x, y, color)) {
            score = WIN - ply;
          } else if (ply >= MAX_PLY) {
            score = this.position.evaluate(color);
          } else {
            // 走「四」是强制手，给予深度延伸
            const extension = this.createsFour(idx, color) ? 1 : 0;
            const nd = Math.max(depth - 1, 0) + extension;
            if (searched === 0) {
              score = -this.negamax(nd, -beta, -alpha, opp, ply + 1);
            } else {
              // 靠后的安静着法先少算一层；若超过 alpha，恢复完整深度验证。
              const reduced = depth >= 3 && searched >= 4 && !tactical && !extension;
              score = -this.negamax(reduced ? nd - 1 : nd, -alpha - 1, -alpha, opp, ply + 1);
              if (reduced && score > alpha) {
                score = -this.negamax(nd, -alpha - 1, -alpha, opp, ply + 1);
              }
              if (score > alpha && score < beta) {
                score = -this.negamax(nd, -beta, -alpha, opp, ply + 1);
              }
            }
          }
        } finally {
          this.undo(idx, color);
        }
        searched++;

        if (score > bestScore) {
          bestScore = score;
          bestMove = idx;
        }
        if (bestScore > alpha) alpha = bestScore;
        if (alpha >= beta) {
          if (this.killers[ply * 2] !== idx) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2];
            this.killers[ply * 2] = idx;
          }
          const h = (color - 1) * this.cells.length + idx;
          this.history[h] = Math.min(2000, this.history[h] + depth * depth);
          break;
        }
      }
      if (searched === 0) return this.position.evaluate(color);
    }

    const flag = bestScore <= alphaOrig ? 2 : bestScore >= beta ? 1 : 0;
    this.ttStore(depth, bestScore, flag, bestMove, ply);
    return bestScore;
  }

  /** 迭代加深 + 根节点处理 */
  run(turn: Player, forcedMove?: Point): SearchOutcome {
    const start = now();
    this.deadline = start + this.config.timeMs;
    const size = this.size;
    const opp = other(turn);

    const outcome: SearchOutcome = {
      move: null,
      score: 0,
      depth: 0,
      nodes: 0,
      elapsedMs: 0,
      candidates: [],
      pv: [],
      forcedWin: null,
    };

    // 空盘：天元
    if (this.stoneCount === 0) {
      const c = (size - 1) >> 1;
      outcome.move = { x: c, y: c };
      outcome.score = 0;
      outcome.elapsedMs = now() - start;
      return outcome;
    }

    // 1. 我能一步成五
    if (this.winPoints(turn, this.winBufA) > 0) {
      const idx = this.winBufA[0];
      outcome.move = idxToPoint(idx, size);
      outcome.forcedWin = { kind: 'five', label: '一步成五', line: [outcome.move] };
      outcome.score = WIN;
      outcome.elapsedMs = now() - start;
      return outcome;
    }

    // 2. 指定着法（例如玩家请求提示后强制走某点）
    if (forcedMove) {
      outcome.move = forcedMove;
      outcome.elapsedMs = now() - start;
      return outcome;
    }

    // 3. 对手的成五点：必须封堵
    const oppWins = this.winPoints(opp, this.winBufB);
    if (oppWins > 0) {
      const idx = Array.from(this.winBufB.subarray(0, oppWins)).find(i => !this.forbidden(i, turn));
      outcome.move = idx === undefined ? this.rootCandidates(turn)[0]?.point ?? null : idxToPoint(idx, size);
      outcome.score = oppWins > 1 || idx === undefined ? -(WIN - 2) : 0;
      if (oppWins > 1) {
        outcome.forcedWin = { kind: 'five', label: '对手双成五点，已无法挽回', line: [] };
      }
      outcome.elapsedMs = now() - start;
      return outcome;
    }

    // 4. VCF 证明杀法，找到便直接执行第一手
    let forcedWin: ForcedWin | null = null;
    const rootCandidates = this.rootCandidates(turn);
    if (this.config.useVcf) {
      const vcfLine = this.tryVcf(turn);
      if (vcfLine) {
        forcedWin = { kind: 'vcf', label: `VCF ${Math.ceil(vcfLine.length / 2)} 手算杀`, line: vcfLine };
      }
    }

    if (forcedWin?.line[0]) {
      outcome.move = forcedWin.line[0];
      outcome.score = WIN - forcedWin.line.length;
      outcome.forcedWin = forcedWin;
      outcome.pv = forcedWin.line;
      outcome.candidates = rootCandidates.slice(0, 8);
      outcome.nodes = this.vcfNodes;
      outcome.elapsedMs = now() - start;
      return outcome;
    }

    // 5. 迭代加深
    let best = rootCandidates[0]?.point ?? null;
    let bestScore = -INF;
    let reachedDepth = 0;
    const orderedRoot = rootCandidates.map((c) => ({ idx: c.y * size + c.x, score: c.analysis.heuristic }));
    orderedRoot.sort((a, b) => b.score - a.score);

    try {
      for (let depth = 1; depth <= this.config.maxDepth; depth++) {
        const scored: Array<{ idx: number; score: number }> = [];
        let alpha = -INF;
        for (let i = 0; i < orderedRoot.length; i++) {
          if (now() >= this.deadline) throw ABORT;
          const idx = orderedRoot[i].idx;
          if (this.forbidden(idx, turn)) continue;
          this.place(idx, turn);
          let score: number;
          try {
            const x = idx % size;
            const y = (idx / size) | 0;
            if (makesFive(this.cells, this.size, x, y, turn)) {
              score = WIN;
            } else {
              if (i === 0) score = -this.negamax(depth - 1, -INF, INF, opp, 1);
              else {
                score = -this.negamax(depth - 1, -alpha - 1, -alpha, opp, 1);
                if (score > alpha) score = -this.negamax(depth - 1, -INF, -alpha, opp, 1);
              }
            }
          } finally {
            this.undo(idx, turn);
          }
          scored.push({ idx, score });
          if (score > alpha) alpha = score;
        }
        if (scored.length === 0) break;
        scored.sort((a, b) => b.score - a.score);
        bestScore = scored[0].score;
        best = idxToPoint(scored[0].idx, size);
        reachedDepth = depth;
        this.ttStore(depth, bestScore, 0, scored[0].idx, 0);
        // 用上一层结果重新排序，提升剪枝效率
        for (let i = 0; i < scored.length && i < orderedRoot.length; i++) orderedRoot[i] = scored[i];
        if (bestScore >= WIN - 100) break; // 已经找到必胜
        if (now() > this.deadline) break;
      }
    } catch (e) {
      if (e !== ABORT) throw e;
    }

    outcome.move = best;
    outcome.score = bestScore === -INF ? 0 : bestScore;
    outcome.depth = reachedDepth;
    outcome.nodes = this.nodes;
    outcome.elapsedMs = now() - start;
    outcome.forcedWin = forcedWin;

    if (!forcedWin && best && bestScore >= WIN - MAX_PLY) {
      const candidate = rootCandidates.find(c => c.x === best!.x && c.y === best!.y);
      if (candidate && candidate.analysis.doubleThreat !== 'none') {
        outcome.forcedWin = { kind: 'double', label: doubleThreatLabel(candidate.analysis), line: [best] };
      }
    }

    // 弱等级：在接近最优的着法里随机选择，制造「人味」
    if (this.config.randomness > 0 && outcome.move && !outcome.forcedWin) {
      const pool = rootCandidates.filter((c) => c.analysis.score >= rootCandidates[0].analysis.score * 0.55);
      if (pool.length > 1 && Math.random() < this.config.randomness) {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        outcome.move = { x: pick.x, y: pick.y };
      }
    }

    outcome.candidates = rootCandidates.slice(0, 8);
    outcome.pv = this.extractPv(turn, 6);
    if (outcome.move && (!outcome.pv[0] || outcome.pv[0].x !== outcome.move.x || outcome.pv[0].y !== outcome.move.y)) {
      outcome.pv = [outcome.move];
    }
    return outcome;
  }

  /** 根节点候选：用完整威胁分析给出可读的分值与棋形 */
  private rootCandidates(color: Player): Array<RootCandidate & { point: Point }> {
    const size = this.size;
    const n = this.gather(color);
    const out: Array<RootCandidate & { point: Point }> = [];
    const limit = Math.max(this.config.branchLimit + 4, 16);
    // 先按启发式取前若干个，再做精确威胁分析
    const idx = this.orderTop(n, limit, -1);
    for (let k = 0; k < idx; k++) {
      const i = this.orderBuf[k];
      const x = i % size;
      const y = (i / size) | 0;
      if (this.forbidden(i, color)) continue;
      const analysis = analyzePoint(this.cells, size, x, y, color);
      analysis.heuristic = this.position.attack[color - 1][i] + this.position.attack[other(color) - 1][i] * 1.08;
      out.push({ x, y, point: { x, y }, score: analysis.score, analysis });
    }
    out.sort((a, b) => b.analysis.heuristic - a.analysis.heuristic);
    return out;
  }

  /* ---------------- 必胜侦测（公开给 UI） ---------------- */

  detectWin(turn: Player): ForcedWin | null {
    this.deadline = now() + this.config.timeMs;
    if (this.stoneCount === 0) return null;
    const size = this.size;
    if (this.winPoints(turn, this.winBufA) > 0) {
      return { kind: 'five', label: '一步成五', line: [idxToPoint(this.winBufA[0], size)] };
    }
    if (this.winPoints(other(turn), this.winBufB) > 0) return null;
    const cands = this.rootCandidates(turn);
    for (const candidate of cands) {
      if (candidate.analysis.doubleThreat === 'none') continue;
      const idx = candidate.y * size + candidate.x;
      this.place(idx, turn);
      try {
        // 双活三、四三不是无条件必胜：先验证对手的反先与强制应手。
        if (-this.negamax(4, -INF, INF, other(turn), 1) >= WIN - MAX_PLY) {
          return { kind: 'double', label: doubleThreatLabel(candidate.analysis), line: [candidate.point] };
        }
      } catch (error) {
        if (error !== ABORT) throw error;
        return null;
      } finally {
        this.undo(idx, turn);
      }
    }
    if (this.config.useVcf) {
      const line = this.tryVcf(turn);
      if (line) return { kind: 'vcf', label: `VCF ${Math.ceil(line.length / 2)} 手算杀`, line };
    }
    return null;
  }

  /* ---------------- VCF 算杀 ---------------- */
  /**
   * 连续冲四取胜搜索。返回从当前局面开始的制胜路线（含双方着法）；
   * 若不存在则返回 null。
   */
  private tryVcf(turn: Player): Point[] | null {
    this.vcfNodes = 0;
    this.vcfBudget = 20000;
    this.vcfDeadline = Math.min(this.deadline, now() + Math.min(500, this.config.timeMs * 0.25));
    const line: number[] = [];
    const ok = this.vcf(this.config.vcfDepth, turn, line, 1);
    if (!ok) return null;
    return line.map((i) => idxToPoint(i, this.size));
  }

  private vcf(depth: number, color: Player, line: number[], ply: number): boolean {
    if (ply >= MAX_PLY || ++this.vcfNodes > this.vcfBudget || now() >= this.vcfDeadline) return false;
    if (this.winPoints(color, this.winBufA) > 0) {
      line.push(this.winBufA[0]);
      return true;
    }
    if (depth <= 0) return false;
    const opp = other(color);
    const oppWins = this.winPoints(opp, this.winBufB);
    if (oppWins > 1) return false;
    const forced = oppWins === 1 ? this.winBufB[0] : -1;
    const n = this.gather(color, 0, true);
    const count = this.orderTop(n, n, forced);
    const moves = this.moveStack[ply];
    moves.set(this.orderBuf.subarray(0, count));
    for (let k = 0; k < count; k++) {
      const idx = moves[k];
      if (forced >= 0 && idx !== forced) continue;
      if (this.position.attack[color - 1][idx] < SHAPE_SCORE[Shape.FOUR]) continue;
      const length = line.length;
      this.place(idx, color);
      let won = false;
      try {
        if (!this.createsFour(idx, color) || this.winPoints(opp, this.winBufB)) continue;
        line.push(idx);
        const wins = this.winPoints(color, this.winBufA);
        if (wins >= 2) {
          line.push(this.winBufA[0]);
          won = true;
          return true;
        }
        if (wins === 1) {
          const block = this.winBufA[0];
          // 连珠中黑棋不能合法封堵，也是一条已证明的杀法。
          if (this.forbidden(block, opp)) {
            won = true;
            return true;
          }
          this.place(block, opp);
          line.push(block);
          try {
            won = this.vcf(depth - 1, color, line, ply + 2);
            if (won) return true;
          } finally {
            this.undo(block, opp);
          }
        }
      } finally {
        this.undo(idx, color);
        if (!won) line.length = length;
      }
    }
    return false;
  }

  /* ---------------- 主变化提取 ---------------- */

  private extractPv(turn: Player, maxLen: number): Point[] {
    const pv: Point[] = [];
    let color = turn;
    const placed: Array<{ idx: number; color: Player }> = [];
    for (let i = 0; i < maxLen; i++) {
      const idx = ((this.key.lo ^ this.key.hi) >>> 0) & TT_MASK;
      if (this.ttDepth[idx] < 0 || this.ttKey[idx] !== this.key.hi || this.ttLo[idx] !== this.key.lo) break;
      const move = this.ttMove[idx];
      if (move < 0 || move >= this.cells.length || this.cells[move] !== 0 || this.forbidden(move, color)) break;
      pv.push(idxToPoint(move, this.size));
      const mover = color;
      this.place(move, mover);
      placed.push({ idx: move, color: mover });
      color = other(color);
      if (makesFive(this.cells, this.size, move % this.size, (move / this.size) | 0, mover)) break;
    }
    for (let i = placed.length - 1; i >= 0; i--) this.undo(placed[i].idx, placed[i].color);
    return pv;
  }

  get nodeCount(): number {
    return this.nodes;
  }
}

/* ------------------------------------------------------------------ */

function idxToPoint(idx: number, size: number): Point {
  return { x: idx % size, y: (idx / size) | 0 };
}

function doubleThreatLabel(a: PointAnalysis): string {
  switch (a.doubleThreat) {
    case 'double-three':
      return '双活三 · 必胜';
    case 'four-three':
      return '四三双杀 · 必胜';
    case 'double-four':
      return '双四 · 必胜';
    default:
      return '必胜之手';
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/* ------------------------------------------------------------------ */

export function search(
  cells: Int8Array,
  turn: Player,
  config: Partial<SearchConfig> = {},
  forcedMove?: Point,
): SearchOutcome {
  const cfg: SearchConfig = { ...DEFAULT_CONFIG, ...config };
  const searcher = new Searcher(cells, cfg.size, cfg);
  return searcher.run(turn, forcedMove);
}

/**
 * 只做「必胜」侦测（不做全局搜索），用于 UI 的必胜动画触发。
 * 依次检查：一步成五 → 双威胁手 → VCF 连续冲四算杀。
 */
export function detectForcedWin(
  cells: Int8Array,
  turn: Player,
  config: Partial<SearchConfig> = {},
): ForcedWin | null {
  const cfg: SearchConfig = { ...DEFAULT_CONFIG, ...config, maxDepth: 2, timeMs: config.timeMs ?? 400 };
  const searcher = new Searcher(cells, cfg.size, cfg);
  return searcher.detectWin(turn);
}
