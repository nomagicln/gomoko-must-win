/**
 * 在线对战传输层：默认 Render 房间中转，可配置 PeerJS 点对点连接。
 *
 * 默认使用现有 Render 服务转发对局消息，避开跨网络 NAT 协商失败。
 * 中转仅维护两位玩家的连接，不保存棋谱。PeerJS 用于显式选择的点对点模式。
 *
 * peerjs 通过动态 import 按需加载，未进入「联机」页面时不会增加首屏体积。
 */

import { peerOptions, relayURL } from './config';
import { RelaySession } from './relay';

export type NetRole = 'host' | 'guest';

export type NetMessage =
  | { t: 'hello'; name: string; size: number; rules: string; clock?: string; version: number }
  | { t: 'ready'; name: string }
  | { t: 'start'; black: NetRole; size: number; rules: string; first: number }
  | { t: 'move'; x: number; y: number; color: 1 | 2; ply: number; ms?: number }
  | { t: 'undo-request' }
  | { t: 'undo-accept'; ply: number }
  | { t: 'undo-reject' }
  | { t: 'resign'; color: 1 | 2 }
  | { t: 'rematch-request' }
  | { t: 'rematch-accept' }
  | { t: 'chat'; text: string }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  | { t: 'sync'; moves: Array<{ x: number; y: number }> }
  | { t: 'bye' };

export interface NetHandlers {
  onMessage?: (msg: NetMessage) => void;
  onOpen?: (session: NetSession) => void;
  onClose?: () => void;
  onError?: (message: string) => void;
  onLatency?: (ms: number) => void;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'inkgomoku-v1-';
const SIGNAL_TIMEOUT = 12000;
const NEGOTIATION_TIMEOUT = 30000;
const NEGOTIATION_ERROR = '双方网络未能建立连接，请重试；仍失败时可尝试同一 Wi-Fi 或其他网络';

function connectionError(err?: { type?: string; message?: string }): string {
  if (err?.type === 'negotiation-failed' || /Negotiation of connection/i.test(err?.message ?? '')) return NEGOTIATION_ERROR;
  if (err?.type === 'connection-closed') return '连接已断开';
  return err?.message ?? '连接异常';
}

export function makeRoomCode(len = 5): string {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .slice(0, 8);
}

/** PeerJS 的最小可用接口（避免把 peerjs 的类型暴露到全局） */
interface PeerLike {
  on(event: string, cb: (arg: never) => void): void;
  connect(id: string, opts?: unknown): DataConnectionLike;
  destroy(): void;
  id?: string;
  open?: boolean;
}
interface DataConnectionLike {
  on(event: string, cb: (arg: never) => void): void;
  send(data: unknown): void;
  close(): void;
  open?: boolean;
  peer?: string;
}

export interface NetSession {
  readonly role: NetRole;
  readonly code: string;
  readonly connected: boolean;
  readonly peerId: string;
  send(msg: NetMessage): void;
  close(): void;
}

/** Render 房间中转避开 NAT 限制；无中转配置时可继续使用 PeerJS。 */
export const NetSession = {
  host: (code: string, handlers: NetHandlers): Promise<NetSession> => {
    const url = relayURL();
    return url ? RelaySession.host(code, handlers, url) : PeerSession.host(code, handlers);
  },
  join: (code: string, handlers: NetHandlers): Promise<NetSession> => {
    const url = relayURL();
    return url ? RelaySession.join(code, handlers, url) : PeerSession.join(code, handlers);
  },
};

export class PeerSession implements NetSession {
  readonly role: NetRole;
  readonly code: string;
  private peer: PeerLike;
  private conn: DataConnectionLike | null = null;
  private handlers: NetHandlers;
  private pingTimer = 0;
  private negotiationTimer = 0;
  private closed = false;
  private pendingQueue: NetMessage[] = [];

  private constructor(role: NetRole, code: string, peer: PeerLike, handlers: NetHandlers) {
    this.role = role;
    this.code = code;
    this.peer = peer;
    this.handlers = handlers;
  }

  get connected(): boolean {
    return Boolean(this.conn?.open);
  }

  get peerId(): string {
    return this.peer.id ?? '';
  }

