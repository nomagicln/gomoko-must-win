/**
 * 开局定式库：把 26 种开局的所有变化建成一棵前缀树，
 * 用于对局中实时识别「定式 / 脱谱」，并给出后续推荐着法。
 */

import type { Point } from '../core/types';
import { OPENINGS, type Opening, type OpeningVariation } from '../data/openings';

export interface VariationIndex {
  opening: Opening;
  variation: OpeningVariation;
  /** 该变化在整棵棋谱树中的完整着法序列 */
  moves: Point[];
}

export interface BookNode {
  /** 经过该节点的变化 */
  entries: VariationIndex[];
  children: Map<string, BookNode>;
}

export interface BookMatch {
  openingName: string;
  openingId: string;
  category: Opening['category'];
  variationName: string;
  tag: OpeningVariation['tag'];
  summary: string;
  /** 已匹配的手数 */
  ply: number;
  /** 书中的下一手（可能有多个分支） */
  nextMoves: Point[];
  /** 该变化剩余的理论着法 */
  remaining: Point[];
}

const key = (p: Point): string => `${p.x},${p.y}`;

function buildTree(): BookNode {
  const root: BookNode = { entries: [], children: new Map() };
  for (const opening of OPENINGS) {
    for (const variation of opening.variations) {
      const entry: VariationIndex = { opening, variation, moves: variation.moves.map((m) => ({ x: m.x, y: m.y })) };
      let node = root;
      node.entries.push(entry);
      for (const move of entry.moves) {
        const k = key(move);
        let child = node.children.get(k);
        if (!child) {
          child = { entries: [], children: new Map() };
          node.children.set(k, child);
        }
        child.entries.push(entry);
        node = child;
      }
    }
  }
  return root;
}

export const BOOK_TREE: BookNode = buildTree();

export const OPENING_BY_ID: ReadonlyMap<string, Opening> = new Map(OPENINGS.map((o) => [o.id, o]));

export const ALL_OPENINGS: readonly Opening[] = OPENINGS;

/** 沿着实际着法前进，返回命中的最深节点（未命中返回 null） */
export function walkBook(moves: readonly Point[]): { node: BookNode; ply: number } | null {
  if (moves.length === 0) return null;
  let node = BOOK_TREE;
  for (let i = 0; i < moves.length; i++) {
    const child = node.children.get(key(moves[i]));
    if (!child) return null;
    node = child;
  }
  return { node, ply: moves.length };
}

/** 局面是否完全落在定式库内 */
export function inBook(moves: readonly Point[]): boolean {
  return walkBook(moves) !== null;
}

/** 识别当前局面对应的定式；不在库中返回 null */
export function bookLookup(moves: readonly Point[]): BookMatch | null {
  const hit = walkBook(moves);
  if (!hit || hit.node.entries.length === 0) return null;
  const entry = hit.node.entries[0];
  const nextMoves: Point[] = [];
  for (const [k] of hit.node.children) {
    const [x, y] = k.split(',').map(Number);
    nextMoves.push({ x, y });
  }
  const remaining = entry.moves.slice(moves.length);
  return {
    openingName: entry.opening.name,
    openingId: entry.opening.id,
    category: entry.opening.category,
    variationName: entry.variation.name,
    tag: entry.variation.tag,
    summary: entry.opening.summary,
    ply: hit.ply,
    nextMoves,
    remaining,
  };
}

/** 某个局面对应了哪些变化（可能多个） */
export function bookEntries(moves: readonly Point[]): VariationIndex[] {
  const hit = walkBook(moves);
  return hit ? hit.node.entries : [];
}

/** 该局面的下一步理论着法（用于定式教学与提示） */
export function bookNextMoves(moves: readonly Point[]): Point[] {
  const hit = walkBook(moves);
  if (!hit) return [];
  return [...hit.node.children.keys()].map((k) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y };
  });
}

/** 应用某个变化的前 n 手，得到局面 */
export function variationPrefix(variation: OpeningVariation, n: number): Point[] {
  return variation.moves.slice(0, Math.max(0, Math.min(n, variation.moves.length))).map((m) => ({ x: m.x, y: m.y }));
}

export const openingDisplay = (o: Opening): string => `${o.name}`;

export type { Opening, OpeningVariation };
