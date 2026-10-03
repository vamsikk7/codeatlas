/**
 * clusterNameMerge.ts — #844 (2026-06-11).
 *
 * INVARIANT: an async naming-enrichment pass may never change cluster
 * MEMBERSHIP or CARDINALITY — it only carries names. The fire-and-forget
 * LLM callbacks used to wholesale-replace working AND baseline cluster
 * maps with whatever map the pass was scheduled over; when that map came
 * from an earlier, partial generation (drift-scan rebuild racing init),
 * the baseline was truncated to one cluster and every later L2a diff
 * showed phantom "+ ADDED" clusters. See ADR-041.
 */
import type { FeatureCluster } from '../graph/graphTypes';

export function mergeEnrichedClusterNames(
    current: Record<string, FeatureCluster> | undefined,
    enriched: Record<string, FeatureCluster> | undefined,
): Record<string, FeatureCluster> {
    if (!current || Object.keys(current).length === 0) return current ?? {};
    if (!enriched) return current;
    let changed = false;
    const out: Record<string, FeatureCluster> = { ...current };
    for (const [id, e] of Object.entries(enriched)) {
        const cur = out[id];
        if (!cur) continue; // never ADD clusters from a naming pass
        if (e?.name && e.name !== cur.name) {
            out[id] = { ...cur, name: e.name };
            changed = true;
        }
    }
    return changed ? out : current;
}
