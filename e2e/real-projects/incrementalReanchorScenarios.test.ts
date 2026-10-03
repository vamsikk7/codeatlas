/**
 * incrementalReanchorScenarios.test.ts — #904 (T3)
 *
 * Comments re-anchor on every incremental `rebuildFile`, not only on a full
 * `resync()`. rebuildFile regenerates the edited file's L4/L5/L3 node ids and
 * spans; before #904 it never called `commentStore.reanchor` + `setComments`,
 * so a comment on a flow/file node silently detached after any save until the
 * next full re-init.
 *
 * This drives a real SnapshotStore + CommentStore + SyncOrchestrator directly
 * (rather than the `runScenario` harness) because the comment must be planted
 * AFTER init but BEFORE the edit — the exact window the harness collapses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncOrchestrator } from '../../src/core/sync/syncOrchestrator';
import { SnapshotStore } from '../../src/core/storage/snapshotStore';
import { CommentStore } from '../../src/core/storage/commentStore';
import { setGrammarsDir, resetTreeSitterForTesting } from '../../src/core/parser/treeSitterParser';

const MOD = `function alpha(x) {
  const a1 = x + 1;
  return a1;
}

function beta(y) {
  const b1 = y * 2;
  const b2 = b1 + 3;
  return b2;
}

module.exports = { alpha, beta };
`;

describe('#904 — comments re-anchor on incremental rebuildFile (not only on resync)', () => {
    const tmpdirs: string[] = [];
    afterEach(() => {
        for (const d of tmpdirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
        tmpdirs.length = 0;
    });

    it('a comment on beta survives an edit to alpha (the function above it) + a save', async () => {
        resetTreeSitterForTesting();
        setGrammarsDir(path.join(process.cwd(), 'grammars'));
        const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reanchor-repo-'));
        const codeatlasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reanchor-ca-'));
        tmpdirs.push(repoDir, codeatlasDir);
        const modPath = path.join(repoDir, 'mod.js');
        fs.writeFileSync(modPath, MOD, 'utf-8');

        const store = new SnapshotStore(codeatlasDir);
        await store.load();
        const commentStore = new CommentStore([]);
        const sync = new SyncOrchestrator(repoDir, store, commentStore);
        await sync.initialize();
        store.save();

        // Plant a comment on a node of beta's flow graph, using that node's anchor.
        const betaFlow = store.getWorking().graphs['flow:mod.js:beta'];
        expect(betaFlow).toBeDefined();
        const anchoredEntry = Object.entries((betaFlow as any).anchors ?? {})
            .find(([, a]: any) => a && a.span && a.filePath);
        expect(anchoredEntry).toBeDefined();
        const [nodeId, anchor] = anchoredEntry as [string, any];
        // Plant the comment ONLY in the in-memory commentStore — NOT in the
        // store. The store gets it only if rebuildFile runs reanchor+setComments
        // (the #904 fix). Without the fix the store never learns about it.
        commentStore.add({ layer: 'flow', targetType: 'node', targetId: nodeId, anchor: { ...anchor }, body: 'review me' });
        expect(store.getComments()).toHaveLength(0); // not persisted yet

        // Edit alpha (the function ABOVE beta): add a line, then save.
        const edited = MOD.replace('  const a1 = x + 1;', '  const a0 = x - 1;\n  const a1 = x + 1;');
        fs.writeFileSync(modPath, edited, 'utf-8');
        await sync.rebuildFile(modPath);
        store.save();

        // #904 — rebuildFile re-anchored + persisted: the store's comments now
        // match the in-memory commentStore. WITHOUT the fix, rebuildFile never
        // called setComments, so the store would still carry ZERO comments here.
        expect(store.getComments()).toEqual(commentStore.toJSON());
        expect(store.getComments()).toHaveLength(1);

        // The comment still RESOLVES: its targetId is a real node in the rebuilt
        // beta flow graph (re-anchor kept it pointed at a live node).
        const rebuiltBeta = store.getWorking().graphs['flow:mod.js:beta'];
        expect(rebuiltBeta).toBeDefined();
        const resolved = commentStore.getAll()[0];
        const nodeIds = new Set((rebuiltBeta as any).nodes.map((n: any) => n.id));
        expect(nodeIds.has(resolved.targetId)).toBe(true);

        sync.dispose?.();
    });
});
