/** 共用湿墨笔法：有吸水边缘的墨滴，少量飞溅；不使用光晕或水波。 */
export function paintWetInk(
  ctx: CanvasRenderingContext2D, x: number, y: number, radius: number,
  progress: number, seed: number, color: string,
): void {
  let state = seed | 0;
  const random = () => {
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
    state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
  const p = Math.max(0, Math.min(1, progress));
  const spread = 1 - Math.pow(1 - p, 4);
  ctx.save();
  ctx.fillStyle = color;
  for (let layer = 0; layer < 3; layer++) {
    const r = radius * (1 - layer * 0.17) * (0.28 + spread * 0.72);
    const points = Array.from({ length: 28 }, (_, i) => {
      const angle = i / 28 * Math.PI * 2;
      const rough = 0.86 + random() * 0.24;
      return { x: x + Math.cos(angle) * r * rough, y: y + Math.sin(angle) * r * rough * 0.84 };
    });
    ctx.globalAlpha = (0.035 + layer * 0.04) * (1 - p * 0.5);
    ctx.beginPath();
    const last = points[points.length - 1];
    ctx.moveTo((last.x + points[0].x) / 2, (last.y + points[0].y) / 2);
    points.forEach((point, i) => {
      const next = points[(i + 1) % points.length];
      ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    });
    ctx.closePath();
    ctx.fill();
  }
  for (let i = 0; i < 9; i++) {
    const angle = random() * Math.PI * 2;
    const distance = radius * (1.05 + random() * 0.7) * spread;
    const r = radius * (0.025 + random() * 0.055);
    ctx.globalAlpha = (0.14 + random() * 0.18) * (1 - p);
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance,
      r * 1.3, r, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let boundRoot: HTMLElement | null = null;

export function bindInkFeedback(root: HTMLElement): void {
  if (boundRoot === root) return;
  boundRoot = root;
  const drop = (target: Element, clientX?: number, clientY?: number) => {
    if (reduced() || !target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const x = clientX ?? rect.left + rect.width / 2;
    const y = clientY ?? rect.top + rect.height / 2;
    const canvas = document.createElement('canvas');
    canvas.className = 'ink-contact';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.left = `${x - 40}px`;
    canvas.style.top = `${y - 40}px`;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = canvas.height = 80 * dpr;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return; }
    ctx.scale(dpr, dpr);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--brush-ink').trim();
    const start = performance.now();
    const seed = Math.floor(Math.random() * 1e8) + 1;
    const frame = () => {
      if (!canvas.isConnected) return;
      const p = Math.min(1, (performance.now() - start) / 640);
      ctx.clearRect(0, 0, 80, 80);
      if (p < 0.22) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.65;
        ctx.beginPath();
        ctx.ellipse(40, 22 + p / 0.22 * 18, 2, 3.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        paintWetInk(ctx, 40, 40, 17, (p - 0.22) / 0.78, seed, color);
      }
      if (p < 1) requestAnimationFrame(frame);
      else canvas.remove();
    };
    requestAnimationFrame(frame);
    window.setTimeout(() => canvas.remove(), 750);
  };
  const control = (target: EventTarget | null) => target instanceof Element
    ? target.closest('button:not(:disabled), a.btn') : null;
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const target = control(e.target);
    if (target) drop(target, e.clientX, e.clientY);
  });
  root.addEventListener('click', e => {
    if (e.detail !== 0) return;
    const target = control(e.target);
    if (target) drop(target);
  });
  root.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const target = control(e.target);
    if (!target) return;
    if (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) return;
    drop(target, e.clientX, e.clientY);
  });
}
