/**
 * sequenceMiddlewareWeaver.ts - UX-30 (2026-06-04)
 *
 * Insert middleware participants into an already-built sequence graph.
 *
 * Background: routes captured with `ApiRecord.meta.middlewares = ['cors',
 * 'auth.required', 'rateLimit']` had those names dropped at the
 * sequence-builder stage because `FRAMEWORK_NOISE` lists them as
 * uninteresting plumbing. So a request that actually flows through
 * `cors → helmet → auth → rateLimit → handler` rendered as
 * `Client → Handler` — every security/observability hop invisible.
 *
 * This post-processor takes the route's middleware list (preserved on
 * `ApiRecord.meta.middlewares`) and weaves a synthetic participant
 * per name into the sequence between the API Client (the actor) and
 * the first handler call. Each middleware also gets a kind tag so
 * the L3 renderer can pick a distinct icon (🔒 for auth-required,
 * 🛡 for CORS, ⏱ for rate-limit, etc.).
 *
 * Pure function — does not mutate the input graph. The caller calls
 * it AFTER `buildSequenceGraph` and BEFORE writing to the snapshot
 * store, so existing tests of buildSequenceGraph keep passing.
 */

import type { DiagramGraph, GraphNode, GraphEdge } from './graphTypes';

export type MiddlewareKind =
    | 'auth-required'
    | 'auth-optional'
    | 'cors'
    | 'rate-limit'
    | 'cache'
    | 'logging'
    | 'validator'
    | 'parser'
    | 'compression'
    | 'session'
    | 'csrf'
    | 'security'
    | 'transform'
    | 'error-handler'
    | 'other';

/**
 * Classify a middleware name into a stable kind tag. The L3 renderer
 * uses this to pick an icon + role in tooltips.
 */
export function classifyMiddleware(name: string): MiddlewareKind {
    const lower = (name ?? '').toLowerCase();

    // Auth — required (denies on failure).
    if (
        /(?:^|\.)auth\.required$/.test(lower) ||
        /^auth$/.test(lower) ||
        /^authrequired$/.test(lower) ||
        /^authmiddleware$/.test(lower) ||
        /^requireauth$/.test(lower) ||
        /^isauthenticated$/.test(lower) ||
        /^ensureauth(?:enticated)?$/.test(lower) ||
        /^basicauth$/.test(lower) ||
        /^bearerauth$/.test(lower) ||
        /^jwt(?:auth)?$/.test(lower) ||
        /(?:^|\.)passport\.authenticate$/.test(lower) ||
        /^expressjwt$/.test(lower) ||
        /^koajwt$/.test(lower) ||
        /^login_required$/.test(lower) ||
        /^authenticate_user!?$/.test(lower) ||
        // NestJS Guards
        /guard$/.test(lower) ||
        // Spring @PreAuthorize / Django @permission_required handled separately by frameworks
        /^@preauthorize$/.test(lower) ||
        /^@permission_required$/.test(lower)
    ) return 'auth-required';

    // Auth — optional (best-effort).
    if (
        /(?:^|\.)auth\.optional$/.test(lower) ||
        /^optionalauth$/.test(lower)
    ) return 'auth-optional';

    if (/^cors$/.test(lower) || /-cors$/.test(lower)) return 'cors';
    if (/ratelimit/.test(lower) || /throttle/.test(lower) || /rate_limit/.test(lower)) return 'rate-limit';
    if (/^cache/.test(lower) || /memoize/.test(lower)) return 'cache';
    if (/^morgan$/.test(lower) || /logger/.test(lower) || /logging/.test(lower)) return 'logging';
    if (/validator/.test(lower) || /validate/.test(lower) || /joi/.test(lower) || /zod/.test(lower) || /pipe$/.test(lower)) return 'validator';
    if (/body-?parser/.test(lower) || /multer/.test(lower) || /cookie-?parser/.test(lower) || /^express-fileupload$/.test(lower)) return 'parser';
    if (/compression/.test(lower)) return 'compression';
    if (/session/.test(lower)) return 'session';
    if (/csrf/.test(lower) || /xsrf/.test(lower)) return 'csrf';
    if (/^helmet/.test(lower) || /security/.test(lower)) return 'security';
    if (/transform/.test(lower) || /interceptor/.test(lower)) return 'transform';
    if (/error/.test(lower) || /exception/.test(lower) || /errorhandler/.test(lower)) return 'error-handler';
    return 'other';
}

interface WeaveOptions {
    /**
     * Identifier for the route this graph belongs to (used to build
     * unique node ids when multiple routes share the same middleware).
     */
    routeKey?: string;
    /**
     * UX-31 Phase 2 (2026-06-05) — Express 4-arg `(err, req, res, next)`
     * error-handler middleware to weave AFTER the handler as the
     * 4xx/5xx error-path terminator. The handler → error-handler edge
     * is labeled `throws 4xx/5xx` so the reader sees the error path
     * distinctly from the normal `next()` chain.
     */
    errorHandlers?: ReadonlyArray<string>;
}

/**
 * Inserts the middleware participants into the given graph.
 *
 * Strategy:
 *   - Find the participant node typed as `actor` (the API Client) — if
 *     none exists, this is a non-HTTP sequence, return the graph unchanged.
 *   - Find the first non-actor participant (the handler entry).
 *   - For each middleware in order, synthesize a participant node typed
 *     `middleware` with kind = classifyMiddleware(name). Insert between
 *     actor and handler.
 *   - Rewrite the actor → handler request edge into a chain
 *     actor → mw1 → mw2 → … → handler.
 *   - Leave response edges (handler → actor) alone — most middleware
 *     touches request, not response, and the chain becomes noisy if
 *     we mirror it both ways.
 *
 * Pure: returns a new graph, doesn't mutate input.
 */
