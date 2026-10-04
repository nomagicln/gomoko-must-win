import { defineConfig } from 'vite';
import { networkInterfaces } from 'node:os';

/**
 * GitHub Pages 项目页部署：https://<user>.github.io/gomoko-must-win/
 * 本地 `npm run dev` / `npm run preview` 同样使用该 base，保证路径行为一致。
 */
export default defineConfig(({ command }) => ({
  define: {
    __DEV_LAN_HOST__: JSON.stringify(command === 'serve'
      ? Object.entries(networkInterfaces()).filter(([name]) => /^en\d+$/.test(name))
        .flatMap(([, addresses]) => addresses ?? []).find(a => a.family === 'IPv4' && !a.internal)?.address ?? ''
      : ''),
  },
  base: '/gomoko-must-win/',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 900,
    reportCompressedSize: false,
  },
  worker: { format: 'es' },
  server: { host: true, port: 5173 },
}));
