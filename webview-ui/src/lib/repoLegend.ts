/**
 * BUG-POLAR-15: the L1 System Design view paints a 4px coloured left-stripe on
 * each service node keyed off the owning repo (multi-repo grouping). The colour
 * had no at-a-glance key. `collectRepoLegend` derives the repo→colour legend
 * straight from the rendered nodes so the L1 view can show a compact swatch key.
 */

/** Stable per-repo accent colour (same hash the node stripe uses). */
export function repoAccentColor(repoId: string): string {
    let h = 0;
    for (let i = 0; i < repoId.length; i++) {
        h = (h * 31 + repoId.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 55%, 55%)`;
}

export interface RepoLegendEntry {
    repoId: string;
    label: string;
    color: string;
}

interface LegendNode {
    data?: { meta?: { repoId?: string; repoName?: string; infra?: boolean } };
    meta?: { repoId?: string; repoName?: string; infra?: boolean };
}

/**
 * Collect the distinct owning repos (in first-seen order) from the L1 nodes,
 * each with its accent colour and a display label. Infra nodes are skipped
 * (their stripe isn't repo-keyed). Returns [] for a single-repo / no-repo graph
 * so the caller can hide the legend (nothing to disambiguate).
 */
export function collectRepoLegend(nodes: LegendNode[] | undefined): RepoLegendEntry[] {
    const seen = new Map<string, RepoLegendEntry>();
    for (const n of nodes ?? []) {
        const meta = n.data?.meta ?? n.meta ?? {};
        if (meta.infra) continue;
        const repoId = meta.repoId;
        if (!repoId || seen.has(repoId)) continue;
        seen.set(repoId, {
            repoId,
            label: meta.repoName ?? repoId,
            color: repoAccentColor(repoId),
        });
    }
    // Only a legend when there's more than one repo to tell apart.
    const entries = [...seen.values()];
    return entries.length > 1 ? entries : [];
}
