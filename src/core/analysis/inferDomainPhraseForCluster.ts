/**
 * inferDomainPhraseForCluster.ts — UX-8 (2026-06-04)
 *
 * Modules-mode cluster nodes (Louvain-derived) carry a folder-shaped
 * label like `auth`, `random`, `src`. The parallel Domains-mode
 * surface produces verb-phrase labels like "Authenticate users",
 * "Manage profiles" for the same underlying files. UX-8 surfaces
 * that verb phrase as a subtitle on Modules nodes so the same view
 * conveys both "where the code lives" AND "what it does".
 *
 * This pure helper takes a cluster's file list + the workspace's
 * detected domains and returns the dominant domain phrase, weighted
 * by overlap count. Returns null when no domain claims any of the
 * cluster's files (cluster sits below the domain detection threshold
 * — e.g. tiny utility folders).
 */

import type { DomainCluster } from '../graph/graphTypes';

export function inferDomainPhraseForCluster(
    clusterFiles: ReadonlyArray<string>,
    domains: Readonly<Record<string, DomainCluster>> | null | undefined,
): string | null {
    if (!domains || clusterFiles.length === 0) return null;

    const fileSet = new Set(clusterFiles);
    let bestDomain: DomainCluster | null = null;
    let bestOverlap = 0;
    let bestConfidence = 0;

    for (const domain of Object.values(domains)) {
        if (!domain || !Array.isArray(domain.files)) continue;
        let overlap = 0;
        for (const f of domain.files) {
            if (fileSet.has(f)) overlap++;
        }
        if (overlap === 0) continue;
        // Pick by overlap count first; tie-break by confidence.
        const confidence = typeof domain.confidence === 'number' ? domain.confidence : 0;
        if (overlap > bestOverlap || (overlap === bestOverlap && confidence > bestConfidence)) {
            bestDomain = domain;
            bestOverlap = overlap;
            bestConfidence = confidence;
        }
    }

    return bestDomain ? bestDomain.name : null;
}
