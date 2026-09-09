import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true
  }
})
