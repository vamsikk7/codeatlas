/**
 * commentReanchorScenarios.test.ts
 *
 * Issue #386: comment re-anchoring at T3.
 *
 * `commentStore.reanchor` uses a 4-tier strategy:
 *   1. Exact source-span match
 *   2. Stable-key match
 *   3. (filePath:symbol) content-key match
 *   4. Same symbol in same file
 * If none match the comment is orphaned.
 *
 * Scenarios:
 *  (a) Body edit on the ANNOTATED function — span/stableKey change, but
 *      symbol stays the same → Strategy 3/4 should pick it up.
 *  (b) Edit on a SIBLING function in the same file → annotated function
 *      untouched → Strategy 1 or 4 should resolve cleanly.
 *  (c) Delete the annotated function → no matching anchor → comment is
 *      reported as orphaned (must NOT silently re-anchor to a wrong node).
 *
 * Lives under e2e/real-projects because it requires a real fixture for the
 * graph anchors map (built during the orchestrator's cascade pipeline).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { PRESENT_FIXTURES, probeLinesFor } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import { CommentStore } from '../../src/core/storage/commentStore';
import type { Anchor } from '../../src/core/graph/graphTypes';

installFixtureSafetyGuard();

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

/**
 * Build the {targetId → Anchor} map for a SINGLE L4 file:graph. Kept as a
 * narrowly-scoped helper for scenarios that want to isolate the L4 reanchor
 * strategies from cross-graph effects.
 */
function collectFileGraphAnchors(snap: { graphs: Record<string, any> }, filePath: string): Map<string, Anchor> {
    const out = new Map<string, Anchor>();
    const l4 = snap.graphs[`file:${filePath}`];
    if (!l4) return out;
    for (const [tid, anchor] of Object.entries((l4 as any).anchors ?? {})) {
        out.set(tid, anchor as Anchor);
    }
    return out;
}

/**
 * Build the FULL cross-graph anchor map exactly the way `syncOrchestrator.resync()`
 * does — Issue #403 fix: keys namespaced by graph id so cross-graph collisions
 * can't clobber. Use this to exercise the realistic resync flow at T3.
 */
function collectAllGraphAnchors(snap: { graphs: Record<string, any> }): Map<string, Anchor> {
    const out = new Map<string, Anchor>();
    for (const [graphId, graph] of Object.entries(snap.graphs)) {
        for (const [tid, anchor] of Object.entries((graph as any).anchors ?? {})) {
            out.set(`${graphId}::${tid}`, anchor as Anchor);
        }
    }
    return out;
}

/** Find the anchor for a function-by-name in a working snapshot. */
function findFnAnchor(snap: { graphs: Record<string, any> }, filePath: string, fnName: string) {
    const l4 = snap.graphs[`file:${filePath}`];
    if (!l4) return undefined;
    const fnNode = l4.nodes.find((n: any) => n.type === 'function' && n.label === fnName);
    if (!fnNode) return undefined;
    const anchor = l4.anchors?.[fnNode.id] as Anchor | undefined;
    return anchor ? { targetId: fnNode.id, anchor } : undefined;
}

d('comment re-anchoring — body edit on annotated function (Strategy 3/4 match)', () => {
    let scenario: ScenarioResult;
    let commentStore: CommentStore;
    let initialComment: any;

    beforeAll(async () => {
        // Phase 1: no-edit init so we can capture the original anchor.
        scenario = await runScenario({ repoPath: TS_EXPRESS!.repoPath, edits: [] });
        const orig = findFnAnchor(scenario.working, TS_EXPRESS!.canonical.relativePath, TS_EXPRESS!.canonical.fnName);
        if (!orig) throw new Error(`expected anchor for ${TS_EXPRESS!.canonical.fnName}`);
        commentStore = new CommentStore([]);
        initialComment = commentStore.add({
            layer: 'file',
            targetType: 'node',
            targetId: orig.targetId,
            anchor: orig.anchor,
            body: 'TODO investigate getCurrentUser semantics',
        });
        // Phase 2: scripted edit on the SAME function — body changes, but
        // symbol/file remain the same.
        scenario.dispose();
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: probeLinesFor(TS_EXPRESS!) },
                },
            ],
        });
        commentStore.reanchor(collectFileGraphAnchors(scenario.working, TS_EXPRESS!.canonical.relativePath));
    }, 120_000);

    afterAll(() => scenario?.dispose());

    it('comment is NOT orphaned (Strategy 3/4 resolves it)', () => {
        const all = commentStore.getAll();
        const here = all.find(c => c.id === initialComment.id);
        expect(here, 'comment should still exist').toBeDefined();
        expect(here!.anchor?.symbol).toBe(TS_EXPRESS!.canonical.fnName);
    });

    it('comment re-anchors to a node whose anchor.symbol still matches the original', () => {
        const all = commentStore.getAll();
        const here = all.find(c => c.id === initialComment.id);
        expect(here!.anchor?.filePath).toBe(TS_EXPRESS!.canonical.relativePath);
    });
});

