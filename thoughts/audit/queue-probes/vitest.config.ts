import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["thoughts/audit/queue-probes/*.test.ts"], fileParallelism: false },
});
