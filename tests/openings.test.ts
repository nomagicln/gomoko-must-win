import { describe, expect, it } from 'vitest';
import { OPENINGS } from '../src/data/openings';
import { bookLookup, inBook, BOOK_TREE } from '../src/ai/book';

describe('定式数据', () => {
  it('包含 26 种开局，直指 13 / 斜指 13', () => {
    expect(OPENINGS).toHaveLength(26);
    expect(OPENINGS.filter((o) => o.category === '直指')).toHaveLength(13);
    expect(OPENINGS.filter((o) => o.category === '斜指')).toHaveLength(13);
  });

  it('每个开局的两个分类内编号唯一且为 1..13', () => {
    for (const cat of ['直指', '斜指'] as const) {
      const nums = OPENINGS.filter((o) => o.category === cat).map((o) => o.number);
      expect([...nums].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    }
  });

  it('id 全局唯一，且每个开局至少 2 个变化', () => {
    const ids = OPENINGS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of OPENINGS) {
      expect(o.variations.length).toBeGreaterThanOrEqual(2);
      expect(o.summary.length).toBeGreaterThan(6);
      expect(o.theory.length).toBeGreaterThanOrEqual(2);
      expect(o.keyPoints.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('每个变化的着法合法：黑白交替、无重复、在盘内', () => {
    const varIds = new Set<string>();
    for (const o of OPENINGS) {
      for (const v of o.variations) {
        expect(varIds.has(v.id), `变化 id 重复：${v.id}`).toBe(false);
        varIds.add(v.id);
        expect(v.moves.length).toBeGreaterThanOrEqual(5);
        const seen = new Set<string>();
        for (const m of v.moves) {
          expect(m.x).toBeGreaterThanOrEqual(0);
          expect(m.x).toBeLessThan(15);
          expect(m.y).toBeGreaterThanOrEqual(0);
          expect(m.y).toBeLessThan(15);
          const k = `${m.x},${m.y}`;
          expect(seen.has(k), `${v.id} 落子重复于 ${k}`).toBe(false);
          seen.add(k);
        }
      }
    }
  });

  it('开局三手符合定式规范：黑1 天元、白2 相邻、黑3 在中央 5×5', () => {
    for (const o of OPENINGS) {
      for (const v of o.variations) {
        const [m1, m2, m3] = v.moves;
        expect([m1.x, m1.y], `${o.name} 黑1`).toEqual([7, 7]);
        if (o.category === '直指') expect([m2.x, m2.y], `${o.name} 白2`).toEqual([7, 8]);
        else expect([m2.x, m2.y], `${o.name} 白2`).toEqual([8, 8]);
        expect(m3.x).toBeGreaterThanOrEqual(5);
        expect(m3.x).toBeLessThanOrEqual(9);
        expect(m3.y).toBeGreaterThanOrEqual(5);
        expect(m3.y).toBeLessThanOrEqual(9);
      }
    }
  });

  it('同一开局的各变化在黑3之前完全一致', () => {
    for (const o of OPENINGS) {
      const first3 = o.variations.map((v) => v.moves.slice(0, 3).map((m) => `${m.x},${m.y}`).join('|'));
      expect(new Set(first3).size).toBe(1);
    }
  });

  it('小测题的答案落在该变化之内', () => {
    for (const o of OPENINGS) {
      for (const v of o.variations) {
        if (!v.quiz) continue;
        const has = v.moves.some((m) => m.x === v.quiz!.answer.x && m.y === v.quiz!.answer.y);
        expect(has, `${v.id} 的测验答案不在变化中`).toBe(true);
      }
    }
  });
});

describe('定式识别', () => {
  it('能够识别花月开局', () => {
    const huayue = OPENINGS.find((o) => o.name === '花月');
    expect(huayue).toBeDefined();
    const moves = huayue!.variations[0].moves.map((m) => ({ x: m.x, y: m.y }));
    const hit = bookLookup(moves);
    expect(hit?.openingName).toBe('花月');
    expect(hit?.nextMoves.length).toBe(0);
  });

  it('前三手即可识别开局', () => {
    const sample = OPENINGS[10].variations[0].moves.slice(0, 3).map((m) => ({ x: m.x, y: m.y }));
    const hit = bookLookup(sample);
    expect(hit).not.toBeNull();
    expect(hit!.openingName).toBe(OPENINGS[10].name);
    expect(hit!.nextMoves.length).toBeGreaterThan(0);
  });

  it('脱谱后不再命中', () => {
    const moves = [
      { x: 7, y: 7 },
      { x: 7, y: 8 },
      { x: 8, y: 8 },
      { x: 0, y: 0 },
    ];
    expect(inBook(moves)).toBe(false);
    expect(bookLookup(moves)).toBeNull();
  });

  it('前缀树包含全部变化', () => {
    expect(BOOK_TREE.children.size).toBe(1);
    const totalVariations = OPENINGS.reduce((n, o) => n + o.variations.length, 0);
    expect(BOOK_TREE.entries.length).toBe(totalVariations);
  });
});
