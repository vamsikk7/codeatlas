/**
 * apiListGraphBuilder.ts
 *
 * Builds an L2b API List diagram (`api-list:<clusterId>`) from a FeatureCluster.
 *
 * Extracted from `handlers/navigationHandlers.ts` (Issue 261 — API-list graph (`api-list:<clusterId>`) not built during workspace init) so SyncOrchestrator
 * can build api-list graphs eagerly at workspace init, without importing handlers
 * (which would create a layering violation — handlers depend on core, not vice
 * versa).
 *
 * Pure function: no vscode / DOM / panelManager dependencies. Identical output
 * to the previous in-handler implementation; the handler now re-exports this.
 */

import type { ApiRecord, DiagramGraph, FeatureCluster, Snapshot } from './graphTypes';
import { computeApiDiff } from '../diff/apiDiff';

/**
 * Issue L2B-3 (2026-06-07) — when Louvain groups a stray file (often a
 * controller calling middleware from another module) into a cluster whose
 * dominant directory is different, the L2b api-list panel pulls in all the
 * stray's routes. Filter the cluster's APIs to the majority top-level
 * directory among the cluster's API-bearing files. The L2a graph keeps the
 * architectural truth (cluster.files unchanged); L2b shows the dominant
 * surface only.
 *
 * Returns the dominant directory PREFIX (with trailing slash) or null when
 * no single directory holds > 50% of the api-bearing files. Null means
 * "don't filter — we don't have a clear winner".
 */
function directoryPrefixFor(filePath: string): string {
    // Top-level "feature directory" — the deepest segment that isn't a
    // generic container word. Skip src/app/routes/etc. as you walk up.
    const parts = filePath.split('/');
    for (let i = parts.length - 2; i >= 0; i--) {
        const seg = parts[i];
        if (!seg || ['src', 'app', 'lib', 'routes', 'controllers'].includes(seg)) continue;
        return parts.slice(0, i + 1).join('/') + '/';
    }
    return parts.slice(0, -1).join('/') + '/';
}

function findDominantDirectoryPrefix(apis: ApiRecord[], clusterLabel: string): string | null {
    if (apis.length === 0) return null;
    // Weight by API count, not unique file count: the user perceives "this
    // cluster has 15 article routes and 4 auth routes" — 1 article file with
    // 15 routes outweighs the auth side even though there are more auth files.
    // This matches inferClusterLabel's weighting upstream.
    const dirCounts = new Map<string, number>();
    for (const api of apis) {
        if (!api.filePath) continue;
        const prefix = directoryPrefixFor(api.filePath);
        dirCounts.set(prefix, (dirCounts.get(prefix) ?? 0) + 1);
    }
    if (dirCounts.size <= 1) return null;
    const totalApis = apis.filter((a) => a.filePath).length;
    let bestPrefix = '';
    let bestCount = 0;
    let bestMatchesLabel = false;
    for (const [prefix, count] of dirCounts.entries()) {
        const matchesLabel = clusterLabel.length > 1 && prefix.toLowerCase().includes('/' + clusterLabel.toLowerCase() + '/');
        if (
            count > bestCount ||
            (count === bestCount && matchesLabel && !bestMatchesLabel)
        ) {
            bestPrefix = prefix;
            bestCount = count;
            bestMatchesLabel = matchesLabel;
        }
    }
    // Require a strict majority so a 50/50 split keeps all APIs.
    if (bestCount * 2 <= totalApis) return null;
    // Also require that the dominant prefix shares a directory segment with
    // the cluster label — otherwise we end up filtering OUT the minority
    // directory that the cluster is named after. Without this guard, a
    // cluster labeled "auth" with 4 auth APIs + 15 article APIs would treat
    // article (the majority) as dominant and drop the 4 auth APIs.
    if (clusterLabel.length > 1) {
        const labelMatches = bestPrefix.toLowerCase().includes('/' + clusterLabel.toLowerCase() + '/')
            || bestPrefix.toLowerCase().endsWith('/' + clusterLabel.toLowerCase() + '/');
        if (!labelMatches) {
            // Look for a prefix that DOES match the label, even if minority.
            for (const [prefix] of dirCounts.entries()) {
                const matches = prefix.toLowerCase().includes('/' + clusterLabel.toLowerCase() + '/')
                    || prefix.toLowerCase().endsWith('/' + clusterLabel.toLowerCase() + '/');
                if (matches) return prefix;
            }
            // No prefix matches the label — fall back to "no filter" so we
            // don't silently hide everything.
            return null;
        }
    }
    return bestPrefix;
}

/**
 * Build an api-list DiagramGraph from a FeatureCluster.
 * Extracts subsystems from sequence diagram participants outside the cluster.
 */
