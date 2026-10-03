/**
 * messageHandler.multiRepo.test.ts — #815 (2026-06-10)
 *
 * Pins the multi-repo plumbing the MCP standalone messageHandler grew to
 * match the extension's WorkspaceOrchestrator behaviour:
 *
 *   1. `workspaceInfo` broadcast carries `isMultiRepo: true` + `repos[]`
 *      when `deps.multiRepo` is wired with ≥2 sub-repos. The webview's
 *      inline Code Review chip + two-step picker + per-repo guidelines
 *      gate on this signal, so the absence of these fields was the
 *      visible MCP regression vs the extension.
 *
 *   2. `requestExplorerData` iterates `perRepoStores` and re-keys cluster
 *      ids `<id>::<orchKey>` so sub-repos sharing `cluster:model` (e.g.
 *      every mongo demo in `js-serverless-examples`) survive the merge
 *      without collapsing under `Object.assign` (v97 fix). And it
 *      recomputes `service.exposedApiCount` from the merged `apiIndex`
 *      (#809 fix) so the picker step-1 subtitle reads real counts.
 *
 *   3. `requestRoute` with `microservice:workspace` + `param=<sub>` (and
 *      `multiRepo` wired) rebuilds the L1 fresh from the sub-repo's
 *      snapshot and stamps `meta.scopedRepo`, matching #811. Same for
 *      `map:workspace` + `param=<sub>` (#812).
 */

import { describe, it, expect, vi } from 'vitest';
import { createStandaloneMessageHandler } from '../messageHandler';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { CommentStore } from '../../core/storage/commentStore';
import type { WsBridge } from '../../server/wsBridge';

/* eslint-disable @typescript-eslint/no-explicit-any */

function mkBroadcaster() {
    const broadcasts: any[] = [];
    return {
        broadcasts,
        wsBridge: {
            broadcast: vi.fn((m: any) => broadcasts.push(m)),
            hasClients: () => true,
        } as unknown as WsBridge,
    };
}

function mkSubRepoStore(opts: {
    services?: Record<string, any>;
    apiIndex?: Record<string, any>;
    clusters?: Record<string, any>;
    files?: Record<string, any>;
    mapGraphNodes?: any[];
    graphs?: Record<string, any>;
    getFileContent?: (kind: string, fp: string) => string | undefined;
}): SnapshotStore {
    const snap: any = {
        services: opts.services ?? {},
        apiIndex: opts.apiIndex ?? {},
        clusters: opts.clusters ?? {},
        files: opts.files ?? {},
        graphs: {
            ...(opts.mapGraphNodes
                ? { 'map:workspace': { graphId: 'map:workspace', type: 'map', nodes: opts.mapGraphNodes, edges: [], anchors: {}, meta: {} } }
                : {}),
            ...(opts.graphs ?? {}),
        },
    };
    return {
        getWorking: () => snap,
        getBaseline: () => snap,
        // #815 — exposed for the lazy content provider in requestRoute.
        getFileContent: opts.getFileContent ?? (() => undefined),
    } as unknown as SnapshotStore;
}

function mkPrimaryDeps(perRepoStores: Map<string, SnapshotStore>, repos: any[]) {
    const { broadcasts, wsBridge } = mkBroadcaster();
    // Primary store is whichever happens to be first; the real bootstrap
    // picks alphabetically. The point of these tests is that the
    // *multiRepo* path supersedes the primary store reads.
    const primary = perRepoStores.values().next().value ?? mkSubRepoStore({});
    const commentStore = {} as unknown as CommentStore;
    return {
        broadcasts,
        wsBridge,
        snapshotStore: primary,
        commentStore,
        log: () => {},
        workspaceRoot: '/ws',
        multiRepo: {
            aggregator: {} as any,
            perRepoStores,
            repos,
        },
    };
}

