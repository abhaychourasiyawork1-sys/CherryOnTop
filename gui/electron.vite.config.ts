import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { rollupOptions: { external: ['pm2'] } } },
  preload: {},
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
});
