import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Not Vite's default 5173 — this machine already runs other dev servers there.
    port: 5273,
    strictPort: true,
  },
  // The shared package is TypeScript source, not a built artefact. Excluding it from dependency
  // pre-bundling keeps edits there hot-reloading straight through to the client.
  optimizeDeps: {
    exclude: ['@mygame/shared'],
  },
});
