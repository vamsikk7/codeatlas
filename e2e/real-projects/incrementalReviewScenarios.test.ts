/**
 * incrementalReviewScenarios.test.ts — Issue 606-LIVE + #606-SYNTHETIC
 *
 * Live cascade-rebuild regression for the incremental review path. Boots a
 * real `SnapshotStore` + `SyncOrchestrator` against a cloned fixture repo,
 * seeds per-entry review cursors as if a full review had just completed,
 * applies a body edit to one handler file, and asserts that
 * `computeReviewDelta` partitions the apiIndex into:
 *
 *   - `changed`         = exactly the entry points in the edited file
 *   - `reused`          = every entry point in every OTHER file
 *   - `deletedCursors`  = empty (no routes vanished from this edit)
 *   - `deletedFindings` = empty
 *
 * Post-#606-SYNTHETIC: the test no longer filters to HTTP routes. The
 * cursor table is keyed by `apiId` so synthetic entries (NETWORK
 * `useMutation`, SCREEN, JOB) that share `method:route` across files are
 * now tracked independently. The contract holds across HTTP + synthetic
 * entries alike.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    runScenario,
    type ScenarioResult,
} from './cascadeHarness';
import { PRESENT_FIXTURES, probeLinesFor, type ScenarioFixture } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import { computeEntryPointHandlerHash, computeReviewDelta, entryPointKey } from '../../src/core/llm/reviewDelta';
import type { ApiRecord } from '../../src/core/graph/graphTypes';

installFixtureSafetyGuard();

if (PRESENT_FIXTURES.length === 0) {
    describe.skip('incremental review scenarios (no fixtures present — run npm run fetch:real-projects)', () => {
        it('placeholder', () => { /* noop */ });
    });
}

// Pick a fixture where the handler function lives directly in the file
// referenced by `canonical.relativePath` — that way, editing that file
// directly shifts the corresponding `apiIndex` entries to `changed`. The
// ts-express-realworld fixture edits a service file whose handlers live
// in a sibling controller, so file-level digest doesn't catch the cascade.
// py-fastapi and go-gin both have the handler co-located with the route.
const PREFERRED_IDS = ['py-fastapi', 'go-gin', 'js-express'];
const FIXTURE = PRESENT_FIXTURES.find((f) => PREFERRED_IDS.includes(f.id));

if (!FIXTURE) {
    describe.skip('incremental review scenarios — no preferred fixture present (need one of py-fastapi / go-gin / js-express)', () => {
        it('placeholder', () => { /* noop */ });
    });
} else {
    runIncrementalScenario(FIXTURE);
}

