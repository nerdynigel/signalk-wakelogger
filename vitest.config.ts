import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    coverage: { reporter: ['text', 'html'] }
  }
})
