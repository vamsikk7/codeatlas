/**
 * UX-67 (2026-06-09) — `PerRepoDebouncer`
 *
 * Coalesces per-repo callbacks. Used by the WorkspaceWatcher to re-emit
 * a sub-repo's `RepoSummary` ~500ms after the last file save in that
 * sub-repo lands. A burst of saves in one repo produces ONE summary
 * emit; concurrent saves in different repos remain isolated and fire
 * independently.
 *
 * Tests live at `__tests__/perRepoDebouncer.test.ts`.
 */
export type RepoCallback = (repoId: string) => void;

export class PerRepoDebouncer {
    private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private callbacks: Map<string, RepoCallback> = new Map();

    constructor(private readonly delayMs: number) {}

    /**
     * Schedule `cb` to run with `repoId` after `delayMs` of quiet on that
     * repo. Subsequent calls within the window re-arm the timer and
     * override the callback.
     */
    schedule(repoId: string, cb: RepoCallback): void {
        const existing = this.timers.get(repoId);
        if (existing) clearTimeout(existing);
        this.callbacks.set(repoId, cb);
        const t = setTimeout(() => {
            const fn = this.callbacks.get(repoId);
            this.timers.delete(repoId);
            this.callbacks.delete(repoId);
            if (!fn) return;
            try { fn(repoId); }
            catch { /* a throwing fn is its own bug; swallow so the
                      next schedule for the same repo still works. */ }
        }, this.delayMs);
        this.timers.set(repoId, t);
    }

    /** Cancel any pending fire for one repo. */
    cancel(repoId: string): void {
        const existing = this.timers.get(repoId);
        if (existing) clearTimeout(existing);
        this.timers.delete(repoId);
        this.callbacks.delete(repoId);
    }

    /** Cancel every pending fire across all repos. */
    cancelAll(): void {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        this.callbacks.clear();
    }
}
