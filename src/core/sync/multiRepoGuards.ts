/**
 * multiRepoGuards.ts — init-path safety guards for multi-repo workspaces.
 */

/**
 * True when a multi-repo workspace's per-repo stores actually hold content, so
 * the AutoInit "skip main-thread re-scan" fast-path is safe to take.
 *
 * The fast-path broadcasts `initProgress: complete` on the assumption that the
 * per-repo workers already populated every store. But an INTERRUPTED resync (or
 * a killed VS Code mid-init) can leave the per-repo stores empty while the
 * workspace is still flagged multi-repo. Skipping then tells the webview
 * "ready" with no data, and every subsequent graph request triggers heavy
 * on-demand main-thread rebuilds — runaway memory / OOM.
 *
 * Reliable signals (both read the live main-thread per-repo stores that the
 * aggregator itself reads): the merged workspace apiIndex is non-empty, OR at
 * least one per-repo store has files. Empty on both ⇒ rebuild instead of skip.
 */
export function multiRepoStoresPopulated(
    aggregatedApiCount: number,
    perRepoFileCounts: number[],
): boolean {
    return aggregatedApiCount > 0 || perRepoFileCounts.some((n) => n > 0);
}
