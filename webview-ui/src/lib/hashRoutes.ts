/**
 * hashRoutes.ts — graphId → URL-hash mapping (extracted from App.tsx for
 * unit testing, #845). `graphIdToScopedHash` carries multi-repo scope
 * (`meta.scopedRepo`) into the URL so reload/copy-link keeps the slice.
 */
export function graphIdToScopedHash(graphId: string, graph?: any): string {
    // Guard undefined/empty (BUG-AIREVIEW-BLOCKS-L2NAV) — these helpers run
    // inside render maps (e.g. AI-review finding links), so a `startsWith` on
    // undefined would crash the whole diagram, not just the one link.
    if (!graphId) return '#/system-design';
    const scopedRepo: string | undefined = graph?.meta?.scopedRepo;
    if (scopedRepo) {
        if (graphId === 'microservice:workspace') return `#/system-design/${scopedRepo}`;
        if (graphId === 'map:workspace') return `#/map/${scopedRepo}`;
        if (graphId === 'domain:workspace') return `#/domain/${scopedRepo}`;
        if (graphId === 'tour:workspace') return `#/tour/${scopedRepo}`;
        // #845 — scoped feature drills keep the repo in the URL. The
        // served graph is often the per-repo store's `feature:workspace`
        // key, which used to collapse the hash to bare `#/features` and
        // lose the scope on reload/copy-link.
        if (graphId.startsWith('feature:')) return `#/features/${scopedRepo}`;
    }
    return graphIdToHash(graphId);
}

/**
 * Map a parsed hash route back to the graphId the server serves for it — the
 * inverse of `graphIdToHash`. Used to detect an UNSOLICITED workspace-root
 * navigateTo that doesn't match the URL the tab is actually asking for
 * (BUG-VERIFY-4 cold-deep-link race). Returns null for routes with no stable
 * single graphId (e.g. missing param).
 */
export function expectedGraphIdForRoute(
    route: { route: string; param?: string; param2?: string } | null | undefined,
): string | null {
    if (!route) return null;
    switch (route.route) {
        case 'system-design': return 'microservice:workspace';
        case 'map': return 'map:workspace';
        case 'domain': return 'domain:workspace';
        case 'features': return route.param ? `feature:${route.param}` : 'feature:workspace';
        case 'health': return 'health:report';
        case 'tour': return route.param ? `tour:${route.param}` : 'tour:workspace';
        case 'apis': return route.param ? `api-list:${route.param}` : null;
        case 'sequence': return route.param ? `sequence:${route.param}` : null;
        case 'file': return route.param ? `file:${route.param}` : null;
        case 'flow': return (route.param && route.param2) ? `flow:${route.param}:${route.param2}` : null;
        default: return null;
    }
}

export function graphIdToHash(graphId: string): string {
    if (!graphId) return '#/system-design'; // guard undefined (see graphIdToScopedHash)
    if (graphId === 'microservice:workspace') return '#/system-design';
    if (graphId === 'map:workspace') return '#/map';
    if (graphId === 'domain:workspace') return '#/domain';
    if (graphId === 'tour:workspace') return '#/tour';
    // ADR-034 Phase H Pass 3 (#793) — per-repo tour drill-in.
    if (graphId.startsWith('tour:')) return `#/tour/${graphId.slice('tour:'.length)}`;
    if (graphId === 'feature:workspace') return '#/features';
    if (graphId.startsWith('feature:')) return `#/features/${graphId.slice(8)}`;
    if (graphId.startsWith('api-list:')) return `#/apis/${graphId.slice(9)}`;
    // v2 phase 4 #485 — screen-content:<screenId> routes to its own URL
    // space so deep-links work directly into a specific FE/mobile
    // screen's L2b panel.
    if (graphId.startsWith('screen-content:')) return `#/screen/${graphId.slice('screen-content:'.length)}`;
    if (graphId.startsWith('sequence:')) return `#/sequence/${graphId.slice(9)}`;
    if (graphId.startsWith('file:')) return `#/file/${graphId.slice(5)}`;
    if (graphId.startsWith('flow:')) {
        // 2026-06-09 — canonical form is `<path>:<fn>` (matches the
        // `sequence:` route's `<path>:<handler>` and the `apiId` key
        // shape used everywhere else). Earlier this rewrote to
        // `<path>/<fn>` which made flow deep-links inconsistent with
        // sequence deep-links — a user who bookmarked the colon form
        // and one who bookmarked the slash form landed at the same
        // graph but with diverging URLs in history. `parseHash` still
        // accepts both forms for back-compat with stale bookmarks.
        return `#/flow/${graphId.slice(5)}`;
    }
    if (graphId === 'health:report') return '#/health';
    return `#/diagram/${encodeURIComponent(graphId)}`;
}

