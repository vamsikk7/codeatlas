/**
 * apiListGraphBuilder.test.ts — TDD coverage for L2B-3 (2026-06-07).
 *
 * The L2B-3 finding: when Louvain groups a stray file with high call coupling
 * into a cluster whose dominant directory is different (e.g.
 * `article.controller.ts` merged into `cluster:auth` because article handlers
 * call auth.required middleware), the L2b api-list panel shows ALL 19 APIs
 * (15 article + 4 auth) under `cluster:auth` — confusing users who expect
 * "auth" to mean "auth-only".
 *
 * Defensive boundary: in `buildApiListGraph`, when the cluster's apisInCluster
 * spans multiple top-level directories AND there's a clear majority directory
 * matching the cluster label, drop APIs from non-majority directories. The L2a
 * graph keeps the architectural truth (cluster has 8 files including the
 * outlier); L2b shows the dominant-directory APIs only.
 *
 * Trade-off accepted: the user clicking through to L2b sees fewer APIs than
 * `apisInCluster.length` would suggest. The (excludedApiCount) chip in meta
 * surfaces the gap so users can drill into L2a to see the full membership.
 */
import { describe, it, expect } from 'vitest';
import { buildApiListGraph } from '../apiListGraphBuilder';
import type { ApiRecord, FeatureCluster, Snapshot } from '../graphTypes';

function makeApi(method: string, route: string, filePath: string): ApiRecord {
    return {
        apiId: `${method}:${route}::${filePath}::anonymous@${method}:${route}`,
        method,
        route,
        handlerName: `anonymous@${method}:${route}`,
        filePath,
        rawRoute: route,
    } as ApiRecord;
}

function makeSnapshot(apis: ApiRecord[]): Snapshot {
    const apiIndex: Record<string, ApiRecord> = {};
    for (const api of apis) apiIndex[api.apiId] = api;
    return {
        files: {},
        apiIndex,
        graphs: {},
        clusters: {},
    };
}

