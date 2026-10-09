import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // *.test.ts files belong to `claude plugin test`, which runs them inside Claude Code.
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
})
