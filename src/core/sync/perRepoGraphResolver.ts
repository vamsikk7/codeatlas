/**
 * perRepoGraphResolver.ts — BUG-POLAR-1.
 *
 * In a monorepo, a deep-link / breadcrumb / reload addresses a sub-repo's
 * features by the REPO name (`#/features/server` → `feature:service:server`),
 * but the per-repo store keys its feature graph by the SERVICE name detected
 * inside the repo (commonly `feature:service:main`). The exact-name lookup and
 * the `<kind>:workspace` fallback both miss (the workspace-level graph is empty
 * by design in multi-repo mode), so the UI rendered "0 features detected" even
 * though the data existed.
 *
 * This mirrors the resolution the L1-click path already does (navigationHandlers
 * `openFeatureForService`, which scans for any `feature:*` graph) so deep-links
 * resolve identically to clicks.
 */
import { getLazyGraphMap } from '../storage/lazyGraphMap';

export function resolvePerRepoGraph<T extends { graphId?: string; nodes?: unknown[] } | undefined>(
    perRepoGraphs: Record<string, T>,
    kind: 'feature' | 'domain' | 'map',
    exactServiceName: string,
): T | undefined {
    const nonEmpty = (g: T): boolean => !!g && ((g!.nodes?.length ?? 0) > 0);

    // 1. Exact service-name key (`feature:service:api`).
    const exact = perRepoGraphs[`${kind}:service:${exactServiceName}`];
    if (nonEmpty(exact)) return exact;

    // 2. Per-repo workspace-level graph (`feature:workspace`).
    const ws = perRepoGraphs[`${kind}:workspace`];
    if (nonEmpty(ws)) return ws;

    // 3. ANY non-empty graph of this kind — the repoName ≠ serviceName case
    //    (e.g. repo "server" whose service graph is `feature:service:main`).
    //
    // PERF (2026-07-20, "slow L1→L2a open"): `perRepoGraphs` is normally a lazy
    // SQLite-backed Proxy (makeLazyGraphsProxy) where reading a VALUE
    // force-fetches + JSON-parses that graph. `Object.entries` / `Object.values`
    // therefore deserialize EVERY graph in the repo — 14,337 on polar's `server`
    // repo — which cost ~0.9s on EVERY features navigation (measured: this was
    // the entire "slow opening" the whole handler round-trip was 0ms otherwise).
    // Enumerate the id KEYSPACE WITHOUT fetching (LazyGraphMap.keys() reads an
    // in-memory Set) and read only the handful of `${kind}:` values.
    const prefix = `${kind}:`;
    const lazy = getLazyGraphMap(perRepoGraphs as Record<string, never>);
    const keys = lazy ? lazy.keys() : Object.keys(perRepoGraphs);
    for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const g = perRepoGraphs[key];
        if (nonEmpty(g)) return g;
    }
    return undefined;
}
