/**
 * UX-65e (2026-06-09) — unit tests for the scoped L2 Knowledge Map filter.
 *
 * Knowledge Map nodes carry `meta.serviceId = 'service:<name>'` for
 * service / cluster / api / participant entries, and `meta.infraId` for
 * infra (database / queue / sdk) entries. The scoped filter for a
 * picked sub-repo keeps any node whose serviceId matches and walks
 * edges to pull in infra + cross-repo service neighbours, stamping
 * `meta.crossRepoTarget` for the hop affordance.
 */
import { describe, it, expect } from 'vitest';
import { filterMapGraphForRepo } from '../scopedMapGraphFilter';

function makeNode(id: string, opts: { serviceId?: string; infra?: boolean; kind?: string; type?: string; meta?: Record<string, any> } = {}) {
    return {
        id,
        type: opts.type ?? 'service',
        kind: opts.kind,
        label: id,
        meta: { serviceId: opts.serviceId, ...(opts.infra ? { infra: true, external: true } : {}), ...opts.meta },
    };
}
function makeEdge(id: string, source: string, target: string) {
    return { id, source, target, edgeType: 'inter-service', diff: 'unchanged' };
}

describe('filterMapGraphForRepo', () => {
    describe('basic scope', () => {
        it('keeps nodes whose meta.serviceId matches', () => {
            const graph = {
                nodes: [
                    makeNode('s1', { serviceId: 'service:svc-a' }),
                    makeNode('s2', { serviceId: 'service:svc-b' }),
                    makeNode('c1', { serviceId: 'service:svc-a', type: 'cluster' }),
                ],
                edges: [],
                meta: {},
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            const ids = out?.nodes.map((n: any) => n.id).sort();
            expect(ids).toEqual(['c1', 's1']);
            expect(out?.meta?.scopedRepo).toBe('svc-a');
        });

        it('returns null when no nodes match', () => {
            const graph = {
                nodes: [makeNode('s1', { serviceId: 'service:other' })],
                edges: [],
                meta: {},
            } as any;
            expect(filterMapGraphForRepo(graph, 'svc-a')).toBeNull();
        });
    });

    describe('infra inclusion', () => {
        it('pulls in infra/database/queue/sdk neighbours', () => {
            const graph = {
                nodes: [
                    makeNode('s1', { serviceId: 'service:svc-a' }),
                    makeNode('db_1', { infra: true, kind: 'database' }),
                ],
                edges: [makeEdge('e1', 's1', 'db_1')],
                meta: {},
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            expect(out?.nodes.map((n: any) => n.id).sort()).toEqual(['db_1', 's1']);
        });

        it('does not include unrelated infra', () => {
            const graph = {
                nodes: [
                    makeNode('s1', { serviceId: 'service:svc-a' }),
                    makeNode('db_b', { infra: true, kind: 'database' }),
                ],
                edges: [],
                meta: {},
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            expect(out?.nodes).toHaveLength(1);
        });
    });

    describe('UX-65e cross-repo hop', () => {
        it('keeps cross-repo service neighbours and stamps meta.crossRepoTarget', () => {
            const graph = {
                nodes: [
                    makeNode('s1', { serviceId: 'service:svc-a' }),
                    makeNode('s2', { serviceId: 'service:svc-b' }),
                ],
                edges: [makeEdge('e1', 's1', 's2')],
                meta: {},
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            const s2 = out?.nodes.find((n: any) => n.id === 's2');
            expect(s2?.meta?.crossRepoTarget).toBe('svc-b');
            expect(out?.crossRepoCount).toBe(1);
        });

        it('stamps meta.crossRepoEdge on the connecting edge', () => {
            const graph = {
                nodes: [
                    makeNode('s1', { serviceId: 'service:svc-a' }),
                    makeNode('s2', { serviceId: 'service:svc-b' }),
                ],
                edges: [makeEdge('e1', 's1', 's2')],
                meta: {},
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            const e = out?.edges.find((x: any) => x.id === 'e1');
            expect(e?.meta?.crossRepoEdge).toBe(true);
        });
    });

    describe('clusters + participants', () => {
        it('keeps cluster + api nodes for the picked service', () => {
            const graph = {
                nodes: [
                    makeNode('s1', { serviceId: 'service:svc-a' }),
                    makeNode('c1', { serviceId: 'service:svc-a', type: 'cluster' }),
                    makeNode('api1', { serviceId: 'service:svc-a', type: 'participant' }),
                ],
                edges: [
                    makeEdge('e1', 's1', 'c1'),
                    makeEdge('e2', 'c1', 'api1'),
                ],
                meta: {},
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            expect(out?.nodes).toHaveLength(3);
            expect(out?.edges).toHaveLength(2);
        });
    });

    describe('edge cases', () => {
        it('returns null for an empty graph', () => {
            expect(filterMapGraphForRepo({ nodes: [], edges: [], meta: {} } as any, 'svc-a')).toBeNull();
        });
        it('handles missing arrays gracefully', () => {
            expect(filterMapGraphForRepo({} as any, 'svc-a')).toBeNull();
        });
        it('preserves the original meta + stamps scopedRepo', () => {
            const graph = {
                nodes: [makeNode('s1', { serviceId: 'service:svc-a' })],
                edges: [],
                meta: { workspace: 'foo', nodeCount: 9 },
            } as any;
            const out = filterMapGraphForRepo(graph, 'svc-a');
            expect(out?.meta?.workspace).toBe('foo');
            expect(out?.meta?.scopedRepo).toBe('svc-a');
        });
    });
});