export function buildApiListGraph(
    cluster: FeatureCluster,
    working: Snapshot,
    baseline: Snapshot,
): DiagramGraph {
    const clusterFileSet = new Set(cluster.files);
    const subsystemMap = new Map<string, { label: string; kind: string; filePath?: string }>();

    // #496: defensive filter. If upstream `cluster.apisInCluster` ever drifts
    // and contains APIs whose filePath is NOT in this cluster's files (e.g.,
    // a stale baseline copy carrying foreign apis), drop them here so the
    // L2b panel never shows cross-cluster contamination.
    const rawApisInCluster = (cluster.apisInCluster ?? []).filter((api) =>
        !api.filePath || clusterFileSet.has(api.filePath),
    );

    // L2B-3 (2026-06-07): even when the apis ARE in cluster.files, the
    // cluster may have been Louvain-merged across two top-level directories
    // (e.g. one stray article controller absorbed into `cluster:auth` because
    // article handlers call auth.required middleware). In that case the L2a
    // graph rightly carries the full mixed file set, but the L2b panel should
    // surface only the dominant directory's APIs — otherwise users see 19
    // routes under `cluster:auth` when they expect 4.
    const dominantPrefix = findDominantDirectoryPrefix(rawApisInCluster, cluster.label);
    const scopedApisInCluster = dominantPrefix
        ? rawApisInCluster.filter((api) => !api.filePath || api.filePath.startsWith(dominantPrefix))
        : rawApisInCluster;
    const excludedApiCount = rawApisInCluster.length - scopedApisInCluster.length;

    const apisWithDiff: ApiRecord[] = scopedApisInCluster.map((api) => {
        const seqGraph = working.graphs[`sequence:${api.filePath}:${api.handlerName}`];

        // Collect subsystem participants from this API's sequence graph
        if (seqGraph) {
            for (const node of seqGraph.nodes) {
                if (node.type !== 'participant') continue;
                if (node.label === 'API Client') continue;
                const anchor = node.anchor ?? seqGraph.anchors[node.id];
                if (anchor?.filePath && clusterFileSet.has(anchor.filePath)) continue;
                const kind = (node.subtitle ?? '«module»').replace(/«|»/g, '').trim();
                subsystemMap.set(node.label, { label: node.label, kind, filePath: anchor?.filePath });
            }
        }

        const diff = computeApiDiff(
            api,
            baseline.apiIndex,
            seqGraph,
            baseline.files[api.filePath]?.hash,
            working.files[api.filePath]?.hash,
        );

        // Issue #760: propagate the per-route diff back to the
        // workspace-level apiIndex so consumers reading the snapshot
        // directly (tourBuilder, MCP tools, future custom queries) get
        // the same diff signal that the L2b list shows. Previously the
        // diff lived only on the cluster's meta.apis copy, so the tour's
        // recent-mode ordering silently fell back to "unchanged" for
        // every entry. Mutates the live snapshot's apiIndex record
        // because `working` is the same Snapshot object the rest of the
        // cascade holds — there's no copy step that would drop the
        // mutation. We only set diff (never overwrite other fields) so
        // baseline-shape invariants stay intact.
        const live = working.apiIndex[api.apiId];
        if (live) {
            (live as ApiRecord).diff = diff;
        }

        return { ...api, diff };
    });

    // Surface APIs that existed in baseline but were removed from this cluster
    for (const [apiId, api] of Object.entries(baseline.apiIndex)) {
        if (api.filePath && clusterFileSet.has(api.filePath) && !working.apiIndex[apiId]) {
            apisWithDiff.push({ ...api, diff: 'deleted' as const });
        }
    }

    return {
        graphId: `api-list:${cluster.id}`,
        type: 'api-list',
        nodes: [],
        edges: [],
        anchors: {},
        meta: {
            clusterId: cluster.id,
            clusterLabel: cluster.label,
            serviceId: cluster.serviceId,
            apis: apisWithDiff.filter((a: any) => !['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING'].includes(a.method)),
            screens: apisWithDiff.filter((a: any) => a.method === 'SCREEN'),
            navRoutes: apisWithDiff.filter((a: any) => a.method === 'NAV_ROUTE'),
            networkCalls: apisWithDiff.filter((a: any) => a.method === 'NETWORK'),
            diBindings: apisWithDiff.filter((a: any) => a.method === 'DI_BINDING'),
            files: cluster.files,
            entryPoints: cluster.entryPoints,
            subsystems: [...subsystemMap.values()],
            // L2B-3: count of APIs dropped because their filePath sits outside
            // the cluster's dominant directory. Surfaced in the L2b header so
            // users know the L2a file count and the L2b API count diverge
            // intentionally — and can drill into L2a for the full membership.
            excludedApiCount,
        },
    };
}
