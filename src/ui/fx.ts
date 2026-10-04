/**
 * 全屏特效：墨晕、朱砂印章、定式横幅。
 * 对应需求中的「定式识别」与「必胜触发」的仪式感表达。
 */

import { el } from './dom';
import { sound } from './audio';

let layer: HTMLElement | null = null;

export function fxLayer(): HTMLElement {
  if (!layer || !layer.isConnected) {
    layer = el('div', { class: 'fx-layer', 'aria-hidden': 'true' });
    document.body.appendChild(layer);
  }
  return layer;
}

/** 墨晕：从指定位置（默认屏幕中心）荡开一圈颜色 */
export function inkBloom(opts: { x?: number; y?: number; color?: string; scale?: number } = {}): void {
  const host = fxLayer();
  const node = el('div', { class: 'fx-bloom' });
  node.style.left = `${opts.x ?? window.innerWidth / 2}px`;
  node.style.top = `${opts.y ?? window.innerHeight / 2}px`;
  if (opts.color) node.style.setProperty('--bloom-color', opts.color);
  if (opts.scale) node.style.width = node.style.height = `${opts.scale}px`;
  host.appendChild(node);
  window.setTimeout(() => node.remove(), 1200);
}

/** 朱砂印章：如「必胜」「五连」「禁手」 */
export function sealStamp(text: string, sub?: string, ms = 1600): void {
  const host = fxLayer();
  const node = el(
    'div',
    { class: 'fx-seal' },
    el('div', { class: 'fx-seal__frame' }),
    el('div', { class: 'fx-seal__text', text }),
  );
  if (sub) node.appendChild(el('div', { class: 'fx-seal__sub', text: sub }));
  host.appendChild(node);
  window.setTimeout(() => node.remove(), ms);
}

/** 定式识别横幅 */
export function openingBanner(opts: { seal: string; title: string; sub: string }): void {
  const host = fxLayer();
  const node = el(
    'div',
    { class: 'fx-banner', role: 'status' },
    el('div', { class: 'fx-banner__seal', text: opts.seal }),
    el(
      'div',
      { class: 'fx-banner__text' },
      el('div', { class: 'fx-banner__title', text: opts.title }),
      el('div', { class: 'fx-banner__sub', text: opts.sub }),
    ),
  );
  host.appendChild(node);
  window.setTimeout(() => node.remove(), 3800);
}

/** 必胜仪式：墨晕 → 印章 → 音效 */
export function forcedWinFX(label: string, center?: { x: number; y: number }): void {
  sound.play('seal');
  inkBloom({ x: center?.x, y: center?.y, color: 'rgba(185,58,43,0.42)' });
  window.setTimeout(() => sealStamp('必胜', label), 120);
}

/** 胜利仪式 */
export function victoryFX(sub: string): void {
  sound.play('win');
  inkBloom({ color: 'rgba(200,169,81,0.4)' });
  window.setTimeout(() => {
    sealStamp('五连', sub);
    inkBloom({ x: window.innerWidth * 0.24, y: window.innerHeight * 0.3, color: 'rgba(185,58,43,0.32)' });
    inkBloom({ x: window.innerWidth * 0.78, y: window.innerHeight * 0.66, color: 'rgba(200,169,81,0.32)' });
  }, 240);
}

/** 禁手提示（轻微，不打断操作） */
export function forbiddenFX(): void {
  sound.play('undo');
  inkBloom({ color: 'rgba(185,58,43,0.28)' });
}