describe('buildApiListGraph — L2B-3 cross-bleed defense', () => {
    it('drops APIs whose top-level directory does not match the cluster label majority', () => {
        // Reproduces the user-reported case: Louvain merged article.controller.ts
        // (1 file, 15 routes) into cluster:auth because article handlers call
        // auth.required. The cluster's label is "auth" (7/8 files in /auth/).
        // L2b should NOT show the 15 article routes.
        const authFiles = [
            'src/app/routes/auth/auth.controller.ts',
            'src/app/routes/auth/auth.ts',
            'src/app/routes/auth/register-input.model.ts',
            'src/app/routes/auth/registered-user.model.ts',
            'src/app/routes/auth/token.utils.ts',
            'src/app/routes/auth/user-request.d.ts',
            'src/app/routes/auth/user.model.ts',
        ];
        const articleStray = 'src/app/routes/article/article.controller.ts';
        const authApis = [
            makeApi('POST', '/api/users', 'src/app/routes/auth/auth.controller.ts'),
            makeApi('POST', '/api/users/login', 'src/app/routes/auth/auth.controller.ts'),
            makeApi('GET', '/api/user', 'src/app/routes/auth/auth.controller.ts'),
            makeApi('PUT', '/api/user', 'src/app/routes/auth/auth.controller.ts'),
        ];
        const articleApis = Array.from({ length: 15 }, (_, i) =>
            makeApi('GET', `/api/articles/route-${i}`, articleStray),
        );

        const cluster: FeatureCluster = {
            id: 'cluster:auth',
            label: 'auth',
            files: [...authFiles, articleStray],
            entryPoints: [],
            apisInCluster: [...authApis, ...articleApis],
            internalCallCount: 17,
            externalCallCount: 19,
        };

        const snapshot = makeSnapshot([...authApis, ...articleApis]);
        const graph = buildApiListGraph(cluster, snapshot, snapshot);

        // The fix: only the 4 auth APIs land in meta.apis.
        const apis = (graph.meta as any).apis as ApiRecord[];
        expect(apis.length).toBe(4);
        expect(apis.every(a => a.filePath.startsWith('src/app/routes/auth/'))).toBe(true);

        // The architectural truth is preserved in meta.files (L2a still shows 8).
        expect((graph.meta as any).files.length).toBe(8);

        // Surface the gap so users know there were dropped APIs.
        const excluded = (graph.meta as any).excludedApiCount;
        expect(excluded).toBe(15);
    });

    it('keeps all APIs when cluster directory is uniform', () => {
        // Sanity-check: no false positives. A cluster whose files are all under
        // /auth/ should show every API.
        const files = [
            'src/app/routes/auth/auth.controller.ts',
            'src/app/routes/auth/auth.service.ts',
        ];
        const apis = [
            makeApi('POST', '/api/users', 'src/app/routes/auth/auth.controller.ts'),
            makeApi('GET', '/api/user', 'src/app/routes/auth/auth.controller.ts'),
        ];
        const cluster: FeatureCluster = {
            id: 'cluster:auth',
            label: 'auth',
            files,
            entryPoints: [],
            apisInCluster: apis,
            internalCallCount: 4,
            externalCallCount: 1,
        };
        const snapshot = makeSnapshot(apis);
        const graph = buildApiListGraph(cluster, snapshot, snapshot);
        expect(((graph.meta as any).apis as ApiRecord[]).length).toBe(2);
        expect((graph.meta as any).excludedApiCount).toBe(0);
    });

    it('keeps majority-directory APIs even with the cluster label diverging', () => {
        // If the cluster label is e.g. "controllers" but all files are in /auth/,
        // we still treat /auth/ as the dominant segment. The label is advisory;
        // the directory majority drives the filter.
        const files = [
            'src/app/auth/auth.controller.ts',
            'src/app/auth/login.controller.ts',
        ];
        const apis = [
            makeApi('POST', '/login', 'src/app/auth/auth.controller.ts'),
            makeApi('GET', '/user', 'src/app/auth/login.controller.ts'),
        ];
        const cluster: FeatureCluster = {
            id: 'cluster:controllers',
            label: 'controllers',
            files,
            entryPoints: [],
            apisInCluster: apis,
            internalCallCount: 4,
            externalCallCount: 1,
        };
        const snapshot = makeSnapshot(apis);
        const graph = buildApiListGraph(cluster, snapshot, snapshot);
        expect(((graph.meta as any).apis as ApiRecord[]).length).toBe(2);
    });

    it('falls back to keeping all APIs when no single directory dominates', () => {
        // If files split 50/50 across two directories, the filter should NOT
        // discard either side — we can't pick a winner. Better to show
        // everything than to hide arbitrarily.
        const files = [
            'src/auth/login.ts',
            'src/auth/logout.ts',
            'src/billing/charge.ts',
            'src/billing/refund.ts',
        ];
        const apis = [
            makeApi('POST', '/login', 'src/auth/login.ts'),
            makeApi('POST', '/logout', 'src/auth/logout.ts'),
            makeApi('POST', '/charge', 'src/billing/charge.ts'),
            makeApi('POST', '/refund', 'src/billing/refund.ts'),
        ];
        const cluster: FeatureCluster = {
            id: 'cluster:misc',
            label: 'misc',
            files,
            entryPoints: [],
            apisInCluster: apis,
            internalCallCount: 4,
            externalCallCount: 0,
        };
        const snapshot = makeSnapshot(apis);
        const graph = buildApiListGraph(cluster, snapshot, snapshot);
        expect(((graph.meta as any).apis as ApiRecord[]).length).toBe(4);
        expect((graph.meta as any).excludedApiCount).toBe(0);
    });

    it('preserves the existing #496 filter for stale baseline APIs', () => {
        // Stale APIs whose filePath is NOT in cluster.files at all (e.g. from
        // a copied baseline that the user never refreshed) must still be
        // dropped — same as the pre-existing #496 filter.
        const files = ['src/auth/auth.controller.ts'];
        const apis = [
            makeApi('POST', '/login', 'src/auth/auth.controller.ts'),
            makeApi('GET', '/orphan', 'src/legacy/legacy.controller.ts'), // stale
        ];
        const cluster: FeatureCluster = {
            id: 'cluster:auth',
            label: 'auth',
            files,
            entryPoints: [],
            apisInCluster: apis,
            internalCallCount: 4,
            externalCallCount: 0,
        };
        const snapshot = makeSnapshot(apis);
        const graph = buildApiListGraph(cluster, snapshot, snapshot);
        const out = (graph.meta as any).apis as ApiRecord[];
        expect(out.length).toBe(1);
        expect(out[0].route).toBe('/login');
    });
});
