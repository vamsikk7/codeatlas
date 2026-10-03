/**
 * UX-64 (2026-06-09) — `GitDiffStateRegistry`
 *
 * In-memory keyed registry of active `PersistedGitDiffState` sessions.
 * Before UX-64 the extension held a single module-scope `gitDiffState`
 * variable, which broke any monorepo workflow that wanted two browser
 * tabs each showing a different sub-repo's diff. The registry replaces
 * the singleton with a `Map<scope, state>` and exposes a typed API the
 * extension bootstrap + per-repo handlers consume.
 *
 * Key conventions:
 *   - `'workspace'` — single-repo / workspace-wide session slot.
 *     Backward-compat readers that don't pass a `repoId` see this entry.
 *   - `<repoName>` — per-repo session. Matches the `scopedRepo` value
 *     each per-repo handler (replayWorkingDiff, commitSelected,
 *     prSelected, branchSelected) stamps onto the state.
 *
 * UX-64 Phase 2 cleanup (2026-06-09) — the legacy "fallback to any
 * non-null" semantic for `get(undefined)` is gone. Every reader call
 * site now threads its `repoId` (or null when truly workspace-wide), so
 * an explicit `get()` only consults the workspace slot. The transitional
 * shim that returned the first per-repo entry when no workspace state
 * existed has been removed; readers without scope simply see null.
 */
import type { PersistedGitDiffState } from './gitDiffStore';

export const WORKSPACE_SCOPE = 'workspace' as const;
export type GitDiffScope = string;

export class GitDiffStateRegistry {
    private states: Map<GitDiffScope, PersistedGitDiffState> = new Map();

    /**
     * Get the state for a specific scope. Returns null when no entry
     * exists for that scope. Defaults to the workspace slot when called
     * without a scope.
     *
     * UX-64 Phase 2 cleanup (2026-06-09) — the legacy transitional shim
     * (return first per-repo entry when no workspace state existed) is
     * gone; every reader threads its scope through now.
     */
    get(scope?: GitDiffScope | null): PersistedGitDiffState | null {
        const key = scope ?? WORKSPACE_SCOPE;
        return this.states.get(key) ?? null;
    }

    /** Set the state for a scope. Overwrites any existing entry. */
    set(scope: GitDiffScope, state: PersistedGitDiffState): void {
        this.states.set(scope, state);
    }

    /** Remove a scope's entry. Defaults to `'workspace'`. No-op if absent. */
    clear(scope?: GitDiffScope): void {
        this.states.delete(scope ?? WORKSPACE_SCOPE);
    }

    /** Remove every entry. Used on workspace switch / re-init. */
    clearAll(): void {
        this.states.clear();
    }

    /** Whether a scope currently has an entry. */
    has(scope: GitDiffScope): boolean {
        return this.states.has(scope);
    }

    /** Number of active sessions across all scopes. */
    get size(): number {
        return this.states.size;
    }

    /** List every active scope. Useful for diagnostics + bulk clear UI. */
    listActiveScopes(): GitDiffScope[] {
        return Array.from(this.states.keys());
    }
}
