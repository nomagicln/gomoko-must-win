import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AIClient, type WorkerResponse } from '../src/ai/engine';
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  messages: Array<{ id: number }> = [];
  terminated = false;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(request: { id: number }) { this.messages.push(request); }
  terminate() { this.terminated = true; }
  reply(id: number) {
    this.onmessage?.({ data: { id, type: 'search', ok: true, result: {
      move: { x: 7, y: 7 }, score: 0, depth: 1, nodes: 1, elapsedMs: 1, candidates: [], pv: [], forcedWin: null,
    } } });
  }
}
const request = { cells: new Int8Array(225), size: 15, rules: 'freestyle' as const, turn: 1 as const, difficulty: 'master' as const };
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => vi.unstubAllGlobals());

it('取消旧搜索和排队侦测，新搜索直接进入新 Worker', async () => {
  const client = new AIClient(), old = FakeWorker.instances[0];
  const thinking = client.think(request), detection = client.detect(request);
  const thinkRejected = expect(thinking).rejects.toMatchObject({ name: 'AbortError' });
  const detectRejected = expect(detection).rejects.toMatchObject({ name: 'AbortError' });
  client.cancel();
  await Promise.all([thinkRejected, detectRejected]);
  expect(old.terminated).toBe(true);
  const fresh = FakeWorker.instances[1];
  const next = client.think(request);
  old.onerror?.();
  expect(fresh.terminated).toBe(false);
  old.reply(old.messages[0].id); // 旧 Worker 的迟到消息不能影响新搜索。
  fresh.reply(fresh.messages[0].id);
  expect((await next).move).toEqual({ x: 7, y: 7 });
  client.dispose();
});

it('没有计算排队时重开不重复创建 Worker', () => {
  const client = new AIClient();
  client.cancel(); client.cancel();
  expect(FakeWorker.instances).toHaveLength(1);
  expect(client.usingWorker).toBe(true);
  client.dispose();
});

it('销毁会结束等待，销毁后不再启动同步计算', async () => {
  const client = new AIClient();
  const waiting = client.think(request);
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  client.dispose(); await rejected;
  await expect(client.think(request)).rejects.toThrow('disposed');
  await expect(client.detect(request)).rejects.toThrow('disposed');
  expect(FakeWorker.instances[0].terminated).toBe(true);
});
