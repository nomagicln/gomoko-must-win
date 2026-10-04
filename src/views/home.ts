/**
 * 首页：品牌叙事 + 自动演示棋盘 + 玩法入口。
 */

import { ALL_OPENINGS } from '../ai/book';
import { DIFFICULTIES } from '../ai/engine';
import { Board } from '../core/board';
import { BLACK } from '../core/types';
import { sound } from '../ui/audio';
import { append, el, icon } from '../ui/dom';
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
          '一方棋盘，两种对手 —— 与 ',
          el('strong', { text: '四档强度的 AI' }),
          ' 拆解攻杀，或与朋友',
          el('strong', { text: '用一个房间码联机' }),
          '。从 ',
          el('strong', { text: '26 种开局定式' }),
          ' 开始，把「随手一子」变成「有谱可循」。',
        ),
        el(
          'div',
          { class: 'hero__cta' },
          el('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/ai') }, icon('swords', 18), '开始人机对战'),
          el('button', { class: 'btn btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/online') }, icon('users', 18), '房间码联机'),
          el('button', { class: 'btn btn--ghost btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/lessons') }, icon('book', 18), '进定式道场'),
        ),
        stats,
      ),
      heroBoard,
    );

    // ---------------- 入口 ----------------
    const entries: Array<{ index: string; title: string; desc: string; foot: string; hash: string; glow: string; ico: string }> = [
      {
        index: '01',
        title: '人机对战',
        desc: '从「入门」到「宗师」四档棋力。AI 跑在浏览器里，能算活三、能识双杀，还会告诉你它在想哪几个点。',
        foot: '四档强度 · 热力图 · 提示',
        hash: '#/ai',
        glow: 'rgba(200,169,81,0.3)',
        ico: 'swords',
      },
      {
        index: '02',
        title: '在线联机',
        desc: '点一下生成房间码，发给朋友即可开战 —— WebRTC 点对点直连，没有服务器，也没有人能看到你们的棋。',
        foot: '房间码 · 聊天 · 悔棋协商',
        hash: '#/online',
        glow: 'rgba(79,156,132,0.3)',
        ico: 'users',
      },
      {
        index: '03',
        title: '本地双人',
        desc: '一台设备，两个人轮流落子。没有网络也能下，适合面对面的午后。',
        foot: '同屏轮换 · 自动记谱',
        hash: '#/local',
        glow: 'rgba(185,58,43,0.28)',
        ico: 'grid',
      },
      {
        index: '04',
        title: '定式道场',
        desc: '26 种开局、69 个变化、25 道小测。逐步演示、讲解要点，还能把定式直接带进对局里验证。',
        foot: '交互教学 · 小测 · 进度留存',
        hash: '#/lessons',
        glow: 'rgba(200,169,81,0.26)',
        ico: 'book',
      },
    ];

    const entryGrid = el('div', { class: 'entry-grid' });
    entries.forEach((e, i) => {
      entryGrid.appendChild(
        el(
          'button',
          {
            class: 'entry',
            type: 'button',
            style: { '--entry-glow': e.glow, animationDelay: `${140 + i * 70}ms` },
            onclick: () => this.ctx.navigate(e.hash),
          },
          el('div', { class: 'row row--between' }, el('span', { class: 'entry__index', text: e.index }), icon(e.ico, 18)),
          el('div', { class: 'entry__title', text: e.title }),
          el('div', { class: 'entry__desc', text: e.desc }),
          el(
            'div',
            { class: 'entry__foot' },
            el('span', { text: e.foot }),
            el('span', { class: 'entry__arrow', text: '→' }),
          ),
        ),
      );
    });

    // ---------------- 特性 ----------------
    const features: Array<[string, string, string]> = [
      ['brain', '会思考的对手', 'Alpha-Beta + 置换表 + 迭代加深，外加 VCF 连续冲四算杀。它会先算清杀棋，再考虑围堵。'],
      ['zap', '必胜即时侦测', '双活三、四三、长链冲四一旦成型，棋盘上会亮出制胜路线并盖上「必胜」朱印。'],
      ['book', '定式实时识别', '前十四手自动比对开局库，告诉你现在走的是花月还是浦月，并在脱谱时提醒你。'],
      ['eye', '热力图与分析', '一键铺开 AI 的评估：金色是进攻要冲，青色是必须封堵，胜负判断一目了然。'],
      ['phone', '为触屏而设计', '手指点不到的地方交给放大镜；底部抽屉放棋谱、工具与设置，单手也能下完一局。'],
      ['seal', '棋谱属于你', '纯前端运行，无账号、无后端；SGF 导出、局面链接分享、复盘逐手回放。'],
    ];
    const featureGrid = el('div', { class: 'feature-grid' });
    for (const [ico, title, desc] of features) {
      featureGrid.appendChild(
        el(
          'div',
          { class: 'feature' },
          el('div', { class: 'feature__icon' }, icon(ico, 20)),
          el('div', { class: 'feature__title', text: title }),
          el('div', { class: 'feature__desc', text: desc }),
        ),
      );
    }

    append(root, [
      hero,
      el(
        'section',
        { class: 'section' },
        el('div', { class: 'section__head' }, el('h2', { class: 'section__title', text: '四种开局方式' }), el('div', { class: 'section__rule' })),
        entryGrid,
      ),
      el(
        'section',
        { class: 'section' },
        el('div', { class: 'section__head' }, el('h2', { class: 'section__title', text: '它凭什么好玩' }), el('div', { class: 'section__rule' })),
        featureGrid,
      ),
    ]);

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
