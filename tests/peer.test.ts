import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetSession } from '../src/net/peer';

class Emitter {
  private events = new Map<string, Array<(arg: unknown) => void>>();
  on(event: string, handler: (arg: unknown) => void) {
    this.events.set(event, [...this.events.get(event) ?? [], handler]);
  }
  emit(event: string, arg?: unknown) { this.events.get(event)?.forEach(handler => handler(arg)); }
}
class Connection extends Emitter {
  open = false;
  send = vi.fn();
  close = vi.fn(() => { this.open = false; this.emit('close'); });
  connect() { this.open = true; this.emit('open'); }
}
const peers: MockPeer[] = [];
class MockPeer extends Emitter {
  conn = new Connection();
  destroy = vi.fn();
  connect = vi.fn(() => this.conn);
  constructor(readonly id?: string) { super(); peers.push(this); }
}
vi.mock('peerjs', () => ({ default: MockPeer }));

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', globalThis); peers.length = 0; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const loaded = async () => { await vi.dynamicImportSettled(); expect(peers).toHaveLength(1); return peers[0]; };
const hello = { t: 'hello' as const, name: '慕容听雪', size: 15, rules: 'freestyle', version: 1 };

describe('联机传输生命周期', () => {
  it('访客连接回调得到可发送的会话，握手不依赖 Promise 赋值', async () => {
    const onOpen = vi.fn((session: NetSession) => session.send(hello));
    const pending = NetSession.join('ABC23', { onOpen });
    const peer = await loaded(); peer.emit('open'); peer.conn.connect();
    const session = await pending;
    expect(peer.connect).toHaveBeenCalledWith('inkgomoku-v1-ABC23', { reliable: true });
    expect(onOpen).toHaveBeenCalledWith(session); expect(peer.conn.send).toHaveBeenCalledWith(hello);
    session.close();
  });
  it('创建失败释放 Peer，清除超时任务', async () => {
    const pending = NetSession.host('ABC23', {});
    const failure = expect(pending).rejects.toThrow('房间码已被占用');
    const peer = await loaded(); peer.emit('error', { type: 'unavailable-id' }); await failure;
    expect(peer.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('加入不存在的房间释放连接与两个超时任务', async () => {
    const pending = NetSession.join('ABC23', {});
    const failure = expect(pending).rejects.toThrow('没有找到该房间');
    const peer = await loaded(); peer.emit('open'); peer.emit('error', { type: 'peer-unavailable' }); await failure;
    expect(peer.conn.close).toHaveBeenCalledTimes(1); expect(peer.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('等待房间超时后清理资源', async () => {
    const pending = NetSession.join('ABC23', {});
    const failure = expect(pending).rejects.toThrow('房间不存在');
    const peer = await loaded(); peer.emit('open'); await vi.advanceTimersByTimeAsync(12000); await failure;
    expect(peer.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('回调立即关闭会话时，不启动新的心跳或显示断线提示', async () => {
    const onClose = vi.fn();
    const pending = NetSession.join('ABC23', { onOpen: session => session.close(), onClose });
    const peer = await loaded(); peer.emit('open');
    const failure = expect(pending).rejects.toThrow('房间已满或房主已离开');
    peer.conn.connect(); await failure;
    expect(onClose).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('房间正在握手时拒绝第三个连接，保留原来的对手', async () => {
    const pending = NetSession.host('ABC23', {});
    const peer = await loaded(); peer.emit('open'); const session = await pending;
    const first = new Connection(), third = new Connection();
    peer.emit('connection', first); peer.emit('connection', third);
    expect(third.close).toHaveBeenCalledTimes(1); expect(first.close).not.toHaveBeenCalled();
    first.connect(); session.send(hello); expect(first.send).toHaveBeenCalledWith(hello); session.close();
  });
  it('数据通道断开停止心跳，主动退出不弹出断线提示', async () => {
    const onClose = vi.fn();
    const pending = NetSession.host('ABC23', { onClose });
    const peer = await loaded(); peer.emit('open'); const session = await pending;
    peer.emit('connection', peer.conn); peer.conn.connect();
    expect(vi.getTimerCount()).toBe(1); peer.conn.close();
    expect(vi.getTimerCount()).toBe(0); expect(onClose).toHaveBeenCalledTimes(1);
    session.close(); expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('信令中断不打断已经建立的棋局', async () => {
    const onClose = vi.fn(), onError = vi.fn();
    const pending = NetSession.host('ABC23', { onClose, onError });
    const peer = await loaded(); peer.emit('open'); const session = await pending;
    peer.emit('connection', peer.conn); peer.conn.connect(); peer.emit('disconnected');
    expect(onClose).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(session.connected).toBe(true); session.close();
  });
});
