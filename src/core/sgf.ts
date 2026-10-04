/**
 * SGF 棋谱读写（GM[4] = 五子棋/连珠）。
 * 坐标约定与本站一致：a 列开始、行自上而下，因此天元在 15 路上为 hh。
 */

import type { Move, Player } from './types';
import { BLACK, WHITE } from './types';

const SGF_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const esc = (s: string): string => s.replace(/([\\\]])/g, '\\$1');

export interface SgfMeta {
  blackName?: string;
  whiteName?: string;
  event?: string;
  date?: string;
  result?: string;
  rules?: string;
}

export function toSgf(moves: readonly Move[], size = 15, meta: SgfMeta = {}): string {
  const head: string[] = ['GM[4]', 'FF[4]', 'CA[UTF-8]', `SZ[${size}]`];
  if (meta.event) head.push(`EV[${esc(meta.event)}]`);
  if (meta.date) head.push(`DT[${esc(meta.date)}]`);
  if (meta.blackName) head.push(`PB[${esc(meta.blackName)}]`);
  if (meta.whiteName) head.push(`PW[${esc(meta.whiteName)}]`);
  if (meta.result) head.push(`RE[${esc(meta.result)}]`);
  head.push(`RU[${esc(meta.rules ?? 'Gomoku')}]`);
  head.push('AP[ink-gomoku:1.0]');
  const body = moves
    .map((m) => `;${m.player === BLACK ? 'B' : 'W'}[${SGF_LETTERS[m.x] ?? 'a'}${SGF_LETTERS[m.y] ?? 'a'}]`)
    .join('');
  return `(;${head.join('')}${body})`;
}

export interface ParsedSgf {
  size: number;
  moves: Array<{ x: number; y: number; player: Player }>;
  meta: SgfMeta;
}

export function parseSgf(text: string): ParsedSgf {
  const sizeMatch = /SZ\[(\d+)\]/.exec(text);
  const size = sizeMatch ? Number(sizeMatch[1]) : 15;
  const meta: SgfMeta = {};
  const pick = (tag: string): string | undefined => {
    const m = new RegExp(`${tag}\\[((?:\\\\.|[^\\]])*)\\]`).exec(text);
    return m ? m[1].replace(/\\(.)/g, '$1') : undefined;
  };
  meta.blackName = pick('PB');
  meta.whiteName = pick('PW');
  meta.event = pick('EV');
  meta.date = pick('DT');
  meta.result = pick('RE');

  const moves: ParsedSgf['moves'] = [];
  const re = /;\s*([BW])\[([a-z]{0,2})\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const color = m[1].toUpperCase() === 'B' ? BLACK : WHITE;
    const coord = m[2];
    if (!coord) continue; // pass
    const x = SGF_LETTERS.indexOf(coord[0]);
    const y = SGF_LETTERS.indexOf(coord[1]);
    if (x < 0 || y < 0) continue;
    moves.push({ x, y, player: color });
  }
  return { size, moves, meta };
}

/** 生成可分享的战绩徽记（用于分享文案） */
export function sgfSummary(moves: readonly Move[]): string {
  return `${moves.length} 手`;
}
