import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // 5273 is the Phaser client and 5274 the admin panel; this is the third dev server on the
    // machine and it deliberately does not collide with either. The Phaser client keeps running
    // beside this one until M7 — the plan's §7.6 safety net — so both ports have to stay live.
    port: 5280,
    strictPort: true,
  },
  // The shared package is TypeScript source, not a built artefact. Excluding it from dependency
  // pre-bundling keeps edits there hot-reloading straight through. `three` is deliberately *not*
  // excluded: it is a real dependency and pre-bundling it is what keeps the dev server's first
  // paint quick.
  optimizeDeps: {
    exclude: ['@mygame/shared'],
  },
});
