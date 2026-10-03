/**
 * ADR-034 Phase J (#795 — Phase J: Cross-repo diff propagation + workspace re-sync (ADR-034)) — recomputeDiffs tests across all three
 * cross-repo tables.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../aggregatorStore';
import { CrossRepoAnalyzerRegistry } from '../../sync/crossRepoAnalyzer';
import { sharedExternalAnalyzer } from '../../analysis/sharedExternalAnalyzer';

const tmpDirs: string[] = [];

async function makeAggregator(): Promise<AggregatorStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-diff-'));
    tmpDirs.push(dir);
    const agg = new AggregatorStore(dir, { inMemoryOnly: true });
    await agg.init();
    return agg;
}

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('recomputeDiffs — shared_externals', () => {
    it('added: row in working only → diff="added"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a'], diff: null,
        });
        agg.recomputeDiffs();
        expect(agg.listSharedExternals()[0].diff).toBe('added');
        agg.close();
    });

    it('unchanged: same consumers in both → diff="unchanged"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a', 'b'], diff: null,
        });
        agg.rotateBaseline();
        agg.recomputeDiffs();
        expect(agg.listSharedExternals()[0].diff).toBeNull();
        // null → also unchanged (we only set diff when it would change)
        agg.close();
    });

    it('modified: working consumers differ from baseline → diff="modified"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a', 'b'], diff: null,
        });
        agg.rotateBaseline();
        // Working changes: drop one consumer.
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a'], diff: null,
        });
        agg.recomputeDiffs();
        expect(agg.listSharedExternals()[0].diff).toBe('modified');
        agg.close();
    });

    it('deleted: row in baseline only → placeholder row with diff="deleted"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedExternal({
            providerId: 'stripe', name: 'Stripe', category: 'payments',
            consumers: ['a'], diff: null,
        });
        agg.rotateBaseline();
        agg.removeSharedExternal('stripe');
        agg.recomputeDiffs();
        const working = agg.listSharedExternals();
        const stripe = working.find((w) => w.providerId === 'stripe');
        expect(stripe).toBeDefined();
        expect(stripe!.diff).toBe('deleted');
        expect(stripe!.consumers).toEqual([]);
        agg.close();
    });
});

describe('recomputeDiffs — shared_schemas', () => {
    it('added → diff="added"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedSchema({
            engine: 'postgresql', tableName: 'users',
            consumers: ['a'], diff: null,
        });
        agg.recomputeDiffs();
        expect(agg.listSharedSchemas()[0].diff).toBe('added');
        agg.close();
    });

    it('modified consumer set → diff="modified"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedSchema({
            engine: 'postgresql', tableName: 'users',
            consumers: ['a', 'b'], diff: null,
        });
        agg.rotateBaseline();
        agg.upsertSharedSchema({
            engine: 'postgresql', tableName: 'users',
            consumers: ['a', 'b', 'c'], diff: null,
        });
        agg.recomputeDiffs();
        expect(agg.listSharedSchemas()[0].diff).toBe('modified');
        agg.close();
    });

    it('deleted schema → placeholder with diff="deleted"', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedSchema({
            engine: 'postgresql', tableName: 'orders',
            consumers: ['a'], diff: null,
        });
        agg.rotateBaseline();
        agg.removeSharedSchema('postgresql', 'orders');
        agg.recomputeDiffs();
        const placeholder = agg.listSharedSchemas().find((s) => s.tableName === 'orders');
        expect(placeholder!.diff).toBe('deleted');
        expect(placeholder!.consumers).toEqual([]);
        agg.close();
    });
});

describe('recomputeDiffs — cross_repo_http_edges', () => {
    it('added → diff="added"', async () => {
        const agg = await makeAggregator();
        agg.upsertCrossRepoHttpEdge({
            sourceRepo: 'a', targetRepo: 'b',
            method: 'GET', route: '/x', diff: null,
        });
        agg.recomputeDiffs();
        expect(agg.listCrossRepoHttpEdges()[0].diff).toBe('added');
        agg.close();
    });

    it('unchanged: same edge in both → diff="unchanged" (left null)', async () => {
        const agg = await makeAggregator();
        agg.upsertCrossRepoHttpEdge({
            sourceRepo: 'a', targetRepo: 'b',
            method: 'GET', route: '/x', diff: null,
        });
        agg.rotateBaseline();
        agg.recomputeDiffs();
        expect(agg.listCrossRepoHttpEdges()[0].diff).toBeNull();
        agg.close();
    });

    it('deleted edge → placeholder with diff="deleted"', async () => {
        const agg = await makeAggregator();
        agg.upsertCrossRepoHttpEdge({
            sourceRepo: 'a', targetRepo: 'b',
            method: 'GET', route: '/x', diff: null,
        });
        agg.rotateBaseline();
        agg.removeCrossRepoHttpEdgesFromSource('a');
        agg.recomputeDiffs();
        const edges = agg.listCrossRepoHttpEdges();
        const placeholder = edges.find((e) => e.sourceRepo === 'a');
        expect(placeholder!.diff).toBe('deleted');
        agg.close();
    });
});

describe('recomputeDiffs — idempotence', () => {
    it('running twice produces identical state', async () => {
        const agg = await makeAggregator();
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a'], diff: null,
        });
        agg.recomputeDiffs();
        const first = JSON.stringify(agg.listSharedExternals());
        agg.recomputeDiffs();
        const second = JSON.stringify(agg.listSharedExternals());
        expect(second).toBe(first);
        agg.close();
    });
});

describe('recomputeDiffs — sandbox scenario', () => {
    it('drop OpenAI from svc-alpha — consumers shrink, diff=modified', async () => {
        const agg = await makeAggregator();
        // Initial state: alpha + gamma both use OpenAI.
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['svc-alpha', 'svc-gamma'], diff: null,
        });
        agg.rotateBaseline();

        // svc-alpha drops openai.
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['svc-gamma'], diff: null,
        });
        agg.recomputeDiffs();

        const row = agg.listSharedExternals()[0];
        expect(row.diff).toBe('modified');
        expect(row.consumers).toEqual(['svc-gamma']);
        // Baseline still has both for the next "what changed" lookup.
        expect(agg.listBaselineSharedExternals()[0].consumers).toEqual(['svc-alpha', 'svc-gamma']);
        agg.close();
    });
});

describe('recomputeDiffs — wired into applySummary', () => {
    it('applySummary triggers diff recomputation automatically', async () => {
        const agg = await makeAggregator();
        // Hook the sharedExternal analyzer so applySummary can union consumers.
        const reg = new CrossRepoAnalyzerRegistry();
        reg.register(sharedExternalAnalyzer);
        agg.setAnalyzerRegistry(reg);

        // Seed baseline with one external + a consumer.
        agg.upsertSharedExternal({
            providerId: 'openai', name: 'OpenAI', category: 'ai',
            consumers: ['a'], diff: null,
        });
        agg.rotateBaseline();

        agg.upsertRepo({
            repoId: 'b', name: 'b', rootPath: 'b', realpathHash: 'b',
            technology: null, status: 'ready', lastInitAt: 0, errorMessage: null,
            fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
            diff: null,
        });
        // Apply repo-b's summary that ALSO uses openai → consumers becomes [a, b]
        // → diff='modified' should propagate automatically through applySummary.
        agg.applySummary('b', {
            repoId: 'b',
            schemaVersion: 1,
            technology: 'nodejs',
            apis: [],
            sdks: [{ sdkId: 'openai', name: 'OpenAI', category: 'ai' }],
            schemas: [],
            httpClientPaths: [],
        });
        const row = agg.listSharedExternals()[0];
        expect(row.consumers).toContain('a');
        expect(row.consumers).toContain('b');
        expect(row.diff).toBe('modified');
        agg.close();
    });
});

// 2026-06-09 — `inferTechnology()` in `WorkspaceOrchestrator` returns
// null at upsert time (Phase B doesn't yet know per-repo extension
// signals). Phase C's `applySummary` was meant to backfill from the
// per-repo summary but did not — so `repos.technology` stayed null and
// `buildWorkspaceMapGraph` rendered every node as "«null»". The fix in
// `applySummary` writes the non-`'unknown'` summary technology back to
// the row so `listRepos()` returns the right framework label.
describe('applySummary — backfills repos.technology', () => {
    it('writes summary.technology onto the repo row', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo({
            repoId: 'svc-a', name: 'svc-a', rootPath: 'svc-a', realpathHash: 'svc-a',
            // The orchestrator's `inferTechnology` returns null at upsert time.
            technology: null, status: 'ready', lastInitAt: 0, errorMessage: null,
            fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
            diff: null,
        });
        agg.applySummary('svc-a', {
            repoId: 'svc-a',
            schemaVersion: 1,
            technology: 'nodejs',
            apis: [],
            sdks: [],
            schemas: [],
            httpClientPaths: [],
        });
        const row = agg.listRepos().find(r => r.repoId === 'svc-a');
        expect(row?.technology).toBe('nodejs');
        agg.close();
    });

    it('does NOT overwrite the row when summary.technology === "unknown"', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo({
            repoId: 'svc-b', name: 'svc-b', rootPath: 'svc-b', realpathHash: 'svc-b',
            technology: 'python', status: 'ready', lastInitAt: 0, errorMessage: null,
            fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
            diff: null,
        });
        // A prior pass set technology=python. A later applySummary that
        // produced 'unknown' (e.g. a partial re-init where source files
        // weren't readable) must NOT clobber the more-precise prior value.
        agg.applySummary('svc-b', {
            repoId: 'svc-b',
            schemaVersion: 1,
            technology: 'unknown',
            apis: [],
            sdks: [],
            schemas: [],
            httpClientPaths: [],
        });
        const row = agg.listRepos().find(r => r.repoId === 'svc-b');
        expect(row?.technology).toBe('python');
        agg.close();
    });
});

// #817 (2026-06-11) — hash-staleness for cross_repo_http_edges. Phase J's
// presence-only diff OVERWROTE the UX-67c analyzer's `modified` re-stamp on
// every applySummary, so a producer surface change never survived to the
// edge row (and the #817 push had no transition to detect). The edge diff
// is now derived: presence first (added/deleted), then producer surface
// hash working-vs-baseline for edges present in both.
describe('recomputeDiffs — cross_repo_http_edges hash-staleness (#817)', () => {
    const summary = (hash: string) => ({
        repoId: 'prod',
        schemaVersion: 1,
        technology: 'nodejs',
        apis: [{ apiId: 'GET:/api/items', method: 'GET', route: '/api/items', handlerName: 'h' }],
        sdks: [],
        schemas: [],
        httpClientPaths: [],
        apiHashes: { 'GET:/api/items': hash },
    } as any);

    async function makeWithEdge() {
        const agg = await makeAggregator();
        for (const [repoId, name] of [['prod', 'producer'], ['con', 'consumer']] as const) {
            agg.upsertRepo({
                repoId, name, rootPath: name, realpathHash: repoId,
                technology: 'nodejs', status: 'ready', lastInitAt: 0, errorMessage: null,
                fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
                diff: null,
            });
        }
        agg.setRepoSummary('prod', summary('hashA'));
        agg.upsertCrossRepoHttpEdge({ sourceRepo: 'con', targetRepo: 'prod', method: 'GET', route: '/api/items', diff: null });
        agg.rotateBaseline();
        return agg;
    }

    it('producer hash unchanged vs baseline → edge stays unchanged', async () => {
        const agg = await makeWithEdge();
        agg.recomputeDiffs();
        const edge = agg.listCrossRepoHttpEdges()[0];
        expect(edge.diff === null || edge.diff === 'unchanged').toBe(true);
        agg.close();
    });

    it('producer hash change vs baseline → edge diff="modified"; revert → cleared', async () => {
        const agg = await makeWithEdge();
        // Producer surface changes (e.g. handler rename → new hash).
        agg.setRepoSummary('prod', summary('hashB'));
        agg.recomputeDiffs();
        expect(agg.listCrossRepoHttpEdges()[0].diff).toBe('modified');
        // Revert: hash returns to the baseline value → marker clears.
        agg.setRepoSummary('prod', summary('hashA'));
        agg.recomputeDiffs();
        const edge = agg.listCrossRepoHttpEdges()[0];
        expect(edge.diff === null || edge.diff === 'unchanged').toBe(true);
        agg.close();
    });

    it('param-token differences between edge route and producer route still match (:id vs ${id})', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo({
            repoId: 'prod', name: 'producer', rootPath: 'producer', realpathHash: 'prod',
            technology: 'nodejs', status: 'ready', lastInitAt: 0, errorMessage: null,
            fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1, diff: null,
        });
        const sum = (hash: string) => ({
            repoId: 'prod', schemaVersion: 1, technology: 'nodejs',
            apis: [{ apiId: 'GET:/api/items/:id', method: 'GET', route: '/api/items/:id', handlerName: 'g' }],
            sdks: [], schemas: [], httpClientPaths: [],
            apiHashes: { 'GET:/api/items/:id': hash },
        } as any);
        agg.setRepoSummary('prod', sum('hashA'));
        // Consumer-side extraction records the template-literal form.
        agg.upsertCrossRepoHttpEdge({ sourceRepo: 'con', targetRepo: 'prod', method: 'GET', route: '/api/items/${id}', diff: null });
        agg.rotateBaseline();
        agg.setRepoSummary('prod', sum('hashB'));
        agg.recomputeDiffs();
        expect(agg.listCrossRepoHttpEdges()[0].diff).toBe('modified');
        agg.close();
    });

    it('applySummary end-to-end: analyzer re-stamp is no longer clobbered by recomputeDiffs', async () => {
        const agg = await makeWithEdge();
        // Full applySummary (analyzer chain + recompute) with a changed hash.
        agg.applySummary('prod', summary('hashB'));
        expect(agg.listCrossRepoHttpEdges()[0].diff).toBe('modified');
        agg.close();
    });
});
