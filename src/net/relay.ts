import type { NetHandlers, NetMessage, NetRole, NetSession } from './peer';

/** Render 免费服务可能休眠，首次建房预留唤醒时间。 */
const CONNECT_TIMEOUT = 90000;

export class RelaySession implements NetSession {
  readonly peerId = '';
  private closed = false;
  private socket: WebSocket;
  private paired = false;
  private registered = false;
  private pingTimer = 0;
  private lastPong = 0;

  private constructor(readonly role: NetRole, readonly code: string, private handlers: NetHandlers, url: string) {
    this.socket = new WebSocket(url);
  }

  get connected(): boolean { return !this.closed && this.paired && this.socket.readyState === WebSocket.OPEN; }

  static host(code: string, handlers: NetHandlers, url: string): Promise<NetSession> {
    return RelaySession.connect('host', code, handlers, url);
  }
  static join(code: string, handlers: NetHandlers, url: string): Promise<NetSession> {
    return RelaySession.connect('guest', code, handlers, url);
  }

  private static connect(role: NetRole, code: string, handlers: NetHandlers, url: string): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      const session = new RelaySession(role, code, handlers, url);
      let settled = false;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (error) { reject(new Error(error)); session.close(); } else resolve(session);
      };
      const timer = window.setTimeout(() => finish('联机服务唤醒超时，请稍后重试'), CONNECT_TIMEOUT);
      const notifyClose = () => {
        if (session.closed) return;
        const wasPaired = session.paired;
        session.close();
        if (!settled) finish('无法连接房间服务，请检查网络后重试');
        else if (wasPaired) handlers.onClose?.();
        else handlers.onError?.('房间服务连接中断，请返回大厅重新创建房间');
      };
      session.socket.addEventListener('open', () => {
        if (session.closed) return;
        session.socket.send(JSON.stringify({ t: role === 'host' ? 'host' : 'join', code }));
      });
      session.socket.addEventListener('message', event => {
        if (session.closed) return;
        let msg: { t?: string; message?: string; data?: NetMessage };
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'error') {
          if (!settled) finish(msg.message ?? '加入房间失败');
          else handlers.onError?.(msg.message ?? '房间连接异常');
        } else if (msg.t === 'created' && role === 'host' && !session.registered) {
          session.registered = true;
          finish();
        } else if ((msg.t === 'joined' && role === 'guest') || (msg.t === 'peer-joined' && role === 'host')) {
          if (session.paired) return;
          session.registered = true;
          session.paired = true;
          handlers.onOpen?.(session);
          if (session.closed) { finish('已离开房间'); return; }
          session.startPing();
          finish();
        } else if (msg.t === 'peer-left') {
          const wasPaired = session.paired;
          session.paired = false;
          window.clearInterval(session.pingTimer);
          session.close();
          if (wasPaired) handlers.onClose?.();
        } else if (msg.t === 'message' && session.paired && msg.data && typeof msg.data === 'object') {
          if (msg.data.t === 'ping') session.send({ t: 'pong', ts: msg.data.ts });
          else if (msg.data.t === 'pong') {
            session.lastPong = Date.now();
            handlers.onLatency?.(Math.max(0, Date.now() - msg.data.ts));
          } else handlers.onMessage?.(msg.data);
        }
      });
      session.socket.addEventListener('close', notifyClose);
      session.socket.addEventListener('error', notifyClose);
    });
  }

  private startPing(): void {
    this.lastPong = Date.now();
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      // 仅在页面可见时判定超时，避免后台标签页节流导致误判。
      if (document.visibilityState === 'hidden') { this.lastPong = Date.now(); return; }
      if (Date.now() - this.lastPong > 30000) {
        this.close(); this.handlers.onClose?.(); return;
      }
      this.send({ t: 'ping', ts: Date.now() });
    }, 4000);
  }

  send(msg: NetMessage): void {
    if (!this.connected) return;
    try { this.socket.send(JSON.stringify({ t: 'message', data: msg })); }
    catch { this.close(); this.handlers.onClose?.(); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.paired = false;
    window.clearInterval(this.pingTimer);
    this.socket.close();
  }
}
