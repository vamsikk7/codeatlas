/**
 * crossRepoCoda.test.ts — #818 (2026-06-11).
 *
 * Pins the coda frame builder: composition (a/b/c), affected-only gating,
 * consumer ordering + cap + overflow summary, unresolvable-call-site
 * skip, empty-state, and the route-fragment reducer.
 */

import { describe, it, expect } from 'vitest';
import { buildCrossRepoCodaFrames, routeSearchFragment, type CodaStoreLike } from '../crossRepoCoda';
import type { IAggregatorStore } from '../../storage/storeInterfaces';

function fakeAggregator(opts: {
    repos?: Array<{ repoId: string; name: string; rootPath: string }>;
    edges?: Array<{ sourceRepo: string; targetRepo: string; method: string; route: string; diff: string | null }>;
}): IAggregatorStore {
    return {
        listRepos: () => (opts.repos ?? []) as any,
        listCrossRepoHttpEdges: () => (opts.edges ?? []) as any,
    } as unknown as IAggregatorStore;
}

const REPOS = [
    { repoId: 'prod', name: 'producer', rootPath: 'producer' },
    { repoId: 'con1', name: 'consumer', rootPath: 'consumer' },
    { repoId: 'con2', name: 'reports', rootPath: 'reports' },
];

const L1 = { graphId: 'microservice:workspace', type: 'microservice', nodes: [], edges: [] } as any;

function consumerStore(opts: { seqRefs?: string; fileContent?: string } = {}): CodaStoreLike {
    const graphs: Record<string, any> = {
        'sequence:consumer/client.js:fetchItems': {
            graphId: 'sequence:consumer/client.js:fetchItems',
            type: 'sequence',
            nodes: [{ id: 'p1', label: opts.seqRefs ?? 'GET http://localhost:3000/api/items' }],
            edges: [],
        },
        'file:consumer/client.js': {
            graphId: 'file:consumer/client.js', type: 'file', nodes: [], edges: [],
        },
    };
    return {
        getWorking: () => ({
            files: { 'consumer/client.js': { hash: 'x' } },
            apiIndex: {}, graphs,
        }) as any,
        getFileContent: () => opts.fileContent ?? "fetch('http://localhost:3000/api/items')",
    };
}

const EDGE = (diff: string | null, route = '/api/items', source = 'con1') =>
    ({ sourceRepo: source, targetRepo: 'prod', method: 'GET', route, diff });

describe('#818 — routeSearchFragment', () => {
    it('strips param tokens of every style', () => {
        expect(routeSearchFragment('/api/items/${id}')).toBe('/api/items');
        expect(routeSearchFragment('/api/items/:id')).toBe('/api/items');
        expect(routeSearchFragment('/api/items/{id}')).toBe('/api/items');
        expect(routeSearchFragment('/api/items')).toBe('/api/items');
    });
});

describe('#818 — buildCrossRepoCodaFrames', () => {
    it('R6: no affected edges (all unchanged) → zero frames', () => {
        const agg = fakeAggregator({ repos: REPOS, edges: [EDGE(null), EDGE('unchanged', '/x')] });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'producer',
            perRepoStores: new Map([['con1', consumerStore()]]),
            workspaceL1: L1,
        });
        expect(frames).toEqual([]);
    });

    it('R2: full composition — L1 + L3 + L4 frames for one affected consumer, all marked cross-repo-coda', () => {
        const agg = fakeAggregator({ repos: REPOS, edges: [EDGE('modified')] });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'producer',
            perRepoStores: new Map([['con1', consumerStore()]]),
            workspaceL1: L1,
        });
        expect(frames.map(f => f.layer)).toEqual(['L1 Cross-repo', 'L3 Cross-repo', 'L4 Cross-repo']);
        expect(frames.every(f => f.replayKind === 'cross-repo-coda')).toBe(true);
        expect(frames.every(f => f.codaProducer === 'producer' && f.codaConsumer === 'consumer')).toBe(true);
        expect(frames[0].graphId).toBe('microservice:workspace');
        expect(frames[1].graphId).toContain('sequence:');
        expect(frames[2].graphId).toBe('file:consumer/client.js');
        expect(frames[0].label).toContain('producer → consumer');
    });

    it('R2: unresolvable L3/L4 are skipped without failing — L1 frame still emitted', () => {
        const logs: string[] = [];
        const agg = fakeAggregator({ repos: REPOS, edges: [EDGE('modified')] });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'producer',
            perRepoStores: new Map([['con1', consumerStore({ seqRefs: 'nothing relevant', fileContent: 'no url here' })]]),
            workspaceL1: L1,
            log: (m) => logs.push(m),
        });
        expect(frames.map(f => f.layer)).toEqual(['L1 Cross-repo']);
        expect(logs.join('\n')).toContain('frame (b) skipped');
        expect(logs.join('\n')).toContain('frame (c) skipped');
    });

    it('R3: consumers ordered by affected-edge count desc, then name', () => {
        const agg = fakeAggregator({
            repos: REPOS,
            edges: [EDGE('modified', '/a', 'con1'), EDGE('modified', '/b', 'con2'), EDGE('modified', '/c', 'con2')],
        });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'prod',
            perRepoStores: new Map(),
            workspaceL1: L1,
        });
        // No stores → only L1 frames, one per consumer, in order.
        expect(frames.map(f => f.codaConsumer)).toEqual(['reports', 'consumer']);
    });

    it('R3: cap + overflow summary frame naming the rest', () => {
        const repos = [
            { repoId: 'prod', name: 'producer', rootPath: 'producer' },
            ...['a', 'b', 'c'].map((n) => ({ repoId: `c-${n}`, name: `svc-${n}`, rootPath: n })),
        ];
        const agg = fakeAggregator({
            repos,
            edges: ['a', 'b', 'c'].map((n) => EDGE('modified', `/r/${n}`, `c-${n}`)),
        });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'prod',
            perRepoStores: new Map(),
            workspaceL1: L1,
            maxConsumers: 2,
        });
        // 2 consumer L1 frames + 1 summary.
        expect(frames).toHaveLength(3);
        const summary = frames[2];
        expect(summary.label).toContain('1 more consumer');
        expect(summary.label).toContain('svc-c');
    });

    it('producer resolvable by name; producer display name in labels', () => {
        const agg = fakeAggregator({ repos: REPOS, edges: [EDGE('added')] });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'producer',  // by name
            perRepoStores: new Map(),
            workspaceL1: L1,
        });
        expect(frames).toHaveLength(1);
        expect(frames[0].codaProducer).toBe('producer');
    });

    it('no workspaceL1 → no L1/summary frames, but consumer L3/L4 still build', () => {
        const agg = fakeAggregator({ repos: REPOS, edges: [EDGE('modified')] });
        const frames = buildCrossRepoCodaFrames({
            aggregator: agg, producer: 'prod',
            perRepoStores: new Map([['con1', consumerStore()]]),
            workspaceL1: null,
        });
        expect(frames.map(f => f.layer)).toEqual(['L3 Cross-repo', 'L4 Cross-repo']);
    });
});