function runIncrementalScenario(f: ScenarioFixture): void {
    describe(`incremental review (#606-LIVE / #606-SYNTHETIC) — ${f.id}`, () => {
        let scenario: ScenarioResult;

        beforeAll(async () => {
            scenario = await runScenario({
                repoPath: f.repoPath,
                edits: [
                    {
                        filePath: f.canonical.relativePath,
                        op: { op: 'addLinesToFunction', fnName: f.canonical.fnName, lines: probeLinesFor(f) },
                    },
                ],
            });
        }, 60_000);

        afterAll(() => scenario?.dispose());

        /**
         * Step 1: baseline-state setup. Seed cursors so every apiId in the
         * baseline snapshot has been "reviewed" at the post-`initialize()`
         * content hash. Mirrors what `runExtensionFullReview` does after a
         * successful run, keyed by `apiId` (post-#606-SYNTHETIC).
         */
        it('per-entry cursors cover every apiId in apiIndex (pre-edit state)', () => {
            const apis = Object.values(scenario.baseline.apiIndex ?? {}) as ApiRecord[];
            expect(apis.length).toBeGreaterThan(0);
            const guidelinesHash = 'test-guidelines-v1';

            for (const api of apis) {
                scenario.store.upsertAiReviewEntryCursor({
                    apiId: api.apiId,
                    entryPointId: entryPointKey(api),
                    handlerHash: computeEntryPointHandlerHash(api, scenario.baseline),
                    guidelinesHash,
                    baselineKind: 'snapshot',
                    baselineRef: 'pre-edit',
                    reviewedAt: Date.now(),
                });
            }

            const cursors = scenario.store.getAiReviewEntryCursors();
            // Cursor table now keyed by apiId — every record gets its own
            // row, including synthetic entries that share `method:route`.
            expect(Object.keys(cursors).length).toBe(apis.length);
            for (const api of apis) {
                expect(cursors[api.apiId]).toBeTruthy();
                expect(cursors[api.apiId].entryPointId).toBe(entryPointKey(api));
            }
        });

        /**
         * Step 2: with cursors stamped against the pre-edit snapshot, the
         * post-edit working snapshot's delta must move exactly the
         * ApiRecords in the edited file into `changed` while every other
         * apiId stays `reused`. Post-#606-SYNTHETIC this holds across
         * HTTP and synthetic entries alike.
         */
        it('post-edit delta moves ONLY ApiRecords in the edited file to `changed`', () => {
            const guidelinesHash = 'test-guidelines-v1';
            const cursors = scenario.store.getAiReviewEntryCursors();
            const delta = computeReviewDelta({
                snapshot: scenario.working,
                cursors,
                guidelinesHash,
            });

            const editedPath = f.canonical.relativePath;
            const apisInWorking = Object.values(scenario.working.apiIndex ?? {}) as ApiRecord[];
            const apisInEditedFile = apisInWorking.filter((a) => a.filePath === editedPath);

            // Sanity: the fixture must wire some entry-points to the edited
            // file, otherwise the test asserts nothing.
            expect(apisInEditedFile.length).toBeGreaterThan(0);

            const changedIds = new Set(delta.changed.map((a) => a.apiId));
            const editedIds = new Set(apisInEditedFile.map((a) => a.apiId));

            // Every apiId from the edited file must be in `changed`.
            for (const id of editedIds) {
                expect(changedIds.has(id)).toBe(true);
            }

            // The `changed` set must NOT contain apiIds from any file other
            // than the edited one — apiId-keyed cursors prevent the
            // pre-#606-SYNTHETIC over-review failure mode.
            for (const changedId of changedIds) {
                expect(editedIds.has(changedId)).toBe(true);
            }

            // Everything else falls into `reused`.
            expect(delta.reused.length).toBe(apisInWorking.length - editedIds.size);
            expect(delta.deletedCursors.length).toBe(0);
            expect(delta.deletedFindings.length).toBe(0);
        });

        /**
         * Step 3: re-stamp cursors after the simulated review of the
         * `changed` subset, then re-run the delta. With no further edits,
         * `changed` should now be empty — proving the system reaches a
         * steady state after one incremental pass.
         */
        it('after re-stamping cursors for the changed subset, a subsequent delta is empty', () => {
            const guidelinesHash = 'test-guidelines-v1';
            const apisInEdited = (Object.values(scenario.working.apiIndex ?? {}) as ApiRecord[])
                .filter((a) => a.filePath === f.canonical.relativePath);
            for (const api of apisInEdited) {
                scenario.store.upsertAiReviewEntryCursor({
                    apiId: api.apiId,
                    entryPointId: entryPointKey(api),
                    handlerHash: computeEntryPointHandlerHash(api, scenario.working),
                    guidelinesHash,
                    baselineKind: 'snapshot',
                    baselineRef: 'post-edit',
                    reviewedAt: Date.now(),
                });
            }
            const delta2 = computeReviewDelta({
                snapshot: scenario.working,
                cursors: scenario.store.getAiReviewEntryCursors(),
                guidelinesHash,
            });
            expect(delta2.changed).toEqual([]);
            expect(delta2.deletedCursors).toEqual([]);
        });

        /**
         * Step 4: guidelines drift invalidates every cursor. After step 3
         * reached steady state, changing the guidelines hash should flip
         * every entry back into `changed`. Proves the guidelinesHash signal
         * is wired end-to-end across HTTP + synthetic entries.
         */
        it('guidelines-hash drift flips every cursor back to `changed`', () => {
            const driftedHash = 'test-guidelines-v2';
            const delta3 = computeReviewDelta({
                snapshot: scenario.working,
                cursors: scenario.store.getAiReviewEntryCursors(),
                guidelinesHash: driftedHash,
            });
            const apisInWorking = Object.values(scenario.working.apiIndex ?? {}) as ApiRecord[];
            expect(delta3.changed.length).toBe(apisInWorking.length);
            expect(delta3.reused).toEqual([]);
        });
    });
}
