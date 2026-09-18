/// <reference types="vitest" />
import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Overridable via frontend/.env.local (gitignored) so a second, independent checkout
  // running its own backend on another port doesn't need to touch this checked-in default.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const devPort = Number(env.VITE_DEV_PORT) || undefined

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      ...(devPort ? { port: devPort, strictPort: true } : {}),
      proxy: {
        '/api': {
          target: env.VITE_DEV_BACKEND_TARGET || 'http://localhost:3002',
          changeOrigin: true,
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
    },
  }
})
