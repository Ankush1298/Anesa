import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Development only: the browser talks to ONE origin (this dev server). Requests to /api are proxied
// to the backend with the prefix stripped. changeOrigin stays false on purpose: the backend's CSRF
// origin check (development fallback) compares Origin with the Host it receives, so Host must remain
// the browser's host. In production a reverse proxy does the same mapping (docs/deployment/frontend.md).
const apiOrigin = process.env['DEV_API_ORIGIN'] ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiOrigin, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // never ship source maps of a private application
    target: 'es2023',
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
