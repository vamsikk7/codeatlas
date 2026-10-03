/**
 * crossRepoEdgesForProducer.test.ts — #817.1 (2026-06-10).
 *
 * Pins `listCrossRepoEdgesForProducer(store, producer)`: the shared
 * helper behind the #817 cross-repo push and the #818 replay coda (and
 * the #827 `includeCrossRepo` glue). Given the aggregator and a producer
 * repo (by repoId, name, or rootPath), returns the consumer→producer
 * edges with consumer names resolved and a deterministic sort.
 */

import { describe, it, expect } from 'vitest';
import { listCrossRepoEdgesForProducer } from '../crossRepoHttpAnalyzer';
import type { IAggregatorStore } from '../../storage/storeInterfaces';

function fakeStore(opts: {
    repos?: Array<{ repoId: string; name: string; rootPath: string }>;
    edges?: Array<{ sourceRepo: string; targetRepo: string; method: string; route: string; diff: string | null }>;
}): IAggregatorStore {
    return {
        listRepos: () => (opts.repos ?? []) as any,
        listCrossRepoHttpEdges: () => (opts.edges ?? []) as any,
    } as unknown as IAggregatorStore;
}

const REPOS = [
    { repoId: 'aaa111', name: 'auth-service', rootPath: 'services/auth' },
    { repoId: 'bbb222', name: 'gateway', rootPath: 'services/gateway' },
    { repoId: 'ccc333', name: 'reports', rootPath: 'services/reports' },
];

const EDGES = [
    { sourceRepo: 'bbb222', targetRepo: 'aaa111', method: 'POST', route: '/login', diff: 'modified' },
    { sourceRepo: 'ccc333', targetRepo: 'aaa111', method: 'GET', route: '/users/:id', diff: null },
    { sourceRepo: 'bbb222', targetRepo: 'ccc333', method: 'GET', route: '/reports', diff: null },
    { sourceRepo: 'bbb222', targetRepo: 'aaa111', method: 'GET', route: '/health', diff: null },
];

describe('#817.1 — listCrossRepoEdgesForProducer', () => {
    it('returns only edges whose target is the producer (consumers calling in)', () => {
        const out = listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges: EDGES }), 'aaa111');
        expect(out).toHaveLength(3);
        expect(out.every(e => e.producerRepoId === 'aaa111')).toBe(true);
        expect(out.map(e => e.route)).not.toContain('/reports');
    });

    it('resolves the producer by name and by rootPath', () => {
        const store = fakeStore({ repos: REPOS, edges: EDGES });
        expect(listCrossRepoEdgesForProducer(store, 'auth-service')).toHaveLength(3);
        expect(listCrossRepoEdgesForProducer(store, 'services/auth')).toHaveLength(3);
    });

    it('resolves consumer repoIds to registry names', () => {
        const out = listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges: EDGES }), 'aaa111');
        const byRoute = Object.fromEntries(out.map(e => [e.route, e]));
        expect(byRoute['/login'].consumerRepoName).toBe('gateway');
        expect(byRoute['/users/:id'].consumerRepoName).toBe('reports');
        expect(byRoute['/login'].consumerRepoId).toBe('bbb222');
    });

    it('sorts deterministically: consumer name asc, then route, then method', () => {
        const out = listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges: EDGES }), 'aaa111');
        expect(out.map(e => `${e.consumerRepoName} ${e.route}`)).toEqual([
            'gateway /health',
            'gateway /login',
            'reports /users/:id',
        ]);
    });

    it('preserves the diff annotation on each edge', () => {
        const out = listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges: EDGES }), 'aaa111');
        const login = out.find(e => e.route === '/login');
        expect(login?.diff).toBe('modified');
        const health = out.find(e => e.route === '/health');
        expect(health?.diff).toBeNull();
    });

    it('unknown producer / no edges → empty array', () => {
        expect(listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges: EDGES }), 'nope')).toEqual([]);
        expect(listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges: [] }), 'aaa111')).toEqual([]);
    });

    it('unregistered consumer id falls back to the raw id as its name', () => {
        const edges = [{ sourceRepo: 'ghost99', targetRepo: 'aaa111', method: 'GET', route: '/x', diff: null }];
        const out = listCrossRepoEdgesForProducer(fakeStore({ repos: REPOS, edges }), 'aaa111');
        expect(out[0].consumerRepoName).toBe('ghost99');
    });
});
