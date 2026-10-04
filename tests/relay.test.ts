import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelaySession } from '../src/net/relay';
import type { NetMessage } from '../src/net/peer';

class Socket extends EventTarget {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event('close')); });
  constructor(readonly url: string) { super(); Socket.sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(data: object) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(data) })); }
}
const url = 'wss://test.example/gomoku';
const hello: NetMessage = { t: 'hello', name: '慕容听雪', size: 15, rules: 'freestyle', version: 1 };
beforeEach(() => {
  vi.useFakeTimers(); Socket.sockets = [];
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('window', globalThis); vi.stubGlobal('document', { visibilityState: 'visible' });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Render 房间传输', () => {
  it('建房只登记座位，等待期间不启动心跳也不超时；对手入座才发送握手', async () => {
    const onOpen = vi.fn(session => session.send(hello));
    const pending = RelaySession.host('ABC23', { onOpen }, url);
    const socket = Socket.sockets[0]; socket.open();
    expect(socket.sent).toEqual([{ t: 'host', code: 'ABC23' }]);
    socket.receive({ t: 'created', code: 'ABC23' }); const session = await pending;
    await vi.advanceTimersByTimeAsync(120000);
    expect(session.connected).toBe(false); expect(onOpen).not.toHaveBeenCalled(); expect(socket.close).not.toHaveBeenCalled();
    socket.receive({ t: 'peer-joined' });
    expect(onOpen).toHaveBeenCalledWith(session);
    expect(socket.sent).toContainEqual({ t: 'message', data: hello });
    session.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('访客确认入座后才允许发送消息，并接收对手落子与延迟', async () => {
    const onMessage = vi.fn(), onLatency = vi.fn();
    const pending = RelaySession.join('ABC23', { onMessage, onLatency }, url);
    const socket = Socket.sockets[0]; socket.open(); socket.receive({ t: 'joined' }); const session = await pending;
    socket.receive({ t: 'message', data: hello }); expect(onMessage).toHaveBeenCalledWith(hello);
    const ts = Date.now(); await vi.advanceTimersByTimeAsync(80);
    socket.receive({ t: 'message', data: { t: 'pong', ts } }); expect(onLatency).toHaveBeenCalledWith(80);
    session.close();
  });
  it('不存在或已满的房间可重试，不残留计时器', async () => {
    const pending = RelaySession.join('ABC23', {}, url);
    const failure = expect(pending).rejects.toThrow('房间已满');
    const socket = Socket.sockets[0]; socket.open(); socket.receive({ t: 'error', message: '房间已满' });
    await failure; expect(socket.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('对手离开只通知一次并释放房间，主动关闭不通知', async () => {
    const onClose = vi.fn();
    const pending = RelaySession.join('ABC23', { onClose }, url);
    const socket = Socket.sockets[0]; socket.open(); socket.receive({ t: 'joined' }); const session = await pending;
    socket.receive({ t: 'peer-left' }); socket.receive({ t: 'peer-left' });
    expect(onClose).toHaveBeenCalledOnce(); expect(session.connected).toBe(false);
    session.close(); expect(onClose).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('给 Render 冷启动留出时间，最终超时明确提示并关闭连接', async () => {
    const pending = RelaySession.host('ABC23', {}, url);
    const failure = expect(pending).rejects.toThrow('唤醒超时');
    await vi.advanceTimersByTimeAsync(89000); expect(Socket.sockets[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('连接后中继断线通知棋局，建房后的断线提示返回大厅', async () => {
    const onClose = vi.fn(), onError = vi.fn();
    const pending = RelaySession.host('ABC23', { onClose, onError }, url);
    const socket = Socket.sockets[0]; socket.open(); socket.receive({ t: 'created' }); await pending;
    socket.dispatchEvent(new Event('error'));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('返回大厅')); expect(onClose).not.toHaveBeenCalled();
  });
  it('Render 唤醒时的升级失败自动重试，旧连接事件不打断重试成功的房间', async () => {
    const onError = vi.fn();
    const pending = RelaySession.host('ABC23', { onError }, url);
    const cold = Socket.sockets[0]; cold.dispatchEvent(new Event('error'));
    await vi.advanceTimersByTimeAsync(1500);
    const warm = Socket.sockets[1]; warm.open(); warm.receive({ t: 'created' }); const session = await pending;
    cold.dispatchEvent(new Event('close')); expect(onError).not.toHaveBeenCalled();
    warm.receive({ t: 'peer-joined' }); expect(session.connected).toBe(true);
    session.close(); expect(vi.getTimerCount()).toBe(0);
  });

});