describe('#815 — workspaceInfo carries isMultiRepo + repos[]', () => {
    it('isMultiRepo=true when deps.multiRepo has ≥2 sub-repos', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({ files: { 'alpha/a.ts': {} } }));
        stores.set('beta', mkSubRepoStore({ files: { 'beta/b.ts': {} } }));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'ready' }, 'c1');

        const ws = deps.broadcasts.find(m => m.type === 'workspaceInfo');
        expect(ws).toBeTruthy();
        expect(ws.isMultiRepo, 'webview gates inline Code Review chip + two-step picker on this').toBe(true);
        expect(ws.repos).toHaveLength(2);
        expect(ws.repos.map((r: any) => r.name).sort()).toEqual(['alpha', 'beta']);
    });

    it('isMultiRepo=false + repos=[] when deps.multiRepo is unset', async () => {
        const { broadcasts, wsBridge } = mkBroadcaster();
        const snap = mkSubRepoStore({ files: { 'a.ts': {} } });
        const h = createStandaloneMessageHandler({
            snapshotStore: snap,
            commentStore: {} as any,
            wsBridge,
            log: () => {},
            workspaceRoot: '/ws',
        } as any);
        await h.handle({ type: 'ready' }, 'c1');

        const ws = broadcasts.find(m => m.type === 'workspaceInfo');
        expect(ws.isMultiRepo).toBe(false);
        expect(ws.repos).toEqual([]);
    });

    it('also broadcasts `workspaceState` (the message HomePage actually reads to gate the inline picker)', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({ files: { 'alpha/a.ts': {} } }));
        stores.set('beta', mkSubRepoStore({ files: { 'beta/b.ts': {} } }));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'ready' }, 'c1');

        const ws = deps.broadcasts.find(m => m.type === 'workspaceState');
        expect(ws, 'workspaceState must be broadcast — HomePage reads from it, not workspaceInfo').toBeTruthy();
        expect(ws.mode).toBe('multi');
        expect(ws.repos).toHaveLength(2);
        // status + diff are required by the WorkspaceState type the
        // App.tsx reducer expects; both are stubbed to safe defaults.
        for (const r of ws.repos) {
            expect(r.status).toBe('ready');
            expect(r.diff).toBeNull();
        }
    });

    it('isMultiRepo=false when deps.multiRepo has only 1 sub-repo (still treat as single)', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('only', mkSubRepoStore({ files: { 'only/a.ts': {} } }));
        const repos = [{ repoId: 'only', name: 'only', rootPath: 'only' }];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'ready' }, 'c1');

        const ws = deps.broadcasts.find(m => m.type === 'workspaceInfo');
        expect(ws.isMultiRepo).toBe(false);
        expect(ws.repos).toHaveLength(1);
    });
});

describe('#835 — workspaceInfo counts union per-repo workings in multi-repo mode', () => {
    it('aggregates files/apis/services across sub-repos instead of reading only the primary store', async () => {
        const stores = new Map<string, SnapshotStore>();
        // Both repos expose the bare `service:main` id with rootPath '' —
        // the live-detector signature #831 resolved: they must count as
        // TWO services (per store), not collapse into one.
        stores.set('alpha', mkSubRepoStore({
            files: { 'alpha/a.ts': {}, 'alpha/b.ts': {} },
            apiIndex: { 'GET:/a::alpha/a.ts::listA': { method: 'GET' } },
            services: { 'service:main': { id: 'service:main', name: 'alpha', rootPath: '' } },
        }));
        stores.set('beta', mkSubRepoStore({
            files: { 'beta/c.ts': {} },
            apiIndex: { 'GET:/c::beta/c.ts::listC': { method: 'GET' } },
            services: { 'service:main': { id: 'service:main', name: 'beta', rootPath: '' } },
        }));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'ready' }, 'c1');

        const ws = deps.broadcasts.find(m => m.type === 'workspaceInfo');
        expect(ws.fileCount, 'files must union across sub-repos (primary alone has 2)').toBe(3);
        expect(ws.apiCount).toBe(2);
        expect(ws.serviceCount, '#831 resolution: bare service:main per store counts per store').toBe(2);
        expect(ws.services).toHaveLength(2);
    });

    it('falls back to the primary store when multiRepo is unset (single-repo unchanged)', async () => {
        const { broadcasts, wsBridge } = mkBroadcaster();
        const snap = mkSubRepoStore({
            files: { 'a.ts': {} },
            services: { 'service:main': { id: 'service:main', name: 'solo' } },
        });
        const h = createStandaloneMessageHandler({
            snapshotStore: snap,
            commentStore: {} as any,
            wsBridge,
            log: () => {},
            workspaceRoot: '/ws',
        } as any);
        await h.handle({ type: 'ready' }, 'c1');

        const ws = broadcasts.find(m => m.type === 'workspaceInfo');
        expect(ws.fileCount).toBe(1);
        expect(ws.serviceCount).toBe(1);
        expect(ws.services).toEqual([{ id: 'service:main', name: 'solo', rootPath: undefined }]);
    });
});

describe('#836B — openFeatureForService honors the repoId scope hint', () => {
    function mkFeatureGraph(repo: string) {
        return {
            graphId: `feature:service:${repo}`,
            type: 'feature',
            nodes: [{ id: `cluster:${repo}:c1`, type: 'cluster', label: `${repo}-cluster` }],
            edges: [], anchors: {}, meta: {},
        };
    }

    it('routes to the HINTED repo when sub-repos share the bare service:main id', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('dotnet', mkSubRepoStore({
            services: { 'service:main': { id: 'service:main', name: 'main' } },
            graphs: { 'feature:service:dotnet-api': mkFeatureGraph('dotnet-api') },
        }));
        stores.set('tsrepo', mkSubRepoStore({
            services: { 'service:main': { id: 'service:main', name: 'main' } },
            graphs: { 'feature:service:ts-api': mkFeatureGraph('ts-api') },
        }));
        const repos = [
            { repoId: 'dotnet', name: 'dotnet-api', rootPath: 'dotnet-api' },
            { repoId: 'tsrepo', name: 'ts-api', rootPath: 'ts-api' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'openFeatureForService', serviceId: 'service:main', repoId: 'ts-api' }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must navigate').toBeTruthy();
        expect(nav.graphId, 'must serve the HINTED repo, not the primary/first store')
            .toBe('feature:service:ts-api');
        expect(nav.label).toContain('ts-api');
    });

    it('without a hint, falls back to legacy primary-store behaviour (no crash)', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({
            graphs: { 'feature:workspace': mkFeatureGraph('alpha') },
        }));
        stores.set('beta', mkSubRepoStore({}));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'openFeatureForService', serviceId: '' }, 'c1');
        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav).toBeTruthy();
    });
});

