import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * vitest config for the LLM-quality bench (Issue 605). Runs the
 * deterministic gate-keep-rate bench against captured fixtures. No live
 * LLM required.
 *
 * Usage:
 *   npm run bench:llm
 */
export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, '..', '..', 'src/__mocks__/vscode.ts'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['e2e/llm-quality/**/*.spec.ts'],
        // Match the bench from the repo root.
        root: path.resolve(__dirname, '..', '..'),
    },
});
