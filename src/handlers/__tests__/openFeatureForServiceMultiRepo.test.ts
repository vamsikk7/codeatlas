/**
 * openFeatureForServiceMultiRepo.test.ts — UX-18 part 2 (2026-06-03 v2)
 *
 * Multi-repo L1 nodes are produced by buildSkeletalL1 with id
 * `service:<hex-repoId>` and `meta.repoId = <hex>`. When the user clicks
 * one of those repo cards, the browser sends
 * `openFeatureForService { serviceId: '<hex-repoId>' }`. The handler
 * previously tried to resolve `feature:<hex>` against the workspace-level
 * aggregator (which has no per-repo cluster data) and fell through to an
 * empty `feature:workspace` graph — user lands on an empty diagram.
 *
 * Fix: when (a) we're in multi-repo mode, (b) the serviceId matches an
 * aggregator repo's repoId, route to that repo's `feature:workspace`
 * graph via repoStoreRegistry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
    window: {
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    commands: { executeCommand: vi.fn() },
    env: { machineId: 't', sessionId: 't', appName: 'Code', uriScheme: 'vscode' },
    version: '1.0.0',
}));

import { makeHarness } from './handlerHarness';
import { registerNavigationHandlers } from '../navigationHandlers';
import type { DiagramGraph } from '../../core/graph/graphTypes';

function setupHandlers() {
    const h = makeHarness();
    const handlers = new Map<string, (msg: any, panelId: string) => any>();
    const register = (type: string, fn: any) => { handlers.set(type, fn); };
    registerNavigationHandlers(register as any, h.ctx);
    return {
        h,
        dispatch(type: string, message: any = {}, panelId = 'test-panel') {
            const fn = handlers.get(type);
            if (!fn) throw new Error(`No handler registered for ${type}`);
            return fn(message, panelId);
        },
    };
}

function makeFeatureGraph(repoName: string): DiagramGraph {
    return {
        graphId: 'feature:workspace',
        type: 'feature',
        nodes: [
            { id: `cluster:${repoName}:auth`, type: 'cluster', label: 'Auth', meta: {} } as any,
        ],
        edges: [],
        anchors: {},
        meta: { repoName },
    } as DiagramGraph;
}

describe('openFeatureForService — multi-repo (UX-18 part 2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('multi-repo: prefers `feature:service:<repoName>` from the per-repo store', async () => {
        const { h, dispatch } = setupHandlers();
        // Per-repo store with `feature:service:api` (the actual graph id
        // produced by per-repo clustering). The legacy `feature:workspace`
        // is missing in this repo.
        const featureGraph = {
            graphId: 'feature:service:api',
            type: 'feature',
            nodes: [{ id: 'cluster:auth', type: 'cluster', label: 'Auth', meta: {} } as any],
            edges: [],
            anchors: {},
        };
        const repoStores = new Map<string, any>();
        repoStores.set('/test/workspace/services/api', {
            getWorking: () => ({ graphs: { 'feature:service:api': featureGraph } }),
        });
        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                { repoId: 'aaaa1111', name: 'api', rootPath: 'services/api', technology: 'node', status: 'ready' },
                { repoId: 'bbbb2222', name: 'web', rootPath: 'services/web', technology: 'next', status: 'ready' },
            ],
        };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: (absPath: string) => repoStores.get(absPath),
            // Issue #790 — the handler now uses the async-load variant.
            getRepoStoreLoaded: async (absPath: string) => repoStores.get(absPath),
        };

        await dispatch('openFeatureForService', { serviceId: 'aaaa1111' });
        const nav = (h.ctx.panelManager as any).navigatePanel as any;
        expect(nav).toHaveBeenCalled();
        const call = nav.mock.calls[0];
        // navigatePanel(sourcePanelId, graphId, mode, graph, label)
        expect(call[1]).toBe('feature:service:api');
        // #845 — the handler serves a scoped COPY (meta.scopedRepo added).
        expect(call[3].nodes).toBe(featureGraph.nodes);
        expect(call[3].meta?.scopedRepo).toBe('api');
        expect(String(call[4])).toContain('api');
    });

    it('multi-repo: falls back to `feature:workspace` if per-repo store lacks the service graph', async () => {
        const { h, dispatch } = setupHandlers();

        // Stand up a fake aggregatorStore with two repos.
        const repoStores = new Map<string, any>();
        const apiFeatureGraph = makeFeatureGraph('api');
        repoStores.set('/test/workspace/services/api', {
            getWorking: () => ({ graphs: { 'feature:workspace': apiFeatureGraph } }),
        });
        repoStores.set('/test/workspace/services/web', {
            getWorking: () => ({ graphs: { 'feature:workspace': makeFeatureGraph('web') } }),
        });

        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                { repoId: 'aaaa1111', name: 'api', rootPath: 'services/api', technology: 'node', status: 'ready' },
                { repoId: 'bbbb2222', name: 'web', rootPath: 'services/web', technology: 'next', status: 'ready' },
            ],
        };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: (absPath: string) => repoStores.get(absPath),
            // Issue #790 — the handler now uses the async-load variant.
            getRepoStoreLoaded: async (absPath: string) => repoStores.get(absPath),
        };

        await dispatch('openFeatureForService', { serviceId: 'aaaa1111' });

        // The handler must have routed the panel to feature:workspace using
        // the per-repo store's graph, with a label that disambiguates which
        // repo's features the user is viewing.
        const nav = (h.ctx.panelManager as any).navigatePanel as any;
        expect(nav).toHaveBeenCalled();
        const call = nav.mock.calls[0];
        // navigatePanel(sourcePanelId, graphId, mode, graph, label)
        // Legacy `feature:workspace` only — no `feature:service:api` — so
        // the fallback branch should fire.
        expect(call[1]).toBe('feature:workspace');
        expect(call[2]).toBe('feature');
        // #845 — scoped copy; content identical, scope stamped.
        expect(call[3].nodes).toBe(apiFeatureGraph.nodes);
        expect(call[3].meta?.scopedRepo).toBe('api');
        expect(String(call[4])).toContain('api');
    });

    it('multi-repo: unknown repoId falls through to single-repo logic (no crash)', async () => {
        const { h, dispatch } = setupHandlers();
        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                { repoId: 'aaaa1111', name: 'api', rootPath: 'services/api', technology: 'node', status: 'ready' },
                { repoId: 'bbbb2222', name: 'web', rootPath: 'services/web', technology: 'next', status: 'ready' },
            ],
        };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: () => { throw new Error('should not be called'); },
            getRepoStoreLoaded: async () => { throw new Error('should not be called'); },
        };

        // Dispatch with a serviceId that doesn't match any repo — the
        // multi-repo branch should not fire (and getRepoStore should not
        // be invoked). The handler swallows errors via withErrorHandling.
        expect(() => dispatch('openFeatureForService', { serviceId: 'service:unknown' })).not.toThrow();
    });

    it('single-repo (only one repo in aggregator): does NOT use multi-repo branch', async () => {
        const { h, dispatch } = setupHandlers();
        // Single repo in the registry — multi-repo branch should not fire.
        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                { repoId: 'aaaa1111', name: 'api', rootPath: '', technology: 'node', status: 'ready' },
            ],
        };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: () => { throw new Error('should not be called'); },
            getRepoStoreLoaded: async () => { throw new Error('should not be called'); },
        };

        // Should fall through to the existing single-repo path (no throw).
        expect(() => dispatch('openFeatureForService', { serviceId: 'aaaa1111' })).not.toThrow();
    });

    // #836B (2026-06-11, live walkthrough build 116) — every sub-repo
    // exposes the bare `service:main` id, so the store-scan fallback
    // resolved the FIRST repo containing it: clicking `main` on the
    // typescript-scoped L1 opened the .NET repo's features. The SPA now
    // threads the URL scope (`#/system-design/<repo>`) as `message.repoId`,
    // and the handler must honor that hint FIRST.
    it('#836B — repoId hint wins over the store-scan fallback for colliding service:main ids', async () => {
        const { h, dispatch } = setupHandlers();
        const dotnetGraph = {
            graphId: 'feature:service:aws-dotnet-rest-api',
            type: 'feature',
            nodes: [{ id: 'cluster:dotnet:entities', type: 'cluster', label: 'entities', meta: {} } as any],
            edges: [], anchors: {},
        };
        const tsGraph = {
            graphId: 'feature:service:aws-node-typescript-rest-api',
            type: 'feature',
            nodes: [{ id: 'cluster:ts:todos', type: 'cluster', label: 'todos', meta: {} } as any],
            edges: [], anchors: {},
        };
        const repoStores = new Map<string, any>();
        // BOTH repos expose `service:main` — the collision.
        repoStores.set('/test/workspace/aws-dotnet-rest-api', {
            getWorking: () => ({
                graphs: { 'feature:service:aws-dotnet-rest-api': dotnetGraph },
                services: { 'service:main': { id: 'service:main', name: 'main' } },
            }),
        });
        repoStores.set('/test/workspace/aws-node-typescript-rest-api', {
            getWorking: () => ({
                graphs: { 'feature:service:aws-node-typescript-rest-api': tsGraph },
                services: { 'service:main': { id: 'service:main', name: 'main' } },
            }),
        });
        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                // dotnet listed FIRST — the pre-fix store-scan fallback picks it.
                { repoId: 'dddd0000', name: 'aws-dotnet-rest-api', rootPath: 'aws-dotnet-rest-api', technology: 'csharp', status: 'ready' },
                { repoId: 'tttt1111', name: 'aws-node-typescript-rest-api', rootPath: 'aws-node-typescript-rest-api', technology: 'node', status: 'ready' },
            ],
        };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: (absPath: string) => repoStores.get(absPath),
            getRepoStoreLoaded: async (absPath: string) => repoStores.get(absPath),
        };

        await dispatch('openFeatureForService', {
            serviceId: 'service:main',
            repoId: 'aws-node-typescript-rest-api',
        });

        const nav = (h.ctx.panelManager as any).navigatePanel as any;
        expect(nav).toHaveBeenCalled();
        const call = nav.mock.calls[0];
        expect(call[1], 'must resolve the HINTED repo, not the first service:main match')
            .toBe('feature:service:aws-node-typescript-rest-api');
        // #845 — the served copy carries the repo scope for the URL.
        expect(call[3].meta?.scopedRepo).toBe('aws-node-typescript-rest-api');
        expect(call[3].nodes).toBe(tsGraph.nodes);
    });

    // 2026-06-09 — user-reported: on FIRST LAUNCH, clicking an L1 service
    // node sometimes lands on an empty L2a Feature Clusters page until
    // a manual re-init. Cause: the per-repo store's lazy `feature:*`
    // graphs hadn't been built yet (cascade hadn't reached them, or the
    // specific service id never had its cluster pre-rendered). The
    // pre-fix handler logged "matched repo but no non-empty feature
    // graph" and fell through to the workspace `buildFeatureGraphForService`
    // path, which reads from the workspace store (empty in multi-repo
    // mode) → empty graph rendered.
    it('on-demand builds the feature graph from the per-repo snapshot when no stored feature:* exists', async () => {
        const { h, dispatch } = setupHandlers();
        // Per-repo store has NO `feature:*` graphs yet (first-launch case).
        // But the snapshot has the data needed to build one: at least one
        // service + at least one cluster.
        const repoSnapshot = {
            files: {
                'services/api/src/index.ts': {
                    path: 'services/api/src/index.ts', hash: 'h', mtime: 0, content: '',
                    symbols: { functions: [], variables: [], imports: [] },
                },
            } as any,
            apiIndex: {},
            graphs: {},
            services: {
                'aaaa1111': {
                    id: 'aaaa1111', name: 'api', rootPath: 'services/api',
                    technology: 'express', category: 'backend',
                    exposedApiCount: 0, consumedUrls: [], consumedServices: [],
                },
            } as any,
            clusters: {
                'cluster:api:auth': {
                    id: 'cluster:api:auth',
                    label: 'Auth',
                    serviceId: 'aaaa1111',
                    files: ['services/api/src/index.ts'],
                    entryPoints: [],
                    apisInCluster: [],
                    internalCallCount: 0,
                    externalCallCount: 0,
                    modularity: 0.5,
                } as any,
            } as any,
        };
        const updates: Array<{ graphId: string; graph: any }> = [];
        const repoStores = new Map<string, any>();
        repoStores.set('/test/workspace/services/api', {
            getWorking: () => repoSnapshot,
            getBaseline: () => undefined,
            updateWorkingGraph: (graphId: string, graph: any) => {
                updates.push({ graphId, graph });
            },
        });
        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                { repoId: 'aaaa1111', name: 'api', rootPath: 'services/api', technology: 'node', status: 'ready' },
                { repoId: 'bbbb2222', name: 'web', rootPath: 'services/web', technology: 'next', status: 'ready' },
            ],
        };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: (absPath: string) => repoStores.get(absPath),
            getRepoStoreLoaded: async (absPath: string) => repoStores.get(absPath),
        };

        await dispatch('openFeatureForService', { serviceId: 'aaaa1111' });

        // The handler must have on-demand-built the feature graph and
        // navigated to it. Without the fix, navigatePanel never fires
        // because `featureGraph` stays undefined and the multi-repo
        // branch falls through to the workspace single-repo path.
        const nav = (h.ctx.panelManager as any).navigatePanel as any;
        expect(nav, 'navigatePanel must be called after on-demand build').toHaveBeenCalled();
        const call = nav.mock.calls[0];
        // navigatePanel(sourcePanelId, graphId, mode, graph, label)
        expect(call[2], 'mode is feature').toBe('feature');
        const navigatedGraph = call[3];
        expect(navigatedGraph, 'graph must be defined').toBeDefined();
        expect(navigatedGraph.nodes.length, 'graph must have at least one cluster node').toBeGreaterThan(0);
        // The handler should have written the built graph back so subsequent clicks hit cache.
        expect(updates.length, 'on-demand build writes back to per-repo store').toBeGreaterThan(0);
    });
});

// #838 follow-up (2026-06-11, user repro via Tour breadcrumb) — navigateHome
// must route through buildMicroserviceGraphCached so multi-repo serves the
// aggregator's bucketed L1, never the workspace store's polluted raw copy.
describe('navigateHome serves the aggregator-owned L1 in multi-repo (#838 follow-up)', () => {
    it('prefers the aggregator bucketed copy over the workspace store raw graph', async () => {
        const { h, dispatch } = setupHandlers();
        // Workspace store holds a polluted 3-node wall…
        h.state.working.graphs['microservice:workspace'] = {
            graphId: 'microservice:workspace', type: 'microservice',
            nodes: [{ id: 'w1', type: 'service', label: 'wall1' }, { id: 'w2', type: 'service', label: 'wall2' }, { id: 'w3', type: 'service', label: 'wall3' }],
            edges: [], anchors: {}, meta: {},
        };
        // …while the aggregator owns the bucketed view.
        const bucketed = {
            graphId: 'microservice:workspace', type: 'microservice',
            nodes: [{ id: 'service:aws:dynamodb', type: 'service', label: 'DynamoDB', meta: { skeletal: true } }],
            edges: [], anchors: {}, meta: { skeletal: true, bucketed: true },
        };
        (h.ctx as any).aggregatorStore = {
            listRepos: () => [
                { repoId: 'a', name: 'a', rootPath: 'a', status: 'ready' },
                { repoId: 'b', name: 'b', rootPath: 'b', status: 'ready' },
            ],
            getWorkingGraph: (id: string) => id === 'microservice:workspace' ? bucketed : undefined,
        };
        (h.ctx as any).repoStoreRegistry = { getRepoStore: () => undefined, getRepoStoreLoaded: async () => undefined };

        await dispatch('navigateHome', {});

        const nav = (h.ctx.panelManager as any).navigatePanel as any;
        expect(nav).toHaveBeenCalled();
        const graph = nav.mock.calls[0][3];
        expect(graph.meta?.bucketed, 'breadcrumb home must serve the bucketed aggregator copy').toBe(true);
        expect(graph.nodes).toHaveLength(1);
    });
});
