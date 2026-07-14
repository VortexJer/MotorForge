import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@sim': resolve(__dirname, 'src/shared/sim')
    }
  },
  test: {
    include: ['src/**/*.test.ts']
  }
})
