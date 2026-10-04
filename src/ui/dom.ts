/**
 * DOM 工具、内联图标、提示条与弹窗。
 * 保持零依赖：全部手写，避免引入 UI 框架带来的体积与首屏成本。
 */

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value as object);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ------------------------------------------------------------------ */
/* 图标（内联 SVG，24×24 描边风格）                                     */
/* ------------------------------------------------------------------ */

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
  swords: 'M14.5 3.5 21 3l-.5 6.5M9.5 20.5 3 21l.5-6.5M3 3l7.5 7.5M21 21l-7.5-7.5M6 6l3 3M18 18l-3-3',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 4.2a4 4 0 0 1 0 7.6',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 5.5v15M8 7.5h8M8 11h5',
  sliders: 'M4 8h10M18 8h2M4 16h4M12 16h8M14 5v6M8 13v6',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z',
  volume: 'M11 5 6.5 8.5H3v7h3.5L11 19zM15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12',
  mute: 'M11 5 6.5 8.5H3v7h3.5L11 19zM22 9l-5 6M17 9l5 6',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 1 3.5 10.9c-.4.3-.5.7-.5 1.1v1H9v-1c0-.4-.1-.8-.5-1.1A6 6 0 0 1 12 3Z',
  flag: 'M5 21V4M5 5h11l-1.5 3L16 11H5',
  refresh: 'M20 11a8 8 0 1 0-1.6 5.6M20 5v6h-6',
  download: 'M12 4v11m0 0 4-4m-4 4-4-4M4 19h16',
  upload: 'M12 20V9m0 0 4 4m-4-4-4 4M4 5h16',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  play: 'M7 4l13 8-13 8z',
  pause: 'M8 5v14M16 5v14',
  start: 'M6 5v14M19 5l-10 7 10 7z',
  end: 'M18 5v14M5 5l10 7L5 19z',
  check: 'M4 12.5 9.5 18 20 6.5',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  share: 'M12 3v12M8 7l4-4 4 4M5 14v5h14v-5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11 7M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7L13 17',
  message: 'M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.5A7.5 7.5 0 1 1 20 12Z',
  zap: 'M13 2 4 14h6l-1 8 9-12h-6z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  crown: 'M3 18h18M4 17 3 6l5 4 4-6 4 6 5-4-1 11z',
  brain: 'M9.5 4A3.5 3.5 0 0 0 6 7.5 3 3 0 0 0 5 13a3 3 0 0 0 2 5 3.5 3.5 0 0 0 6 1.5V4.5A3.5 3.5 0 0 0 9.5 4ZM14.5 4A3.5 3.5 0 0 1 18 7.5 3 3 0 0 1 19 13a3 3 0 0 1-2 5 3.5 3.5 0 0 1-6 1.5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  grid3: 'M4 4h16v16H4zM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  trophy: 'M8 4h8v4a4 4 0 0 1-8 0zM6 5H4v2a3 3 0 0 0 3 3M18 5h2v2a3 3 0 0 1-3 3M9 20h6M12 12v8',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  seal: 'M7 4h10v4H7zM5 20h14v-6a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2',
};

export function icon(name: keyof typeof PATHS | string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const d = PATHS[name] ?? PATHS.grid;
  for (const seg of d.split(' M')) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', seg.startsWith('M') ? seg : `M${seg}`);
    svg.appendChild(path);
  }
  return svg;
}

/* ------------------------------------------------------------------ */
/* 提示条                                                              */
/* ------------------------------------------------------------------ */

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'win' | 'danger' = 'info', ms = 2600): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const node = el('div', { class: `toast toast--${kind}` }, el('span', { text: message }));
  toastHost.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('toast--out');
    window.setTimeout(() => node.remove(), 260);
  }, ms);
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

export interface ModalOptions {
  title: string;
  body: Child[] | HTMLElement;
  actions?: Array<{ label: string; kind?: 'primary' | 'ghost' | 'danger'; onClick: () => void }>;
  onClose?: () => void;
}

export function modal(options: ModalOptions): () => void {
  const panel = el('div', { class: 'modal__panel', role: 'dialog', 'aria-modal': 'true' });
  panel.appendChild(el('h2', { class: 'modal__title', text: options.title }));
  const bodyWrap = el('div', { class: 'modal__body' });
  if (Array.isArray(options.body)) append(bodyWrap, options.body);
  else bodyWrap.appendChild(options.body);
  panel.appendChild(bodyWrap);

  const close = () => {
    host.remove();
    document.removeEventListener('keydown', onKey);
    options.onClose?.();
  };
  const actions = options.actions ?? [{ label: '知道了', kind: 'ghost' as const, onClick: close }];
  panel.appendChild(
    el(
      'div',
      { class: 'modal__actions' },
      ...actions.map((a) =>
        el('button', {
          class: `btn ${a.kind === 'primary' ? 'btn--primary' : a.kind === 'danger' ? 'btn--danger' : 'btn--ghost'}`,
          type: 'button',
          onclick: () => {
            a.onClick();
          },
        }, a.label),
      ),
    ),
  );

  const host = el('div', { class: 'modal', onclick: (e: MouseEvent) => {
    if (e.target === host) close();
  } }, panel);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(host);
  (panel.querySelector('button') as HTMLButtonElement | null)?.focus();
  return close;
}

/* ------------------------------------------------------------------ */
/* 存储与杂项                                                          */
/* ------------------------------------------------------------------ */

const NS = 'inkgomoku:';

export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(NS + key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(NS + key, JSON.stringify(value));
    } catch {
      /* 隐私模式下忽略 */
    }
  },
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 不支持则忽略 */
  }
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
