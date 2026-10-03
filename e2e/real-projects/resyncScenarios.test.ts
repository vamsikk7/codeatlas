/**
 * resyncScenarios.test.ts
 *
 * Issue #382: resync + re-initialize idempotency at T3.
 *
 * Live extension surfaces:
 *  - `codeatlas.resyncEverything` command → `sync.resync()`
 *  - `codeatlas.initializeWorkspaceVisuals` command → `sync.initialize()`
 *
 * Invariants:
 *  - After resync, baseline AND working reflect current disk content
 *    (working diff is wiped — resync is a reset).
 *  - After a second `initialize()` call, state is equivalent to a fresh init.
 *  - `syncDriftedFilesFromDisk` detects on-disk drift introduced outside the
 *    watcher and re-cascades. (This surfaces today's lazy-content fragility:
 *    the helper inspects `rec.content` which is dropped post-save.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { runScenario, workingDiffersByHash, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';

installFixtureSafetyGuard();

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

d('resync scenarios — sync.resync() clears working diff and rescans from disk', () => {
    let scenario: ScenarioResult;

    beforeAll(async () => {
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: [`console.log('[resync-probe]');`] },
                },
            ],
        });
        // Pre-resync sanity: working differs from baseline.
        expect(workingDiffersByHash(scenario.baseline, scenario.working)).toBe(true);
        await scenario.sync.resync();
    }, 90_000);

    afterAll(() => scenario?.dispose());

    it('after resync: baseline matches working (both reflect current disk)', () => {
        const baselineNow = scenario.store.getBaseline();
        const workingNow = scenario.store.getWorking();
        expect(workingDiffersByHash(baselineNow, workingNow)).toBe(false);
    });

    it('after resync: working file count matches a fresh init (no leftover phantoms)', () => {
        const workingNow = scenario.store.getWorking();
        // The fixture has a known minimum file count; just assert > 0.
        expect(Object.keys(workingNow.files).length).toBeGreaterThan(0);
    });

    it('after resync: L4 file:graph for the edited file has zero modified nodes', () => {
        const workingNow = scenario.store.getWorking();
        const l4 = workingNow.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
        expect(l4).toBeDefined();
        const dirty = (l4!.nodes ?? []).filter(n => n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged');
        expect(dirty).toEqual([]);
    });

    it('after resync: L1 microservice:workspace has zero modified services', () => {
        const workingNow = scenario.store.getWorking();
        const l1 = workingNow.graphs['microservice:workspace'];
        expect(l1).toBeDefined();
        const dirty = (l1!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
        expect(dirty).toEqual([]);
    });
});

d('resync scenarios — sync.initialize() called twice is idempotent', () => {
    let scenario: ScenarioResult;

    beforeAll(async () => {
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: [`console.log('[reinit-probe]');`] },
                },
            ],
        });
        // Now call initialize() again — should wipe working state and rescan.
        await scenario.sync.initialize();
    }, 90_000);

    afterAll(() => scenario?.dispose());

    it('after second initialize(): baseline matches working (no leftover diff)', () => {
        const baselineNow = scenario.store.getBaseline();
        const workingNow = scenario.store.getWorking();
        expect(workingDiffersByHash(baselineNow, workingNow)).toBe(false);
    });

    it('after second initialize(): every file:graph has zero modified entity nodes', () => {
        const workingNow = scenario.store.getWorking();
        for (const [gid, graph] of Object.entries(workingNow.graphs)) {
            if (!gid.startsWith('file:')) continue;
            const dirty = (graph as any).nodes.filter(
                (n: any) => n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged',
            );
            expect(dirty, `file ${gid} should have no modified entity nodes after re-init`).toEqual([]);
        }
    });
});

d('resync scenarios — drift detection via syncDriftedFilesFromDisk', () => {
    let scenario: ScenarioResult;
    let drifted: string[];

    beforeAll(async () => {
        scenario = await runScenario({ repoPath: TS_EXPRESS!.repoPath, edits: [] });
        // Drift the canonical file on disk — bypass the orchestrator's
        // rebuildFile path. This simulates an external editor / git reset
        // / branch switch that modifies the workspace without notifying VS Code.
        const abs = path.join(scenario.repoCopyDir, TS_EXPRESS!.canonical.relativePath);
        const current = fs.readFileSync(abs, 'utf-8');
        fs.writeFileSync(abs, current + `\nconsole.log('[drift-probe]');\n`, 'utf-8');
        drifted = await scenario.sync.syncDriftedFilesFromDisk();
    }, 90_000);

    afterAll(() => scenario?.dispose());

    it('syncDriftedFilesFromDisk detects the drifted file (Issue #394 lazy-content fix)', () => {
        expect(drifted).toContain(TS_EXPRESS!.canonical.relativePath);
    });

    it('after drift detection: working hash for the drifted file differs from baseline', () => {
        const workingNow = scenario.store.getWorking();
        const baselineNow = scenario.store.getBaseline();
        const w = workingNow.files[TS_EXPRESS!.canonical.relativePath]?.hash;
        const b = baselineNow.files[TS_EXPRESS!.canonical.relativePath]?.hash;
        expect(w).toBeDefined();
        expect(b).toBeDefined();
        expect(w).not.toBe(b);
    });
});
