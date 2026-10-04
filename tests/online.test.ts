// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/app';
import type { NetHandlers, NetSession } from '../src/net/peer';

const mocks = vi.hoisted(() => ({
  host: vi.fn(), join: vi.fn(), play: vi.fn(), destroy: vi.fn(), qr: vi.fn(), copy: vi.fn(), toast: vi.fn(),
}));
vi.mock('../src/net/peer', async importOriginal => ({
  ...await importOriginal<typeof import('../src/net/peer')>(),
  NetSession: { host: mocks.host, join: mocks.join },
}));
vi.mock('../src/net/invite', async importOriginal => ({
  ...await importOriginal<typeof import('../src/net/invite')>(), renderInviteQR: mocks.qr,
}));
vi.mock('../src/views/play', () => ({ PlayView: class {
  constructor(_ctx: unknown, options: unknown) { mocks.play(options); }
  mount() { return document.createElement('canvas'); }
  destroy() { mocks.destroy(); }
} }));
vi.mock('../src/ui/audio', () => ({ sound: { play: vi.fn() } }));
vi.mock('../src/ui/dom', async importOriginal => ({
  ...await importOriginal<typeof import('../src/ui/dom')>(), toast: mocks.toast, copyText: mocks.copy,
}));
import { OnlineView } from '../src/views/online';

const session = () => ({ send: vi.fn(), close: vi.fn() }) as unknown as NetSession;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let view: OnlineView;
let ctx: AppContext;
const mount = (code = '', mode: 'local' | 'online' = 'online') => {
  view = new OnlineView(ctx, code, mode);
  const root = view.mount(); document.body.append(root); return root;
};
const button = (root: HTMLElement, text: string) => [...root.querySelectorAll('button')].find(b => b.textContent === text)!;

beforeEach(() => {
  vi.clearAllMocks();
  ctx = { root: document.body, navigate: vi.fn(), savePrefs: vi.fn(), recordResult: vi.fn(),
    prefs: { size: 15, rules: 'freestyle', clock: 'none' } } as unknown as AppContext;
  mocks.host.mockResolvedValue(session());
  mocks.join.mockImplementation(() => new Promise(() => {}));
  mocks.qr.mockResolvedValue(undefined); mocks.copy.mockResolvedValue(true);
  Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
});
afterEach(() => { view?.destroy(); document.body.replaceChildren(); });

