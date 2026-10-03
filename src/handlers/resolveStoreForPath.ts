/**
 * ADR-034 Phase B Pass 4b (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — file-path → per-repo store resolver.
 *
 * Navigation handlers receive a workspace-relative file path
 * (`src/app/auth.controller.ts` in single-repo, `svc-alpha/src/app.js` in
 * multi-repo). They need to read the per-repo `state.db` that owns that
 * file. This helper centralises the lookup so handlers don't reinvent it.
 *
 * Resolution algorithm:
 *   1. If the registry has no aggregator yet (Phase A workspaces created
 *      before the orchestrator landed, or in tests), return the
 *      workspace-root `SnapshotStore` — today's behaviour.
 *   2. Read the aggregator's `repos` table. If it has 0 or 1 rows,
 *      single-repo — return the workspace-root store.
 *   3. Multi-repo: find the repo whose `rootPath` is the longest prefix
 *      of `filePath`. That's the owning repo; look up its store in the
 *      registry by absolute path (`workspaceRoot/<rootPath>`).
 *   4. If no repo matches (orphan file at workspace root, or a path that
 *      escapes every repo), fall back to the workspace-root store with
 *      a debug log — never crash navigation.
 *
 * The result is the `IRepoStore` to read from + a `repoRelativePath`
 * (path under the repo's root) for callers that need it for graph IDs.
 */
import type { IRepoStore, IAggregatorStore } from '../core/storage/storeInterfaces';
import type { RepoStoreRegistry } from '../core/storage/repoStoreRegistry';

export interface ResolvedRepoStore {
    /** The per-repo (or workspace-root in single-repo) store to read from. */
    store: IRepoStore;
    /** The owning repo's id, or `''` for single-repo / unmatched paths. */
    repoId: string;
    /** The owning repo's rootPath (relative to workspace), or `''`. */
    rootPath: string;
    /** `filePath` rebased under the owning repo's root. Single-repo: same as input. */
    repoRelativePath: string;
}

export function resolveStoreForPath(
    filePath: string,
    workspaceRoot: string,
    workspaceStore: IRepoStore,
    registry: RepoStoreRegistry | undefined,
    aggregator: IAggregatorStore | undefined,
): ResolvedRepoStore {
    // Default — workspace-root store. Single-repo workspaces never deviate.
    const fallback: ResolvedRepoStore = {
        store: workspaceStore,
        repoId: '',
        rootPath: '',
        repoRelativePath: filePath,
    };

    if (!registry || !aggregator) return fallback;

    let repos;
    try { repos = aggregator.listRepos(); }
    catch { return fallback; }
    if (!repos.length) return fallback;

    // Single-repo workspace: one row with rootPath==''. Pass through.
    if (repos.length === 1 && (!repos[0].rootPath || repos[0].rootPath === '')) {
        return fallback;
    }

    // Multi-repo: longest-rootPath-prefix wins. Sort descending so the
    // deepest match resolves first (e.g. `svc-alpha/sub` beats `svc-alpha`).
    const sorted = [...repos]
        .filter((r) => r.rootPath && r.rootPath.length > 0)
        .sort((a, b) => b.rootPath.length - a.rootPath.length);

    for (const r of sorted) {
        const prefix = r.rootPath.endsWith('/') ? r.rootPath : r.rootPath + '/';
        if (filePath === r.rootPath || filePath.startsWith(prefix)) {
            const absRepoRoot = joinPaths(workspaceRoot, r.rootPath);
            let store: IRepoStore;
            try { store = registry.getRepoStore(absRepoRoot); }
            catch { return fallback; }
            return {
                store,
                repoId: r.repoId,
                rootPath: r.rootPath,
                repoRelativePath: rebase(filePath, r.rootPath),
            };
        }
    }

    return fallback;
}

function joinPaths(workspaceRoot: string, rootPath: string): string {
    if (!rootPath) return workspaceRoot;
    const ws = workspaceRoot.replace(/[/\\]+$/, '');
    return `${ws}/${rootPath.replace(/^[/\\]+/, '')}`;
}

function rebase(filePath: string, rootPath: string): string {
    if (!rootPath) return filePath;
    const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/';
    return filePath === rootPath ? '' : filePath.slice(prefix.length);
}
