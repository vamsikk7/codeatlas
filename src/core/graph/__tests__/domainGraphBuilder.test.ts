/**
 * domainGraphBuilder.test.ts — Issue #701 Domain graph builder tests.
 */

import { describe, it, expect } from 'vitest';
import { buildDomainGraph, DOMAIN_GRAPH_ID } from '../domainGraphBuilder';
import type { Snapshot, DomainCluster, ApiRecord } from '../graphTypes';

function api(id: string, route: string, filePath: string, handlerName = 'handler'): ApiRecord {
    return {
        apiId: id,
        method: 'GET',
        route,
        handlerName,
        filePath,
        anchor: { filePath, span: { start: 0, end: 1 } },
    };
}

function emptySnapshot(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

function domain(id: string, name: string, overrides: Partial<DomainCluster> = {}): DomainCluster {
    return {
        id,
        name,
        verb: 'verb',
        routes: [],
        files: [],
        confidence: 0.5,
        ...overrides,
    };
}

describe('buildDomainGraph', () => {
    it('returns a graph with the well-known id and type', () => {
        const g = buildDomainGraph({}, emptySnapshot());
        expect(g.graphId).toBe(DOMAIN_GRAPH_ID);
        expect(g.type).toBe('domain');
    });

    it('emits one node per domain with the verb + confidence in meta', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': domain('domain:auth', 'Authenticate users', { verb: 'authenticate', confidence: 0.6 }),
            'domain:pay': domain('domain:pay', 'Process payments', { verb: 'process', confidence: 0.4 }),
        };
        const g = buildDomainGraph(domains, emptySnapshot());
        expect(g.nodes).toHaveLength(2);
        const auth = g.nodes.find(n => n.label === 'Authenticate users')!;
        expect(auth.meta?.verb).toBe('authenticate');
        expect(auth.meta?.confidence).toBe(0.6);
    });

    it('orders nodes by confidence DESC, then name, with Other last', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:z': domain('domain:z', 'Zzz', { confidence: 0.6 }),
            'domain:a': domain('domain:a', 'Aaa', { confidence: 0.6 }),
            'domain:low': domain('domain:low', 'Low', { confidence: 0.4 }),
            'domain:other': domain('domain:other', 'Other', { confidence: 0.2 }),
        };
        const g = buildDomainGraph(domains, emptySnapshot());
        expect(g.nodes.map(n => n.label)).toEqual(['Aaa', 'Zzz', 'Low', 'Other']);
    });

    it('drill-down resolves to a route sequence graph when one exists', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a1: api('a1', '/auth/login', 'src/login.ts', 'loginHandler'),
            },
        };
        const domains: Record<string, DomainCluster> = {
            'domain:auth': domain('domain:auth', 'Authenticate users', { routes: ['a1'], files: ['src/login.ts'] }),
        };
        const g = buildDomainGraph(domains, snapshot);
        const node = g.nodes[0];
        expect(node.meta?.drillDownGraphId).toBe('sequence:src/login.ts:loginHandler');
    });

    it('drill-down falls back to file graph when domain has files but no handler-named route', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:misc': domain('domain:misc', 'Other', { files: ['src/util.ts'] }),
        };
        const g = buildDomainGraph(domains, emptySnapshot());
        expect(g.nodes[0].meta?.drillDownGraphId).toBe('file:src/util.ts');
    });

    it('emits overlap edges between domains that share files', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': domain('domain:auth', 'Authenticate users', { files: ['shared.ts', 'auth.ts'] }),
            'domain:profile': domain('domain:profile', 'Manage profiles', { files: ['shared.ts', 'profile.ts'] }),
        };
        const g = buildDomainGraph(domains, emptySnapshot());
        expect(g.edges).toHaveLength(1);
        expect(g.edges[0].label).toBe('shares 1 file');
        expect(g.edges[0].meta?.overlap).toBe(1);
    });

    it('no overlap edges when domains have disjoint file sets', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': domain('domain:auth', 'Authenticate users', { files: ['auth.ts'] }),
            'domain:profile': domain('domain:profile', 'Manage profiles', { files: ['profile.ts'] }),
        };
        const g = buildDomainGraph(domains, emptySnapshot());
        expect(g.edges).toEqual([]);
    });

    it('subtitle includes route + file count + confidence percentage', () => {
        const domains: Record<string, DomainCluster> = {
            'domain:auth': domain('domain:auth', 'Authenticate users', {
                routes: ['a', 'b'],
                files: ['x.ts', 'y.ts'],
                confidence: 0.6,
            }),
        };
        const g = buildDomainGraph(domains, emptySnapshot());
        expect(g.nodes[0].subtitle).toBe('2 routes · 2 files · conf 60%');
    });

    it('graph meta exposes domainCount + companionGraphId', () => {
        const g = buildDomainGraph(
            { 'd1': domain('d1', 'one'), 'd2': domain('d2', 'two') },
            emptySnapshot(),
        );
        expect(g.meta.domainCount).toBe(2);
        expect(g.meta.companionGraphId).toBe('feature:workspace');
    });

    describe('Issue #740 — bubble cascade modified state from routes', () => {
        it('domain whose route is modified in the L2b api-list gets diff=modified', () => {
            const domains = {
                'domain:auth': domain('domain:auth', 'Authenticate users', { routes: ['api:1'] }),
            };
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') },
                graphs: {
                    'api-list:cluster:auth': {
                        graphId: 'api-list:cluster:auth', type: 'api-list', nodes: [], edges: [], anchors: {},
                        meta: { apis: [{ apiId: 'api:1', method: 'GET', route: '/login', diff: 'modified' }] },
                    } as any,
                },
            };
            const g = buildDomainGraph(domains, snapshot);
            expect(g.nodes[0].diff).toBe('modified');
        });

        it('domain with no modified routes stays unchanged', () => {
            const domains = {
                'domain:auth': domain('domain:auth', 'Authenticate users', { routes: ['api:1'] }),
            };
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') },
                graphs: {
                    'api-list:cluster:auth': {
                        graphId: 'api-list:cluster:auth', type: 'api-list', nodes: [], edges: [], anchors: {},
                        meta: { apis: [{ apiId: 'api:1', method: 'GET', route: '/login', diff: 'unchanged' }] },
                    } as any,
                },
            };
            const g = buildDomainGraph(domains, snapshot);
            expect(g.nodes[0].diff).toBeUndefined();
        });

        it('explicit domain.diff="added" wins over a route-bubbled modified', () => {
            // diffDomains pre-stamped the domain as 'added' (new since
            // baseline). One of its routes also has 'modified' in L2b.
            // The pre-stamped 'added' must be preserved.
            const domains = {
                'domain:new': domain('domain:new', 'New', { routes: ['api:1'], diff: 'added' }),
            };
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                apiIndex: { 'api:1': api('api:1', '/x', 'src/a.ts') },
                graphs: {
                    'api-list:cluster:c': {
                        graphId: 'api-list:cluster:c', type: 'api-list', nodes: [], edges: [], anchors: {},
                        meta: { apis: [{ apiId: 'api:1', method: 'GET', route: '/x', diff: 'modified' }] },
                    } as any,
                },
            };
            const g = buildDomainGraph(domains, snapshot);
            expect(g.nodes[0].diff).toBe('added');
        });
    });
});