describe('在线邀请与握手', () => {
  it('默认是本地双人，切到在线联机才显示房间操作', () => {
    const root = mount('', 'local');
    expect(root.querySelector('h1')?.textContent).toBe('双人对战');
    expect(button(root, '创建房间')).toBeUndefined();
    expect(button(root, '加入房间')).toBeUndefined();
    button(root, '开始对局').click(); expect(ctx.navigate).toHaveBeenCalledWith('#/local');
    button(root, '在线联机').click();
    expect(button(root, '创建房间')).toBeDefined();
    expect(button(root, '加入房间')).toBeDefined();
    expect(button(root, '改用本地双人')).toBeUndefined();
    expect(mocks.host).not.toHaveBeenCalled(); expect(mocks.join).not.toHaveBeenCalled();
    button(root, '本地双人').click(); expect(root.querySelector('.nickname-row')).toBeNull();
  });
  it('水墨骰子每次更换无数字的江湖名，并发送新名字', async () => {
    const root = mount();
    const name = root.querySelector<HTMLInputElement>('#duel-nickname')!;
    const old = name.value;
    root.querySelector<HTMLButtonElement>('[aria-label="随机江湖名"]')!.click();
    expect(name.value).not.toBe(old); expect(name.value).toMatch(/^[\u4e00-\u9fff]{3,4}$/);
    const newName = name.value, net = session();
    mocks.host.mockImplementation(async (_code: string, handlers: NetHandlers) => { handlers.onOpen?.(net); return net; });
    button(root, '创建房间').click(); await flush();
    expect(net.send).toHaveBeenCalledWith(expect.objectContaining({ name: newName }));
  });
  it('打开邀请自动加入同一房间，隐藏创建入口，显示随机昵称', () => {
    const root = mount('ab-c23');
    expect(mocks.join).toHaveBeenCalledWith('ABC23', expect.any(Object));
    expect(mocks.host).not.toHaveBeenCalled();
    expect(button(root, '创建房间')).toBeUndefined();
    expect(root.querySelector<HTMLInputElement>('input[placeholder="你的昵称"]')?.value).toMatch(/^[\u4e00-\u9fff]{3,4}$/);
  });
  it('连接回调先于 Promise 返回时仍发送握手，并以房主设置开局', async () => {
    const net = session();
    mocks.join.mockImplementation(async (_code: string, handlers: NetHandlers) => {
      handlers.onOpen?.(net);
      handlers.onMessage?.({ t: 'hello', name: '房主', size: 19, rules: 'renju', clock: '5+5', version: 1 });
      return net;
    });
    const root = mount('ABC23'); await flush();
    expect(net.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'hello', name: expect.stringMatching(/^[\u4e00-\u9fff]{3,4}$/) }));
    expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ size: 19, rules: 'renju', clockMode: '5+5', humanColor: 2 }) }));
    expect(root.getAttribute('aria-busy')).toBe('false');
    expect(root.querySelector('canvas')).not.toBeNull();
  });
  it('连续创建只申请一个房间，连接中禁用表单', async () => {
    mocks.host.mockImplementation(() => new Promise(() => {}));
    const root = mount(), create = button(root, '创建房间');
    create.click(); create.click(); await flush();
    expect(mocks.host).toHaveBeenCalledTimes(1);
    expect(create.disabled).toBe(true);
    expect(root.getAttribute('aria-busy')).toBe('true');
  });
  it('失效邀请保留房间码，重试加入而不创建新房间', async () => {
    mocks.join.mockRejectedValue(new Error('没有找到该房间'));
    const root = mount('ABC23'); await flush();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('没有找到该房间');
    expect(button(root, '重新加入').disabled).toBe(false);
    button(root, '重新加入').click(); await flush();
    expect(mocks.join).toHaveBeenCalledTimes(2);
    expect(mocks.host).not.toHaveBeenCalled();
  });
  it('离开页面后迟到的连接被关闭，不重建棋盘', async () => {
    let open!: (net: NetSession) => void, resolve!: (net: NetSession) => void;
    mocks.join.mockImplementation((_code: string, handlers: NetHandlers) => {
      open = handlers.onOpen!; return new Promise<NetSession>(r => { resolve = r; });
    });
    mount('ABC23'); view.destroy();
    const net = session(); open(net); resolve(net); await flush();
    expect(net.close).toHaveBeenCalled();
    expect(net.send).not.toHaveBeenCalled(); expect(mocks.play).not.toHaveBeenCalled();
  });
  it('旧版没有棋钟字段时采用只计时，不继承访客的限时偏好', async () => {
    ctx.prefs.clock = '30+10';
    mocks.join.mockImplementation(async (_code: string, handlers: NetHandlers) => {
      const net = session(); handlers.onOpen?.(net);
      handlers.onMessage?.({ t: 'hello', name: '房主', size: 15, rules: 'freestyle', version: 1 }); return net;
    });
    mount('ABC23'); await flush();
    expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ clockMode: 'none' }) }));
  });
  it('复制与二维码使用同一地址，二维码可以收起', async () => {
    const root = mount(); button(root, '创建房间').click(); await flush();
    const url = root.querySelector<HTMLAnchorElement>('.invite-link')!.href;
    button(root, '分享邀请链接').click(); await flush();
    expect(mocks.copy).toHaveBeenCalledWith(url);
    const qr = button(root, '二维码邀请'); qr.click(); await flush();
    expect(mocks.qr).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), url);
    expect(qr.getAttribute('aria-expanded')).toBe('true');
    qr.click(); expect(root.querySelector<HTMLElement>('.invite-qr')?.hidden).toBe(true);
  });
  it('取消系统分享不会写入剪贴板', async () => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: vi.fn().mockRejectedValue(new DOMException('取消', 'AbortError')) });
    const root = mount(); button(root, '创建房间').click(); await flush();
    button(root, '分享邀请链接').click(); await flush();
    expect(mocks.copy).not.toHaveBeenCalled();
  });
});
