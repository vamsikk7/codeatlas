/**
 * ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — AI review scope + findings routing helpers.
 *
 * The aiReviewEngine itself runs unchanged per repo. What Phase G adds:
 *
 *   1. A `ReviewScope` type the UI + handler use to pick how broad a
 *      review runs.
 *   2. A pure `routeFindingByGraphId` that decides which store
 *      (aggregator vs per-repo) the finding lives in, mirroring the
 *      conventions storeRouter.resolveStoreFor already established
 *      for cascade graphs.
 *   3. A `planWorkspaceReview` helper that turns a `workspace` scope
 *      into the per-repo target list, honouring `changedOnly`.
 *
 * The actual fan-out (calling runReview per repo with the right scope)
 * lives in the handler module that already owns aiReviewEngine, since
 * it has the HandlerContext + RepoDispatcher access. This file stays
 * pure so the routing decisions are unit-testable in isolation.
 */
import type { IAggregatorStore, RepoRow } from '../storage/storeInterfaces';

export interface ReviewScope {
    kind: 'workspace' | 'repo' | 'entry-point';
    /** Required for 'repo' and 'entry-point'. */
    repoId?: string;
    /** Required for 'entry-point'. */
    entryPointId?: string;
    /** When true, only repos with `repos.diff !== 'unchanged'` are reviewed. */
    changedOnly?: boolean;
}

export interface ReviewTarget {
    repoId: string;
    rootPath: string;
    name: string;
    /** When set, narrow the review to one entry point inside this repo. */
    entryPointId?: string;
}

export interface RoutedFinding {
    /** 'workspace' = goes to aggregator.ai_review_findings; 'repo' = per-repo state.db. */
    target: 'workspace' | 'repo';
    /** When target='repo', this is the repoId whose store owns the finding. */
    repoId?: string;
}

// Workspace-scope graphIds — these always route to the aggregator. Mirrors
// the `WORKSPACE_GRAPH_IDS` list in storeRouter.ts; kept synced manually
// since it's the canonical Phase A list and rarely changes.
const WORKSPACE_GRAPH_IDS: ReadonlyArray<string> = [
    'microservice:workspace',
    'map:workspace',
    'domain:workspace',
    'tour:workspace',
    'health:report',
    'feature:workspace',
];

/**
 * Decide whether a finding belongs in the aggregator's workspace findings
 * table or in one repo's per-repo state.db.
 *
 * Single-repo workspaces always route to 'repo' (no repoId prefix in the
 * graphId; the per-repo store IS the workspace store).
 *
 * Multi-repo:
 *   - Workspace-scope graphIds → 'workspace' (aggregator)
 *   - graphIds with `<repoId>/` prefix → 'repo' with the parsed repoId
 *   - graphIds without prefix → 'repo' with the workspace's only repo
 *     (single-repo path; falls back to undefined repoId if the caller
 *     never passes a repoList)
 */
export function routeFindingByGraphId(
    graphId: string,
    repos: ReadonlyArray<RepoRow>,
): RoutedFinding {
    if (!graphId || typeof graphId !== 'string') {
        return { target: 'repo' };
    }

    if (WORKSPACE_GRAPH_IDS.includes(graphId)) {
        return { target: 'workspace' };
    }

    // Single-repo workspace: one row with rootPath==''. Findings on any
    // repo-scope graphId go to that single repo's store.
    if (repos.length === 1 && (!repos[0].rootPath || repos[0].rootPath === '')) {
        return { target: 'repo', repoId: repos[0].repoId };
    }

    // Multi-repo: parse repoId from the path prefix.
    //   `file:<rootPath>/<file>`         → rootPath = first segment
    //   `flow:<rootPath>/<file>:<fn>`
    //   `sequence:<rootPath>/<file>:<h>`
    //   `feature:cluster:<id>`           → cluster IDs may not encode repoId yet
    //                                      → caller resolves via cluster→files
    //   `api-list:cluster:<id>`          → same as above
    const colon = graphId.indexOf(':');
    if (colon < 0) return { target: 'repo' };
    const prefix = graphId.slice(0, colon);
    const rest = graphId.slice(colon + 1);

    if (prefix === 'file' || prefix === 'flow' || prefix === 'sequence') {
        // The path segment is the part before the next `:` (for flow/sequence)
        // or the entire `rest` (for file).
        const pathPart = (prefix === 'file') ? rest : rest.slice(0, rest.indexOf(':') >= 0 ? rest.indexOf(':') : rest.length);
        // First path segment is the repo's rootPath.
        const firstSegment = pathPart.split('/')[0];
        // Longest rootPath match for nested repos (apps/frontend > apps).
        const sorted = [...repos]
            .filter((r) => r.rootPath)
            .sort((a, b) => b.rootPath.length - a.rootPath.length);
        for (const r of sorted) {
            const rp = r.rootPath;
            if (pathPart === rp || pathPart.startsWith(rp + '/')) {
                return { target: 'repo', repoId: r.repoId };
            }
        }
        // Fallback — first segment match against rootPath
        const match = repos.find((r) => r.rootPath === firstSegment);
        if (match) return { target: 'repo', repoId: match.repoId };
    }

    // feature:cluster:<id> / api-list:cluster:<id> — cluster IDs don't carry
    // repoId today. The caller must resolve via cluster→files when needed.
    // Default to 'repo' with no resolved id; the handler shouldn't write
    // until the cluster is fully resolved.
    return { target: 'repo' };
}

/**
 * Turn a workspace-scope review into the concrete per-repo target list.
 * Honours `changedOnly` (skips repos with diff='unchanged') and skips
 * repos with status='failed' (they have no fresh state to review).
 */
export function planWorkspaceReview(
    scope: ReviewScope,
    aggregator: IAggregatorStore,
): ReviewTarget[] {
    const repos = aggregator.listRepos();

    if (scope.kind === 'repo') {
        const r = repos.find((x) => x.repoId === scope.repoId);
        if (!r) return [];
        return [{ repoId: r.repoId, rootPath: r.rootPath, name: r.name }];
    }

    if (scope.kind === 'entry-point') {
        const r = repos.find((x) => x.repoId === scope.repoId);
        if (!r) return [];
        return [{
            repoId: r.repoId,
            rootPath: r.rootPath,
            name: r.name,
            entryPointId: scope.entryPointId,
        }];
    }

    // kind === 'workspace'
    const targets: ReviewTarget[] = [];
    for (const r of repos) {
        if (r.status === 'failed') continue;
        if (scope.changedOnly && (!r.diff || r.diff === 'unchanged')) continue;
        targets.push({ repoId: r.repoId, rootPath: r.rootPath, name: r.name });
    }
    return targets;
}

/** Exposed for tests. */
export function _workspaceGraphIdsForTest(): ReadonlyArray<string> {
    return WORKSPACE_GRAPH_IDS;
}
