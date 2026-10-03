import { describe, it, expect } from 'vitest';
import { buildFeatureGraph, dominantScreenFramework } from '../featureGraphBuilder';
import type { Snapshot, FileRecord, FeatureCluster } from '../graphTypes';

function makeSnapshotWithClusters(clusters: Record<string, FeatureCluster>): Snapshot {
    const files: Record<string, FileRecord> = {};
    for (const cluster of Object.values(clusters)) {
        for (const fp of cluster.files) {
            files[fp] = {
                content: '',
                symbols: { functions: [], vars: [], imports: [] },
                lastModified: 0,
            };
        }
    }
    return { files, apiIndex: {}, graphs: {}, clusters };
}

const authCluster: FeatureCluster = {
    id: 'cluster:auth',
    label: 'auth',
    serviceId: 'service:orders',
    files: ['auth/login.ts', 'auth/logout.ts'],
    entryPoints: [],
    apisInCluster: [],
    internalCallCount: 4,
    externalCallCount: 1,
};

const paymentsCluster: FeatureCluster = {
    id: 'cluster:payments',
    label: 'payments',
    serviceId: 'service:billing',
    files: ['payments/pay.ts'],
    entryPoints: [],
    apisInCluster: [],
    internalCallCount: 2,
    externalCallCount: 3,
};

describe('dominantScreenFramework (BUG-POLAR-6)', () => {
    it('returns the most common per-screen framework (Next.js for polar clients)', () => {
        const screens = [
            { framework: 'nextjs-app' }, { framework: 'nextjs-app' }, { framework: 'nextjs-app' },
            { framework: 'react' },
        ];
        expect(dominantScreenFramework(screens)).toBe('nextjs-app');
    });
    it('is undefined when no screen has a framework (caller falls back)', () => {
        expect(dominantScreenFramework([{}, {}])).toBeUndefined();
        expect(dominantScreenFramework([])).toBeUndefined();
    });
});

