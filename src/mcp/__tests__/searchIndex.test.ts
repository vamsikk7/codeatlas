/**
 * searchIndex.test.ts — unit tests for the keyword-search reverse index.
 */
import { describe, it, expect } from 'vitest';
import type { Snapshot } from '../../core/graph/graphTypes';
import { tokenize, searchWorkspace } from '../searchIndex';

function buildSnapshot(): Snapshot {
    return {
        files: {
            'src/auth/auth.service.ts': {
                path: 'src/auth/auth.service.ts',
                hash: 'h1', mtime: 0,
                symbols: {
                    functions: [
                        { name: 'getCurrentUser', kind: 'function', span: { start: 0, end: 1 }, signature: 'async function getCurrentUser(id)', bodyText: '', stableKey: 'k1' },
                        { name: 'createUser', kind: 'function', span: { start: 1, end: 2 }, signature: 'async function createUser(data)', bodyText: '', stableKey: 'k2' },
                    ],
                    variables: [],
                    imports: [],
                },
            },
            'src/article/article.controller.ts': {
                path: 'src/article/article.controller.ts',
                hash: 'h2', mtime: 0,
                symbols: {
                    functions: [
                        { name: 'ArticleController', kind: 'class', span: { start: 0, end: 1 }, signature: 'class ArticleController', bodyText: '', stableKey: 'k3' },
                    ],
                    variables: [],
                    imports: [],
                },
            },
        },
        apiIndex: {
            'GET:/user::src/auth/auth.controller.ts::anonymous@GET:/user': {
                apiId: 'GET:/user::src/auth/auth.controller.ts::anonymous@GET:/user',
                method: 'GET', route: '/user',
                handlerName: 'anonymous@GET:/user', filePath: 'src/auth/auth.controller.ts',
                anchor: { filePath: 'src/auth/auth.controller.ts' },
                meta: { auth: 'required', middlewares: ['auth.required'] },
            },
            'POST:/articles::src/article/article.controller.ts::createArticle': {
                apiId: 'POST:/articles::src/article/article.controller.ts::createArticle',
                method: 'POST', route: '/articles',
                handlerName: 'createArticle', filePath: 'src/article/article.controller.ts',
                anchor: { filePath: 'src/article/article.controller.ts' },
                diff: 'modified',
            },
        },
        graphs: {},
        clusters: {
            'cluster:auth': { id: 'cluster:auth', label: 'auth', files: ['src/auth/auth.service.ts', 'src/auth/auth.controller.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 },
            'cluster:article': { id: 'cluster:article', label: 'article', files: ['src/article/article.controller.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 },
        },
        services: {
            'service:main': { id: 'service:main', name: 'main-api', rootPath: '.', technology: 'express', exposedApiCount: 2, consumedUrls: [], consumedServices: [] },
        },
    };
}

describe('searchIndex', () => {
    describe('tokenize', () => {
        it('lowercases + splits on non-word boundaries', () => {
            expect(tokenize('Foo-Bar.Baz')).toEqual(expect.arrayContaining(['foo', 'bar', 'baz']));
        });

        it('splits camelCase', () => {
            const t = tokenize('getCurrentUser');
            expect(t).toEqual(expect.arrayContaining(['get', 'current', 'user', 'getcurrentuser']));
        });

        it('splits snake_case + kebab-case', () => {
            expect(tokenize('current_user_id')).toEqual(expect.arrayContaining(['current', 'user', 'id']));
            expect(tokenize('article-controller')).toEqual(expect.arrayContaining(['article', 'controller']));
        });

        it('drops stop words and very short tokens', () => {
            expect(tokenize('the and a')).toEqual([]);
            expect(tokenize('x y z')).toEqual([]); // all < MIN_TOKEN_LEN
        });
    });

    describe('searchWorkspace', () => {
        it('finds a function by name', () => {
            const results = searchWorkspace(buildSnapshot(), 'getCurrentUser');
            expect(results.length).toBeGreaterThan(0);
            const top = results[0];
            expect(top.name).toBe('getCurrentUser');
            expect(top.kind).toBe('function');
            expect(top.score).toBe(1);
        });

        it('finds a route by method + path', () => {
            const results = searchWorkspace(buildSnapshot(), 'GET user');
            // Top hit should be the route, ranked above other matches.
            expect(results[0].kind).toBe('route');
            expect(results[0].route).toBe('/user');
        });

        it('finds a feature by cluster label', () => {
            const results = searchWorkspace(buildSnapshot(), 'auth', { kinds: ['feature'] });
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].kind).toBe('feature');
            expect(results[0].name).toBe('auth');
        });

        it('finds a class by name', () => {
            const results = searchWorkspace(buildSnapshot(), 'ArticleController');
            const cls = results.find((r) => r.kind === 'class');
            expect(cls).toBeDefined();
            expect(cls!.name).toBe('ArticleController');
        });

        it('boosts diff-modified entries', () => {
            const results = searchWorkspace(buildSnapshot(), 'article', { kinds: ['route', 'feature'] });
            // The POST /articles route is marked modified — should rank above
            // the unchanged article cluster when scores would otherwise tie.
            const route = results.find((r) => r.kind === 'route');
            expect(route?.diff).toBe('modified');
            expect(route!.score).toBeGreaterThan(0);
        });

        it('respects the kinds filter', () => {
            const onlyRoutes = searchWorkspace(buildSnapshot(), 'user', { kinds: ['route'] });
            for (const r of onlyRoutes) expect(r.kind).toBe('route');
        });

        it('returns empty for unmatched query', () => {
            const results = searchWorkspace(buildSnapshot(), 'completely_nonsense_token_xyz');
            expect(results).toEqual([]);
        });

        it('returns empty for empty / stop-word-only query', () => {
            expect(searchWorkspace(buildSnapshot(), '')).toEqual([]);
            expect(searchWorkspace(buildSnapshot(), 'the and a')).toEqual([]);
        });

        it('limit option caps the result count', () => {
            const results = searchWorkspace(buildSnapshot(), 'user', { limit: 2 });
            expect(results.length).toBeLessThanOrEqual(2);
        });

        // Multi-keyword search support.
        it('accepts an array of keywords (OR semantics by default)', () => {
            const results = searchWorkspace(buildSnapshot(), ['user', 'article']);
            // Should find function getCurrentUser AND class ArticleController AND
            // routes/features matching either term.
            const names = results.map((r) => r.name);
            expect(names).toEqual(expect.arrayContaining(['getCurrentUser', 'ArticleController']));
        });

        it('treats string query "user article" the same as ["user","article"]', () => {
            const a = searchWorkspace(buildSnapshot(), 'user article');
            const b = searchWorkspace(buildSnapshot(), ['user', 'article']);
            expect(a.map((r) => r.id).sort()).toEqual(b.map((r) => r.id).sort());
        });

        it('requireAll=true returns only entries matching every keyword', () => {
            // "user" + "create" — should ONLY match createUser (both tokens).
            // getCurrentUser has "user" but not "create"; ArticleController has
            // neither.
            const results = searchWorkspace(buildSnapshot(), ['create', 'user'], { requireAll: true });
            const names = results.map((r) => r.name);
            expect(names).toContain('createUser');
            expect(names).not.toContain('getCurrentUser');
            expect(names).not.toContain('ArticleController');
        });

        it('requireAll=false (default) returns coverage-boosted union', () => {
            // Same query without requireAll — getCurrentUser SHOULD appear
            // (single-token match), but createUser ranks higher (two-token match).
            const results = searchWorkspace(buildSnapshot(), ['create', 'user']);
            const create = results.find((r) => r.name === 'createUser');
            const getUser = results.find((r) => r.name === 'getCurrentUser');
            expect(create).toBeDefined();
            expect(getUser).toBeDefined();
            expect(create!.score).toBeGreaterThan(getUser!.score);
        });

        it('multi-keyword array with empty entries is tolerant', () => {
            const results = searchWorkspace(buildSnapshot(), ['', 'getCurrentUser', '']);
            expect(results.some((r) => r.name === 'getCurrentUser')).toBe(true);
        });

        it('requireAll with no matches returns empty', () => {
            const results = searchWorkspace(buildSnapshot(), ['user', 'nonexistent_token_zz'], { requireAll: true });
            expect(results).toEqual([]);
        });
    });
});
