/**
 * 对弈视图：人机 / 本地双人 / 在线联机共用同一套界面与控制器。
 */

import { DIFFICULTIES, type Difficulty, type SearchOutcome } from '../ai/engine';
import type { BookMatch } from '../ai/book';
import { Board } from '../core/board';
import { coordText } from '../core/coords';
import { toSgf } from '../core/sgf';
import { BLACK, WHITE, type GameStatus, type Move, type Player, type Point, type RuleSet, type WinInfo } from '../core/types';
import { sound } from '../ui/audio';
import { GameController, type GameConfig } from '../ui/controller';
import { append, clear, copyText, el, icon, modal, toast, vibrate } from '../ui/dom';
import { BoardRenderer, type HeatCell, type MarkerCell } from '../ui/renderer';
import type { AppContext, View } from '../app';

export type PlayMode = 'ai' | 'local' | 'online' | 'review';

export interface NetBridge {
  /** 送出本地着法 */
  sendMove(move: Move): void;
  /** 送出控制类消息 */
  sendUndo(): void;
  sendResign(color: Player): void;
  sendChat(text: string): void;
  label: string;
  sublabel: string;
}

export interface PlayViewOptions {
  mode: PlayMode;
  config?: Partial<GameConfig>;
  net?: NetBridge;
  /** 复盘时载入的棋谱 */
  reviewMoves?: Move[];
  /** 开局前直接铺入的着法（定式演练） */
  initialMoves?: Point[];
  reviewTitle?: string;
  onExit?: () => void;
}

type TabName = 'game' | 'moves' | 'tools';

export class PlayView implements View {
  private readonly ctx: AppContext;
  private readonly options: PlayViewOptions;
  private controller: GameController | null = null;
  private renderer: BoardRenderer | null = null;

  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private sidebar!: HTMLElement;
  private sheet!: HTMLElement;
  private sheetScrim!: HTMLElement;
  private sheetBody!: HTMLElement;
  private sheetToggle!: HTMLButtonElement;

  private cards: Record<string, HTMLElement> = {};
  private tab: TabName = 'game';
  private heat: HeatCell[] = [];
  private markers: MarkerCell[] = [];
  private forcedPath: Point[] | null = null;
  private lastWin: WinInfo | null = null;
  private thinking = false;

  /** 复盘状态 */
  private reviewIndex = 0;
  private reviewMoves: Move[] = [];
  private reviewing = false;

