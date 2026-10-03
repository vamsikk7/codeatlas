/**
 * ADR-034 Phase F (#791 — Phase F: Knowledge Map per-repo split (ADR-034)) — buildWorkspaceMapGraph tests.
 *
 * Pure-function tests against a fake aggregator. No DB / no FS.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkspaceMapGraph, MAP_GRAPH_ID } from '../mapGraphBuilder';

function aggregator(opts: {
    repos?: ReadonlyArray<{ repoId: string; name: string; rootPath?: string; technology?: string; status?: 'parsing' | 'ready' | 'failed' | 'stale'; errorMessage?: string }>;
    externals?: ReadonlyArray<{ providerId: string; name: string; category: string; consumers: string[] }>;
    schemas?: ReadonlyArray<{ engine: string; tableName: string; consumers: string[] }>;
    httpEdges?: ReadonlyArray<{ sourceRepo: string; targetRepo: string; method: string; route: string }>;
} = {}) {
    return {
        listRepos: () => (opts.repos ?? []).map((r) => ({
            repoId: r.repoId,
            name: r.name,
            rootPath: r.rootPath ?? r.repoId,
            technology: r.technology ?? null,
            status: r.status ?? 'ready',
            errorMessage: r.errorMessage ?? null,
        })),
        listSharedExternals: () => opts.externals ?? [],
        listSharedSchemas: () => opts.schemas ?? [],
        listCrossRepoHttpEdges: () => opts.httpEdges ?? [],
    };
}

const WS = '/workspace';

describe('buildWorkspaceMapGraph — basics', () => {
    it('empty aggregator → empty graph with valid shape', () => {
        const g = buildWorkspaceMapGraph(aggregator(), WS);
        expect(g.graphId).toBe(MAP_GRAPH_ID);
        expect(g.type).toBe('map');
        expect(g.nodes).toEqual([]);
        expect(g.edges).toEqual([]);
        expect(g.meta.workspaceMap).toBe(true);
        expect(g.meta.repoCount).toBe(0);
    });

    it('three repos with no shared state → three service nodes, no edges', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [
                { repoId: 'a', name: 'svc-a' },
                { repoId: 'b', name: 'svc-b' },
                { repoId: 'c', name: 'svc-c' },
            ],
        }), WS);
        expect(g.nodes).toHaveLength(3);
        expect(g.edges).toHaveLength(0);
        expect(g.nodes.every((n) => n.meta?.workspaceMap === true)).toBe(true);
        expect(g.meta.repoCount).toBe(3);
    });

    it('repos sorted by rootPath for stable layout', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [
                { repoId: 'r1', name: 'z-svc', rootPath: 'z' },
                { repoId: 'r2', name: 'a-svc', rootPath: 'a' },
                { repoId: 'r3', name: 'm-svc', rootPath: 'm' },
            ],
        }), WS);
        expect(g.nodes.map((n) => n.label)).toEqual(['a-svc', 'm-svc', 'z-svc']);
    });
});

describe('buildWorkspaceMapGraph — repo card metadata', () => {
    it('exposes status / errorMessage / technology', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [
                { repoId: 'a', name: 'good', technology: 'nodejs' },
                { repoId: 'b', name: 'bad', status: 'failed', errorMessage: 'parser blew up' },
                { repoId: 'c', name: 'pending', status: 'parsing' },
            ],
        }), WS);
        const meta = g.nodes.map((n) => n.meta);
        expect(meta.find((m) => m!.repoId === 'a')!.technology).toBe('nodejs');
        expect(meta.find((m) => m!.repoId === 'b')!.status).toBe('failed');
        expect(meta.find((m) => m!.repoId === 'b')!.errorMessage).toBe('parser blew up');
        expect(meta.find((m) => m!.repoId === 'c')!.status).toBe('parsing');
    });

    it('drillDownGraphId points at per-repo map', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'r-alpha', name: 'alpha' }],
        }), WS);
        expect(g.nodes[0].meta!.drillDownGraphId).toBe('map:r-alpha');
    });
});

describe('buildWorkspaceMapGraph — shared externals', () => {
    it('OpenAI shared by 2 repos → 1 external node + 2 uses edges', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'a', name: 'A' }, { repoId: 'b', name: 'B' }, { repoId: 'c', name: 'C' }],
            externals: [{ providerId: 'openai', name: 'OpenAI', category: 'ai', consumers: ['a', 'c'] }],
        }), WS);
        const extNode = g.nodes.find((n) => n.meta?.external);
        expect(extNode).toBeDefined();
        expect(extNode!.label).toBe('OpenAI');
        expect(extNode!.meta!.consumerCount).toBe(2);
        const extEdges = g.edges.filter((e) => e.meta?.kind === 'external-usage');
        expect(extEdges).toHaveLength(2);
        expect(extEdges.map((e) => e.source).sort()).toEqual(['repo_a', 'repo_c']);
    });

    it('singleton external still rendered (renderer applies the >= 2 filter, not the builder)', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'a', name: 'A' }],
            externals: [{ providerId: 'stripe', name: 'Stripe', category: 'payments', consumers: ['a'] }],
        }), WS);
        expect(g.nodes.filter((n) => n.meta?.external)).toHaveLength(1);
    });
});

describe('buildWorkspaceMapGraph — shared DB schemas', () => {
    it('Postgres User shared by 3 repos → 1 infra node + 3 uses edges', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'a', name: 'A' }, { repoId: 'b', name: 'B' }, { repoId: 'c', name: 'C' }],
            schemas: [{ engine: 'postgresql', tableName: 'users', consumers: ['a', 'b', 'c'] }],
        }), WS);
        const schemaNode = g.nodes.find((n) => n.meta?.kind === 'database');
        expect(schemaNode!.label).toMatch(/Postgres/);
        expect(schemaNode!.label).toMatch(/users/);
        const schemaEdges = g.edges.filter((e) => e.meta?.kind === 'schema-usage');
        expect(schemaEdges).toHaveLength(3);
    });

    it('different engines for the same table name produce distinct nodes', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'a', name: 'A' }, { repoId: 'b', name: 'B' }],
            schemas: [
                { engine: 'postgresql', tableName: 'users', consumers: ['a'] },
                { engine: 'mongodb', tableName: 'users', consumers: ['b'] },
            ],
        }), WS);
        expect(g.nodes.filter((n) => n.meta?.kind === 'database')).toHaveLength(2);
    });
});

describe('buildWorkspaceMapGraph — cross-repo HTTP edges', () => {
    it('alpha → beta on /items/:id → one calls edge between repo nodes', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'alpha', name: 'alpha' }, { repoId: 'beta', name: 'beta' }],
            httpEdges: [{ sourceRepo: 'alpha', targetRepo: 'beta', method: 'GET', route: '/items/:id' }],
        }), WS);
        const callEdge = g.edges.find((e) => e.meta?.kind === 'cross-repo-http');
        expect(callEdge).toBeDefined();
        expect(callEdge!.source).toBe('repo_alpha');
        expect(callEdge!.target).toBe('repo_beta');
        expect(callEdge!.label).toBe('GET /items/:id');
    });

    it('edge with missing source or target repo is dropped (no orphan edges)', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'alpha', name: 'alpha' }],
            httpEdges: [
                { sourceRepo: 'alpha', targetRepo: 'phantom', method: 'GET', route: '/x' },
                { sourceRepo: 'phantom', targetRepo: 'alpha', method: 'POST', route: '/y' },
            ],
        }), WS);
        expect(g.edges.filter((e) => e.meta?.kind === 'cross-repo-http')).toHaveLength(0);
    });
});

describe('buildWorkspaceMapGraph — full sandbox-shape', () => {
    it('matches the extended-sandbox profile: 3 repos + OpenAI + Pg.user + Pg.order + alpha→beta', () => {
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [
                { repoId: 'svc-alpha', name: 'svc-alpha' },
                { repoId: 'svc-beta', name: 'svc-beta' },
                { repoId: 'svc-gamma', name: 'svc-gamma' },
            ],
            externals: [
                { providerId: 'openai', name: 'OpenAI', category: 'ai', consumers: ['svc-alpha', 'svc-gamma'] },
            ],
            schemas: [
                { engine: 'postgresql', tableName: 'user', consumers: ['svc-alpha', 'svc-beta', 'svc-gamma'] },
                { engine: 'postgresql', tableName: 'order', consumers: ['svc-alpha', 'svc-beta', 'svc-gamma'] },
            ],
            httpEdges: [
                { sourceRepo: 'svc-alpha', targetRepo: 'svc-beta', method: 'GET', route: '/api/svc-beta/items/${id}' },
            ],
        }), WS);

        expect(g.meta.repoCount).toBe(3);
        expect(g.meta.sharedExternalCount).toBe(1);
        expect(g.meta.sharedSchemaCount).toBe(2);
        expect(g.meta.crossRepoHttpEdgeCount).toBe(1);
        expect(g.nodes).toHaveLength(3 + 1 + 2);   // 3 repos + 1 ext + 2 schemas
        // 2 ext-usage edges (alpha,gamma) + 6 schema-usage edges (3 × 2) + 1 cross-repo HTTP = 9
        expect(g.edges).toHaveLength(2 + 6 + 1);
    });
});

// 2026-06-09 — Per-repo subtitle in the workspace L2 Map.
// The 132-repo serverless-examples fixture surfaced this: every workspace
// Map node read no api count at all (or the stale per-repo legacy
// "«unknown» · 0 apis") because `buildWorkspaceMapGraph` ignored summary
// data. The fix pulls `apis.length` from `getRepoSummary` and renders
// `«technology» · N apis` matching the legacy single-repo Map's format.
describe('buildWorkspaceMapGraph — per-repo subtitle (technology + api count)', () => {
    function aggregatorWithSummaries(opts: {
        repos: ReadonlyArray<{ repoId: string; name: string; technology?: string }>;
        summaries: Record<string, { apis: ReadonlyArray<unknown> }>;
    }) {
        const baseAgg = aggregator({ repos: opts.repos });
        return Object.assign(baseAgg, {
            getRepoSummary: (id: string) => opts.summaries[id],
        });
    }

    it('renders «technology» · N apis when the summary has apis', () => {
        const g = buildWorkspaceMapGraph(aggregatorWithSummaries({
            repos: [{ repoId: 'r1', name: 'svc-a', technology: 'nodejs' }],
            summaries: { r1: { apis: [1, 2, 3, 4] } },
        }), WS);
        const node = g.nodes.find(n => n.label === 'svc-a');
        expect(node?.subtitle).toBe('«nodejs» · 4 apis');
        expect(node?.meta?.apiCount).toBe(4);
        expect(node?.meta?.technology).toBe('nodejs');
    });

    it('singularises the label when there is exactly one api', () => {
        const g = buildWorkspaceMapGraph(aggregatorWithSummaries({
            repos: [{ repoId: 'r1', name: 'svc-a', technology: 'nodejs' }],
            summaries: { r1: { apis: [1] } },
        }), WS);
        expect(g.nodes[0].subtitle).toBe('«nodejs» · 1 api');
    });

    it('falls back to «technology» (no api suffix) when the summary has zero apis', () => {
        const g = buildWorkspaceMapGraph(aggregatorWithSummaries({
            repos: [{ repoId: 'r1', name: 'svc-a', technology: 'serverless' }],
            summaries: { r1: { apis: [] } },
        }), WS);
        expect(g.nodes[0].subtitle).toBe('«serverless»');
        expect(g.nodes[0].meta?.apiCount).toBe(0);
    });

    it('renders «unknown» when the repo row has technology === null (Phase B pre-summary)', () => {
        const g = buildWorkspaceMapGraph(aggregatorWithSummaries({
            repos: [{ repoId: 'r1', name: 'svc-a' }], // no technology
            summaries: {},
        }), WS);
        expect(g.nodes[0].subtitle).toBe('«unknown»');
    });

    it('works against an aggregator without getRepoSummary (legacy callers, no apis)', () => {
        // The interface marks getRepoSummary as optional so older callers
        // still satisfy the type. Without it, the subtitle just shows the
        // technology and apiCount stays 0.
        const g = buildWorkspaceMapGraph(aggregator({
            repos: [{ repoId: 'r1', name: 'svc-a', technology: 'serverless' }],
        }), WS);
        expect(g.nodes[0].subtitle).toBe('«serverless»');
        expect(g.nodes[0].meta?.apiCount).toBe(0);
    });
});

