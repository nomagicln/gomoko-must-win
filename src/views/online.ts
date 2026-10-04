/**
 * 双人对战：本地同屏，或通过房间码 / 邀请链接联机。
 * 没有后端，握手之外的一切都在两位玩家的浏览器之间直传。
 */

import { BLACK, WHITE, type Move, type Player, type RuleSet } from '../core/types';
import { NetSession, makeRoomCode, normalizeCode, type NetMessage } from '../net/peer';
import { invitationURL, renderInviteQR } from '../net/invite';
import { randomNickname } from '../net/nickname';
import { CLOCK_PRESETS, type ClockMode } from '../ui/clock';
import { inkDiceCube, rollInkDice } from '../ui/dice';
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
  private myName = randomNickname();
  private readonly invitedCode: string;
  private disposed = false;
  private status: HTMLElement | null = null;
  private matchSettings: { size: number; rules: RuleSet; clock: ClockMode };
  private selectedMode: 'local' | 'online';
  private readonly keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.phase === 'lobby') this.ctx.navigate('#/');
  };

  constructor(ctx: AppContext, invitedCode = '', preferredMode: 'local' | 'online' = 'local') {
    this.ctx = ctx;
    this.invitedCode = normalizeCode(invitedCode);
    this.selectedMode = this.invitedCode ? 'online' : preferredMode;
    this.matchSettings = { size: ctx.prefs.size, rules: ctx.prefs.rules, clock: ctx.prefs.clock };
  }

  mount(): HTMLElement {
    this.root = el('div', { class: 'view' });
    this.renderLobby();
    window.addEventListener('keydown', this.keyHandler);
    if (this.invitedCode) void this.joinRoom(this.invitedCode);
    return this.root;
  }

  destroy(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.keyHandler);
    this.play?.destroy();
    this.session?.close();
    this.session = null;
  }

  /* ------------------------------------------------------------------ */
  /* 大厅                                                                */
  /* ------------------------------------------------------------------ */

  private renderLobby(): void {
    clear(this.root);
    this.status = null;
    const modes = el('div', { class: 'segmented duel-modes', role: 'group', 'aria-label': '双人对战模式' });
    for (const [mode, label, ico] of [['local', '本地双人', 'grid'], ['online', '在线联机', 'wifi']] as const) {
      modes.append(el('button', {
        class: 'segmented__item', type: 'button', 'aria-pressed': String(this.selectedMode === mode),
        onclick: () => {
          if (this.phase !== 'lobby' || this.selectedMode === mode) return;
          if (this.invitedCode) { this.ctx.navigate('#/online'); return; }
          this.selectedMode = mode; this.renderLobby();
          this.root.querySelector<HTMLButtonElement>(`[aria-pressed="true"]`)?.focus();
          sound.play('tick');
        },
      }, icon(ico, 17), label));
    }
    append(this.root, [
      el('div', { class: 'page-head' }, el('div', { class: 'hero__eyebrow', text: 'Across the Board' }),
        el('h1', { class: 'page-title', text: '双人对战' }),
        el('p', { class: 'page-lead', text: this.invitedCode
          ? `正在入座房间 ${this.invitedCode}，连接成功后自动开始对局。`
          : '在同一张棋盘上轮流落子，或邀远方的朋友隔屏对弈。' })),
      modes,
    ]);
    if (this.selectedMode === 'local') {
      append(this.root, [el('section', { class: 'card duel-local' }, el('div', { class: 'card__body stack' },
        el('div', { class: 'card__title', text: '一方棋盘，两位棋友' }),
        el('p', { class: 'faint', text: '共用一台电脑或手机，黑棋先行、白棋随后。轮流落子，随时切磋。' }),
        el('div', { class: 'row wrap' }, el('span', { class: 'tag', text: `${this.ctx.prefs.size} 路棋盘` }),
          el('span', { class: 'tag', text: this.ctx.prefs.rules === 'renju' ? '连珠规则' : '自由规则' })),
        el('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: () => this.ctx.navigate('#/local') }, icon('play', 17), '开始对局'),
      ))]);
      return;
    }
    const nameInput = el('input', {
      class: 'input',
      maxlength: '12',
      value: this.myName,
      placeholder: '你的昵称',
      oninput: (e: Event) => {
        this.myName = (e.target as HTMLInputElement).value.trim() || '棋友';
      },
    });
    nameInput.id = 'duel-nickname';
    const nicknameStatus = el('span', { class: 'sr-only', 'aria-live': 'polite' });
    const diceScene = inkDiceCube();
    const dice = el('button', {
      class: 'btn btn--icon ink-dice', type: 'button', title: '随机江湖名', 'aria-label': '随机江湖名',
      onclick: () => {
        this.myName = randomNickname(this.myName); nameInput.value = this.myName;
        nicknameStatus.textContent = `新的昵称：${this.myName}`;
        dice.disabled = true;
        void rollInkDice(diceScene, 1 + Math.floor(Math.random() * 6)).finally(() => {
          dice.disabled = this.phase !== 'lobby' || this.disposed;
        });
        sound.play('tick');
      },
    }, diceScene);
    append(this.root, [el('div', { class: 'nickname-field field' },
      el('label', { class: 'field__label', for: 'duel-nickname', text: '你的江湖名' }),
      el('div', { class: 'nickname-row' }, nameInput, dice), nicknameStatus)]);
    const codeInput = el('input', {
      class: 'input',
      maxlength: '8',
      value: this.invitedCode,
      placeholder: '输入 5 位房间码',
      style: { textTransform: 'uppercase', letterSpacing: '0.24em' },
      oninput: (e: Event) => {
        (e.target as HTMLInputElement).value = normalizeCode((e.target as HTMLInputElement).value);
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void this.joinRoom(normalizeCode((e.target as HTMLInputElement).value));
      },
    });

    const status = this.status = el('div', { class: 'note', role: 'status', 'aria-live': 'polite' }, el('span', { class: 'note__dot' }), el('span', { text: '正在连接联机服务…' }));
    status.hidden = true;

    const createBtn = el(
      'button',
      {
        class: 'btn btn--primary btn--lg',
        type: 'button',
        onclick: () => void this.createRoom(nameInput.value.trim() || '棋友'),
      },
      icon('link', 18),
      '创建房间',
    );

    const joinBtn = el(
      'button',
      {
        class: `btn${this.invitedCode ? ' btn--primary' : ''} btn--lg`,
        type: 'button',
        onclick: () => void this.joinRoom(normalizeCode(codeInput.value)),
      },
      icon('users', 18),
      this.invitedCode ? '重新加入' : '加入房间',
    );

    append(this.root, [
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
            el('p', { class: 'faint', style: { fontSize: 'var(--step--1)', margin: '0' }, text: '生成房间码，分享链接或让朋友扫码入座。等待期间请保持页面打开。' }),
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
            status,
          ),
        ),
      ),
    ]);
    if (this.invitedCode) {
      this.root.querySelector('.net-grid > section:first-child')?.remove();
      this.root.querySelector('.net-grid')?.classList.add('net-grid--invited');
      const leave = el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => this.ctx.navigate('#/online?m=online') }, '返回联机大厅');
      joinBtn.after(leave);
    }
  }

  private setStatus(text: string, kind: 'info' | 'win' | 'danger' = 'info'): void {
    const node = this.status;
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
      onOpen: (session: NetSession) => {
        if (this.disposed) { session.close(); return; }
        this.session = session;
        sound.play('tick');
        session.send({ t: 'hello', name: this.myName, ...this.matchSettings, version: 1 });
      },
      onClose: () => {
        if (this.disposed) return;
        if (this.phase === 'playing') {
          modal({
            title: '连接已断开',
            body: [el('p', { text: '与对手的连接中断了。可以返回大厅重新开局，或改成本地双人对弈继续下完。' })],
            actions: [
              { label: '返回大厅', kind: 'ghost', onClick: () => this.ctx.navigate('#/online?m=online') },
              { label: '本地双人', kind: 'primary', onClick: () => this.ctx.navigate('#/local') },
            ],
          });
        } else {
          this.setStatus('连接已断开，请重试', 'danger');
        }
      },
      onError: (message: string) => { if (!this.disposed) this.setStatus(message, 'danger'); },
      onLatency: (ms: number) => {
        this.latency = ms;
        const badge = this.root.querySelector('#net-latency');
        if (badge) badge.textContent = `${ms} ms`;
      },
      onMessage: (msg: NetMessage) => { if (!this.disposed) this.handleMessage(msg); },
    };
  }

  private async createRoom(name: string): Promise<void> {
    if (this.disposed || this.phase !== 'lobby') return;
    this.myName = name;
    const code = makeRoomCode();
    this.phase = 'hosting';
    this.myRole = 'host';
    this.setBusy(true);
    this.setStatus('正在向信令服务器申请房间…');
    try {
      const session = await NetSession.host(code, this.handlers());
      if (this.disposed) { session.close(); return; }
      this.session = session;
      if (!this.play) this.renderWaiting(code);
    } catch (err) {
      if (this.disposed) return;
      this.phase = 'lobby';
      this.setBusy(false);
      this.setStatus(err instanceof Error ? err.message : '创建房间失败', 'danger');
      toast('联机服务不可用，也可以先本地双人', 'danger', 3000);
    }
  }

  private async joinRoom(code: string): Promise<void> {
    if (this.disposed || this.phase !== 'lobby') return;
    if (code.length < 4) {
      this.setStatus('请输入完整的房间码', 'danger');
      return;
    }
    this.phase = 'joining';
    this.myRole = 'guest';
    this.setBusy(true);
    this.setStatus(`正在加入房间 ${code}…`);
    try {
      const session = await NetSession.join(code, this.handlers());
      if (this.disposed) { session.close(); return; }
      this.session = session;
      if (!this.play) this.setStatus('已连接，等待房主开局…', 'win');
    } catch (err) {
      if (this.disposed) return;
      this.phase = 'lobby';
      this.setBusy(false);
      this.setStatus(err instanceof Error ? err.message : '加入房间失败', 'danger');
    }
  }

  private setBusy(busy: boolean): void {
    this.root.setAttribute('aria-busy', String(busy));
    this.root.querySelectorAll<HTMLButtonElement>('.net-grid .btn--lg').forEach(b => { b.disabled = busy; });
    this.root.querySelectorAll<HTMLInputElement>('.net-grid input').forEach(input => { input.disabled = busy; });
    this.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.nickname-row input, .nickname-row button, .duel-modes button').forEach(control => { control.disabled = busy; });
  }

  private renderWaiting(code: string): void {
    const codeEl = el('div', { class: 'room-code__value', text: code });
    const url = invitationURL(code, location.href, typeof __DEV_LAN_HOST__ === 'string' ? __DEV_LAN_HOST__ : '');
    const qrPanel = el('section', { class: 'invite-qr stack', id: 'invite-qr', 'aria-label': '房间邀请二维码' });
    qrPanel.hidden = true;
    const canvas = el('canvas', { class: 'invite-qr__canvas', role: 'img', 'aria-label': `扫码加入房间 ${code}` });
    const qrStatus = el('p', { class: 'faint', role: 'status', text: '正在生成二维码…' });
    const download = el('button', {
      class: 'btn btn--sm', type: 'button', disabled: true,
      onclick: () => {
        const link = el('a', { href: canvas.toDataURL('image/png'), download: `ink-gomoku-${code}.png` });
        link.click();
      },
    }, icon('download', 16), '保存二维码');
    append(qrPanel, [canvas, qrStatus, download]);
    let qrReady = false;
    let qrLoading = false;
    const qrButton = el('button', {
      class: 'btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'invite-qr',
      onclick: async () => {
        qrPanel.hidden = !qrPanel.hidden;
        qrButton.setAttribute('aria-expanded', String(!qrPanel.hidden));
        if (qrReady || qrLoading || qrPanel.hidden) return;
        qrLoading = true;
        try {
          await renderInviteQR(canvas, url);
          qrReady = true;
          download.disabled = false;
          qrStatus.textContent = '朋友扫码即可入座，请保持此页面打开。';
        } catch {
          qrStatus.textContent = '二维码生成失败，请重试或复制邀请链接。';
        } finally { qrLoading = false; }
      },
    }, icon('qr', 16), '二维码邀请');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
    const localDevelopment = import.meta.env.DEV && new URL(url).hostname !== location.hostname;
    clear(this.root);
    this.root.setAttribute('aria-busy', 'false');
    this.status = el('div', { class: 'note', role: 'status' }, el('span', { class: 'note__dot' }), el('span', { text: '正在等待对手进入房间…（此页面请保持打开）' }));
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
                  const text = `来下一盘五子棋，房间码 ${code}`;
                  if (navigator.share) {
                    try {
                      await navigator.share({ title: '墨韵五子棋', text, url });
                      return;
                    } catch (err) {
                      if (err instanceof DOMException && err.name === 'AbortError') return;
                    }
                  }
                  const ok = await copyText(url);
                  toast(ok ? '邀请链接已复制' : '复制失败', ok ? 'win' : 'danger', 1800);
                },
              },
              icon('share', 16),
              '分享邀请链接',
            ),
            qrButton,
            el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.ctx.navigate('#/online?m=online') }, '返回'),
          ),
          el('a', { class: 'invite-link', href: url, text: url }),
          loopback ? el('p', { class: 'faint', text: '这是本机地址。跨设备邀请请用本站的局域网或公网地址打开页面后再分享。' }) :
            localDevelopment ? el('p', { class: 'faint', text: '邀请使用局域网地址，朋友的手机或电脑需连接同一 Wi-Fi。' }) : null,
          qrPanel,
          this.status,
        ),
      ),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 对局                                                                */
  /* ------------------------------------------------------------------ */

  private startMatch(blackColor: Player): void {
    this.root.setAttribute('aria-busy', 'false');
    this.root.classList.add('view--online-playing');
    this.status = null;
    this.myColor = blackColor;
    this.phase = 'playing';
    const opponent: Player = blackColor === BLACK ? WHITE : BLACK;

    const bridge: NetBridge = {
      label: `${this.myName}（你）`,
      sublabel: `执${this.myColor === BLACK ? '黑' : '白'} · 延迟 ${this.latency} ms`,
      sendMove: (move: Move) => {
        this.session?.send({
          t: 'move',
          x: move.x,
          y: move.y,
          color: this.myColor,
          ply: move.index,
          ms: this.play?.game?.currentMoveMs() ?? 0,
        });
      },
      sendUndo: () => this.session?.send({ t: 'undo-request' }),
      sendRematch: () => this.session?.send({ t: 'rematch-request' }),
      sendResign: (color: Player) => this.session?.send({ t: 'resign', color }),
      sendChat: (text: string) => this.session?.send({ t: 'chat', text }),
    };

    this.play?.destroy();
    this.play = new PlayView(this.ctx, {
      mode: 'online',
      net: bridge,
      config: {
        size: this.matchSettings.size,
        rules: this.matchSettings.rules,
        clockMode: this.matchSettings.clock,
        black: this.myColor === BLACK ? 'human' : 'remote',
        white: this.myColor === WHITE ? 'human' : 'remote',
        humanColor: this.myColor,
      },
      onExit: () => this.ctx.navigate('#/online?m=online'),
    });
    clear(this.root);
    this.root.appendChild(this.play.mount());
    void opponent;
    toast('对局开始！' + (this.myColor === BLACK ? '你先手' : '对手先手'), 'win', 2600);
  }

  private handleMessage(msg: NetMessage): void {
    switch (msg.t) {
      case 'hello':
        if (this.phase === 'playing') break;
        if (this.myRole === 'guest') {
          if (msg.version !== 1 || ![13, 15, 19].includes(msg.size) || !['freestyle', 'renju'].includes(msg.rules)) {
            this.setStatus('房主的游戏版本或规则不兼容，请双方刷新后重试。', 'danger');
            this.session?.close();
            this.phase = 'lobby';
            this.setBusy(false);
            break;
          }
          this.matchSettings = { size: msg.size, rules: msg.rules as RuleSet,
            clock: CLOCK_PRESETS.some(p => p.id === msg.clock) ? msg.clock as ClockMode : 'none' };
        }
        this.opponentName = msg.name || '对手';
        this.setStatus(`对手 ${this.opponentName} 已入座`, 'win');
        toast(`${this.opponentName} 已进入房间`, 'win', 2200);
        this.startMatch(this.myRole === 'host' ? BLACK : WHITE);
        break;
      case 'start':
        break;
      case 'move': {
        // 对手用时同步给本地的棋钟
        if (typeof msg.ms === 'number' && msg.ms > 0) this.play?.game?.creditRemoteTime(msg.color, msg.ms);
        this.play?.applyRemoteMove(msg.x, msg.y, msg.color);
        break;
      }
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
