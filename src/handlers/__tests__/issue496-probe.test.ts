/**
 * #496 regression: timeline replay's L2b API List panel must isolate APIs to
 * the panel's own cluster. No api whose `filePath` lives outside the cluster's
 * `files[]` array should appear in that cluster's panel.
 *
 * Modelled after the live failure mode reported on
 * node-express-realworld-example-app: edit `getCurrentUser` in
 * `auth.service.ts`, navigate timeline replay to "Working (uncommitted) · L2b
 * API List — auth · Step 5/6", and observe 19 APIs (4 auth + 15 article) in
 * the auth panel.
 *
 * The data-layer probe was performed against the actual SQLite state and
 * showed buildWorkingDiffBundle producing 4 apis for auth and 15 for article
 * — i.e. the data path is correct. This regression test pins that invariant.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildWorkingDiffBundle } from '../replayWorkingChanges';
import { buildApiListGraph } from '../../core/graph/apiListGraphBuilder';
import type { Snapshot, FeatureCluster, ApiRecord, FileRecord } from '../../core/graph/graphTypes';

function hashOf(s: string): string { return createHash('sha256').update(s).digest('hex'); }

function fileRecord(path: string, content: string): FileRecord {
    return {
        path, hash: hashOf(content), mtime: 0,
        symbols: { imports: [], variables: [], functions: [] },
    } as FileRecord;
}

function apiRecord(method: string, route: string, filePath: string, handlerName: string): ApiRecord {
    return {
        apiId: `${method}:${route}@${filePath}`,
        method, route, filePath, handlerName,
        anchor: { filePath, symbol: handlerName },
    };
}

function cluster(id: string, label: string, files: string[], apis: ApiRecord[]): FeatureCluster {
    return {
        id, label, name: label, files, modules: [],
        entryPoints: [],
        apisInCluster: apis,
        screensInCluster: [], navRoutesInCluster: [], networkCallsInCluster: [], diBindingsInCluster: [],
        crossClusterEdges: { incoming: [], outgoing: [] },
    } as any;
}

describe('#496 — Timeline replay api-list cluster isolation', () => {
    it('buildWorkingDiffBundle keeps each cluster api-list scoped to that cluster files', () => {
        // Mirrors realworld-example-app shape: auth (4 apis, 5 files), article (15 apis, 6 files).
        const authFiles = [
            'src/app/routes/auth/auth.controller.ts',
            'src/app/routes/auth/auth.service.ts',
            'src/app/routes/auth/token.utils.ts',
            'src/app/routes/auth/user-request.d.ts',
            'src/app/routes/auth/registered-user.model.ts',
        ];
        const articleFiles = [
            'src/app/routes/article/article.controller.ts',
            'src/app/routes/article/article.service.ts',
            'src/app/routes/article/article.model.ts',
            'src/app/routes/article/comment.model.ts',
            'src/app/routes/article/article.mapper.ts',
            'src/app/routes/auth/user.model.ts',  // realworld actually has this in article cluster
        ];
        const authApis: ApiRecord[] = [
            apiRecord('POST', '/api/users', authFiles[0], 'anonymous@POST:/users'),
            apiRecord('POST', '/api/users/login', authFiles[0], 'anonymous@POST:/users/login'),
            apiRecord('GET', '/api/user', authFiles[0], 'anonymous@GET:/user'),
            apiRecord('PUT', '/api/user', authFiles[0], 'anonymous@PUT:/user'),
        ];
        const articleApis: ApiRecord[] = Array.from({ length: 15 }, (_, i) =>
            apiRecord('GET', `/api/articles/r${i}`, articleFiles[0], `anonymous@GET:/articles/r${i}`)
        );

        const allFiles: Record<string, FileRecord> = {};
        for (const fp of [...authFiles, ...articleFiles]) {
            allFiles[fp] = fileRecord(fp, `// content of ${fp}`);
        }
        const allApiIndex: Record<string, ApiRecord> = {};
        for (const a of [...authApis, ...articleApis]) allApiIndex[a.apiId] = a;

        const baseline: Snapshot = {
            files: allFiles, apiIndex: allApiIndex,
            clusters: {
                'cluster:auth': cluster('cluster:auth', 'auth', authFiles, authApis),
                'cluster:article': cluster('cluster:article', 'article', articleFiles, articleApis),
            },
            services: {}, graphs: {}, callGraph: { edges: [] },
        } as any;

        // Working: simulate a body-only edit to auth.service.ts (different hash).
        const workingFiles: Record<string, FileRecord> = { ...allFiles };
        workingFiles[authFiles[1]] = fileRecord(authFiles[1], `// EDITED content of ${authFiles[1]}`);

        const working: Snapshot = {
            ...baseline,
            files: workingFiles,
        } as any;

        const bundle = buildWorkingDiffBundle(baseline, working);

        const authPanel = bundle['api-list:cluster:auth'];
        const articlePanel = bundle['api-list:cluster:article'];

        const authApisOut = ((authPanel?.meta as any)?.apis ?? []) as ApiRecord[];
        const articleApisOut = ((articlePanel?.meta as any)?.apis ?? []) as ApiRecord[];

        // Every api in the auth panel must have its filePath in the auth cluster's files.
        const authFilesSet = new Set(authFiles);
        const articleFilesSet = new Set(articleFiles);

        const foreignInAuth = authApisOut.filter(a => !authFilesSet.has(a.filePath));
        const foreignInArticle = articleApisOut.filter(a => !articleFilesSet.has(a.filePath));

        expect(
            foreignInAuth.length,
            `auth panel must not contain APIs from other clusters; got: ${foreignInAuth.map(a => `${a.method} ${a.route} @ ${a.filePath}`).join(', ')}`,
        ).toBe(0);
        expect(
            foreignInArticle.length,
            `article panel must not contain APIs from other clusters; got: ${foreignInArticle.map(a => `${a.method} ${a.route} @ ${a.filePath}`).join(', ')}`,
        ).toBe(0);

        // And: count must match the cluster's apisInCluster (no spurious additions).
        expect(authApisOut.length).toBe(authApis.length);
        expect(articleApisOut.length).toBe(articleApis.length);
    });

    /**
     * #496 defensive guard test: even if upstream `cluster.apisInCluster` is
     * polluted (e.g., Louvain misbehaviour merges two feature dirs and the
     * directory-split fails, OR a stale baseline cluster gets re-used with
     * foreign apis), the api-list builder MUST drop apis whose filePath is
     * outside the cluster's own files. The user's screenshot showed the auth
     * panel containing 19 apis (4 auth + 15 article); this test pins the
     * downstream filter so that scenario can't surface again in the UI.
     */
    it('filters out APIs whose filePath is outside cluster.files (defensive guard #496)', () => {
        // Author a deliberately-polluted auth cluster: apisInCluster contains
        // BOTH auth and article routes, but cluster.files only lists auth/.
        // Pre-fix, the builder trusted apisInCluster and emitted all 19; the
        // L2b panel would show foreign article rows under the auth header.
        const authFiles = ['src/app/routes/auth/auth.controller.ts'];
        const authApi = apiRecord('GET', '/api/user', authFiles[0], 'getCurrentUser');
        const articleApi = apiRecord('GET', '/api/articles', 'src/app/routes/article/article.controller.ts', 'getArticles');
        const pollutedCluster = cluster('cluster:auth', 'auth', authFiles, [authApi, articleApi]);

        const files: Record<string, FileRecord> = {
            [authFiles[0]]: fileRecord(authFiles[0], '// auth'),
            'src/app/routes/article/article.controller.ts': fileRecord('src/app/routes/article/article.controller.ts', '// article'),
        };
        const apiIndex: Record<string, ApiRecord> = { [authApi.apiId]: authApi, [articleApi.apiId]: articleApi };
        const baseline: Snapshot = {
            files, apiIndex,
            clusters: { 'cluster:auth': pollutedCluster },
            services: {}, graphs: {}, callGraph: { edges: [] },
        } as any;
        const working: Snapshot = baseline;

        const bundle = buildWorkingDiffBundle(baseline, working);
        const authPanel = bundle['api-list:cluster:auth'];
        const apis = ((authPanel?.meta as any)?.apis ?? []) as ApiRecord[];

        // Pre-fix: would be 2 (auth + article). Post-fix: must be 1 (auth only).
        expect(apis.length).toBe(1);
        expect(apis[0].route).toBe('/api/user');
        expect(apis.every(a => a.filePath?.startsWith('src/app/routes/auth/'))).toBe(true);
    });

    // Same defensive guard, exercised through the live cascade builder (not the
    // commit-replay path). buildApiListGraph is what runs on every save.
    it('live cascade buildApiListGraph also filters foreign apis (#496)', () => {
        const authFiles = ['src/app/routes/auth/auth.controller.ts'];
        const authApi = apiRecord('GET', '/api/user', authFiles[0], 'getCurrentUser');
        const articleApi = apiRecord('GET', '/api/articles', 'src/app/routes/article/article.controller.ts', 'getArticles');
        const pollutedCluster = cluster('cluster:auth', 'auth', authFiles, [authApi, articleApi]);

        const files: Record<string, FileRecord> = {
            [authFiles[0]]: fileRecord(authFiles[0], '// auth'),
            'src/app/routes/article/article.controller.ts': fileRecord('src/app/routes/article/article.controller.ts', '// article'),
        };
        const apiIndex: Record<string, ApiRecord> = { [authApi.apiId]: authApi, [articleApi.apiId]: articleApi };
        const working: Snapshot = {
            files, apiIndex,
            clusters: { 'cluster:auth': pollutedCluster },
            services: {}, graphs: {}, callGraph: { edges: [] },
        } as any;
        const baseline: Snapshot = working;

        const graph = buildApiListGraph(pollutedCluster, working, baseline);
        const apis = (graph.meta as any).apis as ApiRecord[];
        expect(apis.length).toBe(1);
        expect(apis[0].route).toBe('/api/user');
    });
});
