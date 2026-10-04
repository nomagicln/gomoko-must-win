/** 固定局面、固定预算的 AI 基准。可用 --module /path/to/bundled-search.mjs 比较旧版。 */
import { createServer } from 'vite';
import { pathToFileURL } from 'node:url';
const moduleIndex = process.argv.indexOf('--module');
const server = moduleIndex < 0 ? await createServer({ server: { middlewareMode: true }, appType: 'custom' }) : null;
try {
  const { search } = server ? await server.ssrLoadModule('/src/ai/search.ts')
    : await import(pathToFileURL(process.argv[moduleIndex + 1]));
  const fixtures = {
    '开局': [[7,7,1],[7,8,2],[8,6,1],[6,8,2]],
    '中盘': [[7,7,1],[7,8,2],[8,8,1],[6,7,2],[8,6,1],[8,7,2],[6,9,1],[5,8,2],[9,9,1],[10,10,2]],
    '连续冲四': [[6,7,1],[9,6,2],[6,10,1],[10,9,2],[7,6,1],[7,9,2],[4,6,1],[5,5,2],[8,9,1],[10,6,2],[9,9,1],[9,4,2],[8,7,1],[9,7,2],[4,5,1],[5,6,2],[5,7,1],[8,4,2]],
  };
  const rows = [];
  for (const [name, stones] of Object.entries(fixtures)) {
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const cells = new Int8Array(225);
      for (const [x,y,color] of stones) cells[y*15+x] = color;
      const original = cells.slice();
      const start = performance.now();
      const out = search(cells, 1, {maxDepth:6,timeMs:500,branchLimit:12,useVcf:name==='连续冲四',vcfDepth:10});
      if (!out.move || original[out.move.y*15+out.move.x] !== 0 || !cells.every((v,i)=>v===original[i])) {
        throw new Error(`${name}: 搜索返回非法着法或污染了输入棋盘`);
      }
      if (sample) samples.push({ ...out, totalMs: performance.now() - start }); // 第一轮仅预热。
    }
    samples.sort((a,b)=>a.totalMs-b.totalMs);
    const out = samples[Math.floor(samples.length/2)];
    rows.push({局面:name,深度:out.depth,节点:out.nodes,耗时毫秒:+out.totalMs.toFixed(1),
      每秒节点:Math.round(out.nodes/Math.max(out.elapsedMs,0.001)*1000),
      着法:`${String.fromCharCode(65+out.move.x)}${out.move.y+1}`,算杀:out.forcedWin?.kind ?? '—'});
  }
  console.table(rows);
} finally { await server?.close(); }
