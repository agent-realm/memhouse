/* global process */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/relay': 'http://localhost:4638',
      '/api': process.env.RELAY ? 'http://localhost:4638' : 'http://localhost:4637',
    },
  },
})
