/**
 * outsideRouteTitle.ts - Bug A (2026-06-04)
 *
 * Routes that render OUTSIDE the graph-based navigation stack
 * (currently `#/violations`, `#/api-testing`, `#/tour`) don't push an
 * entry into navState, so the existing `prettifyGraphLabel`-driven
 * `document.title` update never fires for them. Without this helper,
 * `#/violations` inherits whatever title was last set (often
 * "Health Report" from a prior visit), confusing users.
 *
 * Pure mapping from outside-route → human-readable title suffix.
 */
export function outsideRouteTitle(route: string | null | undefined): string | null {
    if (!route) return null;
    switch (route) {
        case 'violations': return 'Architecture Violations';
        case 'tour': return 'Tour';
        case 'api-testing': return 'API Testing';
        default: return null;
    }
}
