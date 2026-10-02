import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Разработка: ручки — с живого сервера витрины. changeOrigin обязателен:
// сервер принимает только Host 127.0.0.1:4317 / localhost:4317, прочее — 421 (спека 1.1).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5317,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
