import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('./src/web/ui', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          id = id.replaceAll('\\', '/')
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-runtime'
          if (id.includes('node_modules/tdesign-react/')) return 'tdesign'
          if (id.includes('node_modules/')) return 'ui-support'
        }
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000'
    }
  }
})
