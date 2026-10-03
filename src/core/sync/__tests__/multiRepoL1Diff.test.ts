/**
 * multiRepoL1Diff.test.ts — #852.
 */
import { describe, it, expect } from 'vitest';
import { markMultiRepoL1Diff } from '../multiRepoL1Diff';
import type { DiagramGraph } from '../../graph/graphTypes';

function l1(nodes: any[]): DiagramGraph {
    return { graphId: 'microservice:workspace', type: 'microservice', nodes, edges: [], anchors: {}, meta: {} } as DiagramGraph;
}

describe('markMultiRepoL1Diff (#852)', () => {
    it('marks only the changed repo\'s service node modified (skeletal meta.repoId)', () => {
        const g = l1([
            { id: 'service:producer', type: 'service', label: 'producer', diff: 'unchanged', meta: { repoId: 'producer' } },
            { id: 'service:consumer', type: 'service', label: 'consumer', diff: 'unchanged', meta: { repoId: 'consumer' } },
        ]);
        const out = markMultiRepoL1Diff(g, (id) => id === 'producer');
        expect(out.nodes.find((n) => n.label === 'producer')!.diff).toBe('modified');
        expect(out.nodes.find((n) => n.label === 'consumer')!.diff).toBe('unchanged');
    });

    it('resolves repo via meta.serviceId when repoId absent (aggregator copy)', () => {
        const g = l1([{ id: 's', type: 'service', label: 'producer', diff: 'unchanged', meta: { serviceId: 'producer' } }]);
        const out = markMultiRepoL1Diff(g, () => true);
        expect(out.nodes[0].diff).toBe('modified');
    });

    it('bucketed node marks modified if ANY member repo changed', () => {
        const g = l1([{ id: 'b', type: 'service', label: 'S3', diff: 'unchanged', meta: { awsBucket: 's3', bucketedFrom: ['r1', 'r2', 'r3'] } }]);
        expect(markMultiRepoL1Diff(g, (id) => id === 'r2').nodes[0].diff).toBe('modified');
        expect(markMultiRepoL1Diff(g, (id) => id === 'rX').nodes[0].diff).toBe('unchanged');
    });

    it('leaves external + worker siblings untouched', () => {
        const g = l1([
            { id: 'ext', type: 'service', label: 'localhost', diff: 'unchanged', meta: { external: true, repoId: 'producer' } },
            { id: 'wk', type: 'service', label: 'Workers · producer', diff: 'unchanged', meta: { worker: true, repoId: 'producer' } },
        ]);
        const out = markMultiRepoL1Diff(g, () => true);
        expect(out.nodes.every((n) => n.diff === 'unchanged')).toBe(true);
    });

    it('does not downgrade an existing added/deleted annotation', () => {
        const g = l1([{ id: 's', type: 'service', label: 'producer', diff: 'added', meta: { repoId: 'producer' } }]);
        expect(markMultiRepoL1Diff(g, () => true).nodes[0].diff).toBe('added');
    });

    it('returns the SAME graph object when nothing changed (no needless re-render)', () => {
        const g = l1([{ id: 's', type: 'service', label: 'consumer', diff: 'unchanged', meta: { repoId: 'consumer' } }]);
        expect(markMultiRepoL1Diff(g, () => false)).toBe(g);
    });
});
