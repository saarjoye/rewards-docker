import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./src/web/ui', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000'
    }
  }
})