describe('#839 — openSequenceForApi never strands the SPA when no sequence graph exists', () => {
    it('falls back to the file diagram with a toast when sequence + flow are missing', async () => {
        const apiId = 'POST:/items::dotnet/src/CreateItemFunction.cs::create';
        const stores = new Map<string, SnapshotStore>();
        stores.set('dotnet', mkSubRepoStore({
            apiIndex: { [apiId]: { apiId, method: 'POST', route: '/items', filePath: 'dotnet/src/CreateItemFunction.cs', handlerName: 'create' } },
            graphs: {
                'file:dotnet/src/CreateItemFunction.cs': {
                    graphId: 'file:dotnet/src/CreateItemFunction.cs', type: 'file',
                    nodes: [{ id: 'root', type: 'file', label: 'CreateItemFunction.cs' }],
                    edges: [], anchors: {}, meta: {},
                },
            },
        }));
        stores.set('other', mkSubRepoStore({}));
        const repos = [
            { repoId: 'dotnet', name: 'dotnet-api', rootPath: 'dotnet-api' },
            { repoId: 'other', name: 'other', rootPath: 'other' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        const h = createStandaloneMessageHandler(deps as any);

        await h.handle({ type: 'openSequenceForApi', apiId }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must navigate somewhere — never leave Loading…').toBeTruthy();
        expect(nav.graphId).toBe('file:dotnet/src/CreateItemFunction.cs');
        expect(nav.graph.meta.fallbackFromSequence).toBe(true);
        const toast = deps.broadcasts.find(m => m.type === 'clientToast' || m.type === 'showNotification');
        expect(toast, 'toast explains the fallback').toBeTruthy();
    });

    it('warns (and does not navigate) when nothing renderable exists for the api', async () => {
        const apiId = 'POST:/x::nowhere/x.cs::h';
        const stores = new Map<string, SnapshotStore>();
        stores.set('a', mkSubRepoStore({
            apiIndex: { [apiId]: { apiId, method: 'POST', route: '/x', filePath: 'nowhere/x.cs', handlerName: 'h' } },
        }));
        stores.set('b', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'a', name: 'a', rootPath: 'a' },
            { repoId: 'b', name: 'b', rootPath: 'b' },
        ]);
        const h = createStandaloneMessageHandler(deps as any);

        await h.handle({ type: 'openSequenceForApi', apiId }, 'c1');

        expect(deps.broadcasts.find(m => m.type === 'navigateTo')).toBeFalsy();
        const warn = deps.broadcasts.find(m =>
            (m.type === 'clientToast' || m.type === 'showNotification') && /warning/.test(String(m.level)));
        expect(warn).toBeTruthy();
    });
});

describe('#840 — workspaceInfo strips foreign (polluted) service rows before counting', () => {
    it('a store carrying ANOTHER repo\'s service row does not inflate SERVICES', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({
            files: { 'alpha/a.ts': {} },
            services: {
                'service:main': { id: 'service:main', name: 'alpha', rootPath: '' },
                // aggregator post-init pollution: beta's workspace-relative row
                'service:beta-svc': { id: 'service:beta-svc', name: 'beta', rootPath: 'beta' },
            },
        }));
        stores.set('beta', mkSubRepoStore({
            files: { 'beta/b.ts': {} },
            services: { 'service:main': { id: 'service:main', name: 'beta', rootPath: '' } },
        }));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'ready' }, 'c1');
        const ws = deps.broadcasts.find(m => m.type === 'workspaceInfo');
        expect(ws.serviceCount, 'pollution row for beta must be stripped from alpha\'s store').toBe(2);
    });
});

