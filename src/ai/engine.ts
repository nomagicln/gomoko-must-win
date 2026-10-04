/**
 * AI 对外接口：难度预设、Web Worker 通信与主线程兜底。
 */

import type { Player, Point, RuleSet } from '../core/types';
import { search, detectForcedWin, type ForcedWin, type SearchConfig, type SearchOutcome } from './search';

export type Difficulty = 'novice' | 'easy' | 'hard' | 'master';

export interface DifficultySpec {
  id: Difficulty;
  name: string;
  en: string;
  /** 一句话风格描述 */
  desc: string;
  /** 大致棋力标注 */
  strength: string;
  config: Partial<SearchConfig>;
}

export const DIFFICULTIES: DifficultySpec[] = [
  {
    id: 'novice',
    name: '入门',
    en: 'Novice',
    desc: '只看一两步，会漏杀也会犯错，适合刚学会规则的朋友。',
    strength: '适合初学',
    config: { maxDepth: 2, timeMs: 220, branchLimit: 6, randomness: 0.72, useVcf: false, vcfDepth: 0 },
  },
  {
    id: 'easy',
    name: '进阶',
    en: 'Adept',
    desc: '会封冲四、判断活三，也能找到短链连续冲四的杀法。',
    strength: '基础攻防',
    config: { maxDepth: 4, timeMs: 750, branchLimit: 10, randomness: 0.18, useVcf: true, vcfDepth: 4 },
  },
  {
    id: 'hard',
    name: '大师',
    en: 'Master',
    desc: '更深的攻防搜索，识别四三与双威胁，主动争取先手。',
    strength: '战术挑战',
    config: { maxDepth: 12, timeMs: 1600, branchLimit: 14, randomness: 0, useVcf: true, vcfDepth: 14 },
  },
  {
    id: 'master',
    name: '宗师',
    en: 'Grandmaster',
    desc: '更宽的候选与长链连续冲四算杀，兼顾反先、防守与进攻。',
    strength: '最强挑战',
    config: { maxDepth: 16, timeMs: 3500, branchLimit: 18, randomness: 0, useVcf: true, vcfDepth: 22 },
  },
];

export const difficultyById = (id: Difficulty): DifficultySpec =>
  DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[2];

export interface ThinkRequest {
  cells: Int8Array;
  size: number;
  turn: Player;
  rules: RuleSet;
  difficulty: Difficulty;
  /** 覆盖预设的时间上限 */
  timeMs?: number;
}

export interface DetectRequest {
  cells: Int8Array;
  size: number;
  turn: Player;
  rules: RuleSet;
}

export type WorkerRequest =
  | { id: number; type: 'search'; payload: ThinkRequest }
  | { id: number; type: 'detect'; payload: DetectRequest };

export type WorkerResponse =
  | { id: number; type: 'search'; ok: true; result: SearchOutcome }
  | { id: number; type: 'detect'; ok: true; result: ForcedWin | null }
  | { id: number; type: 'error'; ok: false; message: string };

function configFor(req: { size: number; rules: RuleSet; difficulty?: Difficulty; timeMs?: number }): SearchConfig {
  const spec = difficultyById(req.difficulty ?? 'hard');
  const cfg: SearchConfig = {
    size: req.size,
    rules: req.rules,
    maxDepth: spec.config.maxDepth ?? 8,
    timeMs: req.timeMs ?? spec.config.timeMs ?? 1800,
    branchLimit: spec.config.branchLimit ?? 12,
    randomness: spec.config.randomness ?? 0,
    useVcf: spec.config.useVcf ?? true,
    vcfDepth: spec.config.vcfDepth ?? 8,
    honorForbidden: true,
  };
  return cfg;
}

/** 主线程直接计算（Worker 不可用时的兜底） */
export function thinkSync(req: ThinkRequest): SearchOutcome {
  return search(req.cells, req.turn, configFor(req));
}

export function detectSync(req: DetectRequest): ForcedWin | null {
  return detectForcedWin(req.cells, req.turn, configFor({ ...req, timeMs: 180 }));
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/**
 * AI 客户端：优先使用 Web Worker 保证界面 60fps；
 * 若 Worker 创建失败（极端浏览器环境）则自动降级为主线程计算。
 */
export class AIClient {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;

  constructor() {
    this.createWorker();
  }

  private createWorker(): void {
    try {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        if (this.worker === worker) this.onMessage(e.data);
      };
      worker.onerror = () => {
        if (this.worker !== worker) return;
        // Worker 内部错误：清理挂起的请求，让调用方走兜底路径
        for (const [, p] of this.pending) p.reject(new Error('AI worker error'));
        this.pending.clear();
        this.worker?.terminate();
        this.worker = null;
      };
    } catch {
      this.worker = null;
    }
  }

  /** 重开 / 悔棋时停止旧计算，避免新一局排在旧搜索后面。 */
  cancel(): void {
    if (this.disposed || this.pending.size === 0) return;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new DOMException('AI calculation cancelled', 'AbortError'));
    this.pending.clear();
    this.createWorker();
  }

  get usingWorker(): boolean {
    return this.worker !== null;
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg.result);
  }

  think(req: ThinkRequest): Promise<SearchOutcome> {
    if (this.disposed) return Promise.reject(new Error('AI client disposed'));
    if (!this.worker) return Promise.resolve(thinkSync(req));
    const id = ++this.seq;
    const payload: ThinkRequest = { ...req, cells: req.cells.slice() };
    return new Promise<SearchOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, type: 'search', payload } satisfies WorkerRequest);
    });
  }

  detect(req: DetectRequest): Promise<ForcedWin | null> {
    if (this.disposed) return Promise.reject(new Error('AI client disposed'));
    if (!this.worker) return Promise.resolve(detectSync(req));
    const id = ++this.seq;
    const payload: DetectRequest = { ...req, cells: req.cells.slice() };
    return new Promise<ForcedWin | null>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, type: 'detect', payload } satisfies WorkerRequest);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new DOMException('AI client disposed', 'AbortError'));
    this.pending.clear();
  }
}

/** 从 SearchOutcome 中提取最有价值的一句评语 */
export function describeOutcome(outcome: SearchOutcome, turn: Player): string {
  if (outcome.forcedWin) return outcome.forcedWin.label;
  const who = turn === 1 ? '黑棋' : '白棋';
  if (outcome.score >= 8_000_000) return `${who}已形成必胜之势`;
  if (outcome.score <= -8_000_000) return `${who}形势危急`;
  if (outcome.score > 100_000) return `${who}占据主动`;
  if (outcome.score < -100_000) return `${who}稍处下风`;
  return '双方均势，攻守转换之间';
}

export const pointText = (p: Point): string => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
export type { SearchOutcome, ForcedWin, SearchConfig };
