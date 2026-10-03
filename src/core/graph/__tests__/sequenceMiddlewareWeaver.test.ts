/**
 * sequenceMiddlewareWeaver.test.ts - UX-30 (2026-06-04)
 */

import { describe, it, expect } from 'vitest';
import {
    weaveMiddlewareParticipants,
    classifyMiddleware,
} from '../sequenceMiddlewareWeaver';
import type { DiagramGraph } from '../graphTypes';

function makeBaseGraph(): DiagramGraph {
    return {
        graphId: 'sequence:src/routes/auth.ts:login',
        type: 'sequence',
        nodes: [
            { id: 'actor:client', type: 'participant', label: 'API Client', kind: 'actor', subtitle: 'Inbound requests' } as any,
            { id: 'handler:login', type: 'participant', label: 'login', kind: 'module', subtitle: 'auth.ts' } as any,
        ],
        edges: [
            { id: 'edge:req', source: 'actor:client', target: 'handler:login', label: 'POST /login' } as any,
            { id: 'edge:res', source: 'handler:login', target: 'actor:client', label: '200' } as any,
        ],
        anchors: {},
    } as DiagramGraph;
}

describe('classifyMiddleware', () => {
    it('maps common auth identifiers to auth-required', () => {
        expect(classifyMiddleware('auth.required')).toBe('auth-required');
        expect(classifyMiddleware('authRequired')).toBe('auth-required');
        expect(classifyMiddleware('isAuthenticated')).toBe('auth-required');
        expect(classifyMiddleware('passport.authenticate')).toBe('auth-required');
        expect(classifyMiddleware('expressJwt')).toBe('auth-required');
        expect(classifyMiddleware('JwtAuthGuard')).toBe('auth-required');
    });

    it('maps auth.optional / optionalAuth to auth-optional', () => {
        expect(classifyMiddleware('auth.optional')).toBe('auth-optional');
        expect(classifyMiddleware('optionalAuth')).toBe('auth-optional');
    });

    it('maps common categories', () => {
        expect(classifyMiddleware('cors')).toBe('cors');
        expect(classifyMiddleware('helmet')).toBe('security');
        expect(classifyMiddleware('rateLimit')).toBe('rate-limit');
        expect(classifyMiddleware('morgan')).toBe('logging');
        expect(classifyMiddleware('logger')).toBe('logging');
        expect(classifyMiddleware('bodyParser')).toBe('parser');
        expect(classifyMiddleware('multer')).toBe('parser');
        expect(classifyMiddleware('compression')).toBe('compression');
        expect(classifyMiddleware('csrf')).toBe('csrf');
        expect(classifyMiddleware('session')).toBe('session');
        expect(classifyMiddleware('cacheMiddleware')).toBe('cache');
        expect(classifyMiddleware('ValidationPipe')).toBe('validator');
        expect(classifyMiddleware('errorHandler')).toBe('error-handler');
        // `LoggingInterceptor` matches the `logger`/`logging` substring
        // first — the more specific category wins. NestJS Interceptors
        // that AREN'T logging-shaped fall to `transform`.
        expect(classifyMiddleware('LoggingInterceptor')).toBe('logging');
        expect(classifyMiddleware('CacheInterceptor')).toBe('cache');
        expect(classifyMiddleware('SerialiseInterceptor')).toBe('transform');
    });

    it('falls back to "other" for unrecognized names', () => {
        expect(classifyMiddleware('xyzMiddleware')).toBe('other');
        expect(classifyMiddleware('myCustomCheck')).toBe('other');
        expect(classifyMiddleware('')).toBe('other');
    });
});