describe('buildFeatureGraph', () => {
    it('returns a graph with graphId "feature:workspace"', () => {
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
        const graph = buildFeatureGraph(snapshot);
        expect(graph.graphId).toBe('feature:workspace');
        expect(graph.type).toBe('feature');
    });

    it('creates a node per cluster', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });
        const graph = buildFeatureGraph(snapshot);
        expect(graph.nodes).toHaveLength(2);
        const labels = graph.nodes.map((n) => n.label);
        expect(labels).toContain('auth');
        expect(labels).toContain('payments');
    });

    it('node type is "cluster"', () => {
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
        const graph = buildFeatureGraph(snapshot);
        expect(graph.nodes[0]?.type).toBe('cluster');
    });

    it('nodes have no diff when no baseline provided', () => {
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
        const graph = buildFeatureGraph(snapshot);
        for (const node of graph.nodes) {
            expect(node.diff).toBe('unchanged');
        }
    });

    // Regression (2026-08-09) — the SCREEN-list path (frontend/mobile service)
    // must ALSO default to `unchanged` on a baseline-less build, mirroring the
    // cluster path above. Pre-fix it marked every screen `added`; init builds
    // per-service graphs with baselineSnapshot=undefined, and setBaselineFromWorking
    // froze that `added` into the baseline copy → py-fastapi's frontend feature
    // graph showed spurious diffs whenever the sibling backend was edited.
    it('screen nodes have no diff when no baseline provided (frontend service)', () => {
        const serviceId = 'service:web';
        const snapshot = {
            files: {}, apiIndex: {}, graphs: {}, clusters: {},
            services: { [serviceId]: { id: serviceId, name: 'web', category: 'frontend', technology: 'nextjs', files: [] } },
            screens: {
                s1: { screenId: 'screen:web:/login', serviceId, routePath: '/login', framework: 'nextjs-app', filePath: 'app/login/page.tsx', anchor: { filePath: 'app/login/page.tsx' } },
                s2: { screenId: 'screen:web:/signup', serviceId, routePath: '/signup', framework: 'nextjs-app', filePath: 'app/signup/page.tsx', anchor: { filePath: 'app/signup/page.tsx' } },
            },
        } as unknown as Snapshot;
        const graph = buildFeatureGraph(snapshot, undefined, serviceId);
        expect(graph.nodes.length).toBeGreaterThan(0);
        for (const node of graph.nodes) {
            expect(node.diff, `screen ${node.label} must be unchanged on a baseline-less build`).toBe('unchanged');
        }
    });

    it('marks added clusters as added when compared to baseline', () => {
        const workingSnapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });
        const baselineSnapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            // payments cluster is new
        });
        const graph = buildFeatureGraph(workingSnapshot, baselineSnapshot);
        const paymentsNode = graph.nodes.find((n) => n.label === 'payments');
        expect(paymentsNode?.diff).toBe('added');
    });

    it('marks deleted clusters as deleted when compared to baseline', () => {
        const workingSnapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            // payments cluster deleted
        });
        const baselineSnapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });
        const graph = buildFeatureGraph(workingSnapshot, baselineSnapshot);
        const deletedNode = graph.nodes.find((n) => n.label?.includes('payments'));
        expect(deletedNode?.diff).toBe('deleted');
    });

    it('includes cohesion in node meta', () => {
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
        const graph = buildFeatureGraph(snapshot);
        const node = graph.nodes[0];
        expect(node?.meta).toBeDefined();
        expect(typeof node?.meta?.cohesion).toBe('number');
        // cohesion = internalCallCount / (internalCallCount + externalCallCount) = 4/5 = 80%
        expect(node?.meta?.cohesion).toBe(80);
    });

    it('returns empty nodes/edges for snapshot with no clusters', () => {
        const snapshot: Snapshot = { files: {}, apiIndex: {}, graphs: {}, clusters: {} };
        const graph = buildFeatureGraph(snapshot);
        expect(graph.nodes).toHaveLength(0);
        expect(graph.edges).toHaveLength(0);
    });

    it('anchors are set for each node', () => {
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
        const graph = buildFeatureGraph(snapshot);
        for (const node of graph.nodes) {
            expect(graph.anchors[node.id]).toBeDefined();
        }
    });

    it('meta includes clusterCount', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });
        const graph = buildFeatureGraph(snapshot);
        expect(graph.meta?.clusterCount).toBe(2);
    });

    it('scopes graph to serviceId when provided', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,       // serviceId: 'service:orders'
            'cluster:payments': paymentsCluster, // serviceId: 'service:billing'
        });
        const graph = buildFeatureGraph(snapshot, undefined, 'service:orders');
        expect(graph.graphId).toBe('feature:service:orders');
        // Only auth cluster belongs to service:orders
        expect(graph.nodes).toHaveLength(1);
        expect(graph.nodes[0]?.label).toBe('auth');
    });

    it('returns workspace-wide graph when no serviceId provided', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });
        const graph = buildFeatureGraph(snapshot);
        expect(graph.graphId).toBe('feature:workspace');
        expect(graph.nodes).toHaveLength(2);
    });

    it('node meta includes serviceId from cluster', () => {
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
        const graph = buildFeatureGraph(snapshot);
        expect(graph.nodes[0]?.meta?.serviceId).toBe('service:orders');
    });

    // --- Multi-service orchestration (Issue 3) ---

    it('each service gets its own graphId when called per-service', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,        // service:orders
            'cluster:payments': paymentsCluster, // service:billing
        });

        const ordersGraph = buildFeatureGraph(snapshot, undefined, 'service:orders');
        const billingGraph = buildFeatureGraph(snapshot, undefined, 'service:billing');

        expect(ordersGraph.graphId).toBe('feature:service:orders');
        expect(billingGraph.graphId).toBe('feature:service:billing');
    });

    it('service:billing graph does NOT contain service:orders clusters', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });

        const billingGraph = buildFeatureGraph(snapshot, undefined, 'service:billing');
        const labels = billingGraph.nodes.map(n => n.label);

        expect(labels).toContain('payments');
        expect(labels).not.toContain('auth');
    });

    it('multi-service orchestration produces no feature:workspace graph', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': authCluster,
            'cluster:payments': paymentsCluster,
        });

        // Simulate what initialize() does for multi-service repos:
        // call buildFeatureGraph once per service, never without serviceId
        const services = ['service:orders', 'service:billing'];
        const graphs = services.map(svcId => buildFeatureGraph(snapshot, undefined, svcId));

        expect(graphs.every(g => g.graphId !== 'feature:workspace')).toBe(true);
        expect(graphs.map(g => g.graphId)).toEqual([
            'feature:service:orders',
            'feature:service:billing',
        ]);
    });

    // Issue #773: multi-binary repos (one Louvain mega-cluster per
    // service) should expose sub-cluster nodes at the workspace level
    // so users see actual feature areas instead of N service-summary
    // nodes. The fix in buildFeatureGraph splices `subClusters` in
    // place of their parent when no serviceId is given.
    it('#773 expands subClusters into workspace nodes (multi-binary case)', () => {
        const subA: FeatureCluster = {
            id: 'cluster:rest.auth',
            label: 'auth',
            serviceId: 'service:rest',
            files: ['rest/auth.go'],
            entryPoints: [],
            apisInCluster: [],
            internalCallCount: 3,
            externalCallCount: 0,
        };
        const subB: FeatureCluster = {
            id: 'cluster:rest.articles',
            label: 'articles',
            serviceId: 'service:rest',
            files: ['rest/articles.go'],
            entryPoints: [],
            apisInCluster: [],
            internalCallCount: 5,
            externalCallCount: 1,
        };
        const restMega: FeatureCluster = {
            id: 'cluster:rest',
            label: 'rest',
            serviceId: 'service:rest',
            files: ['rest/auth.go', 'rest/articles.go'],
            entryPoints: [],
            apisInCluster: [],
            internalCallCount: 10,
            externalCallCount: 0,
            subClusters: { 'cluster:rest.auth': subA, 'cluster:rest.articles': subB },
        };
        const snapshot = makeSnapshotWithClusters({ 'cluster:rest': restMega });
        const graph = buildFeatureGraph(snapshot);
        // Without the fix this would have one node ('rest'). With the
        // fix the parent gets dropped and the two sub-clusters surface.
        const labels = graph.nodes.map(n => n.label).sort();
        expect(labels).toEqual(['articles', 'auth']);
        // serviceId is carried through so the renderer can show a badge.
        for (const node of graph.nodes) {
            expect(node.meta?.serviceId).toBe('service:rest');
        }
    });

    it('#773 service-scoped view ignores the subClusters expansion', () => {
        const sub: FeatureCluster = {
            id: 'cluster:rest.auth',
            label: 'auth',
            serviceId: 'service:rest',
            files: ['rest/auth.go'],
            entryPoints: [],
            apisInCluster: [],
            internalCallCount: 3,
            externalCallCount: 0,
        };
        const parent: FeatureCluster = {
            id: 'cluster:rest',
            label: 'rest',
            serviceId: 'service:rest',
            files: ['rest/auth.go'],
            entryPoints: [],
            apisInCluster: [],
            internalCallCount: 3,
            externalCallCount: 0,
            subClusters: { 'cluster:rest.auth': sub },
        };
        const snapshot = makeSnapshotWithClusters({ 'cluster:rest': parent });
        // Per-service drill-down keeps the original parent cluster so
        // the user can still see the mega-cluster summary.
        const svc = buildFeatureGraph(snapshot, undefined, 'service:rest');
        expect(svc.nodes.map(n => n.label)).toEqual(['rest']);
    });

    it('single-service repo still uses feature:workspace', () => {
        const snapshot = makeSnapshotWithClusters({
            'cluster:auth': { ...authCluster, serviceId: 'service:main' },
        });

        // For single service, no serviceId → workspace-wide fallback
        const graph = buildFeatureGraph(snapshot);

        expect(graph.graphId).toBe('feature:workspace');
        expect(graph.nodes).toHaveLength(1);
    });

    it('node meta includes apisInCluster array', () => {
        const clusterWithApis: FeatureCluster = {
            ...authCluster,
            apisInCluster: [
                {
                    apiId: 'api:login',
                    method: 'POST',
                    route: '/login',
                    handlerName: 'loginHandler',
                    filePath: 'auth/login.ts',
                    anchor: { filePath: 'auth/login.ts' },
                },
            ],
        };
        const snapshot = makeSnapshotWithClusters({ 'cluster:auth': clusterWithApis });
        const graph = buildFeatureGraph(snapshot);
        const apisInCluster = graph.nodes[0]?.meta?.apisInCluster as any[];
        expect(Array.isArray(apisInCluster)).toBe(true);
        expect(apisInCluster).toHaveLength(1);
        expect(apisInCluster[0]?.route).toBe('/login');
    });

    // UX-8 (2026-06-04) — when the workspace's Domain detector has
    // produced verb-phrase domains, each Modules cluster node should
    // carry the dominant domain phrase in its meta so the renderer can
    // show "auth" with subtitle "Authenticate users".
    describe('UX-8: domainPhrase on cluster nodes', () => {
        it('attaches meta.domainPhrase when a domain overlaps cluster files', () => {
            const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
            snapshot.domains = {
                'domain:auth': {
                    id: 'domain:auth',
                    name: 'Authenticate users',
                    verb: 'authenticate',
                    routes: [],
                    files: ['auth/login.ts', 'auth/logout.ts'],
                    confidence: 0.9,
                },
            };
            const graph = buildFeatureGraph(snapshot);
            expect(graph.nodes[0]?.meta?.domainPhrase).toBe('Authenticate users');
        });

        it('omits meta.domainPhrase when no domain overlaps the cluster', () => {
            const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
            snapshot.domains = {
                'domain:other': {
                    id: 'domain:other',
                    name: 'Manage profiles',
                    verb: 'manage',
                    routes: [],
                    files: ['profile/edit.ts'],
                    confidence: 0.7,
                },
            };
            const graph = buildFeatureGraph(snapshot);
            expect(graph.nodes[0]?.meta?.domainPhrase).toBeUndefined();
        });

        it('omits meta.domainPhrase when snapshot.domains is absent', () => {
            const snapshot = makeSnapshotWithClusters({ 'cluster:auth': authCluster });
            const graph = buildFeatureGraph(snapshot);
            expect(graph.nodes[0]?.meta?.domainPhrase).toBeUndefined();
        });
    });

    // BUG-EXPLORE-5: a FE/mobile MONOREPO over-fragments the workspace L2a into
    // dozens of Louvain micro-clusters (89 features for 114 entry points on
    // ts-react-native). When SCREENS DOMINATE the workspace (≥3 screens, and at
    // least as many as HTTP routes), the workspace feature graph should be an
    // aggregated SCREEN LIST instead of clusters.
    describe('screen-dominant workspace → aggregated screen list (BUG-EXPLORE-5)', () => {
        const screen = (routePath: string) => ({
            screenId: `screen:app:${routePath}`, serviceId: 'service:app', routePath,
            framework: 'react-native' as any, filePath: `app/${routePath.slice(1)}.tsx`,
            anchor: { filePath: 'app/x.tsx', symbol: 'S', span: { start: 0, end: 1 } },
        });
        const apiRec = (method: string, route: string) => ({ apiId: `${method}:${route}`, method, route, handlerName: 'h', filePath: 's.ts' });

        it('renders a screen list when screens dominate (mobile monorepo, few/no HTTP)', () => {
            const snap: Snapshot = {
                files: {}, apiIndex: {}, graphs: {}, clusters: {},
                screens: { a: screen('/home'), b: screen('/feed'), c: screen('/profile') } as any,
            };
            const graph = buildFeatureGraph(snap);
            expect(graph.meta?.mode).toBe('screen-list');
            expect(graph.meta?.screenCount).toBe(3);
            expect(graph.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(['/home', '/feed', '/profile']));
        });

        it('keeps cluster rendering when HTTP routes dominate (backend with a stray screen)', () => {
            const snap: Snapshot = {
                files: { 's.ts': { content: '', symbols: { functions: [], vars: [], imports: [] }, lastModified: 0 } },
                apiIndex: {
                    'GET:/a': apiRec('GET', '/a'), 'POST:/b': apiRec('POST', '/b'), 'GET:/c': apiRec('GET', '/c'),
                    'PUT:/d': apiRec('PUT', '/d'), 'DELETE:/e': apiRec('DELETE', '/e'),
                } as any,
                graphs: {},
                clusters: { 'cluster:x': { id: 'cluster:x', label: 'x', serviceId: 'service:s', files: ['s.ts'], entryPoints: [], apisInCluster: [], internalCallCount: 1, externalCallCount: 0 } },
                screens: { a: screen('/lonely') } as any,
            };
            const graph = buildFeatureGraph(snap);
            expect(graph.meta?.mode).not.toBe('screen-list');
        });
    });

    // BUG-EXPLORE-13: a newly-added route shows in L2a Feature Areas as `~ modified`
    // instead of `+ added`. Root cause: the feature graph embeds each cluster's
    // `apisInCluster` records verbatim, and those records may carry a STALE `.diff`
    // (from a prior cascade, or a coarse file-change heuristic) that predates
    // buildApiListGraph writing the authoritative `computeApiDiff` result back onto
    // apiIndex. The embedded L2a copy must be re-diffed against baseline so
    // "absent from baseline → added" always wins.
    describe('embedded apisInCluster diff is recomputed against baseline (BUG-EXPLORE-13)', () => {
        const apiRec = (method: string, route: string, diff?: string) => ({
            apiId: `${method}:${route}`, method, route, handlerName: 'h',
            filePath: 'tags.controller.ts',
            anchor: { filePath: 'tags.controller.ts', symbol: 'h', span: { start: 0, end: 1 } },
            ...(diff ? { diff } : {}),
        });
        const fileRec = { content: '', symbols: { functions: [], vars: [], imports: [] }, lastModified: 0 };

        it('re-labels an added route as "added" even when its embedded record says "modified"', () => {
            // The new route carries a STALE diff:"modified" on its own record.
            const added = apiRec('GET', '/api/tags/popular', 'modified');
            const existing = apiRec('GET', '/api/tags', 'unchanged');
            const cluster: FeatureCluster = {
                id: 'cluster:tags', label: 'tags', serviceId: 'service:main',
                files: ['tags.controller.ts'], entryPoints: [],
                apisInCluster: [existing, added],
                internalCallCount: 2, externalCallCount: 0,
            };
            const working: Snapshot = {
                files: { 'tags.controller.ts': fileRec },
                apiIndex: { [existing.apiId]: existing as any, [added.apiId]: added as any },
                graphs: {}, clusters: { 'cluster:tags': cluster },
            };
            // Baseline lacks the new route entirely.
            const baseline: Snapshot = {
                files: { 'tags.controller.ts': fileRec },
                apiIndex: { [existing.apiId]: apiRec('GET', '/api/tags') as any },
                graphs: {}, clusters: { 'cluster:tags': { ...cluster, apisInCluster: [apiRec('GET', '/api/tags')] as any } },
            };
            const graph = buildFeatureGraph(working, baseline);
            const node = graph.nodes.find((n) => (n.meta?.apisInCluster as any[])?.length);
            const embedded = (node?.meta?.apisInCluster as any[]) ?? [];
            const newRow = embedded.find((a) => a.route === '/api/tags/popular');
            expect(newRow?.diff).toBe('added');
        });

        it('embedded api is a DECOUPLED copy — a later apiIndex mutation cannot bleed in', () => {
            // Regression for the LLM-naming cascade aliasing: after buildFeatureGraph,
            // syncOrchestrator re-runs buildApiListGraph(working, working) which mutates
            // apiIndex[id].diff back to a coarse "modified". If apisInCluster held the
            // shared apiIndex reference, that write would surface in the L2a.
            const added = apiRec('GET', '/api/tags/popular'); // diff undefined → computed 'added'
            const cluster: FeatureCluster = {
                id: 'cluster:tags', label: 'tags', serviceId: 'service:main',
                files: ['tags.controller.ts'], entryPoints: [],
                apisInCluster: [added],
                internalCallCount: 1, externalCallCount: 0,
            };
            const working: Snapshot = {
                files: { 'tags.controller.ts': fileRec },
                apiIndex: { [added.apiId]: added as any },
                graphs: {}, clusters: { 'cluster:tags': cluster },
            };
            const baseline: Snapshot = {
                files: { 'tags.controller.ts': fileRec },
                apiIndex: {}, graphs: {}, clusters: {},
            };
            const graph = buildFeatureGraph(working, baseline);
            // Simulate the post-build apiIndex mutation (buildApiListGraph(working, working)).
            (working.apiIndex[added.apiId] as any).diff = 'modified';
            const node = graph.nodes.find((n) => (n.meta?.apisInCluster as any[])?.length);
            const embedded = (node?.meta?.apisInCluster as any[]) ?? [];
            const newRow = embedded.find((a) => a.route === '/api/tags/popular');
            expect(newRow?.diff).toBe('added'); // stayed 'added', not aliased to 'modified'
        });
    });
});