  /**
   * 创建房间。成功后返回房间码；对手用该码加入。
   * 若信令服务器不可用会抛出错误，由 UI 提示玩家改用本地对战。
   */
  static async host(code: string, handlers: NetHandlers): Promise<NetSession> {
    const Peer = await loadPeer();
    const peer = new Peer(PREFIX + code, peerOptions()) as unknown as PeerLike;
    const session = new PeerSession('host', code, peer, handlers);

    let registered = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('信令服务器连接超时，请检查网络后重试')), SIGNAL_TIMEOUT);
        peer.on('open', (() => {
          window.clearTimeout(timer);
          registered = true;
          resolve();
        }) as never);
        peer.on('error', ((err: { type?: string; message?: string }) => {
          window.clearTimeout(timer);
          if (session.closed) return;
          if (registered) { handlers.onError?.(connectionError(err)); return; }
          const type = err?.type ?? '';
          if (type === 'unavailable-id') reject(new Error('房间码已被占用，请换一个'));
          else if (type === 'peer-unavailable') reject(new Error('无法连接到对手'));
          else if (type === 'network' || type === 'server-error') {
            reject(new Error('无法连接联机服务器（可能被网络环境拦截），可先用「本地双人」对弈'));
          } else reject(new Error(err?.message ?? '联机失败'));
        }) as never);
      });
    } catch (err) {
      session.close();
      throw err;
    }

    peer.on('connection', ((conn: DataConnectionLike) => {
      if (session.closed || session.conn) {
        conn.close();
        return;
      }
      session.attach(conn);
    }) as never);
    // 信令短暂断开不等于已建立的数据通道断开。
    peer.on('disconnected', (() => { if (!session.connected && !session.closed) handlers.onError?.('联机服务连接中断，请重新创建房间'); }) as never);
    return session;
  }

  /** 加入房间 */
  static async join(code: string, handlers: NetHandlers): Promise<NetSession> {
    const Peer = await loadPeer();
    const peer = new Peer(undefined, peerOptions()) as unknown as PeerLike;
    const session = new PeerSession('guest', code, peer, handlers);

    let settled = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          if (err) reject(err); else resolve();
        };
        const timer = window.setTimeout(() => finish(new Error('信令服务器连接超时，请检查网络后重试')), SIGNAL_TIMEOUT);
        peer.on('open', (() => {
          if (settled || session.closed) return;
          window.clearTimeout(timer);
          try {
            const conn = peer.connect(PREFIX + code, { reliable: true });
            session.attach(conn, () => finish(), err => finish(err));
          } catch (err) {
            finish(new Error(connectionError(err as { message?: string })));
          }
        }) as never);
        peer.on('error', ((err: { type?: string; message?: string }) => {
          if (session.closed) return;
          if (settled) { handlers.onError?.(connectionError(err)); return; }
          if (err?.type === 'peer-unavailable') finish(new Error('没有找到该房间，请确认房间码'));
          else if (err?.type === 'network' || err?.type === 'server-error') {
            finish(new Error('无法连接联机服务器，请检查网络后重试'));
          } else finish(new Error(connectionError(err)));
        }) as never);
      });
    } catch (err) {
      session.close();
      throw err;
    }
    return session;
  }

  private attach(conn: DataConnectionLike, onReady?: () => void, onFailure?: (err: Error) => void): void {
    this.conn = conn;
    let opened = false;
    // 只释放本次连接，迟到的 close/error 不得影响重试加入的对手。
    const release = (message: string) => {
      if (this.closed || this.conn !== conn) return;
      this.conn = null;
      window.clearTimeout(this.negotiationTimer);
      window.clearInterval(this.pingTimer);
      this.pendingQueue = [];
      if (!opened) {
        onFailure?.(new Error(message));
        if (this.role === 'host') this.handlers.onError?.(`${message}。房间码保持有效，等待对手重新加入。`);
      } else {
        this.handlers.onClose?.();
      }
      conn.close();
    };
    // 房主等待没人加入不设超时；收到连接后才开始计时。给跨网 ICE 足够时间。
    this.negotiationTimer = window.setTimeout(() => release(NEGOTIATION_ERROR), NEGOTIATION_TIMEOUT);
    conn.on('open', (() => {
      if (this.closed || this.conn !== conn) { conn.close(); return; }
      if (opened) return;
      opened = true;
      window.clearTimeout(this.negotiationTimer);
      this.handlers.onOpen?.(this);
      if (this.closed || this.conn !== conn) {
        onFailure?.(new Error('房间已满或房主已离开'));
        return;
      }
      onReady?.();
      for (const msg of this.pendingQueue) this.rawSend(msg);
      this.pendingQueue = [];
      this.startPing();
    }) as never);
    conn.on('data', ((data: unknown) => {
      const msg = data as NetMessage;
      if (this.closed || this.conn !== conn || !opened || !msg || typeof msg !== 'object') return;
      if (msg.t === 'ping') {
        this.rawSend({ t: 'pong', ts: msg.ts });
        return;
      }
      if (msg.t === 'pong') {
        this.handlers.onLatency?.(Math.max(0, Date.now() - msg.ts));
        return;
      }
      this.handlers.onMessage?.(msg);
    }) as never);
    conn.on('close', (() => release('对手取消了连接或已离开')) as never);
    conn.on('error', ((err: { type?: string; message?: string }) => release(connectionError(err))) as never);
  }

  private startPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (!this.connected) return;
      this.rawSend({ t: 'ping', ts: Date.now() });
    }, 4000);
  }

  private rawSend(msg: NetMessage): void {
    try {
      this.conn?.send(msg);
    } catch {
      /* 连接可能已断开 */
    }
  }

  send(msg: NetMessage): void {
    if (this.closed) return;
    if (!this.connected) {
      this.pendingQueue.push(msg);
      return;
    }
    this.rawSend(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingQueue = [];
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.negotiationTimer);
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    try {
      this.peer.destroy();
    } catch {
      /* ignore */
    }
    this.conn = null;
  }
}

async function loadPeer(): Promise<new (id?: string | undefined, opts?: unknown) => unknown> {
  const mod = (await import('peerjs')) as unknown as { default: new (id?: string, opts?: unknown) => unknown };
  return mod.default;
}
