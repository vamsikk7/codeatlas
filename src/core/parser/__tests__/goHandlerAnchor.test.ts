/**
 * goHandlerAnchor.test.ts — TICKET-DETECT-3 (Go cross-file handler anchoring).
 */
import { describe, it, expect } from 'vitest';
import { resolveGoHandlerAnchors } from '../goHandlerAnchor';
import type { ApiRecord } from '../../graph/graphTypes';

function rec(p: Partial<ApiRecord>): ApiRecord {
    return {
        apiId: `${p.method}:${p.route}::${p.filePath}::${p.handlerName}`,
        method: 'GET', route: '/x', handlerName: 'Get', filePath: 'hexagonal/main.go',
        ...p,
    } as ApiRecord;
}
function index(...recs: ApiRecord[]): Record<string, ApiRecord> {
    return Object.fromEntries(recs.map((r) => [r.apiId, r]));
}
function files(defs: Record<string, string[]>): Record<string, any> {
    // defs: file -> [function names]
    const out: Record<string, any> = {};
    for (const [f, fns] of Object.entries(defs)) out[f] = { symbols: { functions: fns.map((name) => ({ name })) } };
    return out;
}

describe('TICKET-DETECT-3 — Go handler anchor resolution', () => {
    it('re-anchors r.Get("/x", handler.Get) onto the handler file (same sub-app)', () => {
        const before = index(rec({ method: 'GET', route: '/products/{code}', handlerName: 'Get', filePath: 'hexagonal/main.go' }));
        const after = resolveGoHandlerAnchors(before, files({
            'hexagonal/main.go': ['main'],
            'hexagonal/api/http.go': ['handler.Get', 'handler.Post'],
        }));
        const e = Object.values(after)[0];
        expect(Object.values(after)).toHaveLength(1);
        expect(e.filePath).toBe('hexagonal/api/http.go');
        expect(e.method).toBe('GET');
        expect(e.route).toBe('/products/{code}');
        expect(e.anchor?.filePath).toBe('hexagonal/api/http.go');
        expect(e.meta?.routeDeclFile).toBe('hexagonal/main.go');
    });

    it('picks the SAME sub-app handler when the name recurs across sub-apps (nearest path)', () => {
        const before = index(rec({ method: 'GET', route: '/api', handlerName: 'Hello', filePath: 'jwt/router/router.go' }));
        const after = resolveGoHandlerAnchors(before, files({
            'jwt/router/router.go': ['SetupRoutes'],
            'jwt/handler/api.go': ['Hello'],           // same sub-app → nearest
            'auth-jwt/handlers/api.go': ['Hello'],     // other sub-app → farther
            'gorm-mysql/routes/routes.go': ['Hello'],  // other sub-app → farther
        }));
        expect(Object.values(after)[0].filePath).toBe('jwt/handler/api.go');
    });

    it('leaves the entry unchanged when the nearest match is a TIE (ambiguous → never a wrong anchor)', () => {
        const before = index(rec({ method: 'GET', route: '/x', handlerName: 'Get', filePath: 'app/main.go' }));
        const after = resolveGoHandlerAnchors(before, files({
            'app/main.go': ['main'],
            'app/a/h.go': ['Get'],  // shared prefix 'app' (1)
            'app/b/h.go': ['Get'],  // shared prefix 'app' (1) — tie!
        }));
        expect(after).toBe(before); // referentially unchanged
    });

    it('does not touch anonymous / closure handlers', () => {
        const before = index(rec({ method: 'POST', route: '/x', handlerName: 'anonymous@POST:/x', filePath: 'app/main.go' }));
        const after = resolveGoHandlerAnchors(before, files({ 'app/main.go': ['main'], 'app/h.go': ['Post'] }));
        expect(after).toBe(before);
    });

    it('does not move a handler already defined in the route file', () => {
        const before = index(rec({ method: 'GET', route: '/x', handlerName: 'Get', filePath: 'app/main.go' }));
        const after = resolveGoHandlerAnchors(before, files({ 'app/main.go': ['main', 'Get'] }));
        expect(after).toBe(before);
    });

    it('fast-bails on non-Go workspaces', () => {
        const before = index(rec({ method: 'GET', route: '/x', handlerName: 'getUsers', filePath: 'src/app.ts' }));
        const after = resolveGoHandlerAnchors(before, files({ 'src/app.ts': ['getUsers'] } as any));
        expect(after).toBe(before);
    });

    it('is deterministic — baseline + working re-anchor identically (no diff churn)', () => {
        const mk = () => index(rec({ method: 'GET', route: '/products', handlerName: 'GetAll', filePath: 'hexagonal/main.go' }));
        const f = files({ 'hexagonal/main.go': ['main'], 'hexagonal/api/http.go': ['handler.GetAll'] });
        const a = resolveGoHandlerAnchors(mk(), f);
        const b = resolveGoHandlerAnchors(mk(), f);
        expect(Object.keys(a)).toEqual(Object.keys(b));
        expect(Object.values(a)[0].apiId).toBe(Object.values(b)[0].apiId);
    });
});
