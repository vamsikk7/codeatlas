/**
 * domainRouteResolver.test.ts — #832 (2026-06-11).
 */
import { describe, it, expect } from 'vitest';
import { resolveBareDomainGraph } from '../domainRouteResolver';

const join = (a: string, b: string) => `${a}/${b}`;
const REPOS = [
    { repoId: 'r1', name: 'alpha', rootPath: 'alpha' },
    { repoId: 'r2', name: 'beta', rootPath: 'beta' },
];

const domainGraph = (n: number) => ({
    graphId: 'domain:workspace', type: 'domain',
    nodes: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, label: `domain-${i}` })),
    edges: [], anchors: {}, meta: {},
}) as any;

function snapshot(opts: { domain?: any; clusters?: Record<string, any> } = {}) {
    return {
        files: {}, apiIndex: {},
        clusters: opts.clusters ?? {},
        graphs: opts.domain ? { 'domain:workspace': opts.domain } : {},
    } as any;
}

describe('#832 — resolveBareDomainGraph', () => {
    it('merged graph wins when non-empty', () => {
        const out = resolveBareDomainGraph({
            mergedGraphs: { 'domain:workspace': domainGraph(3) },
            repos: REPOS, getStore: () => undefined,
            workspaceRoot: '/ws', joinPath: join,
        });
        expect(out?.graph.nodes).toHaveLength(3);
        expect(out?.scopedRepo).toBeUndefined();
    });

    it('falls back to the first repo with an existing non-empty domain graph, scoped', () => {
        const stores: Record<string, any> = {
            '/ws/alpha': { getWorking: () => snapshot() },                 // empty
            '/ws/beta': { getWorking: () => snapshot({ domain: domainGraph(2) }) },
        };
        const out = resolveBareDomainGraph({
            mergedGraphs: {}, repos: REPOS,
            getStore: (p) => stores[p],
            workspaceRoot: '/ws', joinPath: join,
        });
        expect(out?.scopedRepo).toBe('beta');
        expect(out?.graph.meta?.scopedRepo).toBe('beta');
        expect(out?.graph.nodes).toHaveLength(2);
    });

    it('builds on demand from a repo with clusters when no graph exists anywhere', () => {
        const clusters = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth', name: 'Auth',
                files: ['alpha/src/a.ts'], entryPoints: [],
            },
        };
        const stores: Record<string, any> = {
            '/ws/alpha': { getWorking: () => snapshot({ clusters }) },
        };
        const out = resolveBareDomainGraph({
            mergedGraphs: {}, repos: REPOS,
            getStore: (p) => stores[p],
            workspaceRoot: '/ws', joinPath: join,
        });
        expect(out).not.toBeNull();
        expect(out?.scopedRepo).toBe('alpha');
        expect(out?.graph.nodes.length).toBeGreaterThan(0);
    });

    it('returns null when nothing resolvable (caller keeps the toast)', () => {
        const out = resolveBareDomainGraph({
            mergedGraphs: {}, repos: REPOS, getStore: () => ({ getWorking: () => snapshot() }),
            workspaceRoot: '/ws', joinPath: join,
        });
        expect(out).toBeNull();
    });

    it('honours maxScan (does not touch repos past the bound)', () => {
        let touched = 0;
        const out = resolveBareDomainGraph({
            mergedGraphs: {},
            repos: Array.from({ length: 10 }, (_, i) => ({ repoId: `r${i}`, name: `s${i}`, rootPath: `s${i}` })),
            getStore: () => { touched++; return { getWorking: () => snapshot() }; },
            workspaceRoot: '/ws', joinPath: join, maxScan: 4,
        });
        expect(out).toBeNull();
        expect(touched).toBe(4);
    });
});
