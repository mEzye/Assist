import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': process.env.ASSIST_API_ORIGIN || 'http://127.0.0.1:3001',
      '/auth': process.env.ASSIST_API_ORIGIN || 'http://127.0.0.1:3001',
    },
  },
});
