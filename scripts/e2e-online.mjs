/**
 * 在线联机端到端验收：开两个真实标签页，一个建房、一个加入，
 * 然后互相落子，验证 WebRTC 点对点链路。开发期使用。
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/gomoko-must-win/';

const newTab = async () => {
  const t = await (await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' })).json();
  return t;
};

const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
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
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result.value;
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 30));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const setup = async () => {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  };
  return { ws, send, evaluate, click, setup, errors, close: () => ws.close() };
};

const a = await newTab();
const b = await newTab();
const host = await connect(a.webSocketDebuggerUrl);
const guest = await connect(b.webSocketDebuggerUrl);
await host.setup();
await guest.setup();

console.log('→ 房主创建房间');
await host.send('Page.navigate', { url: `${BASE}#/online?m=online` });
await new Promise((r) => setTimeout(r, 1500));
await host.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === '创建房间').click()`);

let code = '';
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 400));
  code = await host.evaluate(`document.querySelector('.room-code__value')?.textContent ?? ''`);
  if (code.length >= 4) break;
}
console.log('   房间码：', code || '(未生成)');
if (!code) {
  const status = await host.evaluate(`document.querySelector('.note')?.innerText ?? ''`);
  console.log('   ❌ 建房失败：', status);
  console.log('   host errors:', JSON.stringify(host.errors));
  process.exit(2);
}

console.log('→ 对手加入房间');
await guest.send('Page.navigate', { url: `${BASE}#/online?r=${code}` });

let playing = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const hasBoard = await guest.evaluate(`!!document.querySelector('.board-canvas')`);
  const hostBoard = await host.evaluate(`!!document.querySelector('.board-canvas')`);
  if (hasBoard && hostBoard) {
    playing = true;
    break;
  }
}
console.log(playing ? '   ✅ 双方已进入棋盘' : '   ❌ 未进入对局');
if (!playing) {
  console.log('   guest:', await guest.evaluate(`document.body.innerText.slice(0, 200)`));
  console.log('   host errors:', JSON.stringify(host.errors), 'guest errors:', JSON.stringify(guest.errors));
  process.exit(3);
}

const readGeo = async (tab) => JSON.parse(await tab.evaluate(`(() => { const c = document.querySelector('.board-canvas'); const r = c.getBoundingClientRect(); return JSON.stringify({left:r.left, top:r.top, w:r.width, h:r.height}); })()`));
const hostGeo = await readGeo(host);
const guestGeo = await readGeo(guest);
const tapAt = async (tab, geo, gx, gy) => {
  const pad = geo.w * 0.058;
  const cell = (geo.w - pad * 2) / 14;
  await tab.click(geo.left + pad + cell * gx, geo.top + pad + cell * gy);
};
console.log('→ 房主（黑）落子 H8');
await tapAt(host, hostGeo, 7, 7);
await new Promise((r) => setTimeout(r, 1400));

const hostSelf = await host.evaluate(`document.querySelector('.movelist')?.innerText ?? ''`);
console.log('   房主端棋谱：', JSON.stringify(hostSelf.replace(/\n/g, ' ').slice(0, 40)));
console.log('   房主浮层：', JSON.stringify(await host.evaluate(`document.querySelector('.board-badge')?.innerText ?? ''`)));

const guestMoves = await guest.evaluate(`document.querySelector('.movelist')?.innerText ?? ''`);
console.log('   对手端棋谱：', JSON.stringify(guestMoves.replace(/\n/g, ' ').slice(0, 40)));

console.log('→ 对手（白）落子 G7');
await tapAt(guest, guestGeo, 6, 7);
await new Promise((r) => setTimeout(r, 1400));
const hostMoves = await host.evaluate(`document.querySelector('.movelist')?.innerText ?? ''`);
console.log('   房主端棋谱：', JSON.stringify(hostMoves.replace(/\n/g, ' ').slice(0, 40)));

const hostCount = (hostMoves.match(/[A-O]\d+/g) ?? []).length;
const guestCount = (guestMoves.match(/[A-O]\d+/g) ?? []).length;
console.log(`   手数：房主 ${hostCount} / 对手 ${guestCount}`);
console.log('   errors:', JSON.stringify([...host.errors, ...guest.errors]));
const ok = hostCount >= 2 && guestCount >= 1;
console.log(ok ? '✅ 联机链路通过' : '❌ 联机链路异常');
await fetch(`http://127.0.0.1:9222/json/close/${a.id}`);
await fetch(`http://127.0.0.1:9222/json/close/${b.id}`);
process.exit(ok ? 0 : 4);
