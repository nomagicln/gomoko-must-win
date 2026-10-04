/**
 * 泼墨特效验收：
 *   A. 人机/双人局面下摆出「杀局」→ 期待泼墨红「杀」
 *   B. 同屏双人分出胜负 → 期待只出现「承让」一字
 *   C. 人机对战中让 AI 取胜 → 期待只出现「败北」一字
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
const evaluate = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
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

async function openSolo(hash, difficultyLabel) {
  await send('Page.navigate', { url: `${BASE}?fx=${Date.now()}${hash}` });
  await new Promise((r) => setTimeout(r, 2200));
  if (difficultyLabel) {
    await evaluate(
      `[...document.querySelectorAll('.diff-card')].find(c => c.textContent.includes('${difficultyLabel}')).click()`,
    );
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.includes('开始对局')).click()`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const geo = JSON.parse(
    await evaluate(`(() => { const c = document.querySelector('.board-canvas'); const r = c.getBoundingClientRect(); return JSON.stringify({left:r.left, top:r.top, w:r.width}); })()`),
  );
  const origin = geo.w * 0.058;
  const cell = (geo.w - origin * 2) / 14;
  return { geo, origin, cell };
}
const tapCell = async (ctx, gx, gy) => {
  await click(ctx.geo.left + ctx.origin + ctx.cell * gx, ctx.geo.top + ctx.origin + ctx.cell * gy);
};
const glyphs = async () =>
  JSON.parse(
    await evaluate(`JSON.stringify([...document.querySelectorAll('.fx-glyph__char:not(.fx-glyph__char--bleed)')].map(n => n.textContent))`),
  );
const waitForGameOver = async (maxMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, 600));
    const badge = await evaluate(`document.querySelector('.board-badge')?.innerText ?? ''`);
    if (badge.includes('胜') || badge.includes('和棋')) return true;
  }
  return false;
};

/* ---------- A. 杀局 ---------- */
const solo = await openSolo('#/local');
const KILL = [ [5,7],[0,0], [6,7],[1,0], [7,5],[2,0], [7,6],[3,0], [7,7] ];
for (const [x, y] of KILL) {
  await tapCell(solo, x, y);
  await new Promise((r) => setTimeout(r, 240));
}
await new Promise((r) => setTimeout(r, 420));
const killGlyphs = await glyphs();
await shot('fx-kill');
console.log('A 杀局 →', JSON.stringify(killGlyphs));

/* ---------- B. 同屏双人分出胜负（中立视角，只出「承让」） ---------- */
const b = await openSolo('#/local');
const WIN = [ [5,7],[0,0], [6,7],[1,0], [7,7],[2,0], [8,7],[3,0], [9,7] ];
for (const [x, y] of WIN) {
  await tapCell(b, x, y);
  await new Promise((r) => setTimeout(r, 240));
}
await new Promise((r) => setTimeout(r, 1400));
const hotseatGlyphs = await glyphs();
await shot('fx-victory');
console.log('B 同屏双人终局 →', JSON.stringify(hotseatGlyphs));

/* ---------- C. 人机对战落败（只出「败北」） ---------- */
const c = await openSolo('#/ai', '宗师');
await tapCell(c, 7, 7);
await new Promise((r) => setTimeout(r, 2200));
await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.includes('认输')).click()`);
await new Promise((r) => setTimeout(r, 600));
await evaluate(`[...document.querySelectorAll('.modal button')].find(x => x.textContent.includes('确认认输')).click()`);
await new Promise((r) => setTimeout(r, 1100));
const loseGlyphs = await glyphs();
await shot('fx-defeat');
const badge = await evaluate(`document.querySelector('.board-badge')?.innerText ?? ''`);
console.log(`C 人机对战认输（结果「${badge}」）→`, JSON.stringify(loseGlyphs));

const ok =
  killGlyphs.includes('杀') &&
  hotseatGlyphs.length === 1 &&
  hotseatGlyphs[0] === '承让' &&
  loseGlyphs.length === 1 &&
  loseGlyphs[0] === '败北';
console.log('ERRORS:', JSON.stringify(errors));
console.log(ok ? '✅ 泼墨杀 / 承让 / 败北 链路通过' : '❌ 特效未按预期触发');
process.exit(ok ? 0 : 1);
