/**
 * Vitest is pytest. `describe`/`it` map to classes/functions, `expect` to
 * `assert`, `vi.fn()` to `unittest.mock.Mock`, and `test.each` to
 * `@pytest.mark.parametrize`.
 *
 * The reason to prefer it over Jest in 2026 is boring: it runs TypeScript and
 * ES modules natively, with no transform configuration to maintain.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Co-located `*.test.ts`, the way pytest finds `test_*.py` next to the
        // code. A separate tests/ tree also works; pick one and be consistent.
        include: ["{apps,packages}/*/src/**/*.test.ts"],
        environment: "node",
        // Fail a hung test rather than a hung CI job.
        testTimeout: 10_000,
    },
});
