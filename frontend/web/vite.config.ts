import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
// Khi dev: /api và /ws chuyển tiếp sang Java BE (mặc định http://localhost:8080) → không cần CORS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_BACKEND_URL || 'http://localhost:8080'
  return {
    plugins: [react()],
    server: {
      fs: { allow: ['..'] }, // cho phép import frontend/shared
      proxy: {
        '/api': { target, changeOrigin: true },
        '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      },
    },
  }
})
