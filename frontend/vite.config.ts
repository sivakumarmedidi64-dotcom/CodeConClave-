import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: same-origin cookies (cc_session, codeconclave_csrf) flow to the
// backend on localhost:4000; /agent is proxied as WebSocket.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/health': { target: 'http://localhost:4000', changeOrigin: true },
      '/agent': { target: 'ws://localhost:4000', ws: true },
      '/agent-browser': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});