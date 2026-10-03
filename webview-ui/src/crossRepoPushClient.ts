/**
 * crossRepoPushClient.ts — #817.5 (2026-06-11).
 *
 * Client-side decision logic for `crossRepoEdgeChanged` pushes. Kept as a
 * pure module (no React, no globals) so the active-refresh / passive-badge
 * split is unit-testable without mounting App.
 *
 * Rules (#817 R5):
 *   - The push matters to a tab when its CURRENT VIEW renders cross-repo
 *     edges: the L1-class routes (`system-design`, `map`, `domain`).
 *       - Workspace-scoped (no repo param) → always refresh: the bare view
 *         renders every repo + the consumes-edges between them.
 *       - Repo-scoped → refresh when the scope matches an affected
 *         consumer OR the producer itself (both sides of the edge render
 *         the marker).
 *   - Any other route (or no match) → passive badge: the change is queued
 *     and surfaced as an "upstream change" chip; clicking navigates to the
 *     first affected consumer's L1.
 */

export interface CrossRepoEdgeChangeEdge {
    consumerRepoId: string;
    consumerRepoName: string;
    method: string;
    route: string;
    diff: string | null;
    prevDiff?: string | null;
}

export interface CrossRepoEdgeChangedMsg {
    type: 'crossRepoEdgeChanged';
    producerRepoId: string;
    producerRepoName: string;
    edges: CrossRepoEdgeChangeEdge[];
    at: number;
}

/** Routes whose rendered graph carries cross-repo edges. */
const REFRESHABLE_ROUTES = new Set(['system-design', 'map', 'domain']);

/** Parse `#/<route>` or `#/<route>/<scope>` → { route, scope }. */
export function routeAndScopeFromHash(hash: string): { route: string; scope: string | null } | null {
    let path = (hash ?? '').replace(/^#\/?/, '');
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
    if (!path || path === 'home') return null;
    const m = path.match(/^([^/?]+)(?:\/([^/?]+))?/);
    if (!m) return null;
    return { route: m[1], scope: m[2] ?? null };
}

export interface CrossRepoAction {
    /** True → soft-refresh the current view (re-request its route). */
    refresh: boolean;
    /** Unique affected consumer repo names (badge + navigation targets). */
    affectedConsumers: string[];
    /** Toast text shown when refreshing; null otherwise. */
    toast: string | null;
}

export function decideCrossRepoAction(hash: string, msg: CrossRepoEdgeChangedMsg): CrossRepoAction {
    const affectedConsumers = [...new Set(msg.edges.map((e) => e.consumerRepoName))];
    const parsed = routeAndScopeFromHash(hash);

    const toastText = (): string => {
        if (msg.edges.length === 1) {
            const e = msg.edges[0];
            // Revert-clear arrives as `null` or the derived `'unchanged'`
            // (recomputeDiffs writes the literal once hashes re-converge).
            const state = (e.diff === null || e.diff === 'unchanged') ? 'back in sync' : e.diff;
            return `${msg.producerRepoName} updated ${e.method} ${e.route} — ${e.consumerRepoName} consumer marker ${state}`;
        }
        return `${msg.producerRepoName} changed ${msg.edges.length} consumed endpoints — view refreshed`;
    };

    if (parsed && REFRESHABLE_ROUTES.has(parsed.route)) {
        if (parsed.scope === null) {
            // Workspace view renders every cross-repo edge.
            return { refresh: true, affectedConsumers, toast: toastText() };
        }
        const scope = parsed.scope;
        const matches =
            scope === msg.producerRepoName || scope === msg.producerRepoId ||
            msg.edges.some((e) => e.consumerRepoName === scope || e.consumerRepoId === scope);
        if (matches) {
            return { refresh: true, affectedConsumers, toast: toastText() };
        }
    }
    return { refresh: false, affectedConsumers, toast: null };
}