describe('#841 — bare multi-repo system-design serves the aggregator/skeletal L1, never a per-repo copy', () => {
    function pollutedL1(n: number) {
        return {
            graphId: 'microservice:workspace', type: 'microservice',
            nodes: Array.from({ length: n }, (_, i) => ({ id: `service:p${i}`, type: 'service', label: `p${i}` })),
            edges: [], anchors: {}, meta: { repoName: 'whole-workspace' },
        };
    }

    it('prefers the aggregator working copy when present', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({ graphs: { 'microservice:workspace': pollutedL1(20) } }));
        stores.set('beta', mkSubRepoStore({}));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        const bucketed = {
            graphId: 'microservice:workspace', type: 'microservice',
            nodes: [{ id: 'service:aws:dynamodb', type: 'service', label: 'DynamoDB', meta: { skeletal: true } }],
            edges: [], anchors: {}, meta: { skeletal: true, bucketed: true },
        };
        (deps as any).multiRepo.aggregator = { getWorkingGraph: (id: string) => id === 'microservice:workspace' ? bucketed : undefined };

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', route: 'system-design' }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must navigate').toBeTruthy();
        expect(nav.graph.meta.bucketed, 'must serve the aggregator bucketed copy').toBe(true);
        expect(nav.graph.nodes).toHaveLength(1);
    });

    it('falls back to a built skeletal L1 (one node per repo) when the aggregator has no copy', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({ graphs: { 'microservice:workspace': pollutedL1(20) } }));
        stores.set('beta', mkSubRepoStore({}));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        (deps as any).multiRepo.aggregator = { getWorkingGraph: () => undefined };

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', route: 'system-design' }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav).toBeTruthy();
        expect(nav.graph.meta.skeletal, 'must serve a skeletal build, not the 20-node per-repo copy').toBe(true);
        expect(nav.graph.nodes).toHaveLength(2);
    });

    it('scoped system-design (param) keeps the per-repo rebuild path (unchanged)', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({ files: { 'alpha/a.ts': {} } }));
        stores.set('beta', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ]);
        (deps as any).multiRepo.aggregator = { getWorkingGraph: () => { throw new Error('aggregator must not be consulted for scoped views'); } };
        const h = createStandaloneMessageHandler(deps as any);
        // No assertion on the result beyond not crashing — the scoped
        // branch builds from the sub-repo snapshot (covered by #815 tests).
        await expect(h.handle({ type: 'requestRoute', route: 'system-design', param: 'alpha' }, 'c1')).resolves.toBeUndefined();
    });
});

describe('#843 — requestRoute for a MISSING sequence graph falls back flow → file (never a dead end)', () => {
    it('serves the flow graph with fallbackFromSequence + toast', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('dotnet', mkSubRepoStore({
            graphs: {
                'flow:dotnet/src/Create.cs:create': {
                    graphId: 'flow:dotnet/src/Create.cs:create', type: 'flow',
                    nodes: [{ id: 'start', type: 'terminal', label: 'Start' }],
                    edges: [], anchors: {}, meta: {},
                },
            },
        }));
        stores.set('other', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'dotnet', name: 'dotnet', rootPath: 'dotnet' },
            { repoId: 'other', name: 'other', rootPath: 'other' },
        ]);
        const h = createStandaloneMessageHandler(deps as any);

        await h.handle({ type: 'requestRoute', graphId: 'sequence:dotnet/src/Create.cs:create' }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must navigate to the flow fallback').toBeTruthy();
        expect(nav.graphId).toBe('flow:dotnet/src/Create.cs:create');
        expect(nav.graph.meta.fallbackFromSequence).toBe(true);
        const toast = deps.broadcasts.find(m => m.type === 'clientToast' || m.type === 'showNotification');
        expect(toast).toBeTruthy();
    });

    it('falls to the file graph when flow is missing too; warns when nothing exists', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('dotnet', mkSubRepoStore({
            graphs: {
                'file:dotnet/src/Create.cs': {
                    graphId: 'file:dotnet/src/Create.cs', type: 'file',
                    nodes: [{ id: 'root', type: 'file', label: 'Create.cs' }],
                    edges: [], anchors: {}, meta: {},
                },
            },
        }));
        stores.set('other', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'dotnet', name: 'dotnet', rootPath: 'dotnet' },
            { repoId: 'other', name: 'other', rootPath: 'other' },
        ]);
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', graphId: 'sequence:dotnet/src/Create.cs:create' }, 'c1');
        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav.graphId).toBe('file:dotnet/src/Create.cs');

        // Nothing renderable at all → warning toast, no navigation.
        const deps2 = mkPrimaryDeps(new Map([['x', mkSubRepoStore({})], ['y', mkSubRepoStore({})]]), [
            { repoId: 'x', name: 'x', rootPath: 'x' }, { repoId: 'y', name: 'y', rootPath: 'y' },
        ]);
        const h2 = createStandaloneMessageHandler(deps2 as any);
        await h2.handle({ type: 'requestRoute', graphId: 'sequence:gone/missing.ts:h' }, 'c1');
        expect(deps2.broadcasts.find(m => m.type === 'navigateTo')).toBeFalsy();
        expect(deps2.broadcasts.find(m => (m.type === 'clientToast' || m.type === 'showNotification'))).toBeTruthy();
    });
});

