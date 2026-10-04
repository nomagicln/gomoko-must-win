/** 用不齐的手绘轮廓和墨点构成骰子，共用按钮的滴墨反馈。 */
export function inkDice(face = 5): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', '28'); svg.setAttribute('height', '28');
  svg.setAttribute('aria-hidden', 'true');
  const path = (d: string, fill: string, stroke = 'none') => {
    const node = document.createElementNS(ns, 'path');
    node.setAttribute('d', d); node.setAttribute('fill', fill); node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', '1.8'); node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round'); svg.append(node); return node;
  };
  path('M7 4.3 24.1 3.7Q28 3.9 27.8 8L28.4 24Q28.1 28.2 24 28L7.4 28.5Q3.8 28 4.2 24L3.7 8Q3.8 4.2 7 4.3Z', 'none', 'currentColor');
  const edge = path('M6.2 5.3 24.4 4.9M27 9.5 27.2 24M23.4 27 7 27.4M5.2 23.2 4.8 9.8', 'none', 'currentColor');
  edge.setAttribute('stroke-width', '.6'); edge.setAttribute('opacity', '.35');
  const pips: Record<number, number[][]> = {
    1: [[16, 16]], 2: [[10, 10], [22, 22]], 3: [[10, 10], [16, 16], [22, 22]],
    4: [[10, 10], [22, 10], [10, 22], [22, 22]],
    5: [[10, 10], [22, 10], [16, 16], [10, 22], [22, 22]],
    6: [[10, 9], [22, 9], [10, 16], [22, 16], [10, 23], [22, 23]],
  };
  for (const [x, y] of pips[face] ?? pips[5]) {
    const dot = path('M-1.7-.8Q-1.3-2.2.4-1.9Q2.3-1.3 1.9.5Q1.3 2.2-.5 1.8Q-2.2 1.3-1.7-.8Z', 'currentColor');
    dot.setAttribute('transform', `translate(${x} ${y})`);
  }
  return svg;
}

const ORIENTATIONS: Record<number, [number, number]> = {
  5: [0, 0], 2: [0, 180], 3: [0, -90], 4: [0, 90], 1: [90, 0], 6: [-90, 0],
};

export function inkDiceCube(): HTMLElement {
  const scene = document.createElement('span'); scene.className = 'dice-scene';
  const cube = document.createElement('span'); cube.className = 'dice-cube';
  cube.dataset.face = '5';
  for (const [side, face] of [['front', 5], ['back', 2], ['right', 3], ['left', 4], ['top', 1], ['bottom', 6]] as const) {
    const panel = document.createElement('span'); panel.className = `dice-face dice-face--${side}`;
    panel.append(inkDice(face)); cube.append(panel);
  }
  scene.append(cube); return scene;
}

export async function rollInkDice(scene: HTMLElement, face: number): Promise<void> {
  const cube = scene.querySelector<HTMLElement>('.dice-cube')!;
  const [fromX, fromY] = ORIENTATIONS[Number(cube.dataset.face)] ?? ORIENTATIONS[5];
  const [toX, toY] = ORIENTATIONS[face] ?? ORIENTATIONS[5];
  cube.dataset.face = String(face);
  const rotation = (x: number, y: number) => `rotateX(${x}deg) rotateY(${y}deg)`;
  cube.style.transform = rotation(toX, toY);
  if (!cube.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const spin = cube.animate([
    { transform: rotation(fromX, fromY) },
    { transform: rotation(toX + 720, toY + 720) },
  ], { duration: 640, easing: 'cubic-bezier(.2,.65,.3,1)' });
  const bounce = scene.animate([
    { transform: 'translateY(0) rotate(0)' },
    { transform: 'translateY(-7px) rotate(-9deg)', offset: .3 },
    { transform: 'translateY(2px) rotate(5deg)', offset: .75 },
    { transform: 'translateY(0) rotate(0)' },
  ], { duration: 640, easing: 'ease-out' });
  await Promise.all([spin.finished.catch(() => {}), bounce.finished.catch(() => {})]);
}
