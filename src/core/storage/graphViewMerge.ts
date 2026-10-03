/**
 * graphViewMerge.ts — #821 (2026-06-10).
 *
 * Builds the unified graph view the `requestRoute` handler serves in
 * multi-repo mode, merging the workspace store's graphs with every
 * per-repo store's graphs under ADR-034's ownership contract:
 *
 *   • REPO-SCOPED graphIds (`file:` / `flow:` / `sequence:` /
 *     `feature:<svc>` / `api-list:<cluster>`) — the per-repo store is
 *     the source of truth. Its copy REPLACES any workspace copy.
 *     Pre-#821 the merge was workspace-wins-when-non-empty, so a stale
 *     `file:` graph written into the workspace store at init shadowed
 *     the per-repo fresh copy and per-repo `diff:'modified'` markers
 *     never reached the UI (DB-right + UI-wrong, found by the
 *     2026-06-10 dev-walkthrough).
 *
 *   • WORKSPACE-SCOPED graphIds (`microservice:workspace`,
 *     `map:workspace`, `domain:workspace`, `tour:workspace`,
 *     `health:report`, `feature:workspace`) — the workspace copy wins,
 *     UNLESS it's an empty shell (0 nodes), in which case a populated
 *     per-repo copy fills the gap (UX-56 behaviour preserved).
 *
 *   • Keys in `skipKeys` are never merged from per-repo stores —
 *     `feature:workspace` needs a union fold the caller performs
 *     separately (UX-53d behaviour preserved).
 *
 * Repo-scoped keys are collision-free across per-repo stores because
 * file paths are workspace-relative including the repo prefix
 * (`file:api-service/src/x.js` belongs to exactly one repo).
 */

import { resolveStoreFor } from './storeRouter';

type GraphLike = { nodes?: unknown[] } & Record<string, unknown>;
export type GraphMap = Record<string, GraphLike>;

/** True when the graphId routes to a per-repo store under ADR-034. */
export function isRepoScopedGraphId(graphId: string, workspaceRoot: string = ''): boolean {
    const spec = resolveStoreFor(graphId, workspaceRoot);
    return spec?.scope === 'repo';
}

function isEmptyShell(g: GraphLike | undefined): boolean {
    return !!g && Array.isArray(g.nodes) && g.nodes.length === 0;
}

// INVARIANT: the workspace L1 is owned by the aggregator (skeletal/bucketed
// build) and must never be filled from a per-repo store's copy — per-repo
// snapshots can carry workspace-wide service rows post-init, so their
// `microservice:workspace` graph masquerades as a full workspace L1 and
// permanently replaces the bucketed view after one rebuildFile; see ADR-037.
// Same bug class as #819 (map:workspace), enforced here instead of at the
// call site so every caller gets the contract.
const NEVER_FILL_FROM_PER_REPO = new Set(['microservice:workspace']);

/**
 * Merge the workspace store's graphs with per-repo graph maps.
 * Pure — no I/O. Caller supplies already-read graph maps.
 */
export function mergeGraphsForView(
    workspaceGraphs: GraphMap,
    perRepoGraphMaps: ReadonlyArray<GraphMap>,
    opts: { workspaceRoot?: string; skipKeys?: ReadonlySet<string> } = {},
): GraphMap {
    const workspaceRoot = opts.workspaceRoot ?? '';
    const skipKeys = opts.skipKeys ?? new Set<string>();
    const merged: GraphMap = { ...workspaceGraphs };

    for (const repoGraphs of perRepoGraphMaps) {
        for (const [graphId, graph] of Object.entries(repoGraphs)) {
            if (skipKeys.has(graphId) || NEVER_FILL_FROM_PER_REPO.has(graphId)) continue;
            if (isRepoScopedGraphId(graphId, workspaceRoot)) {
                // ADR-034: per-repo store owns repo-scoped ids — replace.
                merged[graphId] = graph;
            } else {
                // Workspace-scoped (or unrecognised): workspace wins
                // unless its copy is missing or an empty shell.
                const existing = merged[graphId];
                if (!existing || isEmptyShell(existing)) merged[graphId] = graph;
            }
        }
    }
    return merged;
}
