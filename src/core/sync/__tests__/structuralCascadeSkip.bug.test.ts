/**
 * MULTI-REPO-HANG perf fix (polar) — the whole-(sub)repo cascade inside
 * `rebuildFile` (buildCallGraph / detectServices / Louvain detectCommunities /
 * microservice / domain / health) is CPU-bound and runs on EVERY save. On a
 * large sub-repo (polar/server ≈ 1.6k Python files) that is a ~2-minute
 * CPU-pegged hang per keystroke-burst.
 *
 * Fix: when the edited file's STRUCTURAL SURFACE is unchanged (its API records,
 * its top-level fn/class set, and its import specifiers), SKIP the heavy
 * whole-repo detection and only do the per-file L3/L4/L5 rebuild + light diff
 * propagation. Re-run the heavy detection ONLY when the structural surface
 * actually changed (a new endpoint / service class / import edge).
 *
 * These tests use a per-repo orchestrator whose `repoRoot !== workspaceRoot`
 * (the multi-repo shape) and assert:
 *  (a) a PRIVATE-helper body edit → heavy cascade SKIPPED, but the file's
 *      working record still updates + the file graph still rebuilds.
 *  (b) a NEW API route → heavy cascade RUNS.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from '../../storage/snapshotStore';
import { SyncOrchestrator, computeStructuralKey } from '../syncOrchestrator';
import { CommentStore } from '../../storage/commentStore';

const tmpDirs: string[] = [];

function makeWs(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-skip-'));
    tmpDirs.push(ws);
    return ws;
}

afterEach(() => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

describe('computeStructuralKey', () => {
    it('is stable across a pure body edit and changes when the surface changes', () => {
        const symbolsA = {
            functions: [
                { name: 'add', kind: 'function', span: { start: 0, end: 1 }, signature: 'function add', bodyText: 'return a+b', stableKey: 'k1' },
            ],
            variables: [],
            imports: [{ source: './x', specifiers: [{ local: 'x', imported: 'x' }], span: { start: 0, end: 0 }, stableKey: 'i1' } as any],
        } as any;
        // Body changed only — surface identical.
        const symbolsBodyEdit = {
            functions: [
                { name: 'add', kind: 'function', span: { start: 0, end: 9 }, signature: 'function add', bodyText: 'return a+b+1', stableKey: 'k1' },
            ],
            variables: [],
            imports: [{ source: './x', specifiers: [{ local: 'x', imported: 'x' }], span: { start: 0, end: 0 }, stableKey: 'i1' } as any],
        } as any;
        const apis: any[] = [];

        const keyA = computeStructuralKey('f.ts', symbolsA, apis);
        const keyBody = computeStructuralKey('f.ts', symbolsBodyEdit, apis);
        expect(keyBody).toBe(keyA);

        // Add a new top-level function → surface changes.
        const symbolsNewFn = {
            ...symbolsA,
            functions: [...symbolsA.functions, { name: 'sub', kind: 'function', span: { start: 0, end: 1 }, signature: 'function sub', bodyText: '', stableKey: 'k2' }],
        };
        expect(computeStructuralKey('f.ts', symbolsNewFn, apis)).not.toBe(keyA);

        // Add an API → surface changes.
        const apiKey = computeStructuralKey('f.ts', symbolsA, [{ apiId: 'a1', method: 'GET', route: '/x', handlerName: 'add', filePath: 'f.ts' } as any]);
        expect(apiKey).not.toBe(keyA);

        // Change an import → surface changes.
        const symbolsNewImport = {
            ...symbolsA,
            imports: [{ source: './y', specifiers: [{ local: 'y', imported: 'y' }], span: { start: 0, end: 0 }, stableKey: 'i2' } as any],
        };
        expect(computeStructuralKey('f.ts', symbolsNewImport, apis)).not.toBe(keyA);
    });
});

describe('structural-surface cascade skip (multi-repo shape)', () => {
    async function makePerRepoOrch() {
        const ws = makeWs();
        const repoRoot = path.join(ws, 'server');
        const srcDir = path.join(repoRoot, 'kit');
        fs.mkdirSync(srcDir, { recursive: true });
        // An Express-style API file so the repo has a real API + service surface.
        const apiRel = 'server/kit/routes.js';
        const apiAbs = path.join(ws, apiRel);
        fs.writeFileSync(apiAbs,
            "const express = require('express');\n" +
            "const router = express.Router();\n" +
            "router.get('/users', function listUsers(req, res) { res.json([]); });\n" +
            "module.exports = router;\n");
        // A plain util file with a private helper — no APIs.
        const utilRel = 'server/kit/util.js';
        const utilAbs = path.join(ws, utilRel);
        const utilOriginal = "function format(x) {\n  return String(x);\n}\nmodule.exports = { format };\n";
        // (see the edit in test (a): we add a NESTED private helper inside
        //  format() — a body-only change that does not alter the file's
        //  top-level symbol / API / import surface.)
        fs.writeFileSync(utilAbs, utilOriginal);

        const perRepoStore = new SnapshotStore(repoRoot);
        const orch = new SyncOrchestrator(
            ws, perRepoStore, new CommentStore([]),
            undefined, undefined,
            repoRoot,
        );
        orch.setLogger(() => { /* */ });
        await perRepoStore.load();
        await orch.initialize();
        return { ws, orch, perRepoStore, apiRel, apiAbs, utilRel, utilAbs, utilOriginal };
    }

    it('(a) adding a PRIVATE helper skips the heavy cascade but still rebuilds the file graph + working record', async () => {
        const { orch, perRepoStore, utilRel, utilAbs, utilOriginal } = await makePerRepoOrch();

        const beforeHash = perRepoStore.getWorking().files[utilRel]?.hash;
        expect(beforeHash, 'util.js indexed at init').toBeDefined();

        // Add a NEW PRIVATE (nested) helper inside the existing top-level
        // function. This is a body-only change: no new top-level symbol, no
        // new API, no new import → the structural surface is unchanged.
        const edited = utilOriginal.replace(
            '  return String(x);',
            '  function probe(y) { return y + 1; }\n  return String(probe(x));');
        fs.writeFileSync(utilAbs, edited);

        const result = await orch.rebuildFile(utilAbs, undefined);

        // The heavy detection must have been SKIPPED.
        expect(result.skippedHeavyCascade, 'private-helper edit should skip heavy cascade').toBe(true);

        // ...but the file's working record still updated (new hash).
        const afterHash = perRepoStore.getWorking().files[utilRel]?.hash;
        expect(afterHash).toBeDefined();
        expect(afterHash).not.toBe(beforeHash);

        // ...and the file graph was rebuilt (present in updatedGraphIds).
        const fileGraphId = `file:${utilRel}`;
        expect(result.graphIds).toContain(fileGraphId);
    });

    it('(b) adding a NEW API route runs the heavy cascade', async () => {
        const { orch, perRepoStore, apiRel, apiAbs } = await makePerRepoOrch();

        const src = perRepoStore.getFileContent('working', apiRel)
            ?? fs.readFileSync(apiAbs, 'utf-8');
        // Add a brand-new route → the file's API surface changes.
        const edited = src.replace(
            'module.exports = router;',
            "router.post('/users', function createUser(req, res) { res.status(201).json({}); });\nmodule.exports = router;");
        fs.writeFileSync(apiAbs, edited);

        const result = await orch.rebuildFile(apiAbs, undefined);

        expect(result.skippedHeavyCascade, 'new API route must run heavy cascade').toBe(false);
    });
});
