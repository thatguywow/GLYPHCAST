import { defineConfig } from 'vite';

// base: './' keeps asset URLs relative so the same build works on
// local `vite preview` and on GitHub Pages project subpaths.
export default defineConfig({
  base: './',
  server: { port: 5173, open: true },
});
