/**
 * tourBuilder.test.ts — Issue #702 onboarding-tour ordering tests.
 */

import { describe, it, expect } from 'vitest';
import { buildTour, toLiteSteps, isAnonymousHandlerName } from '../tourBuilder';
import type {
    Snapshot,
    ApiRecord,
    SerializedCallGraphNode,
    SerializedCallGraph,
} from '../../graph/graphTypes';

function api(id: string, route: string, filePath: string, handlerName = 'h', method = 'GET', diff?: 'added' | 'modified' | 'deleted' | 'unchanged'): ApiRecord {
    return {
        apiId: id,
        method,
        route,
        handlerName,
        filePath,
        anchor: { filePath, symbol: handlerName, span: { start: 0, end: 1 } },
        ...(diff && { diff }),
    };
}

function callNode(key: string, calledBy: string[] = []): SerializedCallGraphNode {
    const [filePath, functionName] = key.split('::');
    return { key, filePath, functionName, calls: [], calledBy };
}

function callGraph(nodes: SerializedCallGraphNode[]): SerializedCallGraph {
    const out: SerializedCallGraph = { nodes: {}, edges: [], version: 1 };
    for (const n of nodes) out.nodes[n.key] = n;
    return out;
}

function emptySnapshot(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

describe('buildTour — codebase mode', () => {
    it('returns empty when no APIs exist', () => {
        const steps = buildTour(emptySnapshot(), 'codebase');
        expect(steps).toEqual([]);
    });

    // Issue UX-13 (2026-06-03) — at equal fan-in, prefer reading verbs
    // (GET) over write verbs (DELETE/PUT/POST) so Tour Step 1 doesn't
    // land on a hostile-sounding endpoint.
    it('at equal fan-in, GET sorts before DELETE / PUT / POST', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                delArticle:  api('delArticle',  '/articles/:slug', 'src/article.ts', 'del', 'DELETE'),
                putArticle:  api('putArticle',  '/articles/:slug', 'src/article.ts', 'put', 'PUT'),
                postArticle: api('postArticle', '/articles',       'src/article.ts', 'post', 'POST'),
                getArticle:  api('getArticle',  '/articles',       'src/article.ts', 'get', 'GET'),
            },
            // All four have zero callers — fan-in 0, equal weighted key.
            callGraph: callGraph([
                callNode('src/article.ts::del'),
                callNode('src/article.ts::put'),
                callNode('src/article.ts::post'),
                callNode('src/article.ts::get'),
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        // GET must be Step 1. DELETE must be last among these four.
        expect(steps[0].entryPointId).toBe('getArticle');
        const last = steps[steps.length - 1];
        expect(last.entryPointId).toBe('delArticle');
    });

    it('BUG-POLAR-27: a meta/asset route (GET /og) ranks below a real business route despite higher fan-in', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                og: api('og', '/og', 'src/og.ts', 'ogHandler'),
                login: api('login', '/auth/login', 'src/auth.ts', 'loginHandler'),
            },
            callGraph: callGraph([
                callNode('src/og.ts::ogHandler', ['c1', 'c2', 'c3']), // higher fan-in
                callNode('src/auth.ts::loginHandler', ['c1']),        // lower fan-in
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        // /og is an OpenGraph meta route — a real auth route must lead the tour.
        expect(steps[0].entryPointId).toBe('login');
        expect(steps[steps.length - 1].entryPointId).toBe('og');
    });

    it('BUG-POLAR-27: favicon / sitemap / static asset routes are downweighted too', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                fav: api('fav', '/favicon.ico', 'src/fav.ts', 'favHandler'),
                sitemap: api('sitemap', '/sitemap.xml', 'src/sm.ts', 'smHandler'),
                real: api('real', '/checkout', 'src/checkout.ts', 'checkoutHandler'),
            },
            callGraph: callGraph([
                callNode('src/fav.ts::favHandler', ['a', 'b', 'c', 'd']),
                callNode('src/sm.ts::smHandler', ['a', 'b', 'c']),
                callNode('src/checkout.ts::checkoutHandler', ['a']),
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].entryPointId).toBe('real');
    });

    it('orders entry points by fan-in DESC', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                low: api('low', '/low', 'src/low.ts', 'lowFn'),
                hi: api('hi', '/hi', 'src/hi.ts', 'hiFn'),
                mid: api('mid', '/mid', 'src/mid.ts', 'midFn'),
            },
            callGraph: callGraph([
                callNode('src/low.ts::lowFn', []),
                callNode('src/hi.ts::hiFn', ['caller1', 'caller2', 'caller3']),
                callNode('src/mid.ts::midFn', ['caller1', 'caller2']),
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps.map(s => s.entryPointId)).toEqual(['hi', 'mid', 'low']);
    });

    it('numbers steps 1..N in order', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a: api('a', '/a', 'src/a.ts'),
                b: api('b', '/b', 'src/b.ts'),
                c: api('c', '/c', 'src/c.ts'),
            },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps.map(s => s.stepNumber)).toEqual([1, 2, 3]);
    });

    it('respects maxSteps cap', () => {
        const apis: Record<string, ApiRecord> = {};
        for (let i = 0; i < 50; i++) {
            apis[`a${i}`] = api(`a${i}`, `/r${i}`, `src/f${i}.ts`);
        }
        const steps = buildTour({ ...emptySnapshot(), apiIndex: apis }, 'codebase', { maxSteps: 10 });
        expect(steps).toHaveLength(10);
    });

    it('drill-down resolves to sequence when handler name is present, file otherwise', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                with: api('with', '/x', 'src/x.ts', 'xHandler'),
                without: api('without', '/y', 'src/y.ts', ''),
            },
        };
        const steps = buildTour(snapshot, 'codebase');
        const withStep = steps.find(s => s.entryPointId === 'with')!;
        const withoutStep = steps.find(s => s.entryPointId === 'without')!;
        expect(withStep.drillDownGraphId).toBe('sequence:src/x.ts:xHandler');
        expect(withoutStep.drillDownGraphId).toBe('file:src/y.ts');
    });

    it('produces a non-empty blurb for each step', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: { a: api('a', '/login', 'src/login.ts', 'loginHandler') },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].why.length).toBeGreaterThan(0);
        expect(steps[0].why).toContain('/login');
    });
});