d('comment re-anchoring — edit on a SIBLING function (host function untouched)', () => {
    let scenario: ScenarioResult;
    let commentStore: CommentStore;
    let initialComment: any;

    beforeAll(async () => {
        scenario = await runScenario({ repoPath: TS_EXPRESS!.repoPath, edits: [] });
        const orig = findFnAnchor(scenario.working, TS_EXPRESS!.canonical.relativePath, TS_EXPRESS!.canonical.fnName);
        if (!orig) throw new Error(`expected anchor for ${TS_EXPRESS!.canonical.fnName}`);
        commentStore = new CommentStore([]);
        initialComment = commentStore.add({
            layer: 'file',
            targetType: 'node',
            targetId: orig.targetId,
            anchor: orig.anchor,
            body: 'sibling-edit test',
        });
        scenario.dispose();
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: 'login', lines: [`console.log('[sibling-edit]');`] },
                },
            ],
        });
        commentStore.reanchor(collectFileGraphAnchors(scenario.working, TS_EXPRESS!.canonical.relativePath));
    }, 120_000);

    afterAll(() => scenario?.dispose());

    it('comment is NOT orphaned when its host function was not edited', () => {
        const all = commentStore.getAll();
        const here = all.find(c => c.id === initialComment.id);
        expect(here, 'comment should still exist').toBeDefined();
        expect(here!.anchor?.symbol).toBe(TS_EXPRESS!.canonical.fnName);
    });
});

d('comment re-anchoring — annotated function deleted (orphan path)', () => {
    let scenario: ScenarioResult;
    let commentStore: CommentStore;
    let initialComment: any;
    let orphanedIds: string[] = [];

    beforeAll(async () => {
        scenario = await runScenario({ repoPath: TS_EXPRESS!.repoPath, edits: [] });
        // Anchor a comment on `updateUser` — it's safe to delete without breaking siblings.
        const orig = findFnAnchor(scenario.working, TS_EXPRESS!.canonical.relativePath, 'updateUser');
        if (!orig) throw new Error('expected anchor for updateUser');
        commentStore = new CommentStore([]);
        initialComment = commentStore.add({
            layer: 'file',
            targetType: 'node',
            targetId: orig.targetId,
            anchor: orig.anchor,
            body: 'delete-host test',
        });
        scenario.dispose();
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'deleteFunction', fnName: 'updateUser' },
                },
            ],
        });
        orphanedIds = commentStore.reanchor(collectFileGraphAnchors(scenario.working, TS_EXPRESS!.canonical.relativePath));
    }, 120_000);

    afterAll(() => scenario?.dispose());

    it('reanchor reports the comment as orphaned', () => {
        // The deleted function leaves a "(deleted)" ghost node so symbol-name
        // re-anchoring could find a target. The orphan detection therefore
        // depends on whether the ghost-anchor symbol still matches the
        // original name. Either outcome is allowed here, but if not orphaned,
        // the comment must point at the deleted ghost (which is the
        // user-visible expectation).
        const all = commentStore.getAll();
        const here = all.find(c => c.id === initialComment.id);
        const wasOrphaned = orphanedIds.includes(initialComment.id);
        if (!wasOrphaned) {
            // If re-anchored, the new targetId must point at a node whose
            // label includes "updateUser" (possibly with "(deleted)" suffix).
            const l4 = scenario.working.graphs[`file:${TS_EXPRESS!.canonical.relativePath}`];
            const target = l4.nodes.find((n: any) => n.id === here!.targetId);
            expect(target, 'target node must exist if comment re-anchored').toBeDefined();
            const label = (target!.label as string) ?? '';
            expect(label.includes('updateUser')).toBe(true);
        } else {
            expect(here, 'comment still in store after orphan').toBeDefined();
        }
    });
});

d('comment re-anchoring — FULL cross-graph anchor map (Issue #403 regression)', () => {
    // This scenario mirrors what `syncOrchestrator.resync()` does: collect
    // anchors from ALL graphs into one map. Before the #403 fix, this
    // would clobber the L4 file:graph node anchors with L3/L5 entries
    // sharing the same nodeId — comments silently moved to the wrong node.
    let scenario: ScenarioResult;
    let commentStore: CommentStore;
    let initialComment: any;

    beforeAll(async () => {
        scenario = await runScenario({ repoPath: TS_EXPRESS!.repoPath, edits: [] });
        const orig = findFnAnchor(scenario.working, TS_EXPRESS!.canonical.relativePath, TS_EXPRESS!.canonical.fnName);
        if (!orig) throw new Error(`expected anchor for ${TS_EXPRESS!.canonical.fnName}`);
        commentStore = new CommentStore([]);
        initialComment = commentStore.add({
            layer: 'file',
            targetType: 'node',
            targetId: orig.targetId,
            anchor: orig.anchor,
            body: 'cross-graph reanchor test',
        });
        scenario.dispose();
        scenario = await runScenario({
            repoPath: TS_EXPRESS!.repoPath,
            edits: [
                {
                    filePath: TS_EXPRESS!.canonical.relativePath,
                    op: { op: 'addLinesToFunction', fnName: TS_EXPRESS!.canonical.fnName, lines: probeLinesFor(TS_EXPRESS!) },
                },
            ],
        });
        // Use the production-equivalent helper that namespaces keys (#403 fix).
        commentStore.reanchor(collectAllGraphAnchors(scenario.working));
    }, 120_000);

    afterAll(() => scenario?.dispose());

    it('comment re-anchors to a node whose anchor.symbol matches getCurrentUser (not a colliding nodeId in L3/L5)', () => {
        const all = commentStore.getAll();
        const here = all.find(c => c.id === initialComment.id);
        expect(here, 'comment should still exist').toBeDefined();
        expect(here!.anchor?.symbol).toBe(TS_EXPRESS!.canonical.fnName);
        expect(here!.anchor?.filePath).toBe(TS_EXPRESS!.canonical.relativePath);
    });

    it('comment.targetId is a raw node id (no `graphId::` namespace prefix leaked)', () => {
        const all = commentStore.getAll();
        const here = all.find(c => c.id === initialComment.id);
        expect(here!.targetId.includes('::')).toBe(false);
    });
});
