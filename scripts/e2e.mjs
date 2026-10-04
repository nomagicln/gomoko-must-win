/**
 * 端到端交互验收（开发期使用，不参与站点构建）。
 * 通过 CDP 真实点击棋盘，验证「玩家落子 → AI 应手 → 棋谱更新」的完整链路。
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
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
};

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise((r) => setTimeout(r, 40));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};

console.log('→ 打开 #/ai');
await send('Page.navigate', { url: `${BASE}?e2e=${Date.now()}#/ai` });
await new Promise((r) => setTimeout(r, 1800));

console.log('→ 点击「开始对局」');
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('开始对局')).click()`);
await new Promise((r) => setTimeout(r, 1500));

const geo = await evaluate(`(() => {
  const c = document.querySelector('.board-canvas');
  const r = c.getBoundingClientRect();
  return JSON.stringify({left: r.left, top: r.top, w: r.width});
})()`);
const g = JSON.parse(geo);
const cell = g.w / 15;

console.log('→ 在棋盘上落子（天元右下）');
await click(g.left + cell * (7.5 + 0.5), g.top + cell * (7.5 + 0.5));
await new Promise((r) => setTimeout(r, 700));

const afterMe = await evaluate(`document.querySelector('.movelist')?.innerText ?? ''`);
console.log('   我落子后棋谱：', JSON.stringify(afterMe.replace(/\\n/g, ' ').slice(0, 60)));

console.log('→ 等待 AI 应手（最多 12 秒）');
let moves = afterMe;
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 500));
  moves = await evaluate(`document.querySelector('.movelist')?.innerText ?? ''`);
  if ((moves.match(/[A-O]\\d+/g) ?? []).length >= 2) break;
}
const count = (moves.match(/[A-O]\d+/g) ?? []).length;
console.log(`   棋谱手数：${count}`);

console.log('→ 点击「提示」');
await evaluate(`document.querySelector('[data-kbd="hint"]').click()`);
await new Promise((r) => setTimeout(r, 3500));
const think = await evaluate(`document.querySelectorAll('.think-item').length`);
const notes = await evaluate(`document.querySelector('.note-list')?.innerText ?? ''`);
console.log(`   候选点数量：${think}；战术提示：${JSON.stringify(notes.replace(/\\n/g, ' ').slice(0, 80))}`);

console.log('→ 开启「分析」热力图');
await evaluate(`document.querySelector('[data-kbd="analysis"]').click()`);
await new Promise((r) => setTimeout(r, 4000));

const shot = await send('Page.captureScreenshot', { format: 'png' });
mkdirSync('.shots', { recursive: true });
writeFileSync('.shots/e2e-ai.png', Buffer.from(shot.data, 'base64'));

const badge = await evaluate(`document.querySelector('.board-badge')?.innerText ?? ''`);
const evalText = await evaluate(`document.querySelector('.meter__value')?.textContent ?? ''`);
console.log('   回合浮层：', JSON.stringify(badge), '形势：', evalText);
console.log('ERRORS:', JSON.stringify(errors));
console.log(count >= 2 ? '✅ 人机对局链路通过' : '❌ AI 未应手');
ws.close();
process.exit(count >= 2 ? 0 : 1);
