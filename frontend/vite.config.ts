import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

// TEMPORARY DEMO BUILD: when VITE_DEMO_BUILD=1 the commercial payment surface is
// excluded from the compiled bundle (its strings never reach public users), the
// module files stay untouched in the repo, and __DEMO_BUILD__ gates send the
// dead branches to the minifier for entire-branch elimination.
const demoBuild = process.env.VITE_DEMO_BUILD === '1';

// Dev proxy: same-origin cookies (cc_session, codeconclave_csrf) flow to the
// backend on localhost:4000; /agent is proxied as WebSocket.
export default defineConfig({
  plugins: [react()],
  define: {
    __DEMO_BUILD__: JSON.stringify(demoBuild),
  },
  resolve: demoBuild
    ? {
        alias: [
          {
            find: './components/PaymentGateModal',
            replacement: fileURLToPath(new URL('./src/components/paymentGateStub.tsx', import.meta.url)),
          },
        ],
      }
    : undefined,
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