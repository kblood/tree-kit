import {defineConfig} from 'vite';

export default defineConfig({
  root: '.',
  server: {host: '127.0.0.1'},
  build: {
    rollupOptions: {input: 'tree-asset-lab.html'},
  },
});
