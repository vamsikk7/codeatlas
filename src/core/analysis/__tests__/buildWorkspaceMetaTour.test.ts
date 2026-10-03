/**
 * ADR-034 Phase H (#793 — Phase H: Tours per repo + workspace meta-tour (ADR-034)) — buildWorkspaceMetaTour tests.
 * Pure-function tests with a fake aggregator. Topological ordering by
 * cross-repo HTTP edges, deterministic tie-break, cycle handling.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkspaceMetaTour } from '../tourBuilder';

interface FakeRepo {
    repoId: string;
    name: string;
    rootPath?: string;
    status?: 'parsing' | 'ready' | 'failed' | 'stale';
}

interface FakeApi {
    apiId: string; method: string; route: string; filePath: string; handlerName: string;
}

function api(method: string, route: string): FakeApi {
    return {
        apiId: `${method}:${route}`,
        method, route,
        filePath: `src/x.js`,
        handlerName: `anonymous@${method}:${route}`,
    };
}

function aggregator(opts: {
    repos: ReadonlyArray<FakeRepo>;
    edges?: ReadonlyArray<{ sourceRepo: string; targetRepo: string; method: string; route: string }>;
    summaries?: Record<string, ReadonlyArray<FakeApi>>;
}) {
    const summaries = opts.summaries ?? {};
    return {
        listRepos: () => opts.repos.map((r) => ({
            repoId: r.repoId,
            name: r.name,
            rootPath: r.rootPath ?? r.repoId,
            status: r.status ?? 'ready',
        })),
        listCrossRepoHttpEdges: () => opts.edges ?? [],
        getRepoSummary: (repoId: string) => {
            const apis = summaries[repoId];
            if (!apis) return undefined;
            return { apis };
        },
    };
}

const WS = '/workspace';

describe('buildWorkspaceMetaTour — empty / single repo', () => {
    it('zero repos → empty', () => {
        expect(buildWorkspaceMetaTour(aggregator({ repos: [] }), WS)).toEqual([]);
    });

    it('BUG-POLAR-27: skips meta/asset routes (og, favicon) when picking the repo entry', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [{ repoId: 'clients', name: 'clients' }],
            // /og is the SHORTEST clean GET → old heuristic picked it. /blog is
            // the meaningful entry a user actually wants to start on.
            summaries: { clients: [api('GET', '/og'), api('GET', '/favicon.ico'), api('GET', '/blog')] },
        }), WS);
        expect(t[0].label).toBe('clients: GET /blog');
        expect(t[0].label).not.toContain('/og');
    });

    it('BUG-POLAR-27: still picks a meta route if it is the ONLY option', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [{ repoId: 'r', name: 'r' }],
            summaries: { r: [api('GET', '/og')] },
        }), WS);
        expect(t[0].label).toBe('r: GET /og');
    });

    it('one repo with apis → one step', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [{ repoId: 'r1', name: 'svc-1' }],
            summaries: { r1: [api('GET', '/health'), api('POST', '/items')] },
        }), WS);
        expect(t).toHaveLength(1);
        expect(t[0].entryPointId).toBe('GET:/health');
        expect(t[0].drillDownGraphId).toBe('tour:r1');
        expect(t[0].label).toBe('svc-1: GET /health');
        expect(t[0].stepNumber).toBe(1);
    });

    it('repo with no apis is skipped', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'a', name: 'svc-a' },
                { repoId: 'empty', name: 'no-apis' },
            ],
            summaries: { a: [api('GET', '/health')] },
        }), WS);
        expect(t).toHaveLength(1);
        expect(t[0].entryPointId).toBe('GET:/health');
    });
});

describe('buildWorkspaceMetaTour — failure handling', () => {
    it('failed repo is skipped', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'a', name: 'good' },
                { repoId: 'b', name: 'bad', status: 'failed' },
            ],
            summaries: {
                a: [api('GET', '/health')],
                b: [api('GET', '/health')],
            },
        }), WS);
        expect(t).toHaveLength(1);
        expect(t[0].label).toBe('good: GET /health');
    });
});

describe('buildWorkspaceMetaTour — ordering without edges', () => {
    it('three independent repos → alphabetic by rootPath', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'r1', name: 'gamma', rootPath: 'svc-gamma' },
                { repoId: 'r2', name: 'alpha', rootPath: 'svc-alpha' },
                { repoId: 'r3', name: 'beta', rootPath: 'svc-beta' },
            ],
            summaries: {
                r1: [api('GET', '/health')],
                r2: [api('GET', '/health')],
                r3: [api('GET', '/health')],
            },
        }), WS);
        expect(t.map((s) => s.label.split(':')[0])).toEqual(['alpha', 'beta', 'gamma']);
    });
});

describe('buildWorkspaceMetaTour — topological ordering', () => {
    it('A→B → A first (no in-edge), then B', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'B', name: 'beta' },
                { repoId: 'A', name: 'alpha' },
            ],
            edges: [{ sourceRepo: 'A', targetRepo: 'B', method: 'GET', route: '/x' }],
            summaries: {
                A: [api('GET', '/api-a/health')],
                B: [api('GET', '/api-b/health')],
            },
        }), WS);
        expect(t.map((s) => s.entryPointId)).toEqual(['GET:/api-a/health', 'GET:/api-b/health']);
    });

    it('A→B + B→C → A first, B second, C third', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'C', name: 'gamma' },
                { repoId: 'B', name: 'beta' },
                { repoId: 'A', name: 'alpha' },
            ],
            edges: [
                { sourceRepo: 'A', targetRepo: 'B', method: 'GET', route: '/x' },
                { sourceRepo: 'B', targetRepo: 'C', method: 'GET', route: '/y' },
            ],
            summaries: {
                A: [api('GET', '/a')],
                B: [api('GET', '/b')],
                C: [api('GET', '/c')],
            },
        }), WS);
        expect(t.map((s) => s.entryPointId)).toEqual(['GET:/a', 'GET:/b', 'GET:/c']);
    });

    it('A→C and B→C (B not called by anything) → A and B before C, alphabetic between them', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'A', name: 'alpha' },
                { repoId: 'B', name: 'beta' },
                { repoId: 'C', name: 'gamma' },
            ],
            edges: [
                { sourceRepo: 'A', targetRepo: 'C', method: 'GET', route: '/x' },
                { sourceRepo: 'B', targetRepo: 'C', method: 'GET', route: '/y' },
            ],
            summaries: {
                A: [api('GET', '/a')], B: [api('GET', '/b')], C: [api('GET', '/c')],
            },
        }), WS);
        expect(t.map((s) => s.entryPointId)).toEqual(['GET:/a', 'GET:/b', 'GET:/c']);
    });
});

describe('buildWorkspaceMetaTour — cycle handling', () => {
    it('A↔B cycle → deterministic order (lex-smallest first)', () => {
        const t1 = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'A', name: 'alpha' },
                { repoId: 'B', name: 'beta' },
            ],
            edges: [
                { sourceRepo: 'A', targetRepo: 'B', method: 'GET', route: '/x' },
                { sourceRepo: 'B', targetRepo: 'A', method: 'GET', route: '/y' },
            ],
            summaries: {
                A: [api('GET', '/a')], B: [api('GET', '/b')],
            },
        }), WS);
        const t2 = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'B', name: 'beta' },        // order doesn't matter
                { repoId: 'A', name: 'alpha' },
            ],
            edges: [
                { sourceRepo: 'B', targetRepo: 'A', method: 'GET', route: '/y' },
                { sourceRepo: 'A', targetRepo: 'B', method: 'GET', route: '/x' },
            ],
            summaries: {
                A: [api('GET', '/a')], B: [api('GET', '/b')],
            },
        }), WS);
        expect(t1.map((s) => s.entryPointId)).toEqual(t2.map((s) => s.entryPointId));
        expect(t1.map((s) => s.entryPointId)).toEqual(['GET:/a', 'GET:/b']);
    });
});

describe('buildWorkspaceMetaTour — entry-point selection', () => {
    it('picks the cleanest GET route over parameterised ones', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [{ repoId: 'r', name: 'svc' }],
            summaries: {
                r: [
                    api('GET', '/users/:id'),
                    api('GET', '/health'),
                    api('GET', '/articles/:slug'),
                    api('POST', '/items'),
                ],
            },
        }), WS);
        expect(t[0].entryPointId).toBe('GET:/health');
    });

    it('falls back to first GET when no clean route exists', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [{ repoId: 'r', name: 'svc' }],
            summaries: {
                r: [
                    api('GET', '/users/:id'),
                    api('GET', '/articles/:slug'),
                ],
            },
        }), WS);
        expect(t[0].entryPointId).toBe('GET:/users/:id');
    });

    it('falls back to first api when there are no GETs at all', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [{ repoId: 'r', name: 'svc' }],
            summaries: {
                r: [api('POST', '/items'), api('DELETE', '/items/:id')],
            },
        }), WS);
        expect(t[0].entryPointId).toBe('POST:/items');
    });
});

describe('buildWorkspaceMetaTour — sandbox scenario', () => {
    it('alpha → beta with all three repos → ordered alpha, beta, gamma', () => {
        const t = buildWorkspaceMetaTour(aggregator({
            repos: [
                { repoId: 'svc-alpha', name: 'svc-alpha' },
                { repoId: 'svc-beta', name: 'svc-beta' },
                { repoId: 'svc-gamma', name: 'svc-gamma' },
            ],
            edges: [
                { sourceRepo: 'svc-alpha', targetRepo: 'svc-beta', method: 'GET', route: '/api/svc-beta/items/:id' },
            ],
            summaries: {
                'svc-alpha': [api('GET', '/api/svc-alpha/health'), api('GET', '/api/svc-alpha/items/:id'), api('POST', '/api/svc-alpha/items')],
                'svc-beta': [api('GET', '/api/svc-beta/health'), api('GET', '/api/svc-beta/items/:id'), api('POST', '/api/svc-beta/items')],
                'svc-gamma': [api('GET', '/api/svc-gamma/health'), api('GET', '/api/svc-gamma/items/:id'), api('POST', '/api/svc-gamma/items')],
            },
        }), WS);
        expect(t.map((s) => s.entryPointId)).toEqual([
            'GET:/api/svc-alpha/health',
            'GET:/api/svc-beta/health',
            'GET:/api/svc-gamma/health',
        ]);
        // alpha first (no in-edges). After alpha is processed, beta's
        // in-edge from alpha is decremented to 0, joining gamma as 0-in.
        // Lex tie-break: svc-beta < svc-gamma, so beta wins next.
        expect(t.map((s) => s.drillDownGraphId)).toEqual([
            'tour:svc-alpha', 'tour:svc-beta', 'tour:svc-gamma',
        ]);
        expect(t.map((s) => s.stepNumber)).toEqual([1, 2, 3]);
    });
});
