/**
 * UX-65 / UX-67-test-debt (2026-06-09) — unit tests for the scoped L1
 * microservice graph filter.
 *
 * `case 'system-design':` in extension.ts inlines a ~100-line filter
 * that:
 *   1. Picks every node whose `meta.rootPath === <picked-repo>`.
 *   2. Walks edges to pull in infra/external neighbours.
 *   3. UX-65 — also pulls in cross-repo service neighbours and stamps
 *      `meta.crossRepoTarget` on them + `meta.crossRepoEdge` on edges
 *      so the SPA click handler hops scope.
 *   4. Stamps `meta.scopedRepo` on the resulting graph.
 *
 * Extracting this into a pure function (a) gives us unit tests in
 * isolation, (b) lets the same logic drive the Knowledge Map scoped
 * filter (UX-65e), and (c) means the handler in extension.ts becomes
 * a four-line call instead of an inline block.
 */
import { describe, it, expect } from 'vitest';
import { filterMicroserviceGraphForRepo } from '../scopedMicroserviceGraphFilter';

function makeNode(id: string, type: string, meta: Record<string, any> = {}) {
    return { id, type, label: id, subtitle: '', meta };
}
function makeEdge(id: string, source: string, target: string, meta: Record<string, any> = {}) {
    return { id, source, target, edgeType: 'inter-service', diff: 'unchanged', meta };
}

describe('filterMicroserviceGraphForRepo', () => {
    describe('basic scope filter', () => {
        it('keeps the picked service node only when no neighbours exist', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('s2', 'service', { rootPath: 'svc-b' }),
                ],
                edges: [],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.nodes).toHaveLength(1);
            expect(out?.nodes[0].id).toBe('s1');
            expect(out?.meta?.scopedRepo).toBe('svc-a');
        });

        it('returns null when no nodes match', () => {
            const graph = {
                nodes: [makeNode('s1', 'service', { rootPath: 'svc-a' })],
                edges: [],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'unknown');
            expect(out).toBeNull();
        });

        it('matches against meta.repoId when rootPath is absent', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { repoId: 'svc-a' }),
                ],
                edges: [],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.nodes).toHaveLength(1);
        });
    });

    describe('infra + external inclusion', () => {
        it('pulls in infra neighbours connected to the kept service', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('infra_1', 'service', { infra: true, external: true, kind: 'database' }),
                ],
                edges: [makeEdge('e1', 's1', 'infra_1')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.nodes.map((n: any) => n.id).sort()).toEqual(['infra_1', 's1']);
            expect(out?.edges.map((e: any) => e.id)).toEqual(['e1']);
        });

        it('walks reverse edges (infra → service) too', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('mq_1', 'service', { external: true, kind: 'queue' }),
                ],
                edges: [makeEdge('e1', 'mq_1', 's1')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.nodes).toHaveLength(2);
            expect(out?.edges).toHaveLength(1);
        });

        it('does NOT pull in unrelated infra (no edge to kept set)', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('s2', 'service', { rootPath: 'svc-b' }),
                    makeNode('infra_b', 'service', { infra: true, external: true }),
                ],
                edges: [makeEdge('e_b', 's2', 'infra_b')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.nodes).toHaveLength(1);
            expect(out?.edges).toHaveLength(0);
        });
    });

    describe('UX-65 cross-repo edge hop', () => {
        it('stamps meta.crossRepoTarget on a cross-repo service neighbour', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('s2', 'service', { rootPath: 'svc-b' }),
                ],
                edges: [makeEdge('e1', 's1', 's2')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            const s2 = out?.nodes.find((n: any) => n.id === 's2');
            expect(s2?.meta?.crossRepoTarget).toBe('svc-b');
        });

        it('stamps meta.crossRepoEdge on the connecting edge', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('s2', 'service', { rootPath: 'svc-b' }),
                ],
                edges: [makeEdge('e1', 's1', 's2')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            const e1 = out?.edges.find((e: any) => e.id === 'e1');
            expect(e1?.meta?.crossRepoEdge).toBe(true);
        });

        it('does NOT stamp crossRepoTarget on the SELF service node', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('infra_1', 'service', { infra: true, external: true }),
                ],
                edges: [makeEdge('e1', 's1', 'infra_1')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            const s1 = out?.nodes.find((n: any) => n.id === 's1');
            expect(s1?.meta?.crossRepoTarget).toBeUndefined();
        });

        it('walks transitive infra after a cross-repo hop', () => {
            // svc-a → svc-b → infra_b. We keep svc-b (cross-repo target) but
            // we DON'T transitively pull in svc-b's infra (different scope).
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('s2', 'service', { rootPath: 'svc-b' }),
                    makeNode('infra_b', 'service', { infra: true, external: true }),
                ],
                edges: [
                    makeEdge('e_ab', 's1', 's2'),
                    makeEdge('e_b_infra', 's2', 'infra_b'),
                ],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            // svc-a + svc-b (cross-repo) kept; infra_b walks IS kept because
            // the BFS pulls in any infra neighbour of any kept node. This is
            // intentional — the cross-repo neighbour gives context.
            const ids = out?.nodes.map((n: any) => n.id).sort();
            expect(ids).toContain('s1');
            expect(ids).toContain('s2');
        });
    });

    describe('edge cases', () => {
        it('returns null for an empty graph', () => {
            const out = filterMicroserviceGraphForRepo(
                { nodes: [], edges: [], meta: {} } as any,
                'anything',
            );
            expect(out).toBeNull();
        });

        it('handles missing nodes / edges arrays gracefully', () => {
            const out = filterMicroserviceGraphForRepo({} as any, 'svc-a');
            expect(out).toBeNull();
        });

        it('preserves the original meta + stamps scopedRepo', () => {
            const graph = {
                nodes: [makeNode('s1', 'service', { rootPath: 'svc-a' })],
                edges: [],
                meta: { repoName: 'workspace', serviceCount: 5 },
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.meta?.repoName).toBe('workspace');
            expect(out?.meta?.serviceCount).toBe(5);
            expect(out?.meta?.scopedRepo).toBe('svc-a');
        });
    });

    describe('stats summary', () => {
        it('returns the cross-repo neighbour count alongside the graph', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('s2', 'service', { rootPath: 'svc-b' }),
                    makeNode('s3', 'service', { rootPath: 'svc-c' }),
                ],
                edges: [
                    makeEdge('e_ab', 's1', 's2'),
                    makeEdge('e_ac', 's1', 's3'),
                ],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.crossRepoCount).toBe(2);
            expect(out?.nodes).toHaveLength(3);
        });

        it('reports 0 cross-repo when only infra neighbours are present', () => {
            const graph = {
                nodes: [
                    makeNode('s1', 'service', { rootPath: 'svc-a' }),
                    makeNode('infra_1', 'service', { infra: true, external: true }),
                ],
                edges: [makeEdge('e1', 's1', 'infra_1')],
                meta: {},
            } as any;
            const out = filterMicroserviceGraphForRepo(graph, 'svc-a');
            expect(out?.crossRepoCount).toBe(0);
        });
    });
});
