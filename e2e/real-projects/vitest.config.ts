/**
 * Vitest config dedicated to the real-world verification suite.
 * Keeps verify:real out of the default `npm test` run.
 */
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            // ADR-030: production code imports `vscode` for telemetry. Tests
            // that don't supply their own vi.mock('vscode', ...) get a no-op
            // shim instead of "Failed to load url vscode".
            vscode: path.resolve(__dirname, '..', '..', 'src/__mocks__/vscode.ts'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        // Issue #400: `pool: 'forks'` puts each test file in its own
        // process so tree-sitter wasm state can't leak across teardown.
        // `dangerouslyIgnoreUnhandledErrors` lets the suite pass despite
        // post-test ERR_INTERNAL_ASSERTION rejections from Node internals
        // (tree-sitter wasm GC race with worker exit). Test assertions
        // still surface failures normally.
        pool: 'forks',
        dangerouslyIgnoreUnhandledErrors: true,
        include: [
            path.resolve(__dirname, 'verify.test.ts'),
            path.resolve(__dirname, 'invariants.test.ts'),
            path.resolve(__dirname, 'integrity.test.ts'),
            path.resolve(__dirname, 'layers.test.ts'),
            path.resolve(__dirname, 'manifestDrift.test.ts'),
            path.resolve(__dirname, 'extras.test.ts'),
            path.resolve(__dirname, 'summary.test.ts'),
            path.resolve(__dirname, 'cascadeScenarios.test.ts'),
            path.resolve(__dirname, 'cascadeEditOpScenarios.test.ts'),
            path.resolve(__dirname, 'incrementalReviewScenarios.test.ts'),
            path.resolve(__dirname, 'applyEditOp.test.ts'),
            path.resolve(__dirname, 'persistenceScenarios.test.ts'),
            path.resolve(__dirname, 'resyncScenarios.test.ts'),
            path.resolve(__dirname, 'timelineReplayScenarios.test.ts'),
            path.resolve(__dirname, 'replayStepOrderScenarios.test.ts'),
            path.resolve(__dirname, 'commentReanchorScenarios.test.ts'),
            path.resolve(__dirname, 'commitDiffScenarios.test.ts'),
            path.resolve(__dirname, 'cascadeRefreshIds.test.ts'),
            path.resolve(__dirname, 'liveVerifyTestProject.test.ts'),
            path.resolve(__dirname, 'sessionPatternAudit.test.ts'),
            path.resolve(__dirname, 'perRepoDetectionReport.test.ts'),
            path.resolve(__dirname, 'perRepoCascadeProbe.test.ts'),
            path.resolve(__dirname, 'perRepoLeakProbe.test.ts'),
            path.resolve(__dirname, 'mcpTokenEconomics.test.ts'),
            path.resolve(__dirname, 'mcpMultiRepoSmoke.test.ts'),
            // ADR-034 Phase E Pass 3 follow-up — multi-repo failure isolation.
            path.resolve(__dirname, 'failureIsolation.test.ts'),
            // #829 — edit→revert in-memory hash parity (surfaced by #827).
            path.resolve(__dirname, 'regressionScopeRevert.test.ts'),
            // #830 — apiIndex stability across rebuilds.
            path.resolve(__dirname, 'apiIndexStability.test.ts'),
            // #833 — cascade survives registry LRU eviction.
            path.resolve(__dirname, 'evictedStoreCascade.test.ts'),
            // #837 — module.exports handler edits stamp the L5 flow diff.
            path.resolve(__dirname, 'moduleExportsFlowDiff.test.ts'),
            // #844 — stale naming enrichment cannot corrupt cluster state.
            path.resolve(__dirname, 'staleNamingCallback.test.ts'),
            // #905 — cross-file flow propagation diffs the importer vs baseline (post-save lazy-content).
            path.resolve(__dirname, 'crossFileFlowScenarios.test.ts'),
            // #904 — comments re-anchor on incremental rebuildFile, not only full resync.
            path.resolve(__dirname, 'incrementalReanchorScenarios.test.ts'),
        ],
        // No coverage: verify:real measures behavior, not source coverage.
        // 2026-06-11 — 120s was marginal for the largest fixture
        // (ts-nextjs-pages, ~1.2k graphs) and started flaking once the
        // scan grew the per-function bodySrc capture (#837). The suite
        // gates correctness, not latency; give the big repos headroom.
        testTimeout: 240_000,
        hookTimeout: 60_000,
    },
});
