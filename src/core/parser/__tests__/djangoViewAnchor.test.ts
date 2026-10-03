/**
 * djangoViewAnchor.test.ts — BUG-EXP-11.
 *
 * Django routes declared in urls.py must re-anchor onto the sibling views.py so
 * the endpoint's L3/L4/L5 target the actual handler, not the bodyless URLconf —
 * WITHOUT inflating the entry count.
 */
import { describe, it, expect } from 'vitest';
import { resolveDjangoViewAnchors } from '../djangoViewAnchor';
import type { ApiRecord } from '../../graph/graphTypes';

function rec(p: Partial<ApiRecord>): ApiRecord {
    return {
        apiId: `${p.method}:${p.route}::${p.filePath}::${p.handlerName}`,
        method: 'GET', route: '/x', handlerName: 'SomeView', filePath: 'conduit/apps/articles/urls.py',
        ...p,
    } as ApiRecord;
}
function index(...recs: ApiRecord[]): Record<string, ApiRecord> {
    return Object.fromEntries(recs.map((r) => [r.apiId, r]));
}

describe('BUG-EXP-11 — Django view anchor resolution', () => {
    it('re-anchors a urls.py route onto its sibling views.py', () => {
        const before = index(rec({
            method: 'GET', route: '/articles/feed/?',
            handlerName: 'ArticlesFeedAPIView',
            filePath: 'conduit/apps/articles/urls.py',
        }));
        const after = resolveDjangoViewAnchors(before, [
            'conduit/apps/articles/urls.py',
            'conduit/apps/articles/views.py',
            'conduit/apps/articles/models.py',
        ]);
        const entries = Object.values(after);
        expect(entries, 'entry count preserved (re-anchor, not duplicate)').toHaveLength(1);
        expect(entries[0].filePath).toBe('conduit/apps/articles/views.py');
        expect(entries[0].handlerName).toBe('ArticlesFeedAPIView');
        expect(entries[0].method).toBe('GET');
        expect(entries[0].route).toBe('/articles/feed/?');
        expect(entries[0].meta?.routeDeclFile).toBe('conduit/apps/articles/urls.py');
        // TICKET-ANCHOR-1 residual — the anchor sub-object is consistent with
        // the re-anchored filePath (both = views.py) and drops the stale urls.py span.
        expect(entries[0].anchor?.filePath).toBe('conduit/apps/articles/views.py');
        expect(entries[0].anchor?.span, 'stale urls.py span dropped').toBeUndefined();
    });

    // TICKET-ANCHOR-1 — DRF `router.register(r'articles', ArticleViewSet)` emits a
    // RESOURCE entry (handler = the ViewSet class). RESOURCE is NOT a NON_VIEW_METHOD,
    // so it re-anchors onto views.py exactly like a CBV — which is what makes a
    // `views.py` change surface the ViewSet's review entry pack (BUG-EXP-26).
    it('re-anchors a DRF `router.register` ViewSet (RESOURCE) onto its views.py (TICKET-ANCHOR-1)', () => {
        const before = index(rec({
            method: 'RESOURCE', route: '/articles',
            handlerName: 'ArticleViewSet',
            filePath: 'conduit/apps/articles/urls.py',
        }));
        const after = resolveDjangoViewAnchors(before, [
            'conduit/apps/articles/urls.py',
            'conduit/apps/articles/views.py',
        ]);
        const e = Object.values(after)[0];
        expect(Object.values(after), 'count preserved').toHaveLength(1);
        expect(e.filePath, 'ViewSet anchored to views.py, not urls.py').toBe('conduit/apps/articles/views.py');
        expect(e.method).toBe('RESOURCE');
        expect(e.route).toBe('/articles');
        expect(e.meta?.routeDeclFile).toBe('conduit/apps/articles/urls.py');
    });

    it('resolves a views/ package (views/__init__.py)', () => {
        const before = index(rec({ handlerName: 'UserView', filePath: 'app/urls.py' }));
        const after = resolveDjangoViewAnchors(before, ['app/urls.py', 'app/views/__init__.py']);
        expect(Object.values(after)[0].filePath).toBe('app/views/__init__.py');
    });

    it('leaves INCLUDE entries on urls.py (they mount another URLconf, not a view)', () => {
        const before = index(rec({ method: 'INCLUDE', route: '/api/', handlerName: 'include', filePath: 'conduit/urls.py' }));
        const after = resolveDjangoViewAnchors(before, ['conduit/urls.py', 'conduit/views.py']);
        expect(after).toBe(before);
    });

    it('does not touch a route with no sibling views module', () => {
        const before = index(rec({ handlerName: 'FooView', filePath: 'app/urls.py' }));
        const after = resolveDjangoViewAnchors(before, ['app/urls.py', 'app/models.py']);
        expect(after).toBe(before);
    });

    it('fast-bails on non-Django workspaces (no urls.py)', () => {
        const before = index(rec({ method: 'GET', route: '/h', handlerName: 'h', filePath: 'app.js' }));
        const after = resolveDjangoViewAnchors(before, ['app.js', 'routes.js']);
        expect(after).toBe(before);
    });
});
