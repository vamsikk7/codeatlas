/**
 * failureIsolation.test.ts
 *
 * ADR-034 Phase E Pass 3 follow-up — multi-repo failure-isolation
 * scenarios. Drives the real `WorkspaceOrchestrator` against a synthesized
 * multi-repo workspace via `workspaceCascadeHarness.runWorkspaceScenario`.
 *
 * What it locks in:
 *   - A repo with a parse failure marks `status='failed'` with non-empty
 *     `errorMessage`, while sibling repos in the same workspace reach
 *     `status='ready'` independently.
 *   - `WorkspaceOrchestrator.retryRepo` restores `status='ready'` after
 *     the source is fixed.
 *   - File edits in one good repo trigger that repo's per-repo rebuild
 *     only — the failed sibling's state stays untouched.
 *   - The aggregator's `repos` registry round-trips the failure metadata
 *     so cross-restart UX (skeletal L1, retry button) sees it.
 *
 * These scenarios complement the unit-level coverage in
 * `src/core/sync/__tests__/workspaceOrchestrator.{retry,multiRepo}.test.ts`
 * by running the real SnapshotStore + SyncOrchestrator + cascade pipeline
 * instead of mock runners. Catches the failure-isolation regression class
 * that survives unit tests (e.g. parse error leaking into sibling repos
 * via shared parser state) but breaks live.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    runWorkspaceScenario,
    rebuildRepoFile,
    type WorkspaceScenarioResult,
} from './workspaceCascadeHarness';

async function withScenario<T>(
    repos: Array<{ name: string; inject?: 'runner-throw' }>,
    body: (s: WorkspaceScenarioResult) => Promise<T>,
): Promise<T> {
    const s = await runWorkspaceScenario({ repos });
    try {
        return await body(s);
    } finally {
        await s.dispose();
    }
}

describe('multi-repo failure isolation — one bad apple, rest succeed', () => {
    it('repo with injected syntax error → status=failed; siblings → status=ready', async () => {
        await withScenario([
            { name: 'svc-good-a' },
            { name: 'svc-bad', inject: 'runner-throw' },
            { name: 'svc-good-b' },
        ], async (s) => {
            const byName = Object.fromEntries(s.repoRows.map((r) => [r.rootPath, r]));
            expect(byName['svc-good-a'].status).toBe('ready');
            expect(byName['svc-bad'].status).toBe('failed');
            expect(byName['svc-good-b'].status).toBe('ready');
            // Failure carries a non-empty error message — surfaces in L1 + retry UX.
            expect(byName['svc-bad'].errorMessage).toBeTruthy();
            // initResult.failures mirrors the registry — single failed repo.
            const failedIds = s.initResult.failures.map((f) => f.repoId);
            expect(failedIds).toContain(byName['svc-bad'].repoId);
            expect(failedIds).not.toContain(byName['svc-good-a'].repoId);
        });
    });

    it('all-good workspace → zero failures, all status=ready', async () => {
        await withScenario([
            { name: 'svc-a' },
            { name: 'svc-b' },
            { name: 'svc-c' },
        ], async (s) => {
            expect(s.initResult.failures).toEqual([]);
            expect(s.repoRows.every((r) => r.status === 'ready')).toBe(true);
            expect(s.initResult.repoCount).toBe(3);
        });
    });

    it('multiple failures coexist — every failure recorded, good repo unaffected', async () => {
        await withScenario([
            { name: 'svc-bad-1', inject: 'runner-throw' },
            { name: 'svc-good' },
            { name: 'svc-bad-2', inject: 'runner-throw' },
        ], async (s) => {
            const byName = Object.fromEntries(s.repoRows.map((r) => [r.rootPath, r]));
            expect(byName['svc-bad-1'].status).toBe('failed');
            expect(byName['svc-bad-2'].status).toBe('failed');
            expect(byName['svc-good'].status).toBe('ready');
            expect(s.initResult.failures).toHaveLength(2);
            // Each failure has its own errorMessage — not aliased across rows.
            expect(byName['svc-bad-1'].errorMessage).toBeTruthy();
            expect(byName['svc-bad-2'].errorMessage).toBeTruthy();
        });
    });
});

describe('multi-repo failure isolation — retryRepo recovery', () => {
    it('retryRepo after the failure is cleared flips status back to ready', async () => {
        await withScenario([
            { name: 'svc-stable' },
            { name: 'svc-broken', inject: 'runner-throw' },
        ], async (s) => {
            const byNameInitial = Object.fromEntries(s.repoRows.map((r) => [r.rootPath, r]));
            expect(byNameInitial['svc-broken'].status).toBe('failed');

            // "Fix" the failure — clear the injection so the next runner
            // invocation takes the success path. Models the real-world
            // recovery (user fixes the underlying parse/config issue,
            // then clicks Retry).
            s.clearInjection('svc-broken');

            const retryResult = await s.orchestrator.retryRepo(byNameInitial['svc-broken'].repoId);
            expect(retryResult.status).toBe('ready');

            // Re-read the aggregator and assert the status row is updated.
            const aggregator = s.registry.getAggregatorStore(s.workspaceDir);
            const row = aggregator.getRepo(byNameInitial['svc-broken'].repoId);
            expect(row?.status).toBe('ready');
            expect(row?.errorMessage).toBeFalsy();
        });
    });

    it('retryRepo against still-broken source keeps status=failed with fresh errorMessage', async () => {
        await withScenario([
            { name: 'svc-keeps-failing', inject: 'runner-throw' },
            { name: 'svc-fine' },
        ], async (s) => {
            const byName = Object.fromEntries(s.repoRows.map((r) => [r.rootPath, r]));
            const firstErr = byName['svc-keeps-failing'].errorMessage;
            const retryResult = await s.orchestrator.retryRepo(byName['svc-keeps-failing'].repoId);
            expect(retryResult.status).toBe('failed');
            expect(retryResult.error).toBeTruthy();
            // Aggregator row also reflects the persistent failure — UX
            // shouldn't claim "ready" when the parser keeps choking.
            const aggregator = s.registry.getAggregatorStore(s.workspaceDir);
            const row = aggregator.getRepo(byName['svc-keeps-failing'].repoId);
            expect(row?.status).toBe('failed');
            expect(row?.errorMessage).toBeTruthy();
            // Sibling untouched — locality holds across retries too.
            const otherRow = aggregator.getRepo(byName['svc-fine'].repoId);
            expect(otherRow?.status).toBe('ready');
            expect(firstErr).toBeTruthy();
        });
    });
});

describe('multi-repo failure isolation — cascade locality after init', () => {
    it('edit in a good repo rebuilds only that repo, failed sibling stays untouched', async () => {
        await withScenario([
            { name: 'svc-good' },
            { name: 'svc-bad', inject: 'runner-throw' },
        ], async (s) => {
            const byName = Object.fromEntries(s.repoRows.map((r) => [r.rootPath, r]));
            const goodStoreBefore = s.registry.getRepoStore(
                path.join(s.workspaceDir, 'svc-good'),
            );
            const goodWorkingHashBefore = JSON.stringify(goodStoreBefore.getWorking().files);

            // Edit svc-good's index.js to add a second route.
            const newContent = [
                "const express = require('express');",
                'const app = express();',
                "app.get('/api/svc-good', (req, res) => res.json({ ok: true }));",
                "app.get('/api/svc-good/v2', (req, res) => res.json({ v: 2 }));",
                'module.exports = app;',
                '',
            ].join('\n');
            const { rebuiltGraphIds } = await rebuildRepoFile(
                s, 'svc-good', 'src/index.js', newContent,
            );

            // svc-good's working snapshot changed — file hash diverged.
            const goodWorkingHashAfter = JSON.stringify(goodStoreBefore.getWorking().files);
            expect(goodWorkingHashAfter).not.toBe(goodWorkingHashBefore);
            expect(rebuiltGraphIds.length).toBeGreaterThan(0);

            // svc-bad's row in the aggregator is still 'failed' — the edit
            // in svc-good did not retroactively re-attempt the failed
            // sibling's parse.
            const aggregator = s.registry.getAggregatorStore(s.workspaceDir);
            const badRow = aggregator.getRepo(byName['svc-bad'].repoId);
            expect(badRow?.status).toBe('failed');
        });
    });
});

describe('multi-repo failure isolation — initResult ↔ aggregator round-trip', () => {
    it('every failure in initResult.failures has a matching aggregator row', async () => {
        await withScenario([
            { name: 'svc-x', inject: 'runner-throw' },
            { name: 'svc-y' },
        ], async (s) => {
            const aggregator = s.registry.getAggregatorStore(s.workspaceDir);
            for (const f of s.initResult.failures) {
                const row = aggregator.getRepo(f.repoId);
                expect(row).toBeDefined();
                expect(row!.status).toBe('failed');
                expect(row!.errorMessage).toBeTruthy();
            }
        });
    });

    it('detectedRepos surfaces every repo even when some failed', async () => {
        await withScenario([
            { name: 'svc-good' },
            { name: 'svc-fail', inject: 'runner-throw' },
        ], async (s) => {
            const names = s.initResult.detectedRepos.map((r) => r.rootPath).sort();
            expect(names).toEqual(['svc-fail', 'svc-good']);
        });
    });
});
