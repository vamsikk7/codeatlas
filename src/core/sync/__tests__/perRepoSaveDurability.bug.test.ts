/**
 * MULTI-REPO-HANG regression (polar) — a sub-repo file edit must land in
 * the per-repo state.db's `working` snapshot even though the whole-(sub)repo
 * cascade (buildCallGraph / detectServices / Louvain / microservice / health)
 * runs afterwards.
 *
 * Root cause the fix addresses: in multi-repo mode the WorkspaceWatcher routes
 * a `server/...` save to the OWNING per-repo `SyncOrchestrator.handleFileSave`
 * (correct routing). But the only durable persistence of the edited file's
 * working record happened in the caller's `store.save()` that fires AFTER
 * `rebuildFile()` resolves. On a large sub-repo the synchronous whole-repo
 * cascade inside `rebuildFile` is CPU-bound (minutes on polar/server ≈ 1.6k
 * files), so if it stalls the on-disk `working` snapshot keeps the pre-edit
 * hash → the L1 shows "No changes" for a real edit.
 *
 * The fix persists the edited file's working state BEFORE the heavy cascade.
 * This test asserts the persisted (on-disk) working hash reflects the edit
 * after a `handleFileSave` cycle, using a per-repo orchestrator whose
 * `repoRoot !== workspaceRoot` (the multi-repo shape).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from '../../storage/snapshotStore';
import { SyncOrchestrator } from '../syncOrchestrator';
import { CommentStore } from '../../storage/commentStore';

const tmpDirs: string[] = [];

function makeWs(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'perrepo-save-'));
    tmpDirs.push(ws);
    return ws;
}

afterEach(() => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

describe('per-repo save durability on sub-repo edit (multi-repo shape)', () => {
    it('rebuildFile persists the edited sub-repo file hash to disk before the whole-repo cascade', async () => {
        const ws = makeWs();
        // Multi-repo shape: repoRoot is a sub-dir of the workspace root.
        const repoRoot = path.join(ws, 'server');
        const srcDir = path.join(repoRoot, 'polar', 'kit');
        fs.mkdirSync(srcDir, { recursive: true });
        const relKey = 'server/polar/kit/operator.py'; // workspace-relative store key
        const absFile = path.join(ws, relKey);
        const original = 'def add(a, b):\n    return a + b\n';
        fs.writeFileSync(absFile, original);
        // A second file so the repo has a small call graph to cascade over.
        fs.writeFileSync(path.join(srcDir, 'helpers.py'), 'def helper():\n    return 1\n');

        const perRepoStore = new SnapshotStore(repoRoot);
        const orch = new SyncOrchestrator(
            ws,                       // workspaceRoot (whole workspace)
            perRepoStore,
            new CommentStore([]),
            undefined, undefined,
            repoRoot,                 // repoRoot — distinct repo scope (multi-repo)
        );
        orch.setLogger(() => { /* */ });
        await perRepoStore.load();
        await orch.initialize();

        // Baseline: the initial hash of operator.py is recorded.
        const beforeHash = perRepoStore.getWorking().files[relKey]?.hash;
        expect(beforeHash, 'operator.py should be indexed at init').toBeDefined();

        // Edit the sub-repo file on disk (as the file watcher would observe).
        const edited = original + '\ndef subtract(a, b):\n    return a - b\n';
        fs.writeFileSync(absFile, edited);

        // Call rebuildFile DIRECTLY (not via the debounced processPendingEvents
        // path). rebuildFile is the unit that must persist the edit; its caller
        // only saves once AFTER rebuildFile resolves, so a slow/hung whole-repo
        // cascade would otherwise leave the on-disk working snapshot stale. The
        // fix persists the edited file BEFORE the cascade, so reopening the
        // state.db here must show the new hash even though we never call the
        // caller's trailing save().
        await orch.rebuildFile(absFile, undefined);

        // Re-open the per-repo state.db FROM DISK — this is what the L1 reads.
        const reopened = new SnapshotStore(repoRoot);
        await reopened.load();
        const afterHash = reopened.getWorking().files[relKey]?.hash;
        reopened.close();

        expect(afterHash, 'edited operator.py must be present on disk').toBeDefined();
        expect(afterHash, 'on-disk working hash must reflect the edit (not the pre-edit hash)').not.toBe(beforeHash);
    });
});
