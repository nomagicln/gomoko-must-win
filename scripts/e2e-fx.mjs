/**
 * 泼墨特效验收：用真实点击摆出「杀局」与「五连」两种局面并截图。
 * 开发期使用，不参与站点构建。
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/gomoko-must-win/';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 30));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};
const shot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync('.shots', { recursive: true });
  writeFileSync(`.shots/${name}.png`, Buffer.from(s.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

async function playSequence(moves, tag) {
  await send('Page.navigate', { url: `${BASE}?fx=${Date.now()}#/local` });
  await new Promise((r) => setTimeout(r, 2200));
  const geo = JSON.parse(
    await evaluate(`(() => { const c = document.querySelector('.board-canvas'); const r = c.getBoundingClientRect(); return JSON.stringify({left:r.left, top:r.top, w:r.width}); })()`),
  );
  const origin = geo.w * 0.058;
  const cell = (geo.w - origin * 2) / 14;
  for (const [gx, gy] of moves) {
    await click(geo.left + origin + cell * gx, geo.top + origin + cell * gy);
    await new Promise((r) => setTimeout(r, 260));
  }
  const movesText = await evaluate(`document.querySelector('.movelist')?.innerText.replace(/\\n/g,' ') ?? ''`);
  const badge = await evaluate(`document.querySelector('.board-badge')?.innerText ?? ''`);
  console.log(`[${tag}] 棋谱: ${JSON.stringify(movesText.slice(0, 70))} | 浮层: ${JSON.stringify(badge)}`);
  return { movesText, badge };
}

// ---- 局面一：黑棋在第 9 手形成双活三（杀局） ----
const kill = [
  [5, 7], [0, 0],
  [6, 7], [1, 0],
  [7, 5], [2, 0],
  [7, 6], [3, 0],
  [7, 7],
];
const killState = await playSequence(kill, '杀局');
await new Promise((r) => setTimeout(r, 420));
await shot('fx-kill');
const killGlyph = await evaluate(`document.querySelector('.fx-glyph__char')?.textContent ?? ''`);
console.log('   泼墨大字:', JSON.stringify(killGlyph));

// ---- 局面二：黑棋第 9 手连成五子（胜利） ----
const win = [
  [5, 7], [0, 0],
  [6, 7], [1, 0],
  [7, 7], [2, 0],
  [8, 7], [3, 0],
  [9, 7],
];
const winState = await playSequence(win, '五连');
await new Promise((r) => setTimeout(r, 1500));
await shot('fx-victory');
const glyphs = await evaluate(
  `JSON.stringify([...document.querySelectorAll('.fx-glyph__char:not(.fx-glyph__char--bleed)')].map(n => n.textContent))`,
);
console.log('   泼墨大字:', glyphs);

const ok =
  killState.movesText.includes('H8') &&
  winState.badge.includes('胜') &&
  glyphs.includes('承让');
console.log('ERRORS:', JSON.stringify(errors));
console.log(ok ? '✅ 泼墨杀局 / 承让败北 特效链路通过' : '❌ 特效未按预期触发');
process.exit(ok ? 0 : 1);
