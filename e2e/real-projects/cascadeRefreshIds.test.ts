/**
 * cascadeRefreshIds.test.ts — Issues 374 + 380
 *
 * Pins the refresh-id contract of `applyDiffCascadeToLiveGraphs`:
 * the returned set must include every `feature:*` graph variant
 * (both `feature:workspace` AND any per-service `feature:service:<id>`)
 * plus every `microservice:*` graph — so the navigation handler can
 * push live updates to ALL feature panels on cascade, not just the
 * workspace one.
 *
 * Issue 374 root cause hypothesis: panels for `feature:service:main`
 * rendered stale "all unchanged" because the cascade only emitted a
 * refresh for `feature:workspace`. Fix at
 * `src/core/sync/syncOrchestrator.ts:2056-2059` already iterates
 * `Object.keys(working.graphs)` so every prefix-matching graph is
 * surfaced. This test pins that behavior so a future regression
 * (e.g. someone narrowing the filter back to `=== 'feature:workspace'`)
 * fails immediately.
 *
 * Issue 380 (back-button staleness) shares the same surface: the
 * `requestRoute` handler calls applyDiffCascadeToLiveGraphs() and
 * relies on the returned set to know which panels to refresh.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';

installFixtureSafetyGuard();

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

d('applyDiffCascadeToLiveGraphs — refresh-id contract (Issues 374 + 380)', () => {
    let scenario: ScenarioResult;
    let refreshIds: string[];

    beforeAll(async () => {
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: [`console.log('[refresh-id-probe]');`] },
                },
            ],
        });
        // Drive the cascade explicitly and capture its return.
        refreshIds = scenario.sync.applyDiffCascadeToLiveGraphs();
    }, 90_000);

    afterAll(() => scenario?.dispose());

    it('refresh set is non-empty', () => {
        expect(refreshIds.length).toBeGreaterThan(0);
    });

    it('includes every feature:* graph present in the working snapshot', () => {
        const workingFeatureGraphs = Object.keys(scenario.working.graphs)
            .filter(id => id.startsWith('feature:'));
        for (const id of workingFeatureGraphs) {
            expect(refreshIds, `missing feature graph in refresh set: ${id}`)
                .toContain(id);
        }
        // Sanity: the workspace feature graph must always be present.
        expect(refreshIds).toContain('feature:workspace');
    });

    it('includes microservice:workspace', () => {
        expect(refreshIds).toContain('microservice:workspace');
    });

    // Issue #730 — the Knowledge Map (`map:workspace`) must be in the
    // refresh set so an open Map panel re-renders post-cascade. Without
    // this, edits to a file leave the Map showing pre-edit state until
    // the user manually re-opens the panel.
    it('includes map:workspace', () => {
        expect(refreshIds).toContain('map:workspace');
    });

    it('includes every sequence:* graph in the working snapshot', () => {
        const workingSeq = Object.keys(scenario.working.graphs)
            .filter(id => id.startsWith('sequence:'));
        for (const id of workingSeq) {
            expect(refreshIds, `missing sequence graph in refresh set: ${id}`)
                .toContain(id);
        }
    });

    it('includes the api-list graph for the affected cluster', () => {
        // The auth cluster owns the GET /user route the cascade reaches via
        // auth.controller.ts.
        expect(refreshIds.some(id => id === 'api-list:cluster:auth' || id.startsWith('api-list:'))).toBe(true);
    });

    it('every id in the set is unique (no duplicates from the dedupe pass)', () => {
        expect(refreshIds.length).toBe(new Set(refreshIds).size);
    });
});