  constructor(ctx: AppContext, options: PlayViewOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  /* ------------------------------------------------------------------ */
  /* 挂载                                                                */
  /* ------------------------------------------------------------------ */

  mount(): HTMLElement {
    this.root = el('div', { class: 'view' });
    if (this.options.mode === 'review' && this.options.reviewMoves) {
      this.reviewMoves = this.options.reviewMoves;
      this.mountReview();
      return this.root;
    }
    if (this.options.mode === 'ai' && !this.options.config) {
      this.mountSetup();
      return this.root;
    }
    this.mountGame();
    return this.root;
  }

  destroy(): void {
    this.renderer?.destroy();
    this.controller?.dispose();
    window.removeEventListener('resize', this.onResize);
  }

  /* ------------------------------------------------------------------ */
  /* 设置页                                                              */
  /* ------------------------------------------------------------------ */

  private mountSetup(): void {
    const prefs = this.ctx.prefs;
    let difficulty: Difficulty = prefs.difficulty;
    let humanColor: Player = prefs.humanColor;
    let rules: RuleSet = prefs.rules;
    let size = prefs.size;

    const diffGrid = el('div', { class: 'diff-grid' });
    const renderDiff = () => {
      clear(diffGrid);
      for (const d of DIFFICULTIES) {
        diffGrid.appendChild(
          el(
            'button',
            {
              class: `diff-card${d.id === difficulty ? ' is-active' : ''}`,
              type: 'button',
              'aria-pressed': String(d.id === difficulty),
              onclick: () => {
                difficulty = d.id;
                sound.play('tick');
                renderDiff();
              },
            },
            el('div', { class: 'diff-card__name', text: d.name }),
            el('div', { class: 'diff-card__en', text: d.en }),
            el('div', { class: 'diff-card__strength', text: d.strength }),
            el('div', { class: 'diff-card__desc', text: d.desc }),
          ),
        );
      }
    };
    renderDiff();

    const colorSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': '选择执子' });
    const renderColor = () => {
      clear(colorSeg);
      ([
        [BLACK, '执黑先行'],
        [WHITE, '执白后行'],
      ] as Array<[Player, string]>).forEach(([c, label]) => {
        colorSeg.appendChild(
          el('button', {
            class: 'segmented__item',
            type: 'button',
            'aria-pressed': String(humanColor === c),
            text: label,
            onclick: () => {
              humanColor = c;
              sound.play('tick');
              renderColor();
            },
          }),
        );
      });
    };
    renderColor();

    const rulesSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': '选择规则' });
    const renderRules = () => {
      clear(rulesSeg);
      ([
        ['freestyle', '无禁手'],
        ['renju', '连珠禁手'],
      ] as Array<[RuleSet, string]>).forEach(([r, label]) => {
        rulesSeg.appendChild(
          el('button', {
            class: 'segmented__item',
            type: 'button',
            'aria-pressed': String(rules === r),
            text: label,
            onclick: () => {
              rules = r;
              sound.play('tick');
              renderRules();
            },
          }),
        );
      });
    };
    renderRules();

    const sizeSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': '选择棋盘大小' });
    const renderSize = () => {
      clear(sizeSeg);
      [15, 19].forEach((s) => {
        sizeSeg.appendChild(
          el('button', {
            class: 'segmented__item',
            type: 'button',
            'aria-pressed': String(size === s),
            text: `${s} 路`,
            onclick: () => {
              size = s;
              sound.play('tick');
              renderSize();
            },
          }),
        );
      });
    };
    renderSize();

    const startBtn = el(
      'button',
      {
        class: 'btn btn--primary btn--lg',
        type: 'button',
        onclick: () => {
          sound.unlock();
          this.ctx.prefs.difficulty = difficulty;
          this.ctx.prefs.humanColor = humanColor;
          this.ctx.prefs.rules = rules;
          this.ctx.prefs.size = size;
          this.ctx.savePrefs();
          clear(this.root);
          this.mountGame({
            size,
            rules,
            difficulty,
            black: humanColor === BLACK ? 'human' : 'ai',
            white: humanColor === WHITE ? 'human' : 'ai',
            humanColor,
          });
        },
      },
      icon('swords', 18),
      '开始对局',
    );

    append(this.root, [
      el(
        'div',
        { class: 'page-head' },
        el('div', { class: 'hero__eyebrow', text: 'Human vs Machine' }),
        el('h1', { class: 'page-title', text: '人机对战' }),
        el('p', { class: 'page-lead', text: '四档强度，从陪你熟悉规则的入门，到几乎不犯错的宗师。AI 在浏览器里本地运算，你的棋谱不会离开这台设备。' }),
      ),
      el(
        'section',
        { class: 'section' },
        el('div', { class: 'section__head' }, el('h2', { class: 'section__title', text: '选择对手' }), el('div', { class: 'section__rule' })),
        diffGrid,
      ),
      el(
        'section',
        { class: 'section' },
        el('div', { class: 'section__head' }, el('h2', { class: 'section__title', text: '对局设定' }), el('div', { class: 'section__rule' })),
        el(
          'div',
          { class: 'card' },
          el(
            'div',
            { class: 'card__body stack' },
            field('执子', colorSeg),
            field('规则', rulesSeg),
            field('棋盘', sizeSeg),
            el('p', { class: 'faint', style: { fontSize: 'var(--step--1)', margin: '0' }, text: '连珠禁手规则下，黑棋的三三、四四、长连都会被标为禁手点（朱砂叉），不可落子。' }),
          ),
        ),
      ),
      el('div', { class: 'stack', style: { alignItems: 'center', marginTop: 'var(--sp-5)' } }, startBtn),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 对局页                                                              */
  /* ------------------------------------------------------------------ */

  private mountGame(configOverride?: Partial<GameConfig>): void {
    const prefs = this.ctx.prefs;
    const config: GameConfig = {
      size: prefs.size,
      rules: prefs.rules,
      difficulty: prefs.difficulty,
      black: 'human',
      white: 'human',
      humanColor: prefs.humanColor,
      ...this.options.config,
      ...configOverride,
    };

    this.canvas = el('canvas', { class: 'board-canvas', 'aria-label': '五子棋棋盘' });
    const badge = el('div', { class: 'board-badge' });

    const frame = el('div', { class: 'board-frame' }, this.canvas);
    const actionbar = el('div', { class: 'actionbar' });
    const stage = el('div', { class: 'stage' }, badge, frame, actionbar);

    this.sidebar = el('aside', { class: 'sidebar sidebar--desktop-only' });
    this.sheetBody = el('div', { class: 'sheet__body' });

    // 手柄：点击或下滑都可收起抽屉
    let dragStart = 0;
    const handle = el('div', {
      class: 'sheet__handle',
      role: 'button',
      tabindex: '0',
      'aria-label': '收起面板',
      onclick: () => this.toggleSheet(false),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') this.toggleSheet(false);
      },
      onpointerdown: (e: PointerEvent) => {
        dragStart = e.clientY;
      },
      onpointerup: (e: PointerEvent) => {
        if (dragStart && e.clientY - dragStart > 40) this.toggleSheet(false);
        dragStart = 0;
      },
    });

    this.sheetScrim = el('div', {
      class: 'sheet-scrim',
      hidden: true,
      onclick: () => this.toggleSheet(false),
    });

    this.sheet = el('div', { class: 'sheet', hidden: true }, handle, el('div', { class: 'sheet__tabs' }), this.sheetBody);
    this.sheetToggle = el(
      'button',
      {
        class: 'sheet-toggle',
        type: 'button',
        'aria-label': '展开面板',
        'aria-expanded': 'false',
        onclick: () => this.toggleSheet(this.sheet.hidden),
      },
      icon('sliders', 18),
    );

    append(this.root, [el('div', { class: 'play' }, stage, this.sidebar), this.sheetScrim, this.sheetToggle, this.sheet]);
    this.buildSheetTabs();

    // 控制器
    this.controller = new GameController(config, {
      onStateChange: () => this.syncAll(),
      onMove: ({ move, book }) => this.onMove(move, book),
      onThinking: (on) => {
        this.thinking = on;
        this.syncTurn(badge);
        this.renderThink(null, 0);
      },
      onGameOver: (status, win) => this.onGameOver(status, win),
      onBook: (match) => this.syncBook(match),
      onThreats: (notes, markers) => {
        this.markers = markers;
        this.renderNotes(notes);
        this.syncRenderer();
      },
      onAnalysis: (heat, candidates, score) => {
        if (heat.length) this.heat = heat;
        else if (this.heat.length) this.heat = [];
        this.renderThink(candidates, score);
        if (candidates) this.syncEval(score);
        this.syncRenderer();
      },
      onForbidden: (msg, point) => {
        toast(`${msg}（${coordText(point, config.size)}）`, 'danger', 2200);
        vibrate(40);
      },
    });

    // 渲染器
    this.renderer = new BoardRenderer(
      this.canvas,
      {
        size: this.controller.size,
        cells: this.controller.board.rawCells(),
        moves: [],
        lastMove: null,
        winLine: null,
        heat: [],
        markers: [],
        ghost: null,
        winPath: null,
        showCoords: prefs.showCoords,
        showNumbers: prefs.showNumbers,
        interactive: true,
      },
      {
        onPlace: (x, y) => this.handlePlace(x, y),
        onHover: (p) => {
          if (!p || !this.controller) return;
          this.syncHoverNote(p);
        },
      },
    );

    this.buildCards(actionbar, badge);
    this.layout();
    this.onResize = () => this.layout();
    window.addEventListener('resize', this.onResize);
    if (typeof window.matchMedia === 'function') {
      window.matchMedia('(min-width: 1024px)').addEventListener('change', this.onResize);
    }

    // 如果 AI 执黑，自动开局；若带入了定式着法，则先铺入再续下
    window.setTimeout(() => {
      this.controller?.start();
      const seq = this.options.initialMoves;
      if (seq && seq.length) this.controller?.applySequence(seq);
      this.syncAll();
    }, 60);
    this.syncAll();
  }

  private onResize = (): void => {
    this.layout();
  };

  /* ------------------------------------------------------------------ */
  /* 面板卡片                                                            */
  /* ------------------------------------------------------------------ */

  private buildCards(actionbar: HTMLElement, badge: HTMLElement): void {
    const prefs = this.ctx.prefs;

    // ---- 回合卡 ----
    const turnCard = el('div', { class: 'card turn-card', dataset: { tab: 'game' } });
    this.cards.turn = turnCard;

    // ---- 战术提示 ----
    const noteList = el('div', { class: 'note-list' });
    const notesCard = el(
      'div',
      { class: 'card', dataset: { tab: 'game' } },
      el('div', { class: 'card__body stack' }, el('div', { class: 'card__title', text: '战术提示' }), noteList),
    );
    this.cards.notes = notesCard;
    this.notesList = noteList;

    // ---- AI 思考 ----
    const thinkList = el('div', { class: 'think-list' });
    const thinkCard = el(
      'div',
      { class: 'card', dataset: { tab: 'game' } },
      el('div', { class: 'card__body stack' }, el('div', { class: 'card__title', text: '局势解析' }), thinkList),
    );
    this.cards.think = thinkCard;
    this.thinkList = thinkList;

    // ---- 棋谱 ----
    const moveList = el('div', { class: 'movelist' });
    const movesCard = el(
      'div',
      { class: 'card', dataset: { tab: 'moves' } },
      el(
        'div',
        { class: 'card__body stack' },
        el(
          'div',
          { class: 'row row--between' },
          el('div', { class: 'card__title', text: '棋谱' }),
        ),
        moveList,
      ),
    );
    this.cards.moves = movesCard;
    this.moveList = moveList;

    // ---- 工具 ----
    const toolsBody = el('div', { class: 'card__body stack' });
    const toolsCard = el('div', { class: 'card', dataset: { tab: 'tools' } }, toolsBody);
    this.cards.tools = toolsCard;

    // 设置项
    const modeLabel =
      this.options.mode === 'ai'
        ? `人机对战 · ${DIFFICULTIES.find((d) => d.id === this.controller!.config.difficulty)?.name ?? ''}`
        : this.options.mode === 'online'
          ? this.options.net?.label ?? '在线对战'
          : '本地双人';

    append(toolsBody, [
      el(
        'div',
        { class: 'row row--between' },
        el('div', { class: 'card__title', text: '对局设置' }),
        el('span', { class: 'tag tag--gold', text: modeLabel }),
      ),
      this.options.mode === 'online' && this.options.net
        ? el(
            'div',
            { class: 'stack' },
            el('div', { class: 'player-row is-self' }, el('div', { class: 'player-row__avatar', text: '你' }), el('div', {}, el('div', { class: 'player-row__name', text: this.options.net.label }), el('div', { class: 'player-row__meta', text: this.options.net.sublabel }))),
          )
        : null,
      switchRow('显示坐标', prefs.showCoords, (v) => {
        prefs.showCoords = v;
        this.ctx.savePrefs();
        if (this.renderer) this.renderer.setState({ showCoords: v });
      }),
      switchRow('显示手数', prefs.showNumbers, (v) => {
        prefs.showNumbers = v;
        this.ctx.savePrefs();
        if (this.renderer) {
          this.renderer.setState({ showNumbers: v });
          this.drawNumbers();
        }
      }),
      el(
        'div',
        { class: 'row wrap' },
        el('button', { class: 'btn btn--sm', type: 'button', onclick: () => this.exportSgf() }, icon('download', 15), '导出 SGF'),
        el('button', { class: 'btn btn--sm', type: 'button', onclick: () => this.copyShare() }, icon('link', 15), '复制局面'),
        this.options.mode === 'online' && this.options.net
          ? el('button', { class: 'btn btn--sm', type: 'button', onclick: () => this.openChat() }, icon('message', 15), '聊天')
          : null,
      ),
      el('div', { class: 'hairline' }),
      el(
        'div',
        { class: 'stack' },
        el('div', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: '快捷键' }),
        el(
          'div',
          { class: 'row wrap', style: { gap: '6px' } },
          el('span', { class: 'kbd', text: 'U' }),
          el('span', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: '悔棋' }),
          el('span', { class: 'kbd', text: 'H' }),
          el('span', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: '提示' }),
          el('span', { class: 'kbd', text: 'A' }),
          el('span', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: '分析' }),
          el('span', { class: 'kbd', text: 'R' }),
          el('span', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: '重开' }),
        ),
      ),
    ]);

    // ---- 操作条 ----
    const buttons: HTMLElement[] = [];
    buttons.push(
      el('button', { class: 'btn', type: 'button', dataset: { kbd: 'undo' }, onclick: () => this.doUndo() }, icon('undo', 16), '悔棋'),
      el('button', { class: 'btn', type: 'button', dataset: { kbd: 'hint' }, onclick: () => void this.doHint() }, icon('bulb', 16), '提示'),
      el('button', {
        class: 'btn',
        type: 'button',
        dataset: { kbd: 'analysis' },
        id: 'btn-analysis',
        onclick: () => {
          const on = !this.controller?.analysisEnabled;
          this.controller?.setAnalysis(Boolean(on));
          this.syncAnalysisButton();
        },
      }, icon('eye', 16), '分析'),
    );
    if (this.options.mode === 'ai' || this.options.mode === 'local') {
      buttons.push(
        el('button', {
          class: 'btn',
          type: 'button',
          onclick: () => {
            this.enterReview();
          },
        }, icon('play', 16), '复盘'),
      );
    }
    buttons.push(
      el('button', {
        class: 'btn btn--danger',
        type: 'button',
        onclick: () => this.confirmResign(),
      }, icon('flag', 16), '认输'),
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        dataset: { kbd: 'restart' },
        onclick: () => this.confirmRestart(),
      }, icon('refresh', 16), '重开'),
    );
    if (this.options.onExit) {
      buttons.push(el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => this.options.onExit?.() }, icon('left', 16), '返回'));
    }
    append(actionbar, buttons);

    void badge;
  }

  private buildSheetTabs(): void {
    const tabs = this.sheet.querySelector('.sheet__tabs')!;
    const items: Array<[TabName, string, string]> = [
      ['game', '对局', 'target'],
      ['moves', '棋谱', 'grid'],
      ['tools', '工具', 'sliders'],
    ];
    clear(tabs);
    for (const [name, label, ico] of items) {
      tabs.appendChild(
        el(
          'button',
          {
            class: 'segmented__item',
            type: 'button',
            'aria-pressed': String(this.tab === name),
            onclick: () => this.setTab(name),
          },
          icon(ico, 15),
          ` ${label}`,
        ),
      );
    }
  }

  private toggleSheetSilently(open: boolean): void {
    this.sheet.hidden = !open;
    this.sheetScrim.hidden = !open;
    this.sheetToggle.setAttribute('aria-expanded', String(open));
  }

  private toggleSheet(open: boolean): void {
    this.sheet.hidden = !open;
    this.sheetScrim.hidden = !open;
    this.sheetToggle.setAttribute('aria-expanded', String(open));
    sound.play('tick');
  }

  private setTab(name: TabName): void {
    this.tab = name;
    this.buildSheetTabs();
    this.layout();
    sound.play('tick');
  }

  private layout(): void {
    if (!this.sidebar || !this.sheetBody) return;
    const desktop = window.innerWidth >= 1024;
    const order = ['turn', 'notes', 'think', 'moves', 'tools'];
    const host = desktop ? this.sidebar : this.sheetBody;
    if (desktop) {
      this.toggleSheetSilently(false);
      for (const k of order) {
        const card = this.cards[k];
        if (!card) continue;
        card.hidden = false;
        host.appendChild(card);
      }
    } else {
      for (const k of order) {
        const card = this.cards[k];
        if (!card) continue;
        const tabName = card.dataset.tab ?? 'game';
        card.hidden = tabName !== this.tab;
        host.appendChild(card);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 供联机 / 教学使用的公开入口                                          */
  /* ------------------------------------------------------------------ */

  /** 对手（联机）落子 */
  applyRemoteMove(x: number, y: number, color: Player): void {
    this.controller?.playRemote(x, y, color);
    this.syncAll();
  }

  /** 双方协商一致的悔棋 */
  forceUndo(count: number): void {
    if (!this.controller) return;
    for (let i = 0; i < count; i++) this.controller.board.undo();
    this.lastWin = null;
    this.forcedPath = null;
    this.syncAll();
  }

  /** 对手认输 */
  forceResign(color: Player): void {
    this.controller?.resign(color);
    this.syncAll();
  }

  get game(): GameController | null {
    return this.controller;
  }

  /* 交互与同步                                                          */
  /* ------------------------------------------------------------------ */

  private handlePlace(x: number, y: number): void {
    const c = this.controller;
    if (!c || c.isOver) return;
    if (this.reviewing) {
      toast('复盘中：先退出复盘再落子', 'info', 1800);
      return;
    }
    sound.unlock();
    const color = c.turn;
    if (!c.canPlay(color)) {
      if (this.thinking) toast('AI 正在思考…', 'info', 1200);
      else toast('现在不是你的回合', 'info', 1200);
      return;
    }
    const ok = c.play(x, y);
    if (ok) {
      vibrate(12);
      const move = c.board.lastMove;
      if (move && this.options.net) this.options.net.sendMove(move);
    } else {
      // 合法性提示
      const legal = new Board({ size: c.size, rules: c.config.rules });
      for (const m of c.board.moves) legal.place(m.x, m.y, m.player);
      const info = legal.isLegal(x, y, color);
      if (!info.ok && info.reason) toast(info.reason, 'danger', 1500);
    }
  }

  private onMove(move: Move, book: BookMatch | null): void {
    if (!this.renderer || !this.controller) return;
    this.renderer.registerStone(move);
    this.syncRenderer();
    this.renderMoves();
    if (book) this.renderBookChip(book);
  }

  private onGameOver(status: GameStatus, win: WinInfo | null): void {
    this.lastWin = win;
    this.syncRenderer();
    if (status === 'draw') return;
    const winner: Player = status === 'black-win' ? BLACK : WHITE;
    this.ctx.recordResult?.(winner === this.controller!.config.humanColor);
  }

  private syncAll(): void {
    if (!this.controller || !this.renderer) return;
    this.syncRenderer();
    this.syncTurn(this.root.querySelector('.board-badge') as HTMLElement);
    this.syncEval();
    this.renderMoves();
    this.syncAnalysisButton();
    this.renderForbidden();
  }

  private syncRenderer(): void {
    const c = this.controller;
    if (!c || !this.renderer) return;
    this.renderer.setState({
      size: c.size,
      cells: c.board.rawCells(),
      moves: c.board.moves,
      lastMove: c.board.lastMove ?? null,
      winLine: this.lastWin?.line ?? null,
      heat: this.heat,
      markers: this.markers,
      winPath: this.forcedPath,
      interactive: !c.isOver && !this.reviewing,
    });
    if (this.ctx.prefs.showNumbers) this.drawNumbers();
  }

  private drawNumbers(): void {
    const c = this.controller;
    const r = this.renderer;
    if (!c || !r) return;
    const canvas = this.canvas;
    const g = canvas.getContext('2d');
    if (!g) return;
    const { origin: pad, cell, cssSize } = r.metrics;
    const scale = canvas.width / (cssSize || 1);
    g.save();
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.font = `600 ${Math.max(8, cell * 0.34)}px "IBM Plex Mono", monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const m of c.board.moves) {
      const x = pad + m.x * cell;
      const y = pad + m.y * cell;
      g.fillStyle = m.player === BLACK ? 'rgba(240,232,214,0.86)' : 'rgba(52,42,28,0.86)';
      g.fillText(String(m.index), x, y + 0.5);
    }
    g.restore();
  }

  private syncTurn(badge: HTMLElement): void {
    const c = this.controller;
    if (!c) return;
    const turn = c.turn;
    const seat = turn === BLACK ? c.config.black : c.config.white;
    const isMe = c.canPlay(turn) && !c.isOver;
    badge.innerHTML = '';
    const dot = el('span', {
      class: `board-badge__dot board-badge__dot--${turn === BLACK ? 'black' : 'white'}${this.thinking || isMe ? ' board-badge__dot--pulse' : ''}`,
    });
    const label = c.isOver
      ? c.board.status === 'draw'
        ? '和棋'
        : `${c.board.status === 'black-win' ? '黑棋' : '白棋'}胜`
      : this.thinking
        ? `AI 思考中（${DIFFICULTIES.find((d) => d.id === c.config.difficulty)?.name ?? ''}）`
        : turn === c.config.humanColor && seat === 'human'
          ? '轮到你落子'
          : seat === 'remote'
            ? '等待对手落子'
            : turn === BLACK
              ? '黑棋行棋'
              : '白棋行棋';
    append(badge, [dot, el('span', { text: label })]);

    // 回合卡
    const card = this.cards.turn;
    if (card) {
      clear(card);
      const stone = el('div', { class: `turn-card__stone turn-card__stone--${turn === BLACK ? 'black' : 'white'}` });
      const who = c.isOver ? '对局结束' : `${turn === BLACK ? '黑棋' : '白棋'}行棋`;
      const meta =
        seat === 'human'
          ? '轮到你'
          : seat === 'ai'
            ? `${DIFFICULTIES.find((d) => d.id === c.config.difficulty)?.name ?? 'AI'} 正在计算`
            : '等待对手';
      const main = el('div', { class: 'turn-card__main' }, stone, el(
        'div',
        { class: 'turn-card__text' },
        el('div', { class: 'turn-card__who', text: who }),
        el('div', { class: 'turn-card__meta', text: c.isOver ? `${c.board.moveCount} 手` : meta }),
      ));
      const meter = this.evalRow;
      append(card, [main, meter ?? null]);
      this.evalRow = meter;
      card.classList.toggle('turn-card--thinking', this.thinking);
    }
  }

  private syncEval(scoreOverride?: number): void {
    const c = this.controller;
    if (!c || !this.cards.turn) return;
    const balance = scoreOverride === undefined ? c.evaluateBalance() : scoreToBalance(scoreOverride);
    const pct = Math.round(balance * 100);
    let bar = this.evalRow;
    if (!bar) {
      bar = el(
        'div',
        { class: 'meter' },
        el(
          'div',
          { class: 'meter__head' },
          el('span', { text: '黑' }),
          el('span', { class: 'meter__value', text: '50%' }),
          el('span', { text: '白' }),
        ),
        el('div', { class: 'evalbar' }, el('div', { class: 'evalbar__fill' }), el('div', { class: 'evalbar__mark' })),
      );
      this.evalRow = bar;
      this.cards.turn.appendChild(bar);
    }
    const fill = bar.querySelector('.evalbar__fill') as HTMLElement;
    const mark = bar.querySelector('.evalbar__mark') as HTMLElement;
    const value = bar.querySelector('.meter__value') as HTMLElement;
    fill.style.left = '0%';
    fill.style.width = `${pct}%`;
    mark.style.left = `${pct}%`;
    value.textContent = `${pct}%`;
  }

  private syncHoverNote(p: Point): void {
    const c = this.controller;
    if (!c || !this.notesList) return;
    const text = `${coordText(p, c.size)}：${c.pointNote(p, c.turn)}`;
    let tip = this.hoverNote;
    if (!tip) {
      tip = el('div', { class: 'note hover-note', style: { borderStyle: 'dashed' } }, el('span', { class: 'note__dot' }), el('span'));
      this.hoverNote = tip;
      this.notesList.prepend(tip);
    }
    const span = tip.lastElementChild as HTMLElement | null;
    if (span) span.textContent = text;
  }

  private hoverNote: HTMLElement | null = null;

  private evalRow: HTMLElement | null = null;
  private notesList!: HTMLElement;
  private thinkList!: HTMLElement;
  private moveList!: HTMLElement;

  private renderNotes(notes: Array<{ point: Point; text: string; tone: string }>): void {
    if (!this.notesList) return;
    clear(this.notesList);
    if (notes.length === 0) {
      this.notesList.appendChild(el('div', { class: 'faint', style: { fontSize: 'var(--step--1)' }, text: '局面平稳，暂无必须应对的威胁。' }));
      return;
    }
    for (const n of notes) {
      this.notesList.appendChild(
        el('div', { class: `note note--${n.tone}` }, el('span', { class: 'note__dot' }), el('span', { text: n.text })),
      );
    }
  }

  private renderThink(candidates: SearchOutcome['candidates'] | null, score: number): void {
    if (!this.thinkList) return;
    clear(this.thinkList);
    if (!candidates || candidates.length === 0) {
      this.thinkList.appendChild(el('div', { class: 'faint', style: { fontSize: 'var(--step--1)' }, text: '开启「分析」或请求「提示」后，这里会显示候选点与评分。' }));
      return;
    }
    const max = Math.max(...candidates.map((c) => c.score), 1);
    candidates.slice(0, 6).forEach((cand, i) => {
      const w = Math.max(0.04, cand.score / max);
      this.thinkList.appendChild(
        el(
          'div',
          { class: `think-item${i === 0 ? ' think-item--win' : ''}` },
          el('span', { class: 'think-item__coord', text: coordText(cand, this.controller?.size ?? 15) }),
          el('span', { class: 'think-item__bar' }, el('i', { style: { width: `${(w * 100).toFixed(1)}%` } })),
          el('span', { text: shapeLabel(cand.analysis.best) }),
        ),
      );
    });
    const verdict = el('div', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: `形势评估：${scoreText(score)}` });
    this.thinkList.appendChild(verdict);
  }

  private renderMoves(): void {
    const c = this.controller;
    if (!c || !this.moveList) return;
    clear(this.moveList);
    const moves = c.board.moves;
    if (moves.length === 0) {
      this.moveList.appendChild(el('div', { class: 'movelist__empty', text: '尚未落子' }));
      return;
    }
    for (let i = 0; i < moves.length; i += 2) {
      const row = el('div', { class: 'movelist__row' });
      row.appendChild(el('span', { class: 'movelist__no', text: String(i / 2 + 1) }));
      for (const k of [i, i + 1]) {
        const m = moves[k];
        if (!m) {
          row.appendChild(el('span'));
          continue;
        }
        row.appendChild(
          el(
            'button',
            {
              class: `movelist__move${k === moves.length - 1 ? ' is-current' : ''}`,
              type: 'button',
              onclick: () => {
                this.reviewIndex = k + 1;
                this.enterReview(k + 1);
              },
            },
            el('span', { class: `movelist__glyph movelist__glyph--${m.player === BLACK ? 'black' : 'white'}` }),
            coordText(m, c.size),
          ),
        );
      }
      this.moveList.appendChild(row);
    }
  }

  private renderBookChip(book: BookMatch): void {
    if (!this.moveList) return;
    const chip = el('div', {
      class: 'note note--win',
      style: { marginTop: 'var(--sp-2)' },
    }, el('span', { class: 'note__dot' }), el('span', { text: `定式：${book.openingName} · ${book.variationName}${book.nextMoves.length ? ` · 谱着 ${book.nextMoves.map((p) => coordText(p, this.controller?.size ?? 15)).join('/')}` : ''}` }));
    this.moveList.prepend(chip);
  }

  private syncBook(match: BookMatch | null): void {
    if (!this.renderer) return;
    const ghost = match && match.nextMoves.length === 1 && this.ctx.prefs.hints !== false
      ? { ...match.nextMoves[0], player: this.controller!.turn }
      : null;
    this.renderer.setState({ ghost });
  }

  private renderForbidden(): void {
    const c = this.controller;
    if (!c || !this.renderer) return;
    if (c.config.rules !== 'renju') return;
    const pts = c.board.forbiddenPoints();
    const markers = pts.slice(0, 12).map((p) => ({ x: p.x, y: p.y, kind: 'forbidden' as const }));
    this.markers = [...this.markers.filter((m) => m.kind !== 'forbidden'), ...markers];
  }

  private syncAnalysisButton(): void {
    const btn = this.root.querySelector('#btn-analysis') as HTMLButtonElement | null;
    if (!btn || !this.controller) return;
    btn.classList.toggle('btn--primary', this.controller.analysisEnabled);
  }

  /* ------------------------------------------------------------------ */
  /* 操作                                                                */
  /* ------------------------------------------------------------------ */

  private doUndo(): void {
    const c = this.controller;
    if (!c) return;
    if (this.reviewing) {
      this.exitReview();
    }
    if (this.options.mode === 'online' && this.options.net) {
      this.options.net.sendUndo();
      toast('已向对手发送悔棋请求', 'info', 1800);
      return;
    }
    if (!c.undo()) {
      toast('没有可悔的棋', 'info', 1400);
      return;
    }
    this.lastWin = null;
    this.forcedPath = null;
    this.heat = [];
    this.syncAll();
  }

  private async doHint(): Promise<void> {
    const c = this.controller;
    if (!c || c.isOver) return;
    if (!c.canPlay(c.turn) && this.options.mode !== 'ai') {
      toast('等待对手落子', 'info', 1200);
      return;
    }
    toast('正在为你计算…', 'info', 900);
    const p = await c.requestHint();
    if (!p) return;
    this.markers = [...this.markers.filter((m) => m.kind !== 'book'), { ...p, kind: 'book' }];
    this.forcedPath = null;
    this.syncRenderer();
    toast(`推荐落点：${coordText(p, c.size)}`, 'win', 2600);
  }

  private confirmResign(): void {
    const c = this.controller;
    if (!c || c.isOver) return;
    modal({
      title: '确认认输？',
      body: [el('p', { text: '认输后本局立即结束，棋谱仍可导出复盘。' })],
      actions: [
        { label: '继续对弈', kind: 'ghost', onClick: () => undefined },
        {
          label: '确认认输',
          kind: 'danger',
          onClick: () => {
            const color = c.config.humanColor;
            c.resign(color);
            this.options.net?.sendResign(color);
            this.syncAll();
          },
        },
      ],
    });
  }

  private confirmRestart(): void {
    const c = this.controller;
    if (!c) return;
    modal({
      title: '重新开局？',
      body: [el('p', { text: '当前棋谱将被清空。' })],
      actions: [
        { label: '取消', kind: 'ghost', onClick: () => undefined },
        {
          label: '重新开局',
          kind: 'primary',
          onClick: () => {
            this.lastWin = null;
            this.heat = [];
            this.markers = [];
            this.forcedPath = null;
            this.reviewing = false;
            c.start();
            this.syncAll();
          },
        },
      ],
    });
  }

  private exportSgf(): void {
    const c = this.controller;
    if (!c) return;
    const status = c.board.status;
    const result = status === 'black-win' ? 'B+' : status === 'white-win' ? 'W+' : status === 'draw' ? '0' : '?';
    const sgf = toSgf(c.board.moves, c.size, {
      blackName: c.config.black === 'ai' ? `AI(${c.config.difficulty})` : '玩家',
      whiteName: c.config.white === 'ai' ? `AI(${c.config.difficulty})` : '玩家',
      event: '墨韵五子棋',
      date: new Date().toISOString().slice(0, 10),
      result,
      rules: c.config.rules === 'renju' ? 'Renju' : 'Gomoku',
    });
    const blob = new Blob([sgf], { type: 'application/x-go-sgf' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `ink-gomoku-${Date.now()}.sgf` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已导出 SGF 棋谱', 'win', 2000);
  }

  private async copyShare(): Promise<void> {
    const c = this.controller;
    if (!c) return;
    const hash = c.board.moves.map((m) => `${m.x}${m.y}${m.player}`).join('');
    const url = `${location.origin}${location.pathname}#/review?m=${hash}&s=${c.size}&r=${c.config.rules === 'renju' ? 1 : 0}`;
    const ok = await copyText(url);
    toast(ok ? '局面链接已复制' : '复制失败，请手动复制地址栏', ok ? 'win' : 'danger', 2200);
  }

  private openChat(): void {
    const net = this.options.net;
    if (!net) return;
    let input: HTMLInputElement;
    const close = modal({
      title: '与对手聊天',
      body: [
        (input = el('input', { class: 'input', placeholder: '说点什么…', maxlength: '120' })),
      ],
      actions: [
        { label: '关闭', kind: 'ghost', onClick: () => undefined },
        {
          label: '发送',
          kind: 'primary',
          onClick: () => {
            const v = input.value.trim();
            if (!v) return;
            net.sendChat(v);
            input.value = '';
            close();
          },
        },
      ],
    });
    window.setTimeout(() => input.focus(), 60);
  }

  /* ------------------------------------------------------------------ */
  /* 复盘                                                                */
  /* ------------------------------------------------------------------ */

  private enterReview(at?: number): void {
    const c = this.controller;
    if (!c) return;
    this.reviewing = true;
    this.reviewMoves = [...c.board.moves];
    this.reviewIndex = at ?? this.reviewMoves.length;
    this.mountReviewPanel();
    this.syncReview();
  }

  private exitReview(): void {
    this.reviewing = false;
    this.cards.review?.remove();
    delete this.cards.review;
    this.syncAll();
  }

  private mountReviewPanel(): void {
    if (this.cards.review) return;
    const c = this.controller!;
    const label = el('div', { class: 'mono', style: { fontSize: 'var(--step--1)', color: 'var(--gold-300)' } });
    const prev = el('button', { class: 'btn btn--icon', type: 'button', title: '上一手', onclick: () => { this.reviewIndex = Math.max(0, this.reviewIndex - 1); this.syncReview(); } }, icon('left', 16));
    const next = el('button', { class: 'btn btn--icon', type: 'button', title: '下一手', onclick: () => { this.reviewIndex = Math.min(this.reviewMoves.length, this.reviewIndex + 1); this.syncReview(); } }, icon('right', 16));
    const first = el('button', { class: 'btn btn--icon', type: 'button', title: '回到开局', onclick: () => { this.reviewIndex = 0; this.syncReview(); } }, icon('start', 16));
    const last = el('button', { class: 'btn btn--icon', type: 'button', title: '跳到最后', onclick: () => { this.reviewIndex = this.reviewMoves.length; this.syncReview(); } }, icon('end', 16));
    const exit = el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => this.exitReview() }, '退出复盘');
    const card = el(
      'div',
      { class: 'card', dataset: { tab: 'moves' } },
      el(
        'div',
        { class: 'card__body stack' },
        el('div', { class: 'card__title', text: '复盘' }),
        el('div', { class: 'row row--between' }, label, exit),
        el('div', { class: 'row' }, first, prev, next, last),
        el('p', { class: 'faint', style: { fontSize: 'var(--step--2)', margin: '0' }, text: '复盘中棋盘只读；点击棋谱中的任意一手可直接跳转到该局面。' }),
      ),
    );
    this.cards.review = card;
    this.reviewLabel = label;
    this.layout();
    void c;
  }

  private reviewLabel: HTMLElement | null = null;

  private syncReview(): void {
    const c = this.controller;
    const r = this.renderer;
    if (!c || !r) return;
    const prefix = this.reviewMoves.slice(0, this.reviewIndex);
    const board = Board.fromMoves(prefix, { size: c.size, rules: c.config.rules });
    const last = prefix[prefix.length - 1] ?? null;
    const win = last ? board.checkWinAt(last.x, last.y) : null;
    r.setState({
      cells: board.rawCells(),
      moves: board.moves,
      lastMove: last,
      winLine: win?.line ?? null,
      heat: [],
      markers: [],
      winPath: null,
      ghost: null,
      interactive: false,
    });
    if (this.reviewLabel) {
      this.reviewLabel.textContent = `第 ${this.reviewIndex} / ${this.reviewMoves.length} 手${last ? ` · ${coordText(last, c.size)}` : ''}`;
    }
  }

  private mountReview(): void {
    this.canvas = el('canvas', { class: 'board-canvas' });
    const frame = el('div', { class: 'board-frame' }, this.canvas);
    this.renderer = new BoardRenderer(this.canvas, {
      size: this.options.config?.size ?? 15,
      cells: new Int8Array((this.options.config?.size ?? 15) ** 2),
      moves: [],
      lastMove: null,
      winLine: null,
      heat: [],
      markers: [],
      ghost: null,
      winPath: null,
      showCoords: this.ctx.prefs.showCoords,
      showNumbers: this.ctx.prefs.showNumbers,
      interactive: false,
    });
    const size = this.options.config?.size ?? 15;
    const board = Board.fromMoves(
      this.reviewMoves.map((m) => ({ x: m.x, y: m.y })),
      { size, rules: this.options.config?.rules ?? 'freestyle' },
    );
    this.renderer.setState({ cells: board.rawCells(), moves: board.moves, lastMove: board.lastMove ?? null });
    const last = board.lastMove;
    const win = last ? board.checkWinAt(last.x, last.y) : null;
    if (win) this.renderer.flashWin(win.line);
    append(this.root, [
      el(
        'div',
        { class: 'page-head' },
        el('h1', { class: 'page-title', text: this.options.reviewTitle ?? '棋谱复盘' }),
        el('p', { class: 'page-lead', text: '来自分享链接的局面。' }),
      ),
      el('div', { class: 'play' }, el('div', { class: 'stage' }, frame)),
    ]);
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function field(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'field' }, el('span', { class: 'field__label', text: label }), control);
}

function switchRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: value, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  return el(
    'label',
    { class: 'switch' },
    input,
    el('span', { class: 'switch__track' }),
    el('span', { class: 'switch__label', text: label }),
  );
}

function shapeLabel(shape: number): string {
  const names = ['—', '单子', '眠二', '活二', '眠三', '活三', '冲四', '活四', '五连'];
  return names[shape] ?? '—';
}

/** 把 AI 的分数映射到 0~1 的形势比例（黑方视角为正） */
function scoreToBalance(score: number): number {
  if (!Number.isFinite(score)) return 0.5;
  const k = 90_000;
  return 1 / (1 + Math.exp(-score / k));
}

function scoreText(score: number): string {
  if (score >= 8_000_000) return '必胜';
  if (score <= -8_000_000) return '危险';
  if (score > 80_000) return '明显占优';
  if (score < -80_000) return '稍处下风';
  return '均势';
}

