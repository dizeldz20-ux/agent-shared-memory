import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5930,
    proxy: {
      '/api': 'http://127.0.0.1:8930',
      '/ws': { target: 'ws://127.0.0.1:8930', ws: true },
    },
  },
});
