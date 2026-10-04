/**
 * 定式道场：26 种开局的交互教学。
 * 逐步演示、要点讲解、小测校验，以及「把定式带进对局」。
 */

import { ALL_OPENINGS, inBook, variationPrefix } from '../ai/book';
import type { Opening, OpeningVariation } from '../data/openings';
import { Board } from '../core/board';
import { coordText } from '../core/coords';
import { toSgf } from '../core/sgf';
import type { Move, Point } from '../core/types';
import { sound } from '../ui/audio';
import { append, clear, copyText, el, icon, toast } from '../ui/dom';
import { BoardRenderer } from '../ui/renderer';
import type { AppContext, View } from '../app';

type Filter = 'all' | '直指' | '斜指';

export class LessonsView implements View {
  private readonly ctx: AppContext;

  private root!: HTMLElement;
  private renderer: BoardRenderer | null = null;
  private canvas!: HTMLCanvasElement;

  private filter: Filter = 'all';
  private opening: Opening = ALL_OPENINGS[0];
  private variation: OpeningVariation = ALL_OPENINGS[0].variations[0];
  private ply = 0;
  private playing = false;
  private playTimer = 0;
  private quizDone = false;
  private quizTried = 0;
  private hintPoint: Point | null = null;

  private openingGrid!: HTMLElement;
  private variationList!: HTMLElement;
  private boardInfo!: HTMLElement;
  private commentaryBox!: HTMLElement;
  private quizBox!: HTMLElement;
  private progressBox!: HTMLElement;
  private titleBox!: HTMLElement;

  constructor(ctx: AppContext, focusId?: string) {
    this.ctx = ctx;
    if (focusId) {
      const found = ALL_OPENINGS.find((o) => o.id === focusId || o.name === focusId);
      if (found) {
        this.opening = found;
        this.variation = found.variations[0];
      }
    }
  }

