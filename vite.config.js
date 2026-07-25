import { defineConfig } from 'vite';

// Relative base so the built bundle can be served from any sub-path
// (GitHub Pages project sites, itch.io zips, a plain file:// open, ...).
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
    // No manual chunking: the game is one bundle plus three.js, and it is all
    // needed before the first frame. Splitting it would only add a round trip.
  },
});
