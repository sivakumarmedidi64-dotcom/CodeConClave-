import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

// TEMPORARY DEMO BUILD: production builds default to demo mode so the
// commercial payment surface is excluded from any compiled bundle that a
// public user can reach, regardless of the CI builder command. Dev builds
// (NODE_ENV=development) keep the full UI. Set VITE_DEMO_BUILD=0 to restore
// the paid build, or VITE_DEMO_BUILD=1 to force demo explicitly.
const demoBuild =
  process.env.VITE_DEMO_BUILD === '1' ||
  (process.env.VITE_DEMO_BUILD !== '0' && process.env.NODE_ENV === 'production');

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