import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    // Telegram in-app WebViews can be old (Android System WebView / iOS < 16.4)
    target: ['es2019', 'chrome80', 'safari13'],
    cssTarget: ['chrome80', 'safari13'],
    // tgcloud.jsonc serves the Mini App from ./miniapp-dist (see SPEC §1).
    outDir: '../miniapp-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      }
    }
  }
})
