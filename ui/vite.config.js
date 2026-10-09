/* global process */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import thirdPartyNotices from './third-party-notices.js'

export default defineConfig({
  // thirdPartyNotices: the license texts of everything bundled, written to
  // public/THIRD_PARTY_NOTICES.txt (minification strips them from the code itself).
  plugins: [react(), tailwindcss(), thirdPartyNotices({ extra: ['tailwindcss', 'react-router-dom'], root: import.meta.dirname })],
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
