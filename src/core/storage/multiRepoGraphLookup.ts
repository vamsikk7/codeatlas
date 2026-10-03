/**
 * multiRepoGraphLookup.ts — UX-28 follow-up (2026-06-05).
 *
 * In multi-repo workspaces the workspace-level snapshot store is empty by
 * design; the per-repo `state.db` stores hold the real api-list /
 * sequence / file / flow graphs. The `requestRoute` handler in
 * `extension.ts` walks the registered repos to find the requested
 * graphId. The walk logic used to be inlined for `apis` only; this
 * module factors it out so `sequence` / `file` / `flow` can share the
 * same lookup and so the behaviour is unit-testable.
 *
 * The two-tier shape: if the workspace store already has the graph,
 * caller is expected to use it (this helper is only consulted on a
 * miss). The helper returns the FIRST non-empty match across repos.
 */

import * as path from 'path';
import type { IAggregatorStore, IRepoStore } from './storeInterfaces';

export interface MultiRepoLookupResult {
    graph: any;
    repoName?: string;
}

/**
 * True when the aggregator reports ≥ 2 repos with `rootPath` set —
 * i.e. a real multi-repo workspace (the default `repos[]` includes the
 * synthetic workspace row, which has no rootPath).
 */
export function isMultiRepoWorkspace(aggregator: IAggregatorStore | undefined | null): boolean {
    if (!aggregator) return false;
    try {
        const repos = aggregator.listRepos();
        return repos.length >= 2 && repos.some((r) => !!r.rootPath);
    } catch {
        return false;
    }
}

/**
 * Walk the repo stores looking for `graphId`. Returns the first graph
 * that exists AND looks non-empty (nodes > 0 OR meta.apis > 0 for
 * api-list graphs that store their payload in meta instead of nodes).
 *
 * `getRepoStore` is the registry accessor; it may be the live registry
 * or a test fake. Errors per-repo are swallowed (the underlying store
 * file may have just been swapped during cascade) — they don't abort
 * the lookup. `log` is optional; only called on success so the user can
 * trace which repo answered.
 */
export async function findGraphInRepos(
    graphId: string,
    aggregator: IAggregatorStore | undefined | null,
    // Issue #790 #3 regression — the resolver MUST return a loaded store.
    // In monorepo mode a sync `getRepoStore()` returns a fresh empty
    // SnapshotStore; the `.getWorking().graphs[graphId]` lookup below
    // then sees `undefined` even though the on-disk per-repo state.db
    // has the data. Callers pass `getRepoStoreLoaded` (async) so the
    // store is `await load()`-ed before this helper reads it.
    getRepoStore: (absRepoPath: string) => Promise<IRepoStore | undefined> | IRepoStore | undefined,
    workspaceRoot: string,
    log?: (msg: string) => void,
): Promise<MultiRepoLookupResult | null> {
    if (!aggregator) return null;
    if (!graphId) return null;
    let repos: ReadonlyArray<{ rootPath?: string; name?: string; repoId?: string }>;
    try { repos = aggregator.listRepos(); }
    catch { return null; }
    if (repos.length < 2) return null;

    for (const r of repos) {
        if (!r.rootPath) continue;
        let candidate: any;
        try {
            const absPath = path.join(workspaceRoot, r.rootPath);
            const repoStore = await getRepoStore(absPath);
            candidate = repoStore?.getWorking().graphs[graphId];
        } catch {
            continue;
        }
        if (!candidate) continue;
        // Accept anything with nodes OR — for api-list graphs that
        // store their payload as a meta.apis array — accept that
        // shape too. File / flow / sequence always have nodes.
        const nodeCount = Array.isArray(candidate.nodes) ? candidate.nodes.length : 0;
        const metaApisCount = Array.isArray(candidate?.meta?.apis) ? candidate.meta.apis.length : 0;
        if (nodeCount === 0 && metaApisCount === 0) continue;
        if (log) log(`[multiRepoGraphLookup] resolved ${graphId} from repo=${r.name ?? r.repoId}`);
        return { graph: candidate, repoName: r.name ?? r.repoId };
    }
    return null;
}
