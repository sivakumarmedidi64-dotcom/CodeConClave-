/**
 * CodeConClave frontend — vitest configuration (jsdom).
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __DEMO_BUILD__: JSON.stringify(process.env.VITE_DEMO_BUILD === '1'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
    css: false,
    testTimeout: 20000,
  },
});