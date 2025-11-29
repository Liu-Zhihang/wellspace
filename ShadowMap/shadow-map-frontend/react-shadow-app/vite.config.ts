import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['leaflet', 'leaflet-shadow-simulator', 'suncalc']
  },
  server: {
    port: 5173,
    host: true,
    fs: {
      allow: ['..', '../..']
    }
  }
})
