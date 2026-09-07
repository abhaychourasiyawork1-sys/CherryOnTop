// Renderer-only dev server, for looking at the window in a browser without a
// display server. Proxies /trpc to the real daemon so the page and the API share
// an origin — the daemon deliberately sends no CORS headers, since it is a
// localhost service and any site you visit could otherwise reach it.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DAEMON = Number(process.env.ORG_DAEMON_PORT ?? 4177);

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  define: { 'import.meta.env.VITE_ORG_DAEMON_PORT': JSON.stringify('5199') },
  server: {
    port: 5199,
    strictPort: true,
    proxy: { '/trpc': { target: `http://127.0.0.1:${DAEMON}`, ws: true, changeOrigin: true } },
  },
});
