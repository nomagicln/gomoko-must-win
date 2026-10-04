/**
 * AI Web Worker：把搜索放到后台线程，保证棋盘动画与交互始终顺滑。
 */

import type { WorkerRequest, WorkerResponse } from './engine';
import { thinkSync, detectSync } from './engine';

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'search') {
      const result = thinkSync(req.payload);
      const res: WorkerResponse = { id: req.id, type: 'search', ok: true, result };
      (self as unknown as Worker).postMessage(res);
    } else {
      const result = detectSync(req.payload);
      const res: WorkerResponse = { id: req.id, type: 'detect', ok: true, result };
      (self as unknown as Worker).postMessage(res);
    }
  } catch (err) {
    const res: WorkerResponse = {
      id: req.id,
      type: 'error',
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(res);
  }
};
