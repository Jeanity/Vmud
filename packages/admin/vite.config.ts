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
      // A7c: the staged LPC sheets the art picker draws thumbnails from. Pointed at the **game
      // server**, not at the client's 5273, so the panel needs nothing but the server running — the
      // same reason `/admin` goes there. See `server/src/art.ts`.
      '/lpc': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
      // A10: the supervisor, on its own port and deliberately **not** behind the game server. Every
      // other route here dies with 8787, which is exactly why lifecycle cannot live there — the
      // Server section has to keep answering while the thing it restarts is down. See
      // `server/src/supervisor.ts`.
      '/supervisor': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: false,
      },
    },
  },
});