describe('buildTour — recent mode', () => {
    it('orders modified routes first, then added, then unchanged', () => {
        // Three routes; only `b` is in baseline (so `a` and `c` are 'added').
        // 'modified' is hard to synthesize without a sequence-graph diff, so
        // this test focuses on the added-vs-unchanged ordering.
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a: api('a', '/a', 'src/a.ts'),
                b: api('b', '/b', 'src/b.ts'),
                c: api('c', '/c', 'src/c.ts'),
            },
        };
        const steps = buildTour(snapshot, 'recent', { baselineApiIds: new Set(['b']) });
        // 'a' + 'c' are added (bucket 1); 'b' is unchanged (bucket 2).
        // Within each bucket, fan-in tie → alphabetical.
        expect(steps.map(s => s.entryPointId)).toEqual(['a', 'c', 'b']);
    });

    it('blurb marks added routes as new', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a: api('a', '/new', 'src/new.ts', 'h'),
            },
        };
        const steps = buildTour(snapshot, 'recent', { baselineApiIds: new Set() });
        // Issue #753 — blurb language updated to lead with the insight.
        expect(steps[0].why).toMatch(/Newly added|added since baseline/i);
    });

    // Issue #748: recent mode must read per-record `diff` field (set by
    // buildApiListGraph). Without this, modified routes silently stayed
    // in the unchanged bucket and the order matched codebase mode.
    it('orders routes with diff="modified" ahead of unchanged when baselineApiIds is absent', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a: api('a', '/a', 'src/a.ts', 'h', 'GET'),
                b: api('b', '/b', 'src/b.ts', 'h', 'GET', 'modified'),
                c: api('c', '/c', 'src/c.ts', 'h', 'GET'),
            },
        };
        // No baselineApiIds → previously every route landed in bucket 2
        // and the order matched codebase mode. Now `b` should lead.
        const steps = buildTour(snapshot, 'recent');
        expect(steps.map(s => s.entryPointId)).toEqual(['b', 'a', 'c']);
    });

    it('prefers diff="modified" over diff="added" within the bucket order', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                a: api('a', '/a', 'src/a.ts', 'h', 'GET', 'added'),
                b: api('b', '/b', 'src/b.ts', 'h', 'GET', 'modified'),
                c: api('c', '/c', 'src/c.ts', 'h', 'GET'),
            },
        };
        const steps = buildTour(snapshot, 'recent');
        expect(steps.map(s => s.entryPointId)).toEqual(['b', 'a', 'c']);
    });
});