export function weaveMiddlewareParticipants(
    graph: DiagramGraph,
    middlewares: ReadonlyArray<string> | null | undefined,
    opts: WeaveOptions = {},
): DiagramGraph {
    const errorHandlers = opts.errorHandlers ?? [];
    const hasMiddlewares = !!(middlewares && middlewares.length > 0);
    const hasErrorHandlers = errorHandlers.length > 0;
    if (!hasMiddlewares && !hasErrorHandlers) return graph;
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return graph;

    // Skip when there's no clear actor → handler chain (defensive).
    // The kind/subtitle conventions vary: some builders set `kind: 'actor'`
    // on the GraphNode, others encode it only in `subtitle: '«actor»'`
    // (the visible chip in the webview). Accept both forms so we don't
    // miss the dominant Express case.
    const looksLikeActor = (n: GraphNode): boolean => {
        if ((n as any).kind === 'actor') return true;
        if (typeof (n as any).subtitle === 'string' && /«actor»/.test((n as any).subtitle)) return true;
        if (typeof (n as any).label === 'string' && /^API Client$/i.test((n as any).label)) return true;
        return false;
    };
    const actorNode = graph.nodes.find(looksLikeActor);
    const handlerNode = graph.nodes.find((n) => n !== actorNode && n.type === 'participant');
    if (!actorNode || !handlerNode) return graph;

    const routeKey = opts.routeKey ?? graph.graphId ?? 'route';
    const newNodes: GraphNode[] = [...graph.nodes];
    const newEdges: GraphEdge[] = [...graph.edges];

    // Synthesize a participant per middleware.
    const middlewareNodes: GraphNode[] = (middlewares ?? []).map((name, i) => {
        const kind = classifyMiddleware(name);
        const id = `mw:${routeKey}:${i}:${name}`;
        return {
            id,
            type: 'participant' as const,
            label: name,
            subtitle: `«middleware»`,
            meta: {
                middlewareKind: kind,
                middlewareName: name,
                middlewareOrder: i,
            } as any,
        } as GraphNode;
    });

    // Insert middleware participants right after the actor.
    const actorIdx = newNodes.indexOf(actorNode);
    newNodes.splice(actorIdx + 1, 0, ...middlewareNodes);

    // Find the original request edge (actor → handler) and rewrite into a chain.
    const reqEdgeIdx = newEdges.findIndex((e) => e.source === actorNode.id && e.target === handlerNode.id);
    // 2026-06-09 — preserve the original entry edge's label (HTTP method
    // + route, e.g. "POST /login") on the first hop of the synthesized
    // chain. Before this, the weaver dropped the route info and
    // hardcoded the placeholder "request", leaving users with no route
    // signal at the inbound-HTTP arrow — the spot where it's most useful.
    // Falls back to "request" only when no original entry edge was
    // present (synthetic graphs / unusual inputs).
    const originalEntryLabel = reqEdgeIdx >= 0
        ? String((newEdges[reqEdgeIdx] as any).label ?? '').trim()
        : '';
    const firstHopLabel = originalEntryLabel || 'request';
    // The inbound endpoint arrow (e.g. "GET /user") must reflect whether the
    // endpoint's HANDLER changed. The weaver retargets this arrow onto the first
    // middleware — which usually didn't change — so the webview's "inherit the
    // target participant's diff" rule finds an unchanged target and the change is
    // invisible on the entry arrow. Carry the handler participant's diff onto the
    // first hop (falling back to the original request edge's own non-unchanged
    // diff). Only stamps when the handler genuinely changed, so no over-marking.
    const handlerDiff = (handlerNode as any).diff && (handlerNode as any).diff !== 'unchanged'
        ? (handlerNode as any).diff
        : undefined;
    const originalReqDiff = reqEdgeIdx >= 0 ? (newEdges[reqEdgeIdx] as any).diff : undefined;
    const inboundDiff = handlerDiff ?? (originalReqDiff && originalReqDiff !== 'unchanged' ? originalReqDiff : undefined);
    const chainEdges: GraphEdge[] = [];
    const chainSource = (i: number) => (i === 0 ? actorNode.id : middlewareNodes[i - 1].id);
    for (let i = 0; i < middlewareNodes.length; i++) {
        chainEdges.push({
            id: `mw-edge:${routeKey}:${i}`,
            source: chainSource(i),
            target: middlewareNodes[i].id,
            label: i === 0 ? firstHopLabel : 'next()',
            // Carry the endpoint-change signal onto the inbound arrow so a
            // middleware chain doesn't hide that the handler was modified.
            ...(i === 0 && inboundDiff ? { diff: inboundDiff } : {}),
            // 2026-06-09 — stamp `edgeType: 'message'` so the SequenceView
            // edge filter (`graph.edges.filter(e => e.edgeType === 'message')`)
            // includes these synthesized hops in the swimlane render. Pre-fix
            // they had no `edgeType` and got silently dropped — users saw
            // middleware participants in the lifeline lane but no arrows
            // connecting them, breaking the inbound-request flow.
            edgeType: 'message',
            meta: { synthetic: 'middleware' } as any,
        } as GraphEdge);
    }
    // Final hop: last middleware → handler.
    if (middlewareNodes.length > 0) {
        chainEdges.push({
            id: `mw-edge:${routeKey}:to-handler`,
            source: middlewareNodes[middlewareNodes.length - 1].id,
            target: handlerNode.id,
            label: 'next()',
            edgeType: 'message',
            meta: { synthetic: 'middleware' } as any,
        } as GraphEdge);
    }

    // 2026-06-09 — preserve the original entry edge's anchor under the
    // NEW first chain edge id. The SPA's edge click handler looks up
    // `graph.anchors[edgeId]` to navigate to the handler source; if we
    // rewrite the entry edge to a new id without re-keying the anchor,
    // clicking the "GET /user" message goes nowhere. The anchor under
    // the OLD key is left in place for any back-compat reader.
    const newAnchors: Record<string, any> = { ...(graph.anchors ?? {}) };
    if (reqEdgeIdx >= 0) {
        const originalEdgeId = (newEdges[reqEdgeIdx] as any).id as string | undefined;
        if (originalEdgeId && newAnchors[originalEdgeId] && chainEdges.length > 0) {
            const firstChainId = (chainEdges[0] as any).id as string;
            newAnchors[firstChainId] = newAnchors[originalEdgeId];
        }
        newEdges.splice(reqEdgeIdx, 1, ...chainEdges);
    } else if (chainEdges.length > 0) {
        newEdges.unshift(...chainEdges);
    }

    // UX-31 Phase 2 (2026-06-05) — error-handler weave. After the
    // handler, attach one participant per error handler. Each gets a
    // distinct `throws 4xx/5xx` edge from the handler so the reader
    // sees the error path apart from the normal `next()` chain.
    const errorNodes: GraphNode[] = errorHandlers.map((name, i) => ({
        id: `err:${routeKey}:${i}:${name}`,
        type: 'participant' as const,
        label: name,
        subtitle: `«error-handler»`,
        meta: {
            middlewareKind: 'error-handler',
            middlewareName: name,
            middlewareOrder: i,
            errorTerminator: true,
        } as any,
    } as GraphNode));
    if (errorNodes.length > 0) {
        newNodes.push(...errorNodes);
        for (let i = 0; i < errorNodes.length; i++) {
            newEdges.push({
                id: `err-edge:${routeKey}:${i}`,
                source: handlerNode.id,
                target: errorNodes[i].id,
                label: 'throws 4xx/5xx',
                meta: { synthetic: 'error-handler' } as any,
            } as GraphEdge);
        }
    }

    return {
        ...graph,
        nodes: newNodes,
        edges: newEdges,
        anchors: newAnchors,
        meta: {
            ...(graph.meta ?? {}),
            ...(hasMiddlewares ? { wovenMiddlewareCount: middlewares!.length } : {}),
            ...(hasErrorHandlers ? { wovenErrorHandlerCount: errorHandlers.length } : {}),
        },
    };
}
