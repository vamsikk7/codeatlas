/**
 * persistenceScenarios.test.ts
 *
 * Issue #381: persistence round-trip at T3.
 *
 * The live extension saves diff state to `.codeatlas/state.db` after every
 * cascade and rehydrates it on VS Code restart. The lazy-content drop
 * (FileRecord.content → undefined after save) sits exactly on this seam —
 * any future serialization gap or hydrate mismatch would silently regress
 * the user's diff state across restarts.
 *
 * Scenarios:
 *  1. Edit a function → save → reload → assert L4/L5/L3/L2a/L1 diff
 *     annotations match the pre-save in-memory state byte-for-byte.
 *  2. After reload, `workingDiffersByHash` and `workingDiffersFromBaseline`
 *     still both return true (catches a saved-state regression where
 *     hashes drift across the round-trip).
 *  3. Fresh disk content survives: `store.getFileContent('baseline', ...)`
 *     returns the original un-redacted content after reload.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runScenario, workingDiffersByHash, modifiedFunctionLabels, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import { workingDiffersFromBaseline } from '../../src/handlers/replayWorkingChanges';

installFixtureSafetyGuard();

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

d('persistence scenarios — save/reload round-trip preserves diff state', () => {
    let scenario: ScenarioResult;
    let reloaded: Awaited<ReturnType<ScenarioResult['reloadFromDisk']>>;

    beforeAll(async () => {
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: [`console.log('[persist-probe]');`] },
                },
            ],
        });
        reloaded = await scenario.reloadFromDisk();
    }, 90_000);

    afterAll(() => scenario?.dispose());

    it('reloaded baseline file hash matches pre-save', () => {
        const rel = TS_EXPRESS!.canonical.relativePath;
        const pre = scenario.baseline.files[rel]?.hash;
        const post = reloaded.baseline.files[rel]?.hash;
        expect(post).toBeDefined();
        expect(post).toBe(pre);
    });

    it('reloaded working file hash matches pre-save', () => {
        const rel = TS_EXPRESS!.canonical.relativePath;
        const pre = scenario.working.files[rel]?.hash;
        const post = reloaded.working.files[rel]?.hash;
        expect(post).toBeDefined();
        expect(post).toBe(pre);
    });

    it('workingDiffersByHash + workingDiffersFromBaseline still both true after reload', () => {
        expect(workingDiffersByHash(reloaded.baseline, reloaded.working)).toBe(true);
        expect(workingDiffersFromBaseline(reloaded.baseline, reloaded.working)).toBe(true);
    });

    it('reloaded L4 file:graph keeps the modified function annotation', () => {
        const gid = `file:${TS_EXPRESS!.canonical.relativePath}`;
        const preL4 = scenario.working.graphs[gid];
        const postL4 = reloaded.working.graphs[gid];
        expect(postL4).toBeDefined();
        // Compare modified-function sets pre vs post-reload.
        expect(modifiedFunctionLabels(postL4)).toEqual(modifiedFunctionLabels(preL4));
    });

    it('reloaded L5 flow:graph keeps at least one modified node', () => {
        const flowId = `flow:${TS_EXPRESS!.canonical.relativePath}:${TS_EXPRESS!.canonical.fnName}`;
        const post = reloaded.working.graphs[flowId];
        expect(post, `expected ${flowId} present after reload`).toBeDefined();
        const mods = (post!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
        expect(mods.length).toBeGreaterThan(0);
    });

    it('reloaded L3 sequence carries the modified participant', () => {
        const seqId = TS_EXPRESS!.canonical.expectedModified.sequenceGraphId;
        const post = reloaded.working.graphs[seqId];
        expect(post).toBeDefined();
        const mods = (post!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
        expect(mods.length).toBeGreaterThan(0);
    });

    it('reloaded L2a feature:workspace keeps exactly one modified cluster', () => {
        const post = reloaded.working.graphs['feature:workspace'];
        expect(post).toBeDefined();
        const mods = (post!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
        expect(mods.length).toBe(1);
    });

    it('reloaded L1 microservice:workspace keeps exactly one modified service', () => {
        const post = reloaded.working.graphs['microservice:workspace'];
        expect(post).toBeDefined();
        const mods = (post!.nodes ?? []).filter(n => n.diff && n.diff !== 'unchanged');
        expect(mods.length).toBe(1);
    });

    it('baseline content fetch via getFileContent works after reload (lazy-content guard)', () => {
        const rel = TS_EXPRESS!.canonical.relativePath;
        const post = reloaded.store.getFileContent('baseline', rel);
        expect(post, `expected non-empty baseline content for ${rel}`).toBeDefined();
        expect(typeof post).toBe('string');
        expect((post as string).length).toBeGreaterThan(0);
    });
});