// Issue #770: tour ranking should promote production user-facing routes
// over tests / migrations / seeds / catch-alls / framework-class
// constructors / library internals.
describe('buildTour — Issue #770 ranking filters', () => {
    it('drops test-file handlers from Tour candidates', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                test_high_fanin: api('test_high_fanin', '/x', 'src/__tests__/api.test.ts', 'fn', 'GET'),
                real_low_fanin: api('real_low_fanin', '/y', 'src/api.ts', 'fn', 'POST'),
            },
            callGraph: callGraph([
                callNode('src/__tests__/api.test.ts::fn', ['a', 'b', 'c', 'd', 'e']),
                callNode('src/api.ts::fn', ['x']),
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps.map(s => s.entryPointId)).toEqual(['real_low_fanin']);
    });

    it('drops NestJS-style constructor entries', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                ctor: api('ctor', '/articles', 'src/article.controller.ts', 'constructor', 'CONTROLLER'),
                get: api('get', '/articles', 'src/article.controller.ts', 'findAll', 'GET'),
            },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps.map(s => s.entryPointId)).toEqual(['get']);
    });

    it('ranks GET above DB_MIGRATION at equal fan-in', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                migration: api('migration', '/db/0001', 'db/migrate/0001.rb', 'Migration', 'DB_MIGRATION'),
                getRoute: api('getRoute', '/articles', 'src/article.controller.ts', 'findAll', 'GET'),
            },
            callGraph: callGraph([
                callNode('db/migrate/0001.rb::Migration', ['x']),
                callNode('src/article.controller.ts::findAll', ['x']),
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].entryPointId).toBe('getRoute');
    });

    it('downranks catch-all routes (`ALL *`)', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                catchall: api('catchall', '*', 'src/server.ts', 'getReplay', 'ANY'),
                real:     api('real',     '/api/articles', 'src/api/articles.ts', 'list', 'GET'),
            },
            callGraph: callGraph([
                callNode('src/server.ts::getReplay', ['a', 'b', 'c', 'd']),
                callNode('src/api/articles.ts::list', ['x']),
            ]),
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].entryPointId).toBe('real');
    });

    it('excludes handlers from a self-imported library directory', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            files: {
                'pyproject.toml': { path: 'pyproject.toml', hash: 'x', mtime: 0, symbols: { functions: [], classes: [], variables: [], imports: [] } } as any,
                'starlette/__init__.py': { path: 'starlette/__init__.py', hash: 'x', mtime: 0, symbols: { functions: [], classes: [], variables: [], imports: [] } } as any,
                ...Object.fromEntries(Array.from({ length: 22 }, (_, i) => [
                    `starlette/middleware/m${i}.py`,
                    { path: `starlette/middleware/m${i}.py`, hash: 'x', mtime: 0, symbols: { functions: [], classes: [], variables: [], imports: [] } } as any,
                ])),
                'app.py': { path: 'app.py', hash: 'x', mtime: 0, symbols: { functions: [], classes: [], variables: [], imports: [] } } as any,
            },
            apiIndex: {
                libMW: api('libMW', '/*', 'starlette/middleware/m1.py', 'AuthenticationMiddleware', 'MIDDLEWARE'),
                userRoute: api('userRoute', '/api/items', 'app.py', 'list_items', 'GET'),
            },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps.map(s => s.entryPointId)).toEqual(['userRoute']);
    });
});

