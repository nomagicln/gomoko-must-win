/** WebRTC 穿透服务。覆盖 PeerJS 自带的失效 TURN 域名。 */
const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

/** VITE_ICE_SERVERS 可配置自己的 TURN；只接受浏览器使用的 ICE 凭据。 */
export function parseIceServers(value: string): RTCIceServer[] {
  try {
    const servers: unknown = JSON.parse(value);
    if (!Array.isArray(servers) || !servers.length) throw new Error();
    return servers.map(server => {
      if (!server || typeof server !== 'object') throw new Error();
      const { urls, username, credential } = server;
      const addresses: unknown[] = Array.isArray(urls) ? urls : [urls];
      if (!addresses.length || addresses.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):\S+$/.test(url))) throw new Error();
      const hasTurn = addresses.some(url => /^turns?:/.test(url as string));
      if (hasTurn && (typeof username !== 'string' || !username || typeof credential !== 'string' || !credential)) throw new Error();
      return { urls: addresses as string[], ...(hasTurn ? { username, credential } : {}) };
    });
  } catch {
    throw new Error('联机服务配置有误，请检查 ICE / TURN 配置');
  }
}

export function peerOptions(): { debug: number; config: RTCConfiguration } {
  const configured = import.meta.env.VITE_ICE_SERVERS?.trim();
  return { debug: 0, config: { iceServers: configured ? parseIceServers(configured) : STUN_SERVERS } };
}

/** 空字符串允许部署者显式选择 PeerJS 点对点模式。 */
export function relayURL(): string {
  return (import.meta.env.VITE_ROOM_RELAY_URL ?? 'wss://nomagicln-webrtc.onrender.com/gomoku').trim();
}
