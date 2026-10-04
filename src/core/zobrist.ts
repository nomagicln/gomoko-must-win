/**
 * Zobrist 哈希：用于置换表与局面去重。
 * 使用两个 32 位整数拼成 64 位哈希（避免 BigInt 带来的性能损耗）。
 */

import { BLACK, type Player } from './types';

const SEED = 0x9e3779b9;

/** 确定性伪随机：xorshift32，保证各端一致，便于测试。 */
function makeRng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

export interface ZobristKey {
  lo: number;
  hi: number;
}

export class Zobrist {
  readonly size: number;
  private readonly lo: Int32Array;
  private readonly hi: Int32Array;
  private readonly lo2: Int32Array;
  private readonly hi2: Int32Array;
  private readonly turnLo: number;
  private readonly turnHi: number;

  constructor(size: number) {
    this.size = size;
    const cells = size * size;
    this.lo = new Int32Array(cells);
    this.hi = new Int32Array(cells);
    this.lo2 = new Int32Array(cells);
    this.hi2 = new Int32Array(cells);
    const rng = makeRng(SEED ^ size);
    for (let i = 0; i < cells; i++) {
      this.lo[i] = rng() | 0;
      this.hi[i] = rng() | 0;
      this.lo2[i] = rng() | 0;
      this.hi2[i] = rng() | 0;
    }
    this.turnLo = rng() | 0;
    this.turnHi = rng() | 0;
  }

  /** 在 key 上叠加 / 移除一枚棋子 */
  toggle(key: ZobristKey, idx: number, player: Player): void {
    if (player === BLACK) {
      key.lo ^= this.lo[idx];
      key.hi ^= this.hi[idx];
    } else {
      key.lo ^= this.lo2[idx];
      key.hi ^= this.hi2[idx];
    }
  }

  /** 轮到白棋走时叠加，用于区分「同一局面、不同行棋方」 */
  toggleTurn(key: ZobristKey): void {
    key.lo ^= this.turnLo;
    key.hi ^= this.turnHi;
  }

  keyOf(idx: number, player: Player): ZobristKey {
    if (player === BLACK) return { lo: this.lo[idx], hi: this.hi[idx] };
    return { lo: this.lo2[idx], hi: this.hi2[idx] };
  }
}

export const hashKey = (k: ZobristKey): string => `${k.hi >>> 0}:${k.lo >>> 0}`;
