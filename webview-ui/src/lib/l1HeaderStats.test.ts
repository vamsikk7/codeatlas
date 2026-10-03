/**
 * #835 — L1 header service count must agree with the home page's
 * SERVICES stat on skeletal/bucketed multi-repo workspace L1 graphs.
 */
import { describe, it, expect } from 'vitest';
import { resolveL1ServiceHeader, formatL1HeaderCaption } from './l1HeaderStats';

function nodes(n: number, meta: Record<string, unknown> = {}) {
    return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, meta }));
}

describe('resolveL1ServiceHeader (#835)', () => {
    it('bucketed skeletal L1: captions the workspace service count and notes the bucket count', () => {
        const graph = {
            nodes: nodes(10, { skeletal: true }),
            meta: { skeletal: true, bucketed: true, bucketReason: 'aws-services', repoCount: 132 },
        };
        expect(resolveL1ServiceHeader(graph, 209)).toEqual({
            serviceTotal: 209,
            condensedNote: '10 groups',
        });
    });

    it('per-repo skeletal L1 with multi-service repos: captions the service count and notes the repo count', () => {
        const graph = { nodes: nodes(3, { skeletal: true }), meta: { skeletal: true, repoCount: 3 } };
        expect(resolveL1ServiceHeader(graph, 7)).toEqual({
            serviceTotal: 7,
            condensedNote: '3 repos',
        });
    });

    it('per-repo skeletal L1 where counts agree: no condensed note (the crossrepo 2-repo case)', () => {
        const graph = { nodes: nodes(2, { skeletal: true }), meta: { skeletal: true, repoCount: 2 } };
        expect(resolveL1ServiceHeader(graph, 2)).toEqual({ serviceTotal: 2, condensedNote: null });
    });

    it('non-skeletal (single-repo full L1) ignores the workspace count', () => {
        const graph = { nodes: nodes(4), meta: {} };
        expect(resolveL1ServiceHeader(graph, 209)).toEqual({ serviceTotal: 4, condensedNote: null });
    });

    it('sub-repo scoped rebuild (meta.scopedRepo) counts its own nodes even if skeletal flag leaked', () => {
        const graph = { nodes: nodes(5), meta: { skeletal: true, scopedRepo: 'dotnet' } };
        expect(resolveL1ServiceHeader(graph, 209)).toEqual({ serviceTotal: 5, condensedNote: null });
    });

    it('skeletal L1 with missing or zero workspace count falls back to the node count', () => {
        const graph = { nodes: nodes(10), meta: { skeletal: true, bucketed: true } };
        expect(resolveL1ServiceHeader(graph, undefined)).toEqual({ serviceTotal: 10, condensedNote: null });
        expect(resolveL1ServiceHeader(graph, null)).toEqual({ serviceTotal: 10, condensedNote: null });
        expect(resolveL1ServiceHeader(graph, 0)).toEqual({ serviceTotal: 10, condensedNote: null });
    });

    it('excludes external nodes from the node total (matches the existing header stat)', () => {
        const graph = {
            nodes: [...nodes(3), { id: 'ext', meta: { external: true } }],
            meta: {},
        };
        expect(resolveL1ServiceHeader(graph)).toEqual({ serviceTotal: 3, condensedNote: null });
    });

    it('singular noun for a single condensed node', () => {
        const graph = { nodes: nodes(1, { skeletal: true }), meta: { skeletal: true, bucketed: true } };
        expect(resolveL1ServiceHeader(graph, 12)).toEqual({ serviceTotal: 12, condensedNote: '1 group' });
    });
});

describe('formatL1HeaderCaption (BUG-POLAR-2 — lead with the visible node count)', () => {
    it('condensed multi-repo: leads with repos, service total secondary', () => {
        // polar: 17 services condensed into 4 repo nodes.
        expect(formatL1HeaderCaption({ serviceTotal: 17, condensedNote: '4 repos' }))
            .toBe('4 repos · 17 services');
    });
    it('bucketed: leads with groups', () => {
        expect(formatL1HeaderCaption({ serviceTotal: 209, condensedNote: '10 groups' }))
            .toBe('10 groups · 209 services');
    });
    it('non-condensed: just the service count (singular respected)', () => {
        expect(formatL1HeaderCaption({ serviceTotal: 4, condensedNote: null })).toBe('4 services');
        expect(formatL1HeaderCaption({ serviceTotal: 1, condensedNote: null })).toBe('1 service');
    });
});
