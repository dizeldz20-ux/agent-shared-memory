import { defineConfig } from 'vitest/config';

// Two workers at most: the suite runs on a laptop that is also running the agents.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    pool: 'forks',
    maxWorkers: 2,
    minWorkers: 1,
  },
});
