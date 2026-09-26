import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const marketingApiUrl = process.env.MARKETING_API_URL ?? 'http://127.0.0.1:4178';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: marketingApiUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/env.ts'],
    css: false,
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'test/setup.ts'],
  },
});
