import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000, // first run downloads a MongoDB binary for mongodb-memory-server
    fileParallelism: false, // one in-memory mongod at a time
  },
});
