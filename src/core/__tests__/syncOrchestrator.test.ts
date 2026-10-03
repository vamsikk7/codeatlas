import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncOrchestrator } from '../sync/syncOrchestrator';
import { SnapshotStore } from '../storage/snapshotStore';
import { CommentStore } from '../storage/commentStore';
import { buildMicroserviceGraph } from '../graph/microserviceGraphBuilder';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SyncOrchestrator', () => {
    let workspace: string;
    let store: SnapshotStore;
    let commentStore: CommentStore;
    let sync: SyncOrchestrator;
    let refreshedGraphs: string[] = [];

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-orch-test-'));
        const codeatlasPath = path.join(workspace, '.codeatlas');

        fs.mkdirSync(path.join(workspace, 'src/math'), { recursive: true });
        
        fs.writeFileSync(path.join(workspace, 'src/math/operations.js'), `
            function add(a, b) {
                return a + b;
            }
            function subtract(a, b) {
                return a - b;
            }
            module.exports = { add, subtract };
        `);

        fs.writeFileSync(path.join(workspace, 'src/math/calculator.js'), `
            const { add } = require('./operations');
            function calculate(operation, a, b) {
                if (operation === 'add') return add(a, b);
                return 0;
            }
            module.exports = { calculate };
        `);

        store = new SnapshotStore(codeatlasPath);
        commentStore = new CommentStore([]);
        sync = new SyncOrchestrator(workspace, store, commentStore);
        sync.setLogger(console.log);
        
        refreshedGraphs = [];
        sync.onRefresh((graphs) => {
            refreshedGraphs.push(...graphs);
        });
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        refreshedGraphs = [];
    });

    it('should initialize the workspace correctly', async () => {
        const stats = await sync.initialize();
        
        expect(stats.fileCount).toBe(2);
        
        const working = store.getWorking();
        
        // Assert files are present
        expect(working.files['src/math/operations.js']).toBeDefined();
        expect(working.files['src/math/calculator.js']).toBeDefined();
        
        // Assert flow graphs for functions are created
        const orchFlowGraph = working.graphs['flow:src/math/operations.js:add'];
        expect(orchFlowGraph).toBeDefined();
        
        const calcFlowGraph = working.graphs['flow:src/math/calculator.js:calculate'];
        expect(calcFlowGraph).toBeDefined();

        // Baseline should also match
        const baseline = store.getBaseline();
        expect(baseline.files['src/math/operations.js']).toBeDefined();
    });

    it('should handle file creation correctly', async () => {
        await sync.initialize();
        
        fs.writeFileSync(path.join(workspace, 'src/math/multiply.js'), `
            function multiply(a, b) {
                return a * b;
            }
            module.exports = { multiply };
        `);
        
        sync.handleFileCreated(path.join(workspace, 'src/math/multiply.js'));
        
        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 800));
        
        const working = store.getWorking();
        expect(working.files['src/math/multiply.js']).toBeDefined();
        console.log("File Creation keys:", Object.keys(working.graphs));
        expect(working.graphs['file:src/math/multiply.js']).toBeDefined();
        expect(working.graphs['flow:src/math/multiply.js:multiply']).toBeDefined();
        
        expect(refreshedGraphs).toContain('file:src/math/multiply.js');
        expect(refreshedGraphs).toContain('flow:src/math/multiply.js:multiply');
    });

    it('should handle file modification correctly', async () => {
        await sync.initialize();
        
        // Let's modify operations.js to delete "subtract" and change "add"
        const modifiedOperations = `
            function add(a, b) {
                return a + b + Number.EPSILON;
            }
            module.exports = { add };
        `;
        
        fs.writeFileSync(path.join(workspace, 'src/math/operations.js'), modifiedOperations);
        sync.handleFileSave(path.join(workspace, 'src/math/operations.js'));
        
        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 800));
        
        const working = store.getWorking();
        console.log("Modification keys:", Object.keys(working.graphs));
        
        // "subtract" is removed, it should become a ghost node (diff:'deleted')
        const subtractGraph = working.graphs['flow:src/math/operations.js:subtract'];
        expect(subtractGraph).toBeDefined();
        expect(subtractGraph.nodes[0]?.diff).toBe('deleted');
        
        // "add" is changed, its body was modified
        const addGraph = working.graphs['flow:src/math/operations.js:add'];
        expect(addGraph).toBeDefined();
        
        // It should have rebuilt add
        expect(refreshedGraphs).toContain('flow:src/math/operations.js:add');
    });

    it('should handle file deletion correctly by making graphs ghosts', async () => {
        await sync.initialize();
        
        fs.unlinkSync(path.join(workspace, 'src/math/calculator.js'));
        sync.handleFileDeleted(path.join(workspace, 'src/math/calculator.js'));
        
        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 800));
        
        const working = store.getWorking();
        
        // The file record itself is removed
        expect(working.files['src/math/calculator.js']).toBeUndefined();
        
        console.log("Deletion keys:", Object.keys(working.graphs));
        // But its graphs should become ghost graphs
        const calcFileGraph = working.graphs['file:src/math/calculator.js'];
        expect(calcFileGraph).toBeDefined();
        expect(calcFileGraph.nodes[0]?.diff).toBe('deleted');
        
        const flowGraph = working.graphs['flow:src/math/calculator.js:calculate'];
        expect(flowGraph).toBeDefined();
        expect(flowGraph.nodes[0]?.diff).toBe('deleted');
        
        expect(refreshedGraphs).toContain('file:src/math/calculator.js');
        expect(refreshedGraphs).toContain('flow:src/math/calculator.js:calculate');
    });

    it('should process a file rename as a delete and create', async () => {
        await sync.initialize();
        
        // Rename calculator.js to calc.js
        fs.renameSync(
            path.join(workspace, 'src/math/calculator.js'), 
            path.join(workspace, 'src/math/calc.js')
        );
        
        sync.handleFileRenamed(
            path.join(workspace, 'src/math/calculator.js'),
            path.join(workspace, 'src/math/calc.js')
        );
        
        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 800));
        
        const working = store.getWorking();
        
        // Old file record removed, ghost graph left
        expect(working.files['src/math/calculator.js']).toBeUndefined();
        const oldFileGraph = working.graphs['file:src/math/calculator.js'];
        expect(oldFileGraph).toBeDefined();
        expect(oldFileGraph.nodes.every(n => n.diff === 'deleted')).toBe(true);
        
        // New file record added, normal graph created
        expect(working.files['src/math/calc.js']).toBeDefined();
        const newFileGraph = working.graphs['file:src/math/calc.js'];
        expect(newFileGraph).toBeDefined();
    });

    it('should propagate cross-file flow graph updates', async () => {
        // If operations.add changes, calculator.calculate (which imports 'add' from operations)
        // should have its flow graph rebuilt to reflect potential call graph changes.
        await sync.initialize();
        
        // Modify operations.js to change add's implementation and call another function
        const modifiedOperations = `
            function helper() { return 1; }
            function add(a, b) {
                return a + b + helper();
            }
            function subtract(a, b) {
                return a - b;
            }
            module.exports = { add, subtract, helper };
        `;
        fs.writeFileSync(path.join(workspace, 'src/math/operations.js'), modifiedOperations);
        sync.handleFileSave(path.join(workspace, 'src/math/operations.js'));
        
        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 800));
        
        // The cross-file update modifies the original file's graphs
        console.log("Refreshed Graphs:", refreshedGraphs);
        expect(refreshedGraphs).toContain('flow:src/math/operations.js:add');
    });

    it('L1 microservice graph keeps DB infra after post-init save (lazy-content regression #361)', async () => {
        // End-to-end repro of the user's bug:
        //   - Express + Prisma project, no docker-compose.yml.
        //   - initialize() builds the snapshot, calls save() which drops
        //     FileRecord.content from RAM (#354 — Body-finder gap closure for kotlin-ktor / rust-actix / rust-axum / rust-rocket).
        //   - Auto-init / browser navigation then calls
        //     buildMicroserviceGraph() against the post-save snapshot.
        //   - With #361's fix that call must still detect the Prisma DB.
        const prismaDir = path.join(workspace, 'src/prisma');
        fs.mkdirSync(prismaDir, { recursive: true });
        fs.writeFileSync(path.join(prismaDir, 'prisma-client.ts'), `
            import { PrismaClient } from '@prisma/client';
            const prisma = new PrismaClient();
            export default prisma;
        `);
        // load() opens the SQLite DB so save() actually persists + drops
        // content. Without it the store is uninitialized and save() is a
        // silent no-op — the regression then can't reproduce.
        await store.load();
        await sync.initialize();

        // POST-SAVE STATE: orchestrator.initialize() ends with store.save()
        // which calls forgetContentInMemory(). Confirm content is dropped
        // — otherwise this test isn't exercising the regression path.
        const working = store.getWorking();
        const prismaRecord = working.files['src/prisma/prisma-client.ts'] as any;
        expect(prismaRecord).toBeDefined();
        expect(prismaRecord.content).toBeUndefined();

        // Now build L1 the way buildMicroserviceGraphCached does: with
        // DB-backed lazy content fetchers. Without the providers, the
        // bug reproduces (no infra). With them, Prisma must surface.
        const baseline = store.getBaseline();
        const getWorking = (fp: string) => store.getFileContent('working', fp);
        const getBaseline = (fp: string) => store.getFileContent('baseline', fp);

        const l1WithProvider = buildMicroserviceGraph(workspace, working, baseline, getWorking, getBaseline);
        // Infra nodes are emitted as type:'service' with meta.infra:true.
        const infraNodes = l1WithProvider.nodes.filter((n: any) => n.meta?.infra === true);
        const prismaInfra = infraNodes.find((n: any) =>
            (n.label as string).toLowerCase().includes('prisma') ||
            (n.label as string).toLowerCase().includes('sql'),
        );
        expect(prismaInfra).toBeDefined();
        expect((prismaInfra as any).meta?.kind).toBe('database');

        // Sanity: confirm the bug actually reproduces without providers.
        const l1Broken = buildMicroserviceGraph(workspace, working, baseline);
        const brokenInfra = l1Broken.nodes.filter((n: any) => n.meta?.infra === true);
        expect(brokenInfra).toHaveLength(0);

        // Now simulate the user's reported flow: navigate around → cascade →
        // save() runs again. After this second save, getFileContent must still
        // return the Prisma source — otherwise the L1 rebuilt on the next
        // navigation will silently drop the DB infra node.
        sync.applyDiffCascadeToLiveGraphs();
        const fetchedAfterCascade = store.getFileContent('working', 'src/prisma/prisma-client.ts');
        expect(fetchedAfterCascade).toBeDefined();
        expect(fetchedAfterCascade).toContain('PrismaClient');

        // Final: rebuild L1 again. It should still produce the DB infra.
        const l1Final = buildMicroserviceGraph(workspace, store.getWorking(), store.getBaseline(), getWorking, getBaseline);
        const infraFinal = l1Final.nodes.filter((n: any) => n.meta?.infra === true);
        expect(infraFinal.length).toBeGreaterThan(0);
    });

    it('does not double-count an Express route picked up by both detectors', async () => {
        // Regression for the L2b API list bug where
        //   router.get('/tags', auth.optional, async (req, res) => { … })
        // showed as TWO rows because the Babel detector named the handler
        // `anonymous@GET:/tags` while the regex detector resolved it to the
        // closest preceding identifier (`router`). Tuple-keyed dedup fixes it.
        const routesDir = path.join(workspace, 'src/routes');
        fs.mkdirSync(routesDir, { recursive: true });
        fs.writeFileSync(path.join(routesDir, 'tag.controller.ts'), `
            import { Router } from 'express';
            const router = Router();
            router.get('/tags', async (req, res) => {
                res.json({ tags: [] });
            });
            export default router;
        `);
        await sync.initialize();
        const working = store.getWorking();
        const apis = Object.values(working.apiIndex ?? {}).filter(
            (a: any) => a.filePath === 'src/routes/tag.controller.ts'
        );
        const tagsRoutes = apis.filter((a: any) => a.method === 'GET' && a.route === '/tags');
        expect(tagsRoutes.length).toBe(1);
    });

    /**
     * #446-A / #447-C: at init time, `buildApiListGraph` is called BEFORE
     * `setBaselineFromWorking()`. The baseline snapshot is empty at that
     * moment, so `computeApiDiff` returns `'added'` for every API, and that
     * stale `'added'` annotation gets copied into the baseline alongside the
     * working snapshot. Later cascade rebuilds compute the correct
     * `'unchanged'` for the working api-list, but the baseline copy still
     * holds `'added'`, so the working/baseline diff probe NEVER returns
     * clean. Both repos in this session (go-chi, go-echo) showed 11–30
     * api-list graphs stuck this way after revert.
     *
     * The fix: at init, every API in every api-list graph should land with
     * `diff: 'unchanged'` because there IS no real diff at init time.
     */
    it('init produces api-list graphs with all APIs marked diff:unchanged (#446-A)', async () => {
        const routesDir = path.join(workspace, 'src/routes');
        fs.mkdirSync(routesDir, { recursive: true });
        fs.writeFileSync(path.join(routesDir, 'users.controller.ts'), `
            import { Router } from 'express';
            const router = Router();
            router.get('/users', async (req, res) => { res.json([]); });
            router.post('/users', async (req, res) => { res.status(201).send(); });
            export default router;
        `);
        await sync.initialize();

        const working = store.getWorking();
        const baseline = store.getBaseline();

        // Find the api-list graph(s) that contain users routes.
        const apiListIds = Object.keys(working.graphs).filter(id => id.startsWith('api-list:'));
        expect(apiListIds.length, 'init must produce at least one api-list graph').toBeGreaterThan(0);

        for (const id of apiListIds) {
            const wg: any = working.graphs[id];
            const bg: any = baseline.graphs[id];
            const wApis = (wg?.meta?.apis ?? []) as Array<{ apiId: string; diff: string }>;
            const bApis = (bg?.meta?.apis ?? []) as Array<{ apiId: string; diff: string }>;

            for (const api of wApis) {
                expect(api.diff, `[${id}] working ${api.apiId} should be unchanged at init`).toBe('unchanged');
            }
            for (const api of bApis) {
                expect(api.diff, `[${id}] baseline ${api.apiId} should be unchanged at init`).toBe('unchanged');
            }
        }
    });

    /**
     * #492: same shape as #446-A but for the L1 microservice graph. At init,
     * `buildMicroserviceGraph` was called with `undefined` baseline. With no
     * `baselineExternalKeys` set, every external node (e.g. a `localhost` /
     * `127.0.0.1` consumed URL) gets marked `added`, plus `meta.hasChanges`
     * becomes `true`. That "added" state is then snapshotted into baseline by
     * `setBaselineFromWorking()`. Cascade rebuilds later use a real baseline
     * snapshot and correctly mark the same external as `unchanged` — so the
     * working/baseline diff probe always shows `microservice:workspace` as
     * stuck, even with zero edits.
     *
     * The fix: at init, pass `working` as its own baseline to
     * `buildMicroserviceGraph` (same trick #446-A used for api-list).
     */
    it('init produces microservice:workspace with externals marked diff:unchanged (#492)', async () => {
        const srcDir = path.join(workspace, 'src');
        fs.mkdirSync(srcDir, { recursive: true });
        // External fetch to a localhost URL produces an `ext_*` node in the L1
        // graph. Before the fix this lands as `diff: 'added'`.
        fs.writeFileSync(path.join(srcDir, 'app.ts'), `
            import express from 'express';
            const app = express();
            app.get('/proxy', async (req, res) => {
                const r = await fetch('http://localhost:8080/upstream');
                res.json(await r.json());
            });
            export default app;
        `);
        await sync.initialize();

        const wMs: any = store.getWorking().graphs['microservice:workspace'];
        const bMs: any = store.getBaseline().graphs['microservice:workspace'];
        expect(wMs, 'init must produce microservice:workspace in working').toBeTruthy();
        expect(bMs, 'init must produce microservice:workspace in baseline').toBeTruthy();

        // Every node should be 'unchanged' at init (no real diff).
        for (const n of wMs.nodes) {
            expect(n.diff, `[working] ${n.label} should be unchanged at init`).toBe('unchanged');
        }
        for (const n of bMs.nodes) {
            expect(n.diff, `[baseline] ${n.label} should be unchanged at init`).toBe('unchanged');
        }
        // meta.hasChanges must be false on both sides.
        expect(wMs.meta?.hasChanges, 'working hasChanges').toBe(false);
        expect(bMs.meta?.hasChanges, 'baseline hasChanges').toBe(false);
    });

    // ─── L2B-4 (2026-06-07): live-edit cascade ─────────────────────────────
    //
    // Background: rebuildFile gates the entire L2b/L2a/L1 cascade (feature
    // graphs, microservice graph, api-list rebuild, upgradeServiceCluster
    // DiffAnnotations) behind `if (!content)` — i.e. it only fires for disk-
    // save events without an in-memory content snapshot. When VS Code's
    // `onDidChangeTextDocument` fires for a live edit and passes content,
    // the cascade is skipped. The L4 file graph DOES get its `modified` flag
    // (that part runs unconditionally above the gate), but L2b api-list,
    // L2a feature graph, and L1 microservice graph stay at their pre-edit
    // state — exactly the symptom seen in live-verify on build 79.
    //
    // The fix: drop the `!content` gate. The cascade rebuild is already
    // debounced via queueEvent's 500ms timer, so per-keystroke runs are
    // bounded. detectCommunities (the only genuinely expensive step) stays
    // gated separately on whether the call graph actually changed — see
    // the implementation.

    it('L2B-4: handleFileSave WITH content must still cascade L2a/L1 diff', async () => {
        await sync.initialize();

        const opsPath = path.join(workspace, 'src/math/operations.js');
        // Live-edit event — content is supplied (simulates VS Code's
        // onDidChangeTextDocument firing as the user types).
        const modifiedOperations = `
            function add(a, b) {
                return a + b + 0;
            }
            function subtract(a, b) {
                return a - b;
            }
            module.exports = { add, subtract };
        `;
        // Write to disk too — the realistic case where VS Code is saving
        // the editor buffer back to disk.
        fs.writeFileSync(opsPath, modifiedOperations);
        sync.handleFileSave(opsPath, modifiedOperations);

        // Wait past the 500ms debounce + cascade work.
        await new Promise(resolve => setTimeout(resolve, 1500));

        const working = store.getWorking();

        // L4 — file graph must mark the changed function. This already
        // worked before the fix.
        const fileGraph = working.graphs['file:src/math/operations.js'];
        expect(fileGraph, 'L4 file graph exists').toBeDefined();
        const addFn = fileGraph?.nodes.find(n => n.label === 'add');
        expect(addFn?.diff, 'L4 add() modified').toBe('modified');

        // The smoking-gun assertions: post-fix, the feature graph and
        // microservice graph MUST also exist for the workspace. Before
        // the fix, the entire cascade block (including
        // `buildFeatureGraph` + `buildMicroserviceGraph`) was inside the
        // `!content` gate and got skipped, so these would be either
        // undefined or stuck at their init-time values.
        const featureGraph = working.graphs['feature:workspace'];
        expect(featureGraph, 'L2a feature graph exists after live edit').toBeDefined();

        const msGraph = working.graphs['microservice:workspace'];
        expect(msGraph, 'L1 microservice graph exists after live edit').toBeDefined();

        // The L4 → L3 → L2b → L2a → L1 cascade should also be visible in
        // `refreshedGraphs` because `notifyRefresh` is supposed to broadcast
        // every touched graphId.
        expect(refreshedGraphs).toContain('microservice:workspace');
    });
});
