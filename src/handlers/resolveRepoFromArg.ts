/**
 * UX-67 prep (2026-06-09) — `resolveRepoFromArg`
 *
 * Canonical helper for translating a user-supplied `repoId` argument
 * (which may be a hex repoId, a repo display name, or a `rootPath`)
 * into the matching repo row PLUS its absolute `gitRoot` path. Every
 * per-repo handler in the codebase (UX-63a–f, UX-65, UX-66, UX-67)
 * previously hand-rolled this lookup with subtle drift — empty
 * `rootPath` rows could leak through, `service:` prefixes weren't
 * always stripped, fallback semantics varied. This module pins the
 * contract so the rest of the per-repo surface is consistent.
 */
import * as path from 'path';

export interface RepoLike {
    repoId: string;
    name?: string;
    rootPath?: string;
}

export interface ResolvedRepo {
    repoId: string;
    name?: string;
    rootPath: string;
    /** Absolute path on disk — joins workspaceRoot + rootPath. */
    gitRoot: string;
    /** Display value preferred for log lines + diff-state labels. */
    scopedRepo: string;
}

/** Anything that exposes the repo list — usually the `AggregatorStore`. */
export interface RepoListAccessor {
    listRepos(): readonly RepoLike[] | null | undefined;
}

/**
 * Resolve a `repoId` argument to its repo + per-repo `gitRoot`.
 *
 * Match priority — first hit wins:
 *   1. `repoId` exact match (hex)
 *   2. `name` exact match
 *   3. `rootPath` exact match
 *
 * Returns `null` when:
 *   - the arg is empty / undefined / null
 *   - no row matches
 *   - the matched row has no `rootPath` (can't scope to a workspace-root row)
 *   - the repo source accessor throws or returns null
 *
 * Strips a leading `service:` prefix before matching so `serviceId`
 * values (e.g. `'service:foo'`) work uniformly with raw repo names.
 */
export function resolveRepoFromArg(
    arg: string | undefined | null,
    workspaceRoot: string,
    source: ReadonlyArray<RepoLike> | RepoListAccessor,
): ResolvedRepo | null {
    if (!arg) return null;
    const stripped = String(arg).replace(/^service:/, '');
    if (!stripped) return null;

    let repos: readonly RepoLike[] | null | undefined;
    try {
        repos = Array.isArray(source)
            ? source
            : (source as RepoListAccessor).listRepos();
    } catch {
        return null;
    }
    if (!repos || repos.length === 0) return null;

    const matched =
        repos.find(r => r.repoId === stripped)
        ?? repos.find(r => r.name === stripped)
        ?? repos.find(r => r.rootPath === stripped);
    if (!matched) return null;
    if (!matched.rootPath) return null;

    const gitRoot = path.join(workspaceRoot, matched.rootPath);
    const scopedRepo = matched.name ?? matched.rootPath ?? matched.repoId;
    return {
        repoId: matched.repoId,
        name: matched.name,
        rootPath: matched.rootPath,
        gitRoot,
        scopedRepo,
    };
}
