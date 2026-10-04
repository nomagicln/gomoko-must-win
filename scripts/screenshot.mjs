/**
 * 无头 Chrome 校验脚本（仅用于开发期验收，不参与站点构建）。
 *
 * 用法：node scripts/screenshot.mjs <url> <out.png> [width] [height] [waitMs] [--scroll]
 * 通过 CDP 直连，收集 console 错误并截图。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, out, w = '1440', h = '1000', waitMs = '2500'] = process.argv.slice(2);
const width = Number(w);
const height = Number(h);

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
let target = list.find((t) => t.type === 'page');
if (!target) {
  target = await (await fetch('http://127.0.0.1:9222/json/new?about:blank')).json();
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
    errors.push({
      level: msg.params.type,
      text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
    });
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push({ level: 'exception', text: d.exception?.description ?? d.text });
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push({ level: 'log', text: msg.params.entry.text });
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: width < 500 ? 3 : 2,
  mobile: width < 500,
});
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(waitMs)));

if (process.argv.includes('--scroll')) {
  await send('Runtime.evaluate', {
    expression: 'window.scrollTo(0, document.body.scrollHeight); void 0',
  });
  await new Promise((r) => setTimeout(r, 900));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));

const meta = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    hash: location.hash,
    appChildren: document.getElementById('app')?.children.length ?? 0,
    text: (document.getElementById('app')?.innerText ?? '').slice(0, 400)
  })`,
  returnByValue: true,
});

console.log('URL:', url);
console.log('META:', meta.result.value);
console.log('ERRORS:', JSON.stringify(errors, null, 2));
ws.close();
