/**
 * 应用外壳：偏好设置、Hash 路由、顶栏与移动端标签栏。
 */

import type { Difficulty } from './ai/engine';
import type { ClockMode } from './ui/clock';
import { BLACK, WHITE, type Move, type Player, type RuleSet } from './core/types';
import { sound } from './ui/audio';
import { append, clear, el, icon, store, toast } from './ui/dom';
import { ALL_OPENINGS } from './ai/book';
import { HomeView } from './views/home';
import { LessonsView } from './views/lessons';
import { OnlineView } from './views/online';
import { PlayView } from './views/play';

export interface Prefs {
  theme: 'ink' | 'paper';
  sound: boolean;
  showCoords: boolean;
  showNumbers: boolean;
  hints: boolean;
  difficulty: Difficulty;
  /** 棋钟模式 */
  clock: ClockMode;
  humanColor: Player;
  rules: RuleSet;
  size: number;
  progress: Record<string, number>;
  stats: { wins: number; losses: number; draws: number };
}

export interface AppContext {
  root: HTMLElement;
  prefs: Prefs;
  savePrefs(): void;
  navigate(hash: string): void;
  recordResult(won: boolean): void;
}

export interface View {
  mount(): HTMLElement;
  destroy?(): void;
}

const DEFAULT_PREFS: Prefs = {
  theme: 'ink',
  sound: true,
  showCoords: true,
  showNumbers: false,
  hints: true,
  difficulty: 'hard',
  clock: 'none',
  humanColor: BLACK,
  rules: 'freestyle',
  size: 15,
  progress: {},
  stats: { wins: 0, losses: 0, draws: 0 },
};

type RouteName = 'home' | 'ai' | 'local' | 'online' | 'lessons' | 'review';

interface Route {
  name: RouteName;
  id?: string;
  params: URLSearchParams;
}

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const head = parts[0] ?? '';
  switch (head) {
    case 'ai':
      return { name: 'ai', params };
    case 'local':
      return { name: 'local', params };
    case 'online':
      return { name: 'online', params };
    case 'lessons':
      return { name: 'lessons', id: parts[1], params };
    case 'review':
      return { name: 'review', params };
    default:
      return { name: 'home', params };
  }
}