  mount(): HTMLElement {
    this.root = el('div', { class: 'view' });
    this.canvas = el('canvas', { class: 'board-canvas', 'aria-label': '定式演示棋盘' });

    const frame = el('div', { class: 'board-frame' }, this.canvas);
    this.boardInfo = el('div', { class: 'card__body stack', style: { paddingTop: '0' } });

    const left = el('aside', { class: 'lesson-col' });
    const center = el('div', { class: 'stage' }, frame, this.buildControls(), this.boardInfo);
    const right = el('aside', { class: 'lesson-col' });

    append(this.root, [
      el(
        'div',
        { class: 'page-head' },
        el('div', { class: 'hero__eyebrow', text: 'Opening Theory' }),
        el('h1', { class: 'page-title', text: '定式道场' }),
        el('p', {
          class: 'page-lead',
          text: '26 种标准开局、69 个变化。点开任意一个，逐步看它如何展开；读懂了就做一道小测，再把这条定式带进与 AI 的对局里验证。',
        }),
      ),
      el('div', { class: 'lesson-layout' }, left, center, right),
    ]);

    // 左侧：开局选择
    const filterSeg = el('div', { class: 'segmented' });
    const buildFilter = () => {
      clear(filterSeg);
      ([
        ['all', `全部 ${ALL_OPENINGS.length}`],
        ['直指', '直指 13'],
        ['斜指', '斜指 13'],
      ] as Array<[Filter, string]>).forEach(([f, label]) => {
        filterSeg.appendChild(
          el('button', {
            class: 'segmented__item',
            type: 'button',
            'aria-pressed': String(this.filter === f),
            text: label,
            onclick: () => {
              this.filter = f;
              buildFilter();
              this.buildOpeningGrid();
              sound.play('tick');
            },
          }),
        );
      });
    };
    buildFilter();
    this.openingGrid = el('div', { class: 'opening-grid' });
    append(left, [
      el('div', { class: 'card' }, el('div', { class: 'card__body stack' }, el('div', { class: 'card__title', text: '选择开局' }), filterSeg)),
      this.openingGrid,
    ]);

    // 右侧：变化 + 讲解 + 小测
    this.titleBox = el('div', { class: 'card__body stack' });
    this.variationList = el('div', { class: 'variation-list' });
    this.commentaryBox = el('div', { class: 'commentary' });
    this.quizBox = el('div', { class: 'stack' });
    this.progressBox = el('div', { class: 'row row--between' });
    append(right, [
      el('div', { class: 'card' }, this.titleBox),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card__body stack' }, el('div', { class: 'card__title', text: '变化' }), this.variationList),
      ),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card__body stack' }, el('div', { class: 'card__title', text: '要点讲解' }), this.commentaryBox, this.quizBox),
      ),
      el('div', { class: 'card' }, el('div', { class: 'card__body' }, this.progressBox)),
    ]);

    this.renderer = new BoardRenderer(
      this.canvas,
      {
        size: 15,
        cells: new Int8Array(225),
        moves: [],
        lastMove: null,
        winLine: null,
        heat: [],
        markers: [],
        ghost: null,
        winPath: null,
        showCoords: this.ctx.prefs.showCoords,
        showNumbers: true,
        interactive: true,
      },
      { onPlace: (x, y) => this.handleBoardClick(x, y) },
    );

    this.buildOpeningGrid();
    this.selectOpening(this.opening, this.variation);
    return this.root;
  }

  destroy(): void {
    window.clearInterval(this.playTimer);
    this.renderer?.destroy();
  }

  /* ------------------------------------------------------------------ */
  /* 左侧：开局列表                                                      */
  /* ------------------------------------------------------------------ */

  private buildOpeningGrid(): void {
    clear(this.openingGrid);
    const list = ALL_OPENINGS.filter((o) => this.filter === 'all' || o.category === this.filter);
    for (const o of list) {
      const done = o.variations.filter((v) => this.ctx.prefs.progress[v.id]).length;
      this.openingGrid.appendChild(
        el(
          'button',
          {
            class: 'opening-chip',
            type: 'button',
            'aria-pressed': String(o.id === this.opening.id),
            onclick: () => this.selectOpening(o, o.variations[0]),
          },
          el('div', { class: 'opening-chip__name', text: o.name }),
          el('div', { class: 'opening-chip__meta', text: `${o.category} ${o.number} · ${o.number <= 13 ? '黑1天元' : ''}` }),
          el(
            'div',
            { class: 'opening-chip__adv row', style: { gap: '4px' } },
            el('span', { class: `tag ${o.firstAdvantage === '黑优' ? 'tag--gold' : o.firstAdvantage === '白优' ? 'tag--cinnabar' : 'tag--jade'}`, text: o.firstAdvantage }),
            done > 0 ? el('span', { class: 'tag', text: `${done}/${o.variations.length}` }) : null,
          ),
        ),
      );
    }
  }

  private selectOpening(o: Opening, v: OpeningVariation): void {
    this.opening = o;
    this.variation = v;
    this.ply = 0;
    this.quizDone = false;
    this.quizTried = 0;
    this.hintPoint = null;
    this.stopPlaying();
    this.buildOpeningGrid();
    this.renderTitle();
    this.renderVariations();
    this.renderCommentary();
    this.renderQuiz();
    this.renderProgress();
    this.syncBoard();
    sound.play('tick');
  }

  /* ------------------------------------------------------------------ */
  /* 右侧面板                                                            */
  /* ------------------------------------------------------------------ */

  private renderTitle(): void {
    const o = this.opening;
    clear(this.titleBox);
    append(this.titleBox, [
      el(
        'div',
        { class: 'row row--between' },
        el('div', { class: 'card__title', text: `${o.name}　${o.category}` }),
        el('span', { class: 'tag tag--cinnabar', text: o.pinyin }),
      ),
      el('p', { style: { margin: '0', color: 'var(--text-dim)', fontSize: 'var(--step--1)' }, text: o.summary }),
      el(
        'div',
        { class: 'keypoints' },
        el('span', { class: `tag ${o.firstAdvantage === '黑优' ? 'tag--gold' : o.firstAdvantage === '白优' ? 'tag--cinnabar' : 'tag--jade'}`, text: o.firstAdvantage }),
        el('span', { class: 'tag', text: `难度 ${'●'.repeat(o.difficulty)}${'○'.repeat(3 - o.difficulty)}` }),
      ),
      el(
        'div',
        { class: 'stack' },
        ...o.theory.map((t) => el('p', { style: { margin: '0', fontSize: 'var(--step--1)', color: 'var(--text-dim)', lineHeight: '1.85' }, text: t })),
      ),
      el(
        'div',
        { class: 'keypoints' },
        ...o.keyPoints.map((k) => el('span', { class: 'tag', text: k })),
      ),
    ]);
  }

  private renderVariations(): void {
    clear(this.variationList);
    for (const v of this.opening.variations) {
      this.variationList.appendChild(
        el(
          'button',
          {
            class: 'variation',
            type: 'button',
            'aria-pressed': String(v.id === this.variation.id),
            onclick: () => this.selectOpening(this.opening, v),
          },
          el(
            'div',
            { class: 'variation__head' },
            el('span', { class: 'variation__name', text: v.name }),
            el('span', { class: `tag ${v.tag === '主流' ? 'tag--gold' : v.tag === '陷阱' ? 'tag--cinnabar' : 'tag--jade'}`, text: v.tag }),
            this.ctx.prefs.progress[v.id] ? el('span', { class: 'tag tag--gold', text: '已学' }) : null,
          ),
          el('div', { class: 'variation__sum', text: v.summary }),
        ),
      );
    }
  }

  private renderCommentary(): void {
    clear(this.commentaryBox);
    const paras = this.variation.commentary;
    const active = Math.min(paras.length - 1, Math.floor(this.ply / Math.max(1, Math.ceil(this.variation.moves.length / paras.length))));
    paras.forEach((text, i) => {
      this.commentaryBox.appendChild(el('p', { class: i === active ? 'is-active' : '', text }));
    });
  }

  private renderQuiz(): void {
    clear(this.quizBox);
    const quiz = this.variation.quiz;
    if (!quiz) {
      this.quizBox.appendChild(
        el('div', { class: 'quiz' }, el('div', { class: 'quiz__prompt', text: '自由演练' }), el('div', { class: 'faint', style: { fontSize: 'var(--step--1)' }, text: '这个变化没有配套小测，直接点击棋盘任意交叉点，看看会发生什么。' })),
      );
      return;
    }
    const status = el('div', { class: 'quiz__status' });
    const box = el(
      'div',
      { class: 'quiz' },
      el('div', { class: 'quiz__prompt', text: quiz.prompt }),
      el('div', { class: 'row wrap' }, el('button', {
        class: 'btn btn--sm',
        type: 'button',
        onclick: () => {
          this.hintPoint = { x: quiz.answer.x, y: quiz.answer.y };
          this.syncBoard();
          toast('已在棋盘上用金环标出答案', 'info', 2000);
        },
      }, icon('bulb', 15), '看答案位置'), el('span', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: '或直接在棋盘上落子作答' })),
      status,
    );
    if (this.quizDone) {
      status.className = 'quiz__status quiz__status--ok';
      status.textContent = `答对了！${quiz.explanation}`;
    } else if (this.quizTried > 0) {
      status.className = 'quiz__status quiz__status--bad';
      status.textContent = `再想想 —— 已尝试 ${this.quizTried} 次。提示：先找能形成「四」或「活三」的点。`;
    }
    this.quizBox.appendChild(box);
  }

  private renderProgress(): void {
    const total = ALL_OPENINGS.reduce((n, o) => n + o.variations.length, 0);
    const done = Object.keys(this.ctx.prefs.progress).length;
    clear(this.progressBox);
    append(this.progressBox, [
      el(
        'div',
        { class: 'row', style: { gap: 'var(--sp-3)' } },
        el('div', { class: 'progress-ring', style: { '--p': String(Math.round((done / total) * 100)) } }, el('span', { class: 'progress-ring__text', text: `${Math.round((done / total) * 100)}%` })),
        el(
          'div',
          {},
          el('div', { style: { fontSize: 'var(--step--1)' }, text: '定式修习进度' }),
          el('div', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: `已完成 ${done} / ${total} 个变化` }),
        ),
      ),
      el(
        'button',
        {
          class: 'btn btn--sm',
          type: 'button',
          onclick: () => {
            this.ctx.prefs.progress = {};
            this.ctx.savePrefs();
            this.renderProgress();
            this.buildOpeningGrid();
            toast('进度已重置', 'info', 1600);
          },
        },
        '重置',
      ),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 棋盘与控制                                                          */
  /* ------------------------------------------------------------------ */

  private buildControls(): HTMLElement {
    const mk = (ico: string, title: string, fn: () => void, kbd?: string) =>
      el('button', { class: 'btn btn--icon', type: 'button', title, 'aria-label': title, dataset: kbd ? { kbd } : {}, onclick: fn }, icon(ico, 17));
    const bar = el(
      'div',
      { class: 'actionbar' },
      mk('start', '回到开局', () => this.goto(0)),
      mk('left', '上一手', () => this.goto(this.ply - 1)),
      el('button', { class: 'btn', type: 'button', onclick: () => this.togglePlay() }, icon('play', 16), '自动演示'),
      mk('right', '下一手', () => this.goto(this.ply + 1)),
      mk('end', '走完全谱', () => this.goto(this.variation.moves.length)),
      el('div', { class: 'actionbar__spacer' }),
      el(
        'button',
        {
          class: 'btn btn--primary',
          type: 'button',
          onclick: () => {
            const idx = this.opening.variations.indexOf(this.variation);
            this.ctx.navigate(`#/ai?o=${this.opening.id}&v=${idx}`);
          },
        },
        icon('swords', 16),
        '与 AI 演练',
      ),
    );
    return bar;
  }

  private goto(ply: number): void {
    const max = this.variation.moves.length;
    this.ply = Math.max(0, Math.min(max, ply));
    this.hintPoint = null;
    this.syncBoard();
    this.renderCommentary();
    sound.play('tick');
    if (this.ply >= max) this.markProgress();
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlaying();
      return;
    }
    this.playing = true;
    if (this.ply >= this.variation.moves.length) this.ply = 0;
    this.playTimer = window.setInterval(() => {
      if (this.ply >= this.variation.moves.length) {
        this.stopPlaying();
        return;
      }
      this.ply += 1;
      this.syncBoard();
      this.renderCommentary();
      sound.play('tick');
      if (this.ply >= this.variation.moves.length) this.markProgress();
    }, 900);
  }

  private stopPlaying(): void {
    this.playing = false;
    window.clearInterval(this.playTimer);
  }

  private markProgress(): void {
    if (!this.ctx.prefs.progress[this.variation.id]) {
      this.ctx.prefs.progress[this.variation.id] = 1;
      this.ctx.savePrefs();
      this.renderProgress();
      this.buildOpeningGrid();
      this.renderVariations();
    }
  }

  private handleBoardClick(x: number, y: number): void {
    const quiz = this.variation.quiz;
    if (quiz && !this.quizDone) {
      if (quiz.answer.x === x && quiz.answer.y === y) {
        this.quizDone = true;
        this.markProgress();
        sound.play('win');
        toast('答对了！', 'win', 2400);
      } else {
        this.quizTried += 1;
        sound.play('undo');
        toast('位置不对，再找找看', 'danger', 1800);
      }
      this.renderQuiz();
      this.syncBoard();
      return;
    }
    // 非答题状态：显示该点的战术评价
    const board = this.buildBoard(this.ply);
    const moves = variationPrefix(this.variation, this.ply + 1);
    const isBookNext = this.ply < this.variation.moves.length && this.variation.moves[this.ply].x === x && this.variation.moves[this.ply].y === y;
    if (isBookNext) {
      this.goto(this.ply + 1);
    } else {
      const inDb = inBook(moves);
      toast(
        inDb
          ? `${coordText({ x, y }, 15)} 不在本变化的主线上，但仍是定式库内的选点`
          : `${coordText({ x, y }, 15)} 属于自选着法`,
        'info',
        2000,
      );
      void board;
    }
  }

  private buildBoard(ply: number): Board {
    const moves: Move[] = variationPrefix(this.variation, ply).map((p, i) => ({
      x: p.x,
      y: p.y,
      player: (i % 2 === 0 ? 1 : 2) as Move['player'],
      index: i + 1,
    }));
    const board = new Board({ size: 15 });
    for (const m of moves) board.place(m.x, m.y, m.player);
    return board;
  }

  private syncBoard(): void {
    if (!this.renderer) return;
    const board = this.buildBoard(this.ply);
    const markers = this.hintPoint ? [{ x: this.hintPoint.x, y: this.hintPoint.y, kind: 'book' as const }] : [];
    // 下一手的提示点（虚线金环）
    if (!this.hintPoint && this.ply < this.variation.moves.length && this.ctx.prefs.hints !== false) {
      const next = this.variation.moves[this.ply];
      markers.push({ x: next.x, y: next.y, kind: 'book' });
    }
    this.renderer.setState({
      cells: board.rawCells(),
      moves: board.moves,
      lastMove: board.lastMove ?? null,
      winLine: null,
      markers,
      ghost: null,
      showNumbers: true,
      interactive: true,
    });
    const note = this.ply > 0 ? this.variation.moves[this.ply - 1].note : '开局：黑1 落天元，先手必争。';
    clear(this.boardInfo);
    append(this.boardInfo, [
      el(
        'div',
        { class: 'row row--between' },
        el('span', { class: 'mono', style: { color: 'var(--gold-300)' }, text: `第 ${this.ply} / ${this.variation.moves.length} 手` }),
        el('span', { class: 'faint', style: { fontSize: 'var(--step--2)' }, text: this.variation.name }),
      ),
      el('div', { style: { fontSize: 'var(--step--1)', color: 'var(--text-dim)' }, text: note ?? '' }),
      el(
        'div',
        { class: 'row wrap' },
        el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => this.exportVariation() }, icon('download', 15), '导出 SGF'),
        el('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => void this.copyVariation() }, icon('copy', 15), '复制着法'),
      ),
    ]);
  }

  private moveList(): Move[] {
    return this.variation.moves.map((m, i) => ({ x: m.x, y: m.y, player: (i % 2 === 0 ? 1 : 2) as Move['player'], index: i + 1, note: m.note }));
  }

  private exportVariation(): void {
    const sgf = toSgf(this.moveList(), 15, {
      event: `墨韵五子棋 · ${this.opening.name}`,
      blackName: '定式演示',
      whiteName: this.variation.name,
      rules: 'Gomoku',
    });
    const blob = new Blob([sgf], { type: 'application/x-go-sgf' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${this.opening.id}-${this.variation.id}.sgf` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('已导出该变化的 SGF', 'win', 2000);
  }

  private async copyVariation(): Promise<void> {
    const text = this.variation.moves.map((m, i) => `${i + 1}. ${coordText(m, 15)}`).join('　');
    const ok = await copyText(`${this.opening.name} · ${this.variation.name}\n${text}`);
    toast(ok ? '着法已复制' : '复制失败', ok ? 'win' : 'danger', 1800);
  }
}
