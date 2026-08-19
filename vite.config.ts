import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// base: './' keeps asset URLs relative so the same build works on
// local `vite preview` and on GitHub Pages project subpaths.
export default defineConfig({
  base: './',
  server: { port: 5173, open: true },
  build: {
    rollupOptions: {
      // The player ships as its own page so it can be hosted on its own.
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
      },
    },
  },
});