export function startApp(root: HTMLElement): void {
  const prefs: Prefs = { ...DEFAULT_PREFS, ...store.get<Partial<Prefs>>('prefs', {}) };
  prefs.stats = { ...DEFAULT_PREFS.stats, ...(prefs.stats ?? {}) };
  prefs.progress = { ...(prefs.progress ?? {}) };

  let current: View | null = null;

  const ctx: AppContext = {
    root,
    prefs,
    savePrefs: () => store.set('prefs', prefs),
    navigate: (hash) => {
      if (location.hash === hash) render();
      else location.hash = hash;
    },
    recordResult: (won: boolean) => {
      if (won) prefs.stats.wins += 1;
      else prefs.stats.losses += 1;
      store.set('prefs', prefs);
    },
  };

  applyTheme(prefs.theme);
  sound.setEnabled(prefs.sound);

  const shell = el('div', { class: 'shell' });
  const topbar = el('header', { class: 'topbar' });
  const main = el('main', { id: 'view' });
  const tabbar = el('nav', { class: 'tabbar', 'aria-label': '主导航' });
  append(shell, [topbar, main, tabbar, buildFooter()]);
  clear(root);
  root.appendChild(shell);

  const navItems: Array<[RouteName, string, string, string]> = [
    ['home', '首页', 'home', '#/'],
    ['ai', '人机对战', 'swords', '#/ai'],
    ['online', '在线联机', 'users', '#/online'],
    ['lessons', '定式道场', 'book', '#/lessons'],
  ];

  const buildTopbar = () => {
    clear(topbar);
    const brand = el(
      'button',
      { class: 'brand', type: 'button', 'aria-label': '返回首页', onclick: () => ctx.navigate('#/') },
      sealMark(),
      el(
        'span',
        { class: 'brand__text' },
        el('span', { class: 'brand__cn', text: '墨韵五子棋' }),
        el('span', { class: 'brand__en', text: 'Ink Gomoku' }),
      ),
    );
    const nav = el('nav', { class: 'nav', 'aria-label': '主导航' });
    for (const [name, label, , hash] of navItems) {
      nav.appendChild(
        el('button', {
          class: 'nav__link',
          type: 'button',
          'aria-current': currentRoute.name === name ? 'page' : 'false',
          text: label,
          onclick: () => ctx.navigate(hash),
        }),
      );
    }
    const themeBtn = el(
      'button',
      {
        class: 'btn btn--icon btn--ghost',
        type: 'button',
        title: prefs.theme === 'ink' ? '切换到宣纸主题' : '切换到墨夜主题',
        'aria-label': '切换主题',
        onclick: () => {
          prefs.theme = prefs.theme === 'ink' ? 'paper' : 'ink';
          applyTheme(prefs.theme);
          ctx.savePrefs();
          buildTopbar();
        },
      },
      icon(prefs.theme === 'ink' ? 'sun' : 'moon', 18),
    );
    const soundBtn = el(
      'button',
      {
        class: 'btn btn--icon btn--ghost',
        type: 'button',
        title: prefs.sound ? '关闭音效' : '开启音效',
        'aria-label': '切换音效',
        onclick: () => {
          prefs.sound = !prefs.sound;
          sound.setEnabled(prefs.sound);
          if (prefs.sound) {
            sound.unlock();
            sound.play('tick');
          }
          ctx.savePrefs();
          buildTopbar();
        },
      },
      icon(prefs.sound ? 'volume' : 'mute', 18),
    );
    append(topbar, [brand, nav, el('div', { class: 'topbar__spacer' }), el('div', { class: 'topbar__actions' }, themeBtn, soundBtn)]);
  };

  const buildTabbar = () => {
    clear(tabbar);
    for (const [name, label, ico, hash] of navItems) {
      tabbar.appendChild(
        el(
          'button',
          {
            class: 'tabbar__item',
            type: 'button',
            'aria-current': currentRoute.name === name ? 'page' : 'false',
            onclick: () => ctx.navigate(hash),
          },
          icon(ico, 20),
          el('span', { text: label }),
        ),
      );
    }
  };

  let currentRoute: Route = parseRoute();

  const render = () => {
    currentRoute = parseRoute();
    document.documentElement.dataset.route = currentRoute.name;
    current?.destroy?.();
    clear(main);
    buildTopbar();
    buildTabbar();
    window.scrollTo({ top: 0, behavior: 'auto' });

    let view: View;
    switch (currentRoute.name) {
      case 'ai': {
        const openingId = currentRoute.params.get('o');
        const variationIdx = Number(currentRoute.params.get('v') ?? '0') || 0;
        const opening = openingId ? ALL_OPENINGS.find((o) => o.id === openingId) : undefined;
        if (opening) {
          const variation = opening.variations[Math.min(variationIdx, opening.variations.length - 1)];
          const initialMoves = variation.moves.map((m) => ({ x: m.x, y: m.y }));
          view = new PlayView(ctx, {
            mode: 'ai',
            config: {
              size: 15,
              rules: prefs.rules,
              difficulty: prefs.difficulty,
              black: 'human',
              white: 'ai',
              humanColor: BLACK,
            },
            initialMoves,
          });
          toast(`已按「${opening.name}」定式开局，第 ${initialMoves.length + 1} 手轮到你`, 'win', 3200);
        } else {
          view = new PlayView(ctx, { mode: 'ai' });
        }
        break;
      }
      case 'local':
        view = new PlayView(ctx, {
          mode: 'local',
          config: { black: 'human', white: 'human', humanColor: BLACK, size: prefs.size, rules: prefs.rules },
        });
        break;
      case 'online':
        view = new OnlineView(ctx);
        break;
      case 'lessons':
        view = new LessonsView(ctx, currentRoute.id);
        break;
      case 'review': {
        const raw = currentRoute.params.get('m') ?? '';
        const size = Number(currentRoute.params.get('s') ?? 15) || 15;
        const rules: RuleSet = currentRoute.params.get('r') === '1' ? 'renju' : 'freestyle';
        const moves: Move[] = [];
        for (let i = 0; i + 3 <= raw.length; i += 3) {
          const chunk = raw.slice(i, i + 3);
          if (chunk.length < 3) break;
          const x = Number(chunk[0]);
          const y = Number(chunk[1]);
          const p = Number(chunk[2]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) break;
          moves.push({ x, y, player: (p === 2 ? WHITE : BLACK) as Player, index: moves.length + 1 });
        }
        view = new PlayView(ctx, {
          mode: 'review',
          config: { size, rules },
          reviewMoves: moves,
          reviewTitle: '分享的棋谱',
        });
        break;
      }
      default:
        view = new HomeView(ctx);
    }
    current = view;
    main.appendChild(view.mount());
  };

  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = '#/';
  render();

  // 首次用户手势解锁音频
  const unlock = () => {
    sound.unlock();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  // 键盘快捷键（对弈页）：U 悔棋 / H 提示 / A 分析 / R 重开
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const map: Record<string, string> = { u: 'undo', h: 'hint', a: 'analysis', r: 'restart' };
    const key = map[e.key.toLowerCase()];
    if (!key) return;
    const btn = main.querySelector<HTMLButtonElement>(`[data-kbd="${key}"]`);
    if (!btn) return;
    e.preventDefault();
    btn.click();
  });
}

function applyTheme(theme: 'ink' | 'paper'): void {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'ink' ? '#12100d' : '#e9dfc9');
}

function sealMark(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'brand__seal');
  svg.setAttribute('aria-hidden', 'true');
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('x', '1');
  rect.setAttribute('y', '1');
  rect.setAttribute('width', '38');
  rect.setAttribute('height', '38');
  rect.setAttribute('rx', '7');
  rect.setAttribute('fill', '#b93a2b');
  const text = document.createElementNS(ns, 'text');
  text.setAttribute('x', '20');
  text.setAttribute('y', '26');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('font-size', '20');
  text.setAttribute('font-family', '"Noto Serif SC", serif');
  text.setAttribute('font-weight', '700');
  text.setAttribute('fill', '#fdf3e6');
  text.textContent = '墨';
  const inner = document.createElementNS(ns, 'rect');
  inner.setAttribute('x', '4.5');
  inner.setAttribute('y', '4.5');
  inner.setAttribute('width', '31');
  inner.setAttribute('height', '31');
  inner.setAttribute('rx', '4');
  inner.setAttribute('fill', 'none');
  inner.setAttribute('stroke', 'rgba(253,243,230,0.55)');
  inner.setAttribute('stroke-width', '1.2');
  svg.append(rect, text, inner);
  return svg;
}

function buildFooter(): HTMLElement {
  return el(
    'footer',
    { class: 'footer' },
    el('div', { text: '墨韵五子棋 · 纯前端实现，棋谱只留在你的设备上' }),
    el(
      'div',
      { style: { marginTop: '6px' } },
      el('span', { text: '人机对战 · 在线联机 · 26 种开局定式 · ' }),
      el('a', { href: 'https://github.com/nomagicln/gomoko-must-win', target: '_blank', rel: 'noopener', text: 'GitHub' }),
    ),
  );
}
