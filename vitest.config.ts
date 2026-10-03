import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            // ADR-030: production code imports `vscode` for telemetry. Tests
            // that don't supply their own vi.mock('vscode', ...) get a no-op
            // shim instead of "Failed to load url vscode".
            vscode: path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        // No telemetry key ships in source (audit S2/S3): `MIXPANEL_TOKEN` is
        // read at module load and the send path returns early when it is
        // empty, so a build from a clone never reaches the network.
        //
        // The envelope tests exist to pin the Mixpanel request shape, which
        // means they need SOME token present to get past that guard. Provide
        // an obviously-fake one here. This must never be a real project
        // token -- the whole point of S2 is that no real token lives in this
        // repository.
        env: {
            CODEATLAS_MIXPANEL_TOKEN: 'test-token-not-a-real-project-token',
        },
        include: ['src/**/__tests__/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
        },
    },
});
