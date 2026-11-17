import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const SERVER = `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/socket.io': { target: SERVER, ws: true, changeOrigin: true },
      '/api': { target: SERVER, changeOrigin: true },
      '/uploads': { target: SERVER, changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