describe('#846c — standalone serves the workspace meta-tour + per-repo drill in multi-repo mode', () => {
    function depsWithAggregator() {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({
            apiIndex: { 'GET:/a::alpha/a.ts::ha': { apiId: 'GET:/a::alpha/a.ts::ha', method: 'GET', route: '/a', filePath: 'alpha/a.ts', handlerName: 'ha' } },
        }));
        stores.set('beta', mkSubRepoStore({
            apiIndex: { 'GET:/b::beta/b.ts::hb': { apiId: 'GET:/b::beta/b.ts::hb', method: 'GET', route: '/b', filePath: 'beta/b.ts', handlerName: 'hb' } },
        }));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        (deps as any).multiRepo.aggregator = {
            listRepos: () => repos.map(r => ({ ...r, status: 'ready' })),
            listCrossRepoHttpEdges: () => [],
            getRepoSummary: (repoId: string) => ({
                apis: [{ apiId: `GET:/${repoId}`, method: 'GET', route: `/${repoId}`, filePath: `${repoId}/x.ts`, handlerName: 'h' }],
            }),
        };
        return deps;
    }

    it('requestTour in multi-repo broadcasts the repo-qualified meta-tour (one step per repo)', async () => {
        const deps = depsWithAggregator();
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestTour' }, 'c1');
        const tour = deps.broadcasts.find(m => m.type === 'tourSteps');
        expect(tour, 'tourSteps must broadcast').toBeTruthy();
        expect(tour.steps).toHaveLength(2);
        expect(tour.steps[0].label).toMatch(/alpha|beta/);
        expect(tour.steps[0].drillDownGraphId).toMatch(/^tour:/);
    });

    it('requestRoute tour:<repoId> drills into that repo\'s own tour', async () => {
        const deps = depsWithAggregator();
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', graphId: 'tour:beta' }, 'c1');
        const tour = deps.broadcasts.find(m => m.type === 'tourSteps');
        expect(tour).toBeTruthy();
        expect(tour.steps).toHaveLength(1);
        expect(tour.steps[0].label).toContain('/b');
    });
});

describe('#848b — bare multi-repo map serves the repo-card overview, not the fold', () => {
    it('requestRoute map in multi-repo broadcasts repo cards with drill targets', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', mkSubRepoStore({ mapGraphNodes: Array.from({length: 20}, (_, i) => ({ id: `m${i}`, label: `n${i}`, meta: { layer: 'api' } })) }));
        stores.set('beta', mkSubRepoStore({}));
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        (deps as any).multiRepo.aggregator = {
            listRepos: () => repos.map(r => ({ ...r, status: 'ready', technology: 'nodejs', errorMessage: null })),
            listSharedExternals: () => [],
            listSharedSchemas: () => [],
            listCrossRepoHttpEdges: () => [],
            getRepoSummary: () => ({ apis: [] }),
        };
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', route: 'map' }, 'c1');
        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must navigate').toBeTruthy();
        const cards = nav.graph.nodes.filter((n: any) => n.meta?.workspaceMap && !n.meta?.external);
        expect(cards, 'one card per repo — not the primary store 20-node map').toHaveLength(2);
        expect(cards[0].meta.drillDownGraphId).toMatch(/^map:/);
    });
});