describe('weaveMiddlewareParticipants - UX-30', () => {
    it('returns the graph unchanged when middlewares is empty / null', () => {
        const g = makeBaseGraph();
        expect(weaveMiddlewareParticipants(g, [])).toBe(g);
        expect(weaveMiddlewareParticipants(g, null)).toBe(g);
        expect(weaveMiddlewareParticipants(g, undefined)).toBe(g);
    });

    it('inserts one participant per middleware between actor and handler', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth.required', 'rateLimit']);
        expect(out.nodes.length).toBe(g.nodes.length + 3);
        const labels = out.nodes.map((n) => n.label);
        expect(labels).toEqual(['API Client', 'cors', 'auth.required', 'rateLimit', 'login']);
    });

    it('stamps each middleware participant with a kind tag', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth.required', 'rateLimit']);
        const mwNodes = out.nodes.filter((n) => (n.meta as any)?.middlewareName);
        expect(mwNodes.map((n) => (n.meta as any).middlewareKind)).toEqual(['cors', 'auth-required', 'rate-limit']);
    });

    it('rewrites the actor → handler edge into a chain through middlewares', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth']);
        // Original request edge should be gone.
        expect(out.edges.find((e) => e.source === 'actor:client' && e.target === 'handler:login')).toBeUndefined();
        // The chain: actor → mw[0] → mw[1] → handler.
        const sources = out.edges.map((e) => e.source);
        const targets = out.edges.map((e) => e.target);
        const mwIds = out.nodes.filter((n) => (n.meta as any)?.middlewareName).map((n) => n.id);
        expect(sources).toContain('actor:client');
        expect(targets).toContain(mwIds[0]);
        expect(sources).toContain(mwIds[0]);
        expect(targets).toContain(mwIds[1]);
        expect(sources).toContain(mwIds[1]);
        expect(targets).toContain('handler:login');
    });

    it('preserves the response edge (handler → actor) unchanged', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors']);
        const resEdge = out.edges.find((e) => e.source === 'handler:login' && e.target === 'actor:client');
        expect(resEdge).toBeDefined();
        expect(resEdge!.label).toBe('200');
    });

    it('does not mutate the input graph', () => {
        const g = makeBaseGraph();
        const beforeNodeCount = g.nodes.length;
        const beforeEdgeCount = g.edges.length;
        weaveMiddlewareParticipants(g, ['cors', 'auth']);
        expect(g.nodes.length).toBe(beforeNodeCount);
        expect(g.edges.length).toBe(beforeEdgeCount);
    });

    it('returns graph unchanged when there is no actor or no handler', () => {
        const g: DiagramGraph = { ...makeBaseGraph(), nodes: [] };
        expect(weaveMiddlewareParticipants(g, ['cors'])).toBe(g);
    });

    it('stamps meta.wovenMiddlewareCount on the output graph', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth', 'rateLimit']);
        expect((out.meta as any).wovenMiddlewareCount).toBe(3);
    });

    // 2026-06-09 — user-reported bug: the inbound request label
    // (HTTP method + route, e.g. "POST /login") was getting silently
    // overwritten with the generic placeholder "request" whenever a
    // middleware was woven in. Users lost the route signal at the
    // exact spot it was most useful — the actor → first-hop edge.
    it('preserves the HTTP method + route on the actor → first-middleware edge', () => {
        const g = makeBaseGraph(); // entry edge label = "POST /login"
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth.required']);
        const mwIds = out.nodes.filter((n) => (n.meta as any)?.middlewareName).map((n) => n.id);
        const firstHop = out.edges.find((e) => e.source === 'actor:client' && e.target === mwIds[0]);
        expect(firstHop, 'first hop edge must exist').toBeDefined();
        expect(firstHop!.label,
            `actor → first-middleware label should contain the route "POST /login", got "${firstHop!.label}"`,
        ).toContain('POST /login');
    });

    it('falls back to the generic placeholder only when no original entry edge label exists', () => {
        // Build a graph WITHOUT the actor → handler entry edge — should
        // still synthesize a chain, but with the generic "request" label.
        const g = makeBaseGraph();
        g.edges = g.edges.filter(e => !(e.source === 'actor:client' && e.target === 'handler:login'));
        const out = weaveMiddlewareParticipants(g, ['cors']);
        const mwIds = out.nodes.filter((n) => (n.meta as any)?.middlewareName).map((n) => n.id);
        const firstHop = out.edges.find((e) => e.source === 'actor:client' && e.target === mwIds[0]);
        expect(firstHop, 'first hop edge synthesized even without entry edge').toBeDefined();
        expect(firstHop!.label).toBe('request');
    });

    it('keeps middleware → middleware hops labeled "next()" (only the FIRST hop carries the route)', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth.required']);
        const mwIds = out.nodes.filter((n) => (n.meta as any)?.middlewareName).map((n) => n.id);
        const midHop = out.edges.find((e) => e.source === mwIds[0] && e.target === mwIds[1]);
        expect(midHop?.label).toBe('next()');
        const toHandler = out.edges.find((e) => e.source === mwIds[1] && e.target === 'handler:login');
        expect(toHandler?.label).toBe('next()');
    });

    // 2026-06-09 — every synthesized chain edge must carry
    // `edgeType: 'message'` so the SequenceView edge filter
    // (`graph.edges.filter(e => e.edgeType === 'message')`) includes
    // them. Without this, middleware participants render in the lifeline
    // lane but no arrows connect them — the inbound request flow is
    // invisible.
    it('stamps edgeType="message" on every synthesized chain edge so SequenceView renders them', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth.required']);
        const synthetic = out.edges.filter(e => (e.meta as any)?.synthetic === 'middleware');
        expect(synthetic.length, 'should have 3 synthesized hops: actor→mw0, mw0→mw1, mw1→handler').toBe(3);
        for (const e of synthetic) {
            expect((e as any).edgeType, `synthesized edge "${e.id}" must carry edgeType="message"`).toBe('message');
        }
    });

    // 2026-06-09 — user-reported: clicking the "GET /user" message on
    // the L3 sequence diagram used to navigate to the route's anonymous
    // handler function in the source. Post-weaver this stopped working
    // because the synthesized first chain edge has a NEW id
    // (`mw-edge:<routeKey>:0`) but the `graph.anchors` map still keyed
    // the navigation target by the ORIGINAL entry edge id. The edge
    // renders but clicking it returns `anchor = undefined`.
    //
    // Fix: when the weaver replaces the original entry edge, copy that
    // edge's anchor entry to the new first chain edge's id so click
    // navigation continues to land on the handler source.
    it('rekeys the entry-edge anchor to the new first chain edge id so click→navigate still works', () => {
        const g = makeBaseGraph();
        // Stamp an anchor on the original entry edge.
        g.anchors = { 'edge:req': { filePath: 'src/routes/auth.ts', lineStart: 12, lineEnd: 18, symbol: 'anonymous@POST:/login' } as any };
        const out = weaveMiddlewareParticipants(g, ['auth.required']);
        const mwIds = out.nodes.filter((n) => (n.meta as any)?.middlewareName).map((n) => n.id);
        const firstHop = out.edges.find((e) => e.source === 'actor:client' && e.target === mwIds[0])!;
        // The handler must have copied the original anchor to the new
        // edge id so the SPA's `graph.anchors[firstHop.id]` lookup finds
        // the route handler source.
        expect(out.anchors[firstHop.id], `anchor must be keyed under the new edge id "${firstHop.id}"`).toBeDefined();
        expect((out.anchors[firstHop.id] as any).filePath).toBe('src/routes/auth.ts');
        expect((out.anchors[firstHop.id] as any).symbol).toBe('anonymous@POST:/login');
    });

    it('preserves the original anchor entry under its old key too (back-compat for legacy readers)', () => {
        const g = makeBaseGraph();
        g.anchors = { 'edge:req': { filePath: 'src/routes/auth.ts', symbol: 'login' } as any };
        const out = weaveMiddlewareParticipants(g, ['auth.required']);
        expect(out.anchors['edge:req']).toBeDefined();
    });

    // UX-31 Phase 2 (2026-06-05) — error-handler terminator weave.
    it('UX-31 Phase 2: inserts error-handler participant after the handler', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['auth'], { errorHandlers: ['errorHandler'] });
        const errParticipant = out.nodes.find((n) => n.label === 'errorHandler');
        expect(errParticipant).toBeDefined();
        // The error participant should be classified.
        expect((errParticipant as any).meta?.middlewareKind).toBe('error-handler');
    });

    it('UX-31 Phase 2: adds a handler → error-handler error-path edge', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, [], { errorHandlers: ['errorHandler'] });
        const errEdge = out.edges.find((e: any) => /4xx|5xx|error|throw/i.test(e.label ?? ''));
        expect(errEdge).toBeDefined();
    });

    it('UX-31 Phase 2: meta.wovenErrorHandlerCount reflects count', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, [], { errorHandlers: ['errorHandler', 'secondErrorHandler'] });
        expect((out.meta as any).wovenErrorHandlerCount).toBe(2);
    });

    it('UX-31 Phase 2: no errorHandlers → no terminator weave + no meta key', () => {
        const g = makeBaseGraph();
        const out = weaveMiddlewareParticipants(g, ['auth']);
        expect((out.meta as any).wovenErrorHandlerCount).toBeUndefined();
        const errEdge = out.edges.find((e: any) => /4xx|5xx|throw/i.test(e.label ?? ''));
        expect(errEdge).toBeUndefined();
    });
});