describe('toLiteSteps', () => {
    it('flattens anchor into top-level filePath + symbol', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: { a: api('a', '/r', 'src/r.ts', 'rHandler') },
        };
        const steps = buildTour(snapshot, 'codebase');
        const lite = toLiteSteps(steps);
        expect(lite[0].filePath).toBe('src/r.ts');
        expect(lite[0].symbol).toBe('rHandler');
        expect((lite[0] as any).anchor).toBeUndefined();
    });
});

// Bug D (2026-06-04) — Tour step bodies must NOT expose synthetic
// `anonymous@<METHOD>:<route>` handler IDs the parser generates for
// inline arrow-callback routes. The blurb should read "Read /." not
// "Read /. Handler: `anonymous@GET:/`.".
describe('buildTour — Bug D: anonymous handler IDs are hidden from blurb', () => {
    it('isAnonymousHandlerName treats `anonymous@…` and empty as anonymous', () => {
        expect(isAnonymousHandlerName('anonymous@GET:/')).toBe(true);
        expect(isAnonymousHandlerName('anonymous@POST:/users/login')).toBe(true);
        expect(isAnonymousHandlerName('')).toBe(true);
        expect(isAnonymousHandlerName(null)).toBe(true);
        expect(isAnonymousHandlerName(undefined)).toBe(true);
        // Named handlers stay named.
        expect(isAnonymousHandlerName('getCurrentUser')).toBe(false);
        expect(isAnonymousHandlerName('listArticles')).toBe(false);
    });

    it('blurb for an anonymous-handler route omits the Handler: tail', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: { a: api('a', '/', 'src/main.ts', 'anonymous@GET:/', 'GET') },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps.length).toBeGreaterThan(0);
        expect(steps[0].why).not.toMatch(/anonymous@/);
        expect(steps[0].why).not.toMatch(/Handler:/);
        // Should still surface a friendly verb phrase.
        expect(steps[0].why).toMatch(/Read \//);
    });

    it('blurb for a named-handler route keeps the Handler: tail', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: { a: api('a', '/health', 'src/h.ts', 'healthCheck', 'GET') },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].why).toMatch(/healthCheck/);
        expect(steps[0].why).toMatch(/Handler:/);
    });
});

// #846a (2026-06-11) — step blurbs must read as guidance, not route
// restatements: STEP 1 explains why it leads; steps carry their owning
// feature cluster when known.
describe('tour blurb guidance (#846a)', () => {
    it('codebase STEP 1 opens with "Start here —" and a reason', () => {
        const snapshot: any = {
            apiIndex: {
                'GET:/a::src/a.ts::ha': { apiId: 'GET:/a::src/a.ts::ha', method: 'GET', route: '/a', filePath: 'src/a.ts', handlerName: 'ha' },
                'GET:/b::src/b.ts::hb': { apiId: 'GET:/b::src/b.ts::hb', method: 'GET', route: '/b', filePath: 'src/b.ts', handlerName: 'hb' },
            },
            files: {}, graphs: {}, clusters: {},
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].why).toMatch(/^Start here — /);
        expect(steps[0].why).toMatch(/most (connected|natural)/);
        expect(steps[1].why).not.toMatch(/^Start here/);
    });

    it('steps name their owning feature cluster when the snapshot has one', () => {
        const snapshot: any = {
            apiIndex: {
                'GET:/u::src/auth/u.ts::getUser': { apiId: 'GET:/u::src/auth/u.ts::getUser', method: 'GET', route: '/u', filePath: 'src/auth/u.ts', handlerName: 'getUser' },
            },
            files: {}, graphs: {},
            clusters: {
                'cluster:auth': { id: 'cluster:auth', name: 'User Authentication', files: ['src/auth/u.ts'], serviceId: 's', apisInCluster: [] },
            },
        };
        const steps = buildTour(snapshot, 'codebase');
        expect(steps[0].why).toContain('User Authentication');
    });
});
