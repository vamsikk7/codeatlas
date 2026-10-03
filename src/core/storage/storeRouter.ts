/**
 * ADR-034 Phase A — `resolveStoreFor(graphId, workspaceRoot)` chokepoint (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * Single function every caller goes through to map a `graphId` to either the
 * per-repo `IRepoStore` (file/flow/sequence/feature:service/api-list:cluster
 * scopes) or the workspace-wide `IAggregatorStore` (microservice:workspace,
 * map:workspace, domain:workspace, tour:workspace, health:report,
 * feature:workspace). Returns null for unrecognised prefixes — callers must
 * decide whether that's an error or just unsupported scope (legacy graphIds).
 *
 * Phase A: this module returns ResolvedStoreSpec describing *which* store
 * to use plus the extracted repoId. The actual store resolution (going from
 * spec → instance) lives in `RepoStoreRegistry` (Pass 3). Splitting these
 * keeps the routing logic pure + cheap to unit-test in isolation, with no
 * dependency on the registry singleton.
 */

import { parseGraphId } from '../graph/graphIdBuilder';

/** Workspace-scope graphIds — these always route to the aggregator. */
const WORKSPACE_GRAPH_IDS: ReadonlyArray<string> = [
    'microservice:workspace',
    'map:workspace',
    'domain:workspace',
    'tour:workspace',
    'health:report',
    'feature:workspace',
];

/** Graph-id types that route to a per-repo store. */
const REPO_SCOPED_TYPES = new Set<string>(['file', 'flow', 'sequence', 'feature', 'api-list']);

export interface ResolvedStoreRepoSpec {
    scope: 'repo';
    /** Empty string in single-repo workspaces — registry resolves to the only repo. */
    repoId: string;
    /** Original graphId — passed through unchanged. */
    graphId: string;
}
export interface ResolvedStoreWorkspaceSpec {
    scope: 'workspace';
    graphId: string;
}
export type ResolvedStoreSpec = ResolvedStoreRepoSpec | ResolvedStoreWorkspaceSpec | null;

/**
 * Map a graphId to the store scope + repoId. Pure — no I/O, no registry
 * lookup. Phase A: single-repo workspaces produce `repoId: ''` for all
 * repo-scope graphIds; Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) embeds `repoId` in the path prefix
 * (e.g. `file:repo-a/src/x.ts`) and we split it out here.
 *
 * `workspaceRoot` is reserved for future use — Phase B uses it to detect
 * multi-repo workspaces and decide whether `repoId` should be parsed out
 * of the path or defaulted to ''.
 */
export function resolveStoreFor(
    graphId: string,
    _workspaceRoot: string,
): ResolvedStoreSpec {
    if (!graphId || typeof graphId !== 'string') return null;

    // Exact-match workspace-scope graphIds.
    if (WORKSPACE_GRAPH_IDS.includes(graphId)) {
        return { scope: 'workspace', graphId };
    }

    // Repo-scope prefixes. Phase A: repoId is always '' (single-repo).
    // Phase B will parse the first path segment after the prefix as repoId
    // when multi-repo mode is active. Issue #362 Phase B (2026-06-07):
    // single parseGraphId pass instead of five .startsWith checks.
    const parsed = parseGraphId(graphId);
    if (parsed && REPO_SCOPED_TYPES.has(parsed.type)) {
        return { scope: 'repo', repoId: '', graphId };
    }

    // Unrecognised prefix — caller decides (might be legacy `api-list:workspace`
    // or a not-yet-spec'd id). Returning null is the explicit "don't route".
    return null;
}

/**
 * Helper for tests / debugging — list the workspace-scope graphIds the
 * router treats as aggregator-bound. Keeps the constant private to the
 * module but introspectable in tests.
 */
export function getWorkspaceGraphIds(): ReadonlyArray<string> {
    return WORKSPACE_GRAPH_IDS;
}
