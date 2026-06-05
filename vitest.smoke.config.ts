/**
 * Vitest config for smoke tests only.
 * Used by `npm run smoke` and direct invocations like:
 *   npx vitest run --config vitest.smoke.config.ts test/smoke/guard-hardblock.smoke.test.ts
 *
 * Intentionally omits the test/smoke/** exclude that is in vitest.config.ts,
 * so smoke tests (gated behind RUN_OC_SMOKE=1) are actually discoverable.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/smoke/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tmp/**"],
    environment: "node",
  },
});
