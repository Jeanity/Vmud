import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Beside the client's 5273, and not Vite's default 5173 — this machine already runs other dev
    // servers there.
    port: 5274,
    strictPort: true,
    // The panel talks to the game server's admin API as if it were its own origin, which is what
    // keeps CORS machinery out of both ends: the browser sees one origin, and the game server never
    // grants cross-origin anything. See DESIGN-admin-panel.md §2–3.
    proxy: {
      '/admin': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
