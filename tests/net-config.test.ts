import { afterEach, expect, it, vi } from 'vitest';
import { parseIceServers, peerOptions, relayURL } from '../src/net/config';
afterEach(() => vi.unstubAllEnvs());
it('默认使用部署好的 Render 房间通道，也允许显式改为 P2P', () => {
  expect(relayURL()).toBe('wss://nomagicln-webrtc.onrender.com/gomoku');
  vi.stubEnv('VITE_ROOM_RELAY_URL', ''); expect(relayURL()).toBe('');
});
it('显式 P2P 配置用多个 STUN，不再尝试失效的 PeerJS TURN 域名', () => {
  vi.stubEnv('VITE_ICE_SERVERS', '');
  expect(peerOptions().config.iceServers).toHaveLength(2);
  expect(JSON.stringify(peerOptions())).not.toContain('turn.peerjs.com');
});
it('可接入部署者自己的 TURN，保留客户端凭据并拒绝错误配置', () => {
  const value = '[{"urls":["turn:relay.example:3478","turns:relay.example:443?transport=tcp"],"username":"client","credential":"temporary"}]';
  vi.stubEnv('VITE_ICE_SERVERS', value);
  expect(peerOptions().config.iceServers).toEqual(JSON.parse(value));
  for (const bad of ['null', '[]', 'invalid', '[{}]', '[{"urls":"https://example.com"}]', '[{"urls":"turn:relay.example"}]']) {
    expect(() => parseIceServers(bad)).toThrow('联机服务配置有误');
  }
});
