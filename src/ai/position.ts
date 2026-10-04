/** 增量局面：只更新落子穿过的窗口、四条线上的候选分值和邻域。 */
import type { Player } from '../core/types';
import { DIRS, eachLine, SHAPE_SCORE, Shape, WINDOW_TABLE } from './shapes';

const MOVE_CODES = 1 << 16;
const WINDOW_CODES = 1 << 14;
const moveTable = new Int32Array(MOVE_CODES * 2);
const line = new Int8Array(9);

// 中心恒为待落的棋子，编码另外八格。棋盘外和对手都阻断五窗口。
for (let code = 0; code < MOVE_CODES; code++) {
  for (let color = 1; color <= 2; color++) {
    let bits = code;
    for (let j = 0; j < 9; j++) {
      line[j] = j === 4 ? color : bits & 3;
      if (j !== 4) bits >>>= 2;
    }
    let wins = 0;
    let stones = 0;
    let openThree = false;
    for (let start = 0; start <= 4; start++) {
      let mine = 0;
      let empty = -1;
      let blocked = false;
      for (let j = start; j < start + 5; j++) {
        if (line[j] === color) mine++;
        else if (line[j] === 0) empty = j;
        else { blocked = true; break; }
      }
      if (blocked) continue;
      stones = Math.max(stones, mine);
      if (mine === 4) wins |= 1 << empty;
    }
    for (let start = 0; start <= 3; start++) {
      if (line[start] !== 0 || line[start + 5] !== 0) continue;
      let mine = 0;
      let blocked = false;
      for (let j = start + 1; j < start + 5; j++) {
        if (line[j] === color) mine++;
        else if (line[j] !== 0) blocked = true;
      }
      if (!blocked && mine === 3) openThree = true;
    }
    const shape = stones >= 5 ? Shape.FIVE
      : wins && (wins & (wins - 1)) ? Shape.OPEN_FOUR
      : wins ? Shape.FOUR
      : openThree ? Shape.OPEN_THREE
      : stones === 3 ? Shape.SLEEP_THREE
      : stones === 2 ? Shape.OPEN_TWO
      : stones === 1 ? Shape.ONE : Shape.NONE;
    moveTable[(color - 1) * MOVE_CODES + code] = SHAPE_SCORE[shape];
  }
}

interface Topology {
  rays: Int16Array;
  windows: Array<{ id: number; shift: number }>[];
  windowCells: number[][];
  neighbors: number[][];
}
const topologies = new Map<number, Topology>();
function topology(size: number): Topology {
  const saved = topologies.get(size);
  if (saved) return saved;
  const count = size * size;
  const rays = new Int16Array(count * 32).fill(-1);
  const windows: Topology['windows'] = Array.from({ length: count }, () => []);
  const windowCells: number[][] = [];
  const neighbors: number[][] = Array.from({ length: count }, () => []);
  for (let idx = 0; idx < count; idx++) {
    const x = idx % size;
    const y = (idx / size) | 0;
    for (let d = 0; d < 4; d++) {
      let slot = idx * 32 + d * 8;
      const [dx, dy] = DIRS[d];
      for (let i = -4; i <= 4; i++) {
        if (i === 0) continue;
        const nx = x + i * dx;
        const ny = y + i * dy;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) rays[slot] = ny * size + nx;
        slot++;
      }
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) neighbors[idx].push(ny * size + nx);
      }
    }
  }
  eachLine(size, (x, y, dx, dy, length) => {
    for (let start = 0; start <= length - 7; start++) {
      const id = windowCells.length;
      const points: number[] = [];
      for (let j = 0; j < 7; j++) {
        const idx = (y + (start + j) * dy) * size + x + (start + j) * dx;
        points.push(idx);
        windows[idx].push({ id, shift: (6 - j) * 2 });
      }
      windowCells.push(points);
    }
  });
  const result = { rays, windows, windowCells, neighbors };
  topologies.set(size, result);
  return result;
}

export class SearchPosition {
  readonly attack: [Int32Array, Int32Array];
  readonly neighbors: Int16Array;
  private readonly geometry: Topology;
  private readonly directions: [Int32Array, Int32Array];
  private readonly codes: Int32Array;
  private black = 0;
  private white = 0;

  constructor(private readonly cells: Int8Array, size: number) {
    this.geometry = topology(size);
    this.attack = [new Int32Array(cells.length), new Int32Array(cells.length)];
    this.directions = [new Int32Array(cells.length * 4), new Int32Array(cells.length * 4)];
    this.neighbors = new Int16Array(cells.length);
    this.codes = new Int32Array(this.geometry.windowCells.length);
    this.geometry.windowCells.forEach((points, id) => {
      let code = 0;
      for (const idx of points) code = (code << 2) | cells[idx];
      this.codes[id] = code;
      this.black += WINDOW_TABLE[code];
      this.white += WINDOW_TABLE[WINDOW_CODES + code];
    });
    for (let idx = 0; idx < cells.length; idx++) {
      if (cells[idx]) for (const near of this.geometry.neighbors[idx]) this.neighbors[near]++;
      for (let d = 0; d < 4; d++) this.updateDirection(idx, d);
      this.combine(idx);
    }
  }

  /** 调用前 cells[idx] 已经改为 next；撤销也走完全相同的路径。 */
  update(idx: number, previous: number, next: number): void {
    for (const { id, shift } of this.geometry.windows[idx]) {
      const old = this.codes[id];
      const code = old ^ ((previous ^ next) << shift);
      this.black += WINDOW_TABLE[code] - WINDOW_TABLE[old];
      this.white += WINDOW_TABLE[WINDOW_CODES + code] - WINDOW_TABLE[WINDOW_CODES + old];
      this.codes[id] = code;
    }
    const delta = next ? 1 : -1;
    for (const near of this.geometry.neighbors[idx]) this.neighbors[near] += delta;
    for (let d = 0; d < 4; d++) {
      this.updateDirection(idx, d);
      for (let j = idx * 32 + d * 8; j < idx * 32 + d * 8 + 8; j++) {
        const near = this.geometry.rays[j];
        if (near < 0 || this.cells[near]) continue;
        this.updateDirection(near, d);
        this.combine(near);
      }
    }
    this.combine(idx);
  }

  evaluate(color: Player): number {
    // Negamax 要求双方分数严格互为相反数。
    const score = this.black - this.white;
    return color === 1 ? score : -score;
  }

  private updateDirection(idx: number, direction: number): void {
    let code = 0;
    const offset = idx * 32 + direction * 8;
    for (let j = 0; j < 8; j++) {
      const near = this.geometry.rays[offset + j];
      code |= (near < 0 ? 3 : this.cells[near]) << (j * 2);
    }
    this.directions[0][idx * 4 + direction] = moveTable[code];
    this.directions[1][idx * 4 + direction] = moveTable[MOVE_CODES + code];
  }

  private combine(idx: number): void {
    for (let color = 0; color < 2; color++) {
      let total = 0;
      let fours = 0;
      let threes = 0;
      for (let d = 0; d < 4; d++) {
        const score = this.directions[color][idx * 4 + d];
        total += score;
        if (score >= SHAPE_SCORE[Shape.FOUR]) fours++;
        if (score === SHAPE_SCORE[Shape.OPEN_THREE]) threes++;
      }
      if (fours >= 2) total += SHAPE_SCORE[Shape.OPEN_FOUR];
      else if (fours && threes) total += SHAPE_SCORE[Shape.FOUR] * 2;
      else if (threes >= 2) total += SHAPE_SCORE[Shape.OPEN_THREE] * 4;
      this.attack[color][idx] = total;
    }
  }
}