describe('#815 — handleRequestExplorerData: multi-repo merge (v97 composite-key) + #809 recompute', () => {
    it('clusters sharing the same id across sub-repos do NOT collapse under Object.assign', async () => {
        const alphaStore = mkSubRepoStore({
            services: { 'service:alpha': { id: 'service:alpha', name: 'alpha', technology: 'serverless', exposedApiCount: 0, rootPath: 'alpha', repoId: 'alpha' } },
            clusters: {
                'cluster:model': { id: 'cluster:model', name: 'model', files: ['alpha/model/User.js'], serviceId: 'service:alpha' },
            },
            apiIndex: {},
            files: { 'alpha/model/User.js': {} },
        });
        const betaStore = mkSubRepoStore({
            services: { 'service:beta': { id: 'service:beta', name: 'beta', technology: 'serverless', exposedApiCount: 0, rootPath: 'beta', repoId: 'beta' } },
            clusters: {
                'cluster:model': { id: 'cluster:model', name: 'model', files: ['beta/model/User.js'], serviceId: 'service:beta' },
            },
            apiIndex: {},
            files: { 'beta/model/User.js': {} },
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', alphaStore);
        stores.set('beta', betaStore);
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta', name: 'beta', rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestExplorerData' }, 'c1');

        const ex = deps.broadcasts.find(m => m.type === 'explorerData');
        expect(ex, 'explorerData must be broadcast').toBeTruthy();
        // The composite-key merge is invisible to downstream Object.values()
        // iterators, so the features array sees BOTH `cluster:model`
        // entries — one per sub-repo. Pre-#815 the alphaStore's
        // `cluster:model` was silently overwritten by betaStore's via
        // Object.assign, leaving only ONE `cluster:model` in the picker.
        const modelClusters = ex.features.filter((f: any) => f.id === 'cluster:model');
        expect(modelClusters).toHaveLength(2);
        // Each must carry the right repoId via its serviceId mapping.
        const repoIds = modelClusters.map((f: any) => f.repoId).sort();
        expect(repoIds).toEqual(['alpha', 'beta']);
    });

    it('recomputes service.exposedApiCount from the merged apiIndex (#809)', async () => {
        const subStore = mkSubRepoStore({
            services: {
                // Stored count is stale 0 — happens when detectServices
                // runs before apiIndex is fully populated. Pre-#815 the
                // picker subtitle would read "serverless · 0 APIs".
                'service:gamma': {
                    id: 'service:gamma', name: 'gamma', technology: 'serverless',
                    exposedApiCount: 0, rootPath: 'gamma', repoId: 'gamma',
                },
            },
            clusters: {},
            apiIndex: {
                'sls:gamma:create:POST:/items:0': { apiId: 'sls:gamma:create:POST:/items:0', method: 'POST', route: '/items', filePath: 'gamma/handler.js' },
                'sls:gamma:get:GET:/items:0':    { apiId: 'sls:gamma:get:GET:/items:0',    method: 'GET',  route: '/items', filePath: 'gamma/handler.js' },
                'sls:gamma:list:GET:/list:0':    { apiId: 'sls:gamma:list:GET:/list:0',    method: 'GET',  route: '/list',  filePath: 'gamma/handler.js' },
            },
            files: { 'gamma/handler.js': {} },
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('gamma', subStore);
        stores.set('placeholder', mkSubRepoStore({}));
        const repos = [
            { repoId: 'gamma', name: 'gamma', rootPath: 'gamma' },
            { repoId: 'placeholder', name: 'placeholder', rootPath: 'placeholder' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestExplorerData' }, 'c1');

        const ex = deps.broadcasts.find(m => m.type === 'explorerData');
        const gamma = ex.services.find((s: any) => s.id === 'service:gamma');
        expect(gamma, 'gamma must surface in services').toBeTruthy();
        // Subtitle reflects the recomputed count, not the stale stored 0.
        expect(gamma.subtitle).toBe('serverless · 3 APIs');
    });

    it('#816: rebuilds picker step-1 from multiRepo.repos (one entry per sub-repo) instead of leaking inner services', async () => {
        // Phase 5 scopes detectServices to the sub-repo's tree, so each
        // per-repo state.db now has 1-2 inner-service entries (e.g.
        // .NET project layout: `DotNetServerless.Lambda` + `main`)
        // rather than 132 workspace-wide entries. If the picker source
        // were `working.services` it would explode to 200+ inner-
        // service items. #816 sources from `multiRepo.repos` so the
        // picker shows ONE entry per sub-repo regardless of how many
        // inner services the orchestrator detected.
        const alphaStore = mkSubRepoStore({
            services: {
                // Phase-5-scoped per-repo state: 2 inner services.
                'service:DotNetServerless.Lambda': {
                    id: 'service:DotNetServerless.Lambda', name: 'DotNetServerless.Lambda',
                    technology: 'serverless', exposedApiCount: 0,
                    rootPath: 'alpha/src/DotNetServerless.Lambda', repoId: 'alpha',
                },
                'service:main': {
                    id: 'service:main', name: 'main',
                    technology: 'unknown', exposedApiCount: 0,
                    rootPath: 'alpha', repoId: 'alpha',
                },
            },
            apiIndex: {
                'a1': { apiId: 'a1', method: 'GET',  route: '/items', filePath: 'alpha/handler.cs' },
                'a2': { apiId: 'a2', method: 'POST', route: '/items', filePath: 'alpha/handler.cs' },
                'a3': { apiId: 'a3', method: 'PUT',  route: '/items', filePath: 'alpha/handler.cs' },
            },
            files: { 'alpha/handler.cs': {} },
        });
        const betaStore = mkSubRepoStore({
            services: {
                'service:getFolder': {
                    id: 'service:getFolder', name: 'getFolder',
                    technology: 'serverless', exposedApiCount: 0,
                    rootPath: 'beta/getFolder', repoId: 'beta',
                },
            },
            apiIndex: {
                'b1': { apiId: 'b1', method: 'GET', route: '/folder', filePath: 'beta/handler.js' },
            },
            files: { 'beta/handler.js': {} },
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', alphaStore);
        stores.set('beta', betaStore);
        const repos = [
            { repoId: 'alpha', name: 'alpha-svc', rootPath: 'alpha' },
            { repoId: 'beta',  name: 'beta-svc',  rootPath: 'beta' },
        ];
        const deps = mkPrimaryDeps(stores, repos);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestExplorerData' }, 'c1');

        const ex = deps.broadcasts.find(m => m.type === 'explorerData');
        expect(ex, 'explorerData must be broadcast').toBeTruthy();
        // ONE entry per sub-repo (2), NOT one per inner service (3).
        expect(ex.services).toHaveLength(2);
        const names = ex.services.map((s: any) => s.label).sort();
        expect(names).toEqual(['alpha-svc', 'beta-svc']);
        // Subtitles carry API counts derived from the merged apiIndex.
        const alphaEntry = ex.services.find((s: any) => s.label === 'alpha-svc');
        const betaEntry  = ex.services.find((s: any) => s.label === 'beta-svc');
        expect(alphaEntry.subtitle).toContain('3 APIs');
        expect(betaEntry.subtitle).toContain('1 APIs');
        // Technology refined from each per-repo store's first inner
        // service. Both sub-repos have `technology: 'serverless'` set,
        // so the picker subtitle reflects that.
        expect(alphaEntry.subtitle).toContain('serverless');
        expect(betaEntry.subtitle).toContain('serverless');
        // id + action target the sub-repo by name so the existing
        // openFeatureForService flow can resolve.
        expect(alphaEntry.id).toBe('service:alpha-svc');
        expect(alphaEntry.action).toEqual({ type: 'openFeatureForService', serviceId: 'service:alpha-svc' });
        expect(alphaEntry.repoId).toBe('alpha');
    });

    it('non-HTTP methods (MIDDLEWARE/EVENT/DATA_FETCH) do not inflate exposedApiCount', async () => {
        const subStore = mkSubRepoStore({
            services: {
                'service:delta': {
                    id: 'service:delta', name: 'delta', technology: 'express',
                    exposedApiCount: 0, rootPath: 'delta', repoId: 'delta',
                },
            },
            clusters: {},
            apiIndex: {
                'http': { apiId: 'http', method: 'GET', route: '/users', filePath: 'delta/api.js' },
                'mw': { apiId: 'mw', method: 'MIDDLEWARE', route: 'auth', filePath: 'delta/api.js' },
                'ev': { apiId: 'ev', method: 'EVENT_LISTENER', route: 'user.created', filePath: 'delta/api.js' },
                'fetch': { apiId: 'fetch', method: 'DATA_FETCH', route: '/api/users', filePath: 'delta/api.js' },
            },
            files: { 'delta/api.js': {} },
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('delta', subStore);
        stores.set('extra', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'delta', name: 'delta', rootPath: 'delta' },
            { repoId: 'extra', name: 'extra', rootPath: 'extra' },
        ]);

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestExplorerData' }, 'c1');

        const ex = deps.broadcasts.find(m => m.type === 'explorerData');
        const delta = ex.services.find((s: any) => s.id === 'service:delta');
        expect(delta.subtitle).toBe('express · 1 APIs');
    });
});

describe('#815 — requestRoute: per-sub-repo rebuild for microservice + map', () => {
    it('microservice:workspace with `param=<sub>` attempts fresh rebuild then falls back to primary', async () => {
        // Sub-repo's underlying buildMicroserviceGraph relies on
        // workspaceRoot existing on disk for `detectServices`. The test
        // fixture sets a phantom path so the fresh rebuild emits 0
        // nodes — the handler falls back to the primary store's cached
        // graph, which is the documented behaviour. Either way a
        // navigateTo MUST broadcast.
        const subStore = mkSubRepoStore({
            services: {
                'service:epsilon': {
                    id: 'service:epsilon', name: 'epsilon', technology: 'express',
                    exposedApiCount: 2, rootPath: 'epsilon', repoId: 'epsilon',
                    consumedServices: [],
                },
            },
            apiIndex: {
                'a1': { apiId: 'a1', method: 'GET', route: '/users', filePath: 'src/users.js' },
                'a2': { apiId: 'a2', method: 'POST', route: '/users', filePath: 'src/users.js' },
            },
            files: { 'src/users.js': {} },
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('epsilon', subStore);
        stores.set('zeta', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'epsilon', name: 'epsilon', rootPath: 'epsilon' },
            { repoId: 'zeta',    name: 'zeta',    rootPath: 'zeta' },
        ]);
        // Primary store provides the fallback microservice:workspace
        // graph the handler navigates to when the fresh rebuild can't
        // produce nodes (no real on-disk workspace).
        (deps.snapshotStore.getWorking() as any).graphs = {
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [{ id: 'p1', type: 'service', label: 'epsilon-cached' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({
            type: 'requestRoute',
            graphId: 'microservice:workspace',
            param: 'epsilon',
        }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo' && m.graphId === 'microservice:workspace');
        expect(nav, 'navigateTo must broadcast (fresh or fallback)').toBeTruthy();
        expect(nav.graph.nodes.length).toBeGreaterThan(0);
    });

    it('map:workspace with `param=<sub>` rebuilds fresh against the filtered sub-snapshot', async () => {
        // #815 follow-up — per-repo state.db can carry the WORKSPACE
        // snapshot (the extension's WorkspaceOrchestrator writes
        // workspace-wide data into each per-repo .codeatlas/state.db).
        // The handler filters services / apiIndex / files / clusters by
        // the sub-repo's rootPath prefix BEFORE buildMapGraph fires AND
        // clears `graphs` so the cached workspace-overview map can't
        // win. With an empty filtered snapshot the fresh rebuild
        // produces a small graph (or none), and the handler may fall
        // back to the primary store's cached graph — either path must
        // still navigateTo without crashing.
        const subStore = mkSubRepoStore({
            services: {
                'service:epsilon': {
                    id: 'service:epsilon', name: 'epsilon', technology: 'express',
                    exposedApiCount: 0, rootPath: 'epsilon', repoId: 'epsilon',
                    consumedServices: [],
                },
            },
            apiIndex: {},
            files: { 'epsilon/api.js': {} },
            // Cached map graph carries the workspace overview shape —
            // the filter must drop it.
            mapGraphNodes: [
                { id: 'workspace-svc', type: 'service', label: 'workspace-primary', meta: {} },
            ],
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('epsilon', subStore);
        stores.set('zeta', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'epsilon', name: 'epsilon', rootPath: 'epsilon' },
            { repoId: 'zeta',    name: 'zeta',    rootPath: 'zeta' },
        ]);
        // Primary store provides the fallback graph when fresh rebuild
        // can't produce nodes (no on-disk workspace in the test).
        (deps.snapshotStore.getWorking() as any).graphs = {
            'map:workspace': {
                graphId: 'map:workspace', type: 'map',
                nodes: [{ id: 'p1', type: 'service', label: 'fallback' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({
            type: 'requestRoute',
            graphId: 'map:workspace',
            param: 'epsilon',
        }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo' && m.graphId === 'map:workspace');
        expect(nav, 'navigateTo must broadcast').toBeTruthy();
        // Whether it's the fresh sub-snapshot rebuild or the fallback,
        // the workspace-overview cached `workspace-svc` node from the
        // sub-repo store must NOT win — that was the pre-#815 leak
        // the user reported as "KMap shows 556 nodes for one sub-repo".
        const labels = nav.graph.nodes.map((n: any) => n.label);
        expect(labels).not.toContain('workspace-primary');
    });

    it('falls through to primary store when `param` does not match any sub-repo', async () => {
        const subStore = mkSubRepoStore({
            services: {},
            apiIndex: {},
            files: {},
        });
        const stores = new Map<string, SnapshotStore>();
        stores.set('alpha', subStore);
        stores.set('beta', mkSubRepoStore({}));
        const deps = mkPrimaryDeps(stores, [
            { repoId: 'alpha', name: 'alpha', rootPath: 'alpha' },
            { repoId: 'beta',  name: 'beta',  rootPath: 'beta' },
        ]);
        // Primary store has a microservice graph at the legacy slot.
        (deps.snapshotStore.getWorking() as any).graphs = {
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [{ id: 'p1', type: 'service', label: 'primary' }],
                edges: [], anchors: {}, meta: { /* no scopedRepo */ },
            },
        };

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({
            type: 'requestRoute',
            graphId: 'microservice:workspace',
            param: 'no-such-repo',
        }, 'c1');

        const nav = deps.broadcasts.find(m => m.type === 'navigateTo' && m.graphId === 'microservice:workspace');
        expect(nav, 'still navigateTo even if param does not match').toBeTruthy();
        // Fallback: the primary store's cached graph; no scopedRepo stamp.
        expect(nav.graph.nodes[0].label).toBe('primary');
        expect(nav.graph.meta?.scopedRepo).toBeUndefined();
    });
});

// ─── BUG-VERIFY-4: requestRoute resolves per-repo feature graphs ─────────────
describe('BUG-VERIFY-4 — requestRoute resolves per-repo feature graphs in multi-repo', () => {
    function mkFeatureGraph(repo: string, entryPoints: number) {
        return {
            graphId: `feature:service:${repo}`,
            type: 'feature',
            nodes: [{
                id: `cluster:${repo}:c1`, type: 'cluster', label: `${repo}-cluster`,
                meta: { apisInCluster: Array.from({ length: entryPoints }, (_, i) => ({ apiId: `${repo}:${i}` })) },
            }],
            edges: [], anchors: {}, meta: {},
        };
    }

    it('requestRoute feature:service:X finds the graph in a per-repo store (not the empty workspace store)', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('empty', mkSubRepoStore({}));                       // primary — no feature graphs
        stores.set('big', mkSubRepoStore({ graphs: { 'feature:service:big': mkFeatureGraph('big', 5) } }));
        const repos = [
            { repoId: 'empty', name: 'empty', rootPath: 'empty' },
            { repoId: 'big', name: 'big', rootPath: 'big' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', graphId: 'feature:service:big' }, 'c1');
        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must navigate, not fall through to Diagram-not-found').toBeTruthy();
        expect(nav.graphId).toBe('feature:service:big');
    });

    it('bare feature:workspace picks the per-repo feature graph with the MOST entry points', async () => {
        const stores = new Map<string, SnapshotStore>();
        stores.set('small', mkSubRepoStore({ graphs: { 'feature:service:small': mkFeatureGraph('small', 2) } }));
        stores.set('big', mkSubRepoStore({ graphs: { 'feature:service:big': mkFeatureGraph('big', 9) } }));
        const repos = [
            { repoId: 'small', name: 'small', rootPath: 'small' },
            { repoId: 'big', name: 'big', rootPath: 'big' },
        ];
        const deps = mkPrimaryDeps(stores, repos);
        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestRoute', graphId: 'feature:workspace' }, 'c1');
        const nav = deps.broadcasts.find(m => m.type === 'navigateTo');
        expect(nav, 'must land on a real service instead of an empty workspace view').toBeTruthy();
        expect(nav.graphId, 'should pick the service with the most entry points').toBe('feature:service:big');
    });
});
