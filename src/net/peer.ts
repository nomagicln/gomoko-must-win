/**
 * 在线对战传输层：基于 WebRTC（PeerJS）的点对点连接。
 *
 * 为什么是 P2P：本站托管在 GitHub Pages 上，没有自己的后端。
 * PeerJS 只提供一次性的信令握手，之后所有着法直接在两位玩家的浏览器之间传输，
 * 因此既不需要服务器，也没有中间人能看到棋谱。
 *
 * peerjs 通过动态 import 按需加载，未进入「联机」页面时不会增加首屏体积。
 */

export type NetRole = 'host' | 'guest';

export type NetMessage =
  | { t: 'hello'; name: string; size: number; rules: string; version: number }
  | { t: 'ready'; name: string }
  | { t: 'start'; black: NetRole; size: number; rules: string; first: number }
  | { t: 'move'; x: number; y: number; color: 1 | 2; ply: number }
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
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
  onLatency?: (ms: number) => void;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PREFIX = 'inkgomoku-v1-';

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

export class NetSession {
  readonly role: NetRole;
  readonly code: string;
  private peer: PeerLike;
  private conn: DataConnectionLike | null = null;
  private handlers: NetHandlers;
  private pingTimer = 0;
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
    const peer = new Peer(PREFIX + code, { debug: 0 }) as unknown as PeerLike;
    const session = new NetSession('host', code, peer, handlers);

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('信令服务器连接超时，请检查网络后重试')), 12000);
      peer.on('open', (() => {
        window.clearTimeout(timer);
        resolve();
      }) as never);
      peer.on('error', ((err: { type?: string; message?: string }) => {
        window.clearTimeout(timer);
        const type = err?.type ?? '';
        if (type === 'unavailable-id') reject(new Error('房间码已被占用，请换一个'));
        else if (type === 'peer-unavailable') reject(new Error('无法连接到对手'));
        else if (type === 'network' || type === 'server-error') {
          reject(new Error('无法连接联机服务器（可能被网络环境拦截），可先用「本地双人」对弈'));
        } else reject(new Error(err?.message ?? '联机失败'));
      }) as never);
    });

    peer.on('connection', ((conn: DataConnectionLike) => {
      if (session.conn?.open) {
        conn.close();
        return;
      }
      session.attach(conn);
    }) as never);
    peer.on('disconnected', (() => handlers.onClose?.()) as never);
    return session;
  }

  /** 加入房间 */
  static async join(code: string, handlers: NetHandlers): Promise<NetSession> {
    const Peer = await loadPeer();
    const peer = new Peer(undefined, { debug: 0 }) as unknown as PeerLike;
    const session = new NetSession('guest', code, peer, handlers);

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('信令服务器连接超时，请检查网络后重试')), 12000);
      peer.on('open', (() => {
        window.clearTimeout(timer);
        const conn = peer.connect(PREFIX + code, { reliable: true });
        session.attach(conn);
        const openTimer = window.setTimeout(() => {
          if (!conn.open) reject(new Error('房间不存在或对手已离线'));
        }, 12000);
        conn.on('open', (() => {
          window.clearTimeout(openTimer);
          resolve();
        }) as never);
      }) as never);
      peer.on('error', ((err: { type?: string; message?: string }) => {
        window.clearTimeout(timer);
        if (err?.type === 'peer-unavailable') reject(new Error('没有找到该房间，请确认房间码'));
        else if (err?.type === 'network' || err?.type === 'server-error') {
          reject(new Error('无法连接联机服务器（可能被网络环境拦截），可先用「本地双人」对弈'));
        } else reject(new Error(err?.message ?? '加入房间失败'));
      }) as never);
    });
    return session;
  }

  private attach(conn: DataConnectionLike): void {
    this.conn = conn;
    conn.on('open', (() => {
      this.handlers.onOpen?.();
      for (const msg of this.pendingQueue) this.rawSend(msg);
      this.pendingQueue = [];
      this.startPing();
    }) as never);
    conn.on('data', ((data: unknown) => {
      const msg = data as NetMessage;
      if (!msg || typeof msg !== 'object') return;
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
    conn.on('close', (() => this.handlers.onClose?.()) as never);
    conn.on('error', ((err: { message?: string }) => this.handlers.onError?.(err?.message ?? '连接异常')) as never);
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
    this.closed = true;
    window.clearInterval(this.pingTimer);
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
