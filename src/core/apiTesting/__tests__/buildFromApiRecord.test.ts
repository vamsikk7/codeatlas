/**
 * buildFromApiRecord.test.ts — Issue #601 Phase 1.
 */

import { describe, it, expect } from 'vitest';
import { buildApiTestingPayload } from '../buildFromApiRecord';
import type { Snapshot, ApiRecord, FeatureCluster } from '../../graph/graphTypes';

function api(opts: Partial<ApiRecord> & { apiId: string; method: string; route: string; filePath: string }): ApiRecord {
    return {
        method: opts.method,
        route: opts.route,
        apiId: opts.apiId,
        handlerName: opts.handlerName ?? 'handler',
        filePath: opts.filePath,
        anchor: { filePath: opts.filePath },
        ...opts,
    };
}

function snapshotWith(apis: ApiRecord[], clusters: FeatureCluster[]): Snapshot {
    const apiIndex: Record<string, ApiRecord> = {};
    for (const a of apis) apiIndex[a.apiId] = a;
    const clusterIndex: Record<string, FeatureCluster> = {};
    for (const c of clusters) clusterIndex[c.id] = c;
    return {
        files: {},
        apiIndex,
        graphs: {},
        clusters: clusterIndex,
    };
}

describe('buildApiTestingPayload', () => {
    it('returns an empty payload when no APIs are present', () => {
        const out = buildApiTestingPayload(snapshotWith([], []));
        expect(out.totalEndpoints).toBe(0);
        expect(out.collections).toEqual([]);
    });

    it('groups endpoints by L2a cluster membership', () => {
        const apis = [
            api({ apiId: 'a1', method: 'GET', route: '/api/articles', filePath: 'src/articles.ts' }),
            api({ apiId: 'a2', method: 'POST', route: '/api/articles', filePath: 'src/articles.ts' }),
            api({ apiId: 'a3', method: 'POST', route: '/api/users/login', filePath: 'src/auth.ts' }),
        ];
        const clusters: FeatureCluster[] = [
            { id: 'cluster:articles', name: 'articles', files: ['src/articles.ts'], clusterId: 'c1', subClusters: [], confidence: 1 },
            { id: 'cluster:auth', name: 'auth', files: ['src/auth.ts'], clusterId: 'c2', subClusters: [], confidence: 1 },
        ];
        const out = buildApiTestingPayload(snapshotWith(apis, clusters));
        expect(out.totalEndpoints).toBe(3);
        const articles = out.collections.find(c => c.id === 'cluster:articles')!;
        const auth = out.collections.find(c => c.id === 'cluster:auth')!;
        expect(articles.endpoints).toHaveLength(2);
        expect(auth.endpoints).toHaveLength(1);
        expect(articles.label).toBe('articles');
        expect(auth.label).toBe('auth');
    });

    it('sorts collections by endpoint count DESC with Other last', () => {
        const apis = [
            api({ apiId: 'a1', method: 'GET', route: '/api/x', filePath: 'src/many.ts' }),
            api({ apiId: 'a2', method: 'POST', route: '/api/y', filePath: 'src/many.ts' }),
            api({ apiId: 'a3', method: 'POST', route: '/api/z', filePath: 'src/many.ts' }),
            api({ apiId: 'a4', method: 'GET', route: '/api/single', filePath: 'src/one.ts' }),
            api({ apiId: 'a5', method: 'GET', route: '/api/orphan', filePath: 'src/unmapped.ts' }),
        ];
        const clusters: FeatureCluster[] = [
            { id: 'cluster:many', name: 'many', files: ['src/many.ts'], clusterId: 'c1', subClusters: [], confidence: 1 },
            { id: 'cluster:single', name: 'single', files: ['src/one.ts'], clusterId: 'c2', subClusters: [], confidence: 1 },
        ];
        const out = buildApiTestingPayload(snapshotWith(apis, clusters));
        expect(out.collections.map(c => c.id)).toEqual([
            'cluster:many',     // 3 endpoints
            'cluster:single',   // 1 endpoint
            'collection:other', // unmapped — always last
        ]);
    });

    it('drops endpoints into Other when no cluster matches the file', () => {
        const apis = [api({ apiId: 'a1', method: 'GET', route: '/x', filePath: 'src/orphan.ts' })];
        const out = buildApiTestingPayload(snapshotWith(apis, []));
        expect(out.collections).toHaveLength(1);
        expect(out.collections[0].id).toBe('collection:other');
        expect(out.collections[0].endpoints[0].id).toBe('a1');
    });

    it('passes through schema metadata + auth + webhook flags', () => {
        const apis = [
            api({
                apiId: 'a1', method: 'POST', route: '/api/articles', filePath: 'src/articles.ts',
                meta: {
                    auth: 'required',
                    requestSchema: {
                        kind: 'json',
                        source: 'zod',
                        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
                    },
                    webhook: true,
                    webhookProvider: 'stripe',
                },
            }),
        ];
        const out = buildApiTestingPayload(snapshotWith(apis, []));
        const ep = out.collections[0].endpoints[0];
        expect(ep.auth).toBe('required');
        expect(ep.webhook).toBe(true);
        expect(ep.webhookProvider).toBe('stripe');
        expect(ep.requestSchema?.source).toBe('zod');
        expect(ep.requestSchema?.schema?.required).toEqual(['title']);
    });

    it('sorts endpoints within a collection by method then route', () => {
        const apis = [
            api({ apiId: 'a1', method: 'POST', route: '/articles', filePath: 'src/a.ts' }),
            api({ apiId: 'a2', method: 'GET', route: '/articles', filePath: 'src/a.ts' }),
            api({ apiId: 'a3', method: 'GET', route: '/articles/:id', filePath: 'src/a.ts' }),
        ];
        const out = buildApiTestingPayload(snapshotWith(apis, []));
        const ordered = out.collections[0].endpoints.map(e => `${e.method} ${e.route}`);
        expect(ordered).toEqual(['GET /articles', 'GET /articles/:id', 'POST /articles']);
    });
});
