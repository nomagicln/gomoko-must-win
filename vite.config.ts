import { defineConfig } from 'vite';

/**
 * GitHub Pages 项目页部署：https://<user>.github.io/gomoko-must-win/
 * 本地 `npm run dev` / `npm run preview` 同样使用该 base，保证路径行为一致。
 */
export default defineConfig({
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
});