describe('inbound endpoint arrow reflects handler diff (middleware chain)', () => {
    const firstHop = (out: DiagramGraph) =>
        out.edges.find((e: any) => e.label === 'POST /login' && e.meta?.synthetic === 'middleware');

    it('modified handler → inbound "POST /login" arrow is marked modified', () => {
        const g = makeBaseGraph();
        (g.nodes.find(n => n.label === 'login') as any).diff = 'modified';
        const out = weaveMiddlewareParticipants(g, ['auth.required']);
        const hop = firstHop(out) as any;
        expect(hop, 'inbound first-hop edge must exist').toBeTruthy();
        expect(hop.diff, 'inbound arrow inherits the modified handler diff').toBe('modified');
    });

    it('added handler → inbound arrow is marked added', () => {
        const g = makeBaseGraph();
        (g.nodes.find(n => n.label === 'login') as any).diff = 'added';
        const out = weaveMiddlewareParticipants(g, ['auth.required']);
        expect((firstHop(out) as any).diff).toBe('added');
    });

    it('unchanged handler → inbound arrow carries no modified diff (no over-marking)', () => {
        const g = makeBaseGraph();
        // handler participant left with no diff (unchanged)
        const out = weaveMiddlewareParticipants(g, ['auth.required']);
        const hop = firstHop(out) as any;
        expect(hop.diff === undefined || hop.diff === 'unchanged').toBe(true);
    });

    it('later next() hops are NOT stamped — only the inbound arrow', () => {
        const g = makeBaseGraph();
        (g.nodes.find(n => n.label === 'login') as any).diff = 'modified';
        const out = weaveMiddlewareParticipants(g, ['cors', 'auth.required']);
        // the intermediate/handler-bound next() hops must not carry the inbound stamp
        const nextHops = out.edges.filter((e: any) => e.label === 'next()' && e.meta?.synthetic === 'middleware');
        expect(nextHops.every((e: any) => e.diff === undefined || e.diff === 'unchanged')).toBe(true);
    });
});
