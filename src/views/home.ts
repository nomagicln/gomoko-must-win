/**
 * 首页：品牌叙事 + 自动演示棋盘 + 玩法入口。
 */

import { ALL_OPENINGS } from '../ai/book';
import { DIFFICULTIES } from '../ai/engine';
import { Board } from '../core/board';
import { BLACK } from '../core/types';
import { sound } from '../ui/audio';
import { el, icon } from '../ui/dom';
import { BoardRenderer, demoSequence } from '../ui/renderer';
import type { AppContext, View } from '../app';

export class HomeView implements View {
  private readonly ctx: AppContext;
  private renderer: BoardRenderer | null = null;
  private timer = 0;
  private board = new Board({ size: 15 });
  private seq = demoSequence(15);
  private idx = 0;
  private holdUntil = 0;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(): HTMLElement {
    const root = el('div', { class: 'view view--home' });

    // ---------------- Hero ----------------
    const canvas = el('canvas', { class: 'board-canvas', 'aria-hidden': 'true' });
    const demoFrame = el(
      'div',
      {
        class: 'board-frame hero__board-inner',
        role: 'button',
        tabindex: '0',
        title: '点击开始人机对弈',
        onclick: () => this.ctx.navigate('#/ai'),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') this.ctx.navigate('#/ai');
        },
      },
      canvas,
    );
    const heroBoard = el('div', { class: 'hero__board' }, demoFrame, el('div', { class: 'hero__board-hint', text: '点击棋盘 · 立即人机对弈' }));

    const stats = el(
      'div',
      { class: 'hero__stats' },
      stat(`${DIFFICULTIES.length}`, '档 AI 强度'),
      stat(`${ALL_OPENINGS.length}`, '种开局定式'),
      stat(`${ALL_OPENINGS.reduce((n, o) => n + o.variations.length, 0)}`, '个变化详解'),
      stat('0', '台服务器依赖'),
    );

    const hero = el(
      'section',
      { class: 'hero' },
      el(
        'div',
        { class: 'hero__copy' },
        el('div', { class: 'hero__eyebrow', text: 'Ink · Gomoku · 2026' }),
        el(
          'h1',
          { class: 'hero__title' },
          el('span', { class: 'ink', text: '墨韵' }),
          el('br'),
          el('span', { class: 'ink stroke', text: '五子棋' }),
        ),
        el(
          'p',
          { class: 'hero__lead' },
          '一方棋盘，两种对手。与 ',
          el('strong', { text: '四档强度的 AI' }),
          ' 拆解攻杀，或与朋友',
          el('strong', { text: '同屏切磋或在线联机' }),
          '。从 ',
          el('strong', { text: '26 种开局定式' }),
          ' 开始，把「随手一子」变成「有谱可循」。',
        ),
        el(
          'div',
          { class: 'hero__cta' },
          el('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/ai') }, icon('swords', 18), '开始人机对战'),
          el('button', { class: 'btn btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/online') }, icon('users', 18), '双人对战'),
          el('button', { class: 'btn btn--ghost btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/lessons') }, icon('book', 18), '进定式道场'),
        ),
        stats,
      ),
      heroBoard,
    );

    root.appendChild(hero);

    this.renderer = new BoardRenderer(
      canvas,
      {
        size: 15,
        cells: this.board.rawCells(),
        moves: [],
        lastMove: null,
        winLine: null,
        heat: [],
        markers: [],
        ghost: null,
        winPath: null,
        showCoords: false,
        showNumbers: false,
        interactive: false,
      },
      { reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches },
    );

    this.tick();
    this.timer = window.setInterval(() => this.tick(), 640);
    return root;
  }

  destroy(): void {
    window.clearInterval(this.timer);
    this.renderer?.destroy();
  }

  private tick(): void {
    if (!this.renderer) return;
    const now = Date.now();
    if (now < this.holdUntil) return;

    if (this.idx >= this.seq.length) {
      // 演示结束：稍作停留后重开
      if (this.holdUntil === 0) {
        this.holdUntil = now + 2600;
        return;
      }
      this.holdUntil = 0;
      this.board = new Board({ size: 15 });
      this.idx = 0;
      this.renderer.setState({
        cells: this.board.rawCells(),
        moves: [],
        lastMove: null,
        winLine: null,
      });
      return;
    }

    const p = this.seq[this.idx++];
    const result = this.board.place(p.x, p.y);
    if (!result.ok || !result.move) return;
    this.renderer.registerStone(result.move);
    this.renderer.setState({
      cells: this.board.rawCells(),
      moves: this.board.moves,
      lastMove: result.move,
      winLine: result.win?.line ?? null,
    });
    if (result.win) {
      this.renderer.flashWin(result.win.line);
      this.holdUntil = Date.now() + 2600;
      this.idx = this.seq.length;
    }
  }
}

function stat(value: string, label: string): HTMLElement {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'stat__value', text: value }),
    el('div', { class: 'stat__label', text: label }),
  );
}

/** 首页演示棋局的落子音效（静音时无副作用） */
export function playDemoTick(): void {
  sound.play('tick');
}

export { BLACK };
