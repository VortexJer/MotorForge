import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    assetsInclude: ['**/*.stl'],
    worker: {
      format: 'es'
    },
    resolve: {
      alias: {
        '@sim': resolve(__dirname, 'src/shared/sim'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    }
  }
})
