import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoundEngine } from '../src/ui/audio';

const parameter = () => ({
  value: 0,
  setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(),
});
class MockNode {
  disconnect = vi.fn();
  connect(node: MockNode): MockNode { return node; }
}
class MockSource extends MockNode {
  buffer: unknown;
  type = '';
  frequency = parameter();
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn((at?: number) => { if (at === undefined) this.onended?.(); });
}
class MockGain extends MockNode { gain = parameter(); }
class MockFilter extends MockNode {
  type = '';
  Q = parameter();
  frequency = parameter();
}
let initialState = 'running';
const contexts: MockContext[] = [];
let resumeContext: (ctx: MockContext) => Promise<void> = async ctx => { ctx.state = 'running'; };
class MockContext {
  state = initialState;
  currentTime = 4;
  sampleRate = 1000;
  destination = new MockNode();
  sources: MockSource[] = [];
  gains: MockGain[] = [];
  filters: MockFilter[] = [];
  resume = vi.fn(() => resumeContext(this));
  constructor() { contexts.push(this); }
  createGain() { const gain = new MockGain(); this.gains.push(gain); return gain; }
  createBiquadFilter() { const filter = new MockFilter(); this.filters.push(filter); return filter; }
  createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { const source = new MockSource(); this.sources.push(source); return source; }
  createOscillator() { const source = new MockSource(); this.sources.push(source); return source; }
}

beforeEach(() => {
  vi.useFakeTimers();
  contexts.length = 0;
  initialState = 'running';
  resumeContext = async ctx => { ctx.state = 'running'; };
  vi.stubGlobal('window', { AudioContext: MockContext });
  vi.stubGlobal('document', { hidden: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('声音播放与静音生命周期', () => {
  it('静音启动不会创建上下文或排队音效', () => {
    const engine = new SoundEngine(false);
    engine.unlock(); engine.play('win'); engine.schedule('seal', 240);
    vi.advanceTimersByTime(1000);
    expect(contexts).toHaveLength(0);
    engine.setEnabled(true); engine.unlock(); engine.play('tick');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].sources).toHaveLength(1);
  });

  it('静音立即停止全部音源，重新开启不会恢复旧曲尾音', () => {
    const engine = new SoundEngine(); engine.unlock(); engine.play('win');
    const ctx = contexts[0];
    expect(ctx.sources).toHaveLength(12);
    engine.setEnabled(false);
    expect(ctx.gains[0].gain.setValueAtTime).toHaveBeenLastCalledWith(0, ctx.currentTime);
    ctx.sources.forEach(source => {
      expect(source.stop).toHaveBeenLastCalledWith();
      expect(source.disconnect).toHaveBeenCalledTimes(1);
    });
    engine.setEnabled(true);
    expect(ctx.sources).toHaveLength(12);
    engine.play('tick');
    expect(ctx.sources).toHaveLength(13);
  });

  it('静音后重新开启，也不补播之前排队的胜负音效', () => {
    const engine = new SoundEngine(); engine.unlock();
    engine.schedule('win', 620); engine.schedule('loss', 520);
    engine.setEnabled(false); engine.setEnabled(true);
    vi.advanceTimersByTime(1000);
    expect(contexts[0].sources).toHaveLength(0);
  });

  it('切页或重开清理声音后，旧计时器不会发声', () => {
    const engine = new SoundEngine(); engine.unlock(); engine.play('brush');
    engine.schedule('seal', 240); engine.schedule('win', 620);
    engine.stopAll();
    const count = contexts[0].sources.length;
    vi.advanceTimersByTime(1000);
    expect(contexts[0].sources).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('第一次恢复尚未完成，只保留当前最新反馈，避免叠加历史声音', async () => {
    initialState = 'suspended';
    const engine = new SoundEngine();
    let resume!: () => void;
    // Create the context without resolving resume yet.
    resumeContext = () => new Promise<void>(resolve => { resume = resolve; });
    engine.unlock(); engine.play('win'); engine.play('tick');
    expect(contexts[0].sources).toHaveLength(0);
    contexts[0].state = 'running'; resume(); await settle();
    expect(contexts[0].sources).toHaveLength(1);
  });

  it('恢复失败会被处理，下次手势可以重试', async () => {
    initialState = 'suspended';
    const engine = new SoundEngine(); engine.unlock();
    await settle();
    const ctx = contexts[0]; ctx.state = 'suspended';
    ctx.resume.mockRejectedValueOnce(new Error('blocked'));
    engine.unlock(); engine.play('tick'); await settle();
    expect(ctx.sources).toHaveLength(0);
    engine.unlock(); engine.play('tick'); await settle();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.resume).toHaveBeenCalledTimes(3);
  });

  it('恢复期间静音，第一声待播反馈也被取消', async () => {
    initialState = 'suspended';
    let resume!: () => void;
    resumeContext = () => new Promise<void>(resolve => { resume = resolve; });
    const engine = new SoundEngine(); engine.unlock(); engine.play('win');
    engine.setEnabled(false); contexts[0].state = 'running'; resume();
    await settle(); engine.setEnabled(true);
    expect(contexts[0].sources).toHaveLength(0);
  });

  it('已经被浏览器暂停时，不排队后台产生的声音', async () => {
    const engine = new SoundEngine(); engine.unlock();
    contexts[0].state = 'suspended';
    engine.play('win'); engine.schedule('loss', 520);
    expect(contexts[0].sources).toHaveLength(0);
    engine.unlock(); await settle(); vi.advanceTimersByTime(1000);
    expect(contexts[0].sources).toHaveLength(0);
  });

  it('后台标签页跳过新的声音和延迟播放', () => {
    const engine = new SoundEngine(); engine.unlock();
    vi.stubGlobal('document', { hidden: true });
    engine.play('win'); engine.schedule('loss', 520);
    vi.advanceTimersByTime(1000);
    expect(contexts[0].sources).toHaveLength(0);
  });

  it('自然结束后释放音源和滤波节点，不再次停止已结束的音源', () => {
    const engine = new SoundEngine(); engine.unlock(); engine.play('place-black');
    const ctx = contexts[0];
    ctx.sources.forEach(source => source.onended?.());
    ctx.filters.forEach(filter => expect(filter.disconnect).toHaveBeenCalledOnce());
    engine.stopAll();
    ctx.sources.forEach(source => expect(source.stop).toHaveBeenCalledTimes(1));
  });

  it('关闭的上下文会在下次手势重建', () => {
    const engine = new SoundEngine(); engine.unlock();
    contexts[0].state = 'closed'; engine.unlock(); engine.play('tick');
    expect(contexts).toHaveLength(2);
    expect(contexts[1].sources).toHaveLength(1);
  });
});
