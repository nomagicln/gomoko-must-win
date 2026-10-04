/**
 * 在线联机：房间码 → WebRTC 点对点 → 双方对局。
 * 没有后端，握手之外的一切都在两位玩家的浏览器之间直传。
 */

import { BLACK, WHITE, type Move, type Player } from '../core/types';
import { NetSession, makeRoomCode, normalizeCode, type NetMessage } from '../net/peer';
import { sound } from '../ui/audio';
import { append, clear, copyText, el, icon, modal, toast } from '../ui/dom';
import { PlayView, type NetBridge } from './play';
import type { AppContext, View } from '../app';

type Phase = 'lobby' | 'hosting' | 'joining' | 'playing';

export class OnlineView implements View {
  private readonly ctx: AppContext;
  private root!: HTMLElement;
  private session: NetSession | null = null;
  private play: PlayView | null = null;
  private phase: Phase = 'lobby';
  private myRole: 'host' | 'guest' = 'host';
  private myColor: Player = BLACK;
  private latency = 0;
  private opponentName = '对手';
  private myName = '棋友';
  private readonly keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.phase === 'lobby') this.ctx.navigate('#/');
  };

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  mount(): HTMLElement {
    this.root = el('div', { class: 'view' });
    this.renderLobby();
    window.addEventListener('keydown', this.keyHandler);
    return this.root;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.play?.destroy();
    this.session?.close();
    this.session = null;
  }

  /* ------------------------------------------------------------------ */
  /* 大厅                                                                */
  /* ------------------------------------------------------------------ */

  private renderLobby(): void {
    const nameInput = el('input', {
      class: 'input',
      maxlength: '12',
      value: this.myName,
      placeholder: '你的昵称',
      oninput: (e: Event) => {
        this.myName = (e.target as HTMLInputElement).value.trim() || '棋友';
      },
    });
    const codeInput = el('input', {
      class: 'input',
      maxlength: '8',
      placeholder: '输入 5 位房间码',
      style: { textTransform: 'uppercase', letterSpacing: '0.24em' },
      oninput: (e: Event) => {
        (e.target as HTMLInputElement).value = normalizeCode((e.target as HTMLInputElement).value);
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void this.joinRoom(normalizeCode((e.target as HTMLInputElement).value));
      },
    });

    const status = el('div', { class: 'note' }, el('span', { class: 'note__dot' }), el('span', { text: '正在连接联机服务…' }));
    status.hidden = true;

    const createBtn = el(
      'button',
      {
        class: 'btn btn--primary btn--lg btn--block',
        type: 'button',
        onclick: () => void this.createRoom(nameInput.value.trim() || '棋友'),
      },
      icon('link', 18),
      '生成房间码，等朋友加入',
    );

    const joinBtn = el(
      'button',
      {
        class: 'btn btn--lg btn--block',
        type: 'button',
        onclick: () => void this.joinRoom(normalizeCode(codeInput.value)),
      },
      icon('users', 18),
      '加入房间',
    );

    const fallback = el(
      'button',
      { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => this.ctx.navigate('#/local') },
      icon('grid', 15),
      '改用本地双人',
    );

    append(this.root, [
      el(
        'div',
        { class: 'page-head' },
        el('div', { class: 'hero__eyebrow', text: 'Peer to Peer' }),
        el('h1', { class: 'page-title', text: '在线联机' }),
        el('p', {
          class: 'page-lead',
          text: '本站没有服务器：房间码只用于一次握手，之后你的每一步都会通过 WebRTC 加密通道直达对手浏览器。',
        }),
      ),
      el(
        'div',
        { class: 'net-grid' },
        el(
          'section',
          { class: 'card' },
          el(
            'div',
            { class: 'card__body stack' },
            el('div', { class: 'card__title', text: '创建房间' }),
            el('p', { class: 'faint', style: { fontSize: 'var(--step--1)', margin: '0' }, text: '生成房间码后把它发给朋友，对方在右侧输入即可入座。你先手执黑。' }),
            field('你的昵称', nameInput),
            createBtn,
          ),
        ),
        el(
          'section',
          { class: 'card' },
          el(
            'div',
            { class: 'card__body stack' },
            el('div', { class: 'card__title', text: '加入房间' }),
            el('p', { class: 'faint', style: { fontSize: 'var(--step--1)', margin: '0' }, text: '输入朋友给你的 5 位房间码（忽略大小写，字母 O 视作数字 0）。' }),
            field('房间码', codeInput),
            joinBtn,
            el('div', { class: 'hairline' }),
            status,
            el('div', { class: 'row wrap' }, fallback),
          ),
        ),
      ),
    ]);
  }

  private setStatus(text: string, kind: 'info' | 'win' | 'danger' = 'info'): void {
    const node = this.root.querySelector<HTMLElement>('.note');
    if (!node) return;
    node.hidden = false;
    node.className = `note${kind === 'win' ? ' note--win' : kind === 'danger' ? ' note--must' : ''}`;
    const span = node.lastElementChild as HTMLElement | null;
    if (span) span.textContent = text;
  }

  /* ------------------------------------------------------------------ */
  /* 连接                                                                */
  /* ------------------------------------------------------------------ */

  private handlers() {
    return {
      onOpen: () => {
        sound.play('tick');
        if (this.myRole === 'host') {
          this.session?.send({ t: 'hello', name: this.myName, size: this.ctx.prefs.size, rules: this.ctx.prefs.rules, version: 1 });
          this.startMatch(BLACK);
        } else {
          this.session?.send({ t: 'hello', name: this.myName, size: this.ctx.prefs.size, rules: this.ctx.prefs.rules, version: 1 });
        }
      },
      onClose: () => {
        if (this.phase === 'playing') {
          modal({
            title: '连接已断开',
            body: [el('p', { text: '与对手的连接中断了。可以返回大厅重新开局，或改成本地双人对弈继续下完。' })],
            actions: [
              { label: '返回大厅', kind: 'ghost', onClick: () => this.ctx.navigate('#/online') },
              { label: '本地双人', kind: 'primary', onClick: () => this.ctx.navigate('#/local') },
            ],
          });
        } else {
          this.setStatus('连接已断开，请重试', 'danger');
        }
      },
      onError: (message: string) => this.setStatus(message, 'danger'),
      onLatency: (ms: number) => {
        this.latency = ms;
        const badge = this.root.querySelector('#net-latency');
        if (badge) badge.textContent = `${ms} ms`;
      },
      onMessage: (msg: NetMessage) => this.handleMessage(msg),
    };
  }

  private async createRoom(name: string): Promise<void> {
    this.myName = name;
    const code = makeRoomCode();
    this.phase = 'hosting';
    this.myRole = 'host';
    this.setStatus('正在向信令服务器申请房间…');
    try {
      this.session = await NetSession.host(code, this.handlers());
      this.renderWaiting(code);
    } catch (err) {
      this.phase = 'lobby';
      this.setStatus(err instanceof Error ? err.message : '创建房间失败', 'danger');
      toast('联机服务不可用，也可以先本地双人', 'danger', 3000);
    }
  }

  private async joinRoom(code: string): Promise<void> {
    if (code.length < 4) {
      this.setStatus('请输入完整的房间码', 'danger');
      return;
    }
    this.phase = 'joining';
    this.myRole = 'guest';
    this.setStatus('正在加入房间…');
    try {
      this.session = await NetSession.join(code, this.handlers());
      this.setStatus('已连接，等待房主开局…', 'win');
    } catch (err) {
      this.phase = 'lobby';
      this.setStatus(err instanceof Error ? err.message : '加入房间失败', 'danger');
    }
  }

  private renderWaiting(code: string): void {
    const codeEl = el('div', { class: 'room-code__value', text: code });
    const url = `${location.origin}${location.pathname}#/online?r=${code}`;
    clear(this.root);
    append(this.root, [
      el(
        'div',
        { class: 'page-head' },
        el('div', { class: 'hero__eyebrow', text: 'Room Created' }),
        el('h1', { class: 'page-title', text: '把房间码发给朋友' }),
      ),
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'card__body stack' },
          el('div', { class: 'room-code' }, codeEl, el('span', { class: 'tag tag--gold', text: '等待对手加入' })),
          el(
            'div',
            { class: 'row wrap' },
            el(
              'button',
              {
                class: 'btn btn--primary',
                type: 'button',
                onclick: async () => {
                  const ok = await copyText(code);
                  toast(ok ? '房间码已复制' : '复制失败', ok ? 'win' : 'danger', 1800);
                },
              },
              icon('copy', 16),
              '复制房间码',
            ),
            el(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: async () => {
                  const text = `来下盘五子棋：${url}`;
                  if (navigator.share) {
                    try {
                      await navigator.share({ title: '墨韵五子棋', text, url });
                      return;
                    } catch {
                      /* 用户取消 */
                    }
                  }
                  const ok = await copyText(text);
                  toast(ok ? '邀请链接已复制' : '复制失败', ok ? 'win' : 'danger', 1800);
                },
              },
              icon('share', 16),
              '分享邀请链接',
            ),
            el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.ctx.navigate('#/online') }, '返回'),
          ),
          el(
            'div',
            { class: 'row', style: { marginTop: 'var(--sp-3)' } },
            el('span', { class: 'spinner' }),
            el('span', { class: 'faint', style: { fontSize: 'var(--step--1)' }, text: '正在等待对手进入房间…（此页面请保持打开）' }),
          ),
        ),
      ),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 对局                                                                */
  /* ------------------------------------------------------------------ */

  private startMatch(blackColor: Player): void {
    this.myColor = blackColor;
    this.phase = 'playing';
    const opponent: Player = blackColor === BLACK ? WHITE : BLACK;

    const bridge: NetBridge = {
      label: `${this.myName}（你）`,
      sublabel: `执${this.myColor === BLACK ? '黑' : '白'} · 延迟 ${this.latency} ms`,
      sendMove: (move: Move) => {
        this.session?.send({ t: 'move', x: move.x, y: move.y, color: this.myColor, ply: move.index });
      },
      sendUndo: () => this.session?.send({ t: 'undo-request' }),
      sendResign: (color: Player) => this.session?.send({ t: 'resign', color }),
      sendChat: (text: string) => this.session?.send({ t: 'chat', text }),
    };

    this.play?.destroy();
    this.play = new PlayView(this.ctx, {
      mode: 'online',
      net: bridge,
      config: {
        size: this.ctx.prefs.size,
        rules: this.ctx.prefs.rules,
        black: this.myColor === BLACK ? 'human' : 'remote',
        white: this.myColor === WHITE ? 'human' : 'remote',
        humanColor: this.myColor,
      },
      onExit: () => this.ctx.navigate('#/online'),
    });
    clear(this.root);
    this.root.appendChild(this.play.mount());
    void opponent;
    toast('对局开始！' + (this.myColor === BLACK ? '你先手' : '对手先手'), 'win', 2600);
  }

  private handleMessage(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello':
        this.opponentName = msg.name || '对手';
        this.setStatus(`对手 ${this.opponentName} 已入座`, 'win');
        toast(`${this.opponentName} 已进入房间`, 'win', 2200);
        if (this.myRole === 'guest') this.startMatch(WHITE);
        break;
      case 'start':
        break;
      case 'move':
        this.play?.applyRemoteMove(msg.x, msg.y, msg.color);
        break;
      case 'undo-request':
        modal({
          title: '对手请求悔棋',
          body: [el('p', { text: '同意后双方各回退一手。' })],
          actions: [
            {
              label: '拒绝',
              kind: 'ghost',
              onClick: () => this.session?.send({ t: 'undo-reject' }),
            },
            {
              label: '同意',
              kind: 'primary',
              onClick: () => {
                this.play?.forceUndo(2);
                this.session?.send({ t: 'undo-accept', ply: this.play?.game?.board.moveCount ?? 0 });
              },
            },
          ],
        });
        break;
      case 'undo-accept':
        this.play?.forceUndo(2);
        toast('对手同意悔棋', 'info', 1800);
        break;
      case 'undo-reject':
        toast('对手拒绝了悔棋请求', 'danger', 2200);
        break;
      case 'resign':
        toast(`${this.opponentName}认输了`, 'win', 2600);
        this.play?.forceResign(msg.color);
        break;
      case 'chat':
        toast(`${this.opponentName}：${msg.text}`, 'info', 4200);
        break;
      case 'rematch-request':
        modal({
          title: '对手想再来一局',
          body: [el('p', { text: '接受后将交换先后手重新开局。' })],
          actions: [
            { label: '稍后', kind: 'ghost', onClick: () => undefined },
            {
              label: '再来一局',
              kind: 'primary',
              onClick: () => {
                this.session?.send({ t: 'rematch-accept' });
                this.startMatch(this.myColor === BLACK ? WHITE : BLACK);
              },
            },
          ],
        });
        break;
      case 'rematch-accept':
        this.startMatch(this.myColor === BLACK ? WHITE : BLACK);
        break;
      case 'sync':
        break;
      case 'bye':
        this.setStatus('对手已离开房间', 'danger');
        break;
    }
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'field' }, el('span', { class: 'field__label', text: label }), control);
}
