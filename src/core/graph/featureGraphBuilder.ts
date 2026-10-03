/**
 * featureGraphBuilder.ts
 *
 * Builds a Feature/Domain layer diagram from community detection results.
 *
 * Nodes = feature clusters (functional domains)
 * Edges = inter-cluster call relationships
 *
 * Supports differential UML: clusters gain DiffStatus from diffClusters().
 * Clicking a cluster node in the webview drills into its sequence diagrams.
 */

import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    FeatureCluster,
    Snapshot,
    DiffStatus,
    ScreenRecord,
    ServiceRecord,
} from './graphTypes';
import { WorkspaceCallGraph, buildCallGraph, resolveImportPath } from './callGraphResolver';
import { detectCommunities, diffClusters } from '../analysis/communityDetector';
import { inferDomainPhraseForCluster } from '../analysis/inferDomainPhraseForCluster';
import { computeApiDiff } from '../diff/apiDiff';

/**
 * BUG-EXPLORE-13: the feature graph embeds each cluster's `apisInCluster`
 * records verbatim for the L2a Feature Areas list. Those records can carry a
 * STALE `.diff` — set by an earlier cascade or a coarse file-change heuristic —
 * that predates `buildApiListGraph` writing the authoritative `computeApiDiff`
 * result back onto `apiIndex`. Re-diff each embedded copy against baseline here
 * so "absent from baseline → added" always wins over a stale "modified". Uses
 * the SAME `computeApiDiff` the L2b list uses, so both layers agree.
 *
 * CRITICAL: always return a fresh COPY of each api, never the shared `apiIndex`
 * reference. `cluster.apisInCluster` holds references to the live `apiIndex`
 * records, and the LLM-naming cascade (syncOrchestrator #497/#384) re-runs
 * `buildApiListGraph(working, working)` AFTER this build, which mutates
 * `apiIndex[id].diff` back to a coarse "modified". If we returned the shared
 * reference, that later mutation would bleed straight into this feature graph's
 * embedded copy — the exact BUG-EXPLORE-13 desync (added route rendered `~`).
 * Copying decouples the L2a snapshot from subsequent apiIndex writes.
 *
 * When there's no baseline we still copy (to decouple), keeping the record's
 * current diff — but callers should pass a baseline so the diff is authoritative.
 */
function reDiffApisAgainstBaseline<T extends { apiId: string; filePath: string; handlerName: string; diff?: DiffStatus }>(
    apis: T[],
    workingSnapshot: Snapshot,
    baselineSnapshot?: Snapshot,
): T[] {
    if (!baselineSnapshot) return apis.map((api) => ({ ...api }));
    return apis.map((api) => {
        const seqGraph = workingSnapshot.graphs?.[`sequence:${api.filePath}:${api.handlerName}`];
        const diff = computeApiDiff(
            api as unknown as import('./graphTypes').ApiRecord,
            baselineSnapshot.apiIndex ?? {},
            seqGraph,
            baselineSnapshot.files?.[api.filePath]?.hash,
            workingSnapshot.files?.[api.filePath]?.hash,
        );
        return { ...api, diff };
    });
}

/**
 * BUG-POLAR-6: the dominant per-screen framework for a screen-list service, used
 * to caption the L2a ("next · 421 screens") instead of a hardcoded default.
 */
export function dominantScreenFramework(
    screens: ReadonlyArray<{ framework?: string }>,
): string | undefined {
    const counts = new Map<string, number>();
    for (const s of screens) {
        if (s.framework) counts.set(s.framework, (counts.get(s.framework) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [f, n] of counts) {
        if (n > bestN) { bestN = n; best = f; }
    }
    return best;
}

let idCounter = 0;
function nextId(prefix = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

/**
 * Build a feature diagram from working snapshot clusters,
 * optionally diffed against baseline snapshot clusters.
 * When serviceId is provided, only clusters belonging to that service are shown.
 */
export function buildFeatureGraph(
    workingSnapshot: Snapshot,
    baselineSnapshot?: Snapshot,
    serviceId?: string
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    // v2 follow-up #716 — FE/mobile flat-list rendering. When the
    // graph is scoped to a single service AND that service is
    // frontend/mobile, build a screen-list graph instead of the
    // Louvain cluster diagram. Backend (and workspace-wide / unknown)
    // services continue with today's cluster rendering byte-identically.
    if (serviceId && workingSnapshot.services && workingSnapshot.screens) {
        const svc = workingSnapshot.services[serviceId];
        if (svc && (svc.category === 'frontend' || svc.category === 'mobile')) {
            return buildScreenListGraph(workingSnapshot, baselineSnapshot, svc);
        }
    }
    // BUG-EXPLORE-5: a FE/mobile MONOREPO (workspace-level graph, no serviceId)
    // over-fragments into dozens of Louvain micro-clusters (89 "features" for 114
    // entry points on ts-react-native). Service categorization is unreliable on
    // such repos (they surface as "Other"/"S3"), so key off SCREEN DOMINANCE
    // instead: when the workspace has ≥3 screens AND screens are at least as many
    // as HTTP routes, render one aggregated screen list (grouped by nav prefix).
    // Backend-dominant workspaces (more HTTP routes than screens) are unchanged.
    if (!serviceId && workingSnapshot.screens) {
        const screenCount = Object.keys(workingSnapshot.screens).length;
        const HTTP_METHOD = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']);
        const httpCount = Object.values(workingSnapshot.apiIndex ?? {})
            .filter((a) => HTTP_METHOD.has(String((a as { method?: string }).method ?? '').toUpperCase())).length;
        if (screenCount >= 3 && screenCount >= httpCount) {
            return buildScreenListGraph(workingSnapshot, baselineSnapshot, null);
        }
    }

    // Get or compute call graph
    const callGraph = workingSnapshot.callGraph
        ? WorkspaceCallGraph.deserialize(workingSnapshot.callGraph)
        : buildCallGraph(workingSnapshot);

    // Get or compute working clusters (pass baseline clusters for ID stability)
    const workingClusters: Record<string, FeatureCluster> =
        workingSnapshot.clusters ?? detectCommunities(workingSnapshot, callGraph, undefined, baselineSnapshot?.clusters);

    // Diff clusters if baseline provided — pass file records so content changes propagate up
    let clustersWithDiff: Record<string, FeatureCluster> = workingClusters;
    if (baselineSnapshot) {
        const baselineClusters: Record<string, FeatureCluster> =
            baselineSnapshot.clusters ?? detectCommunities(baselineSnapshot);
        clustersWithDiff = diffClusters(
            baselineClusters,
            workingClusters,
            baselineSnapshot.files,
            workingSnapshot.files
        );
    }

    // Filter to service scope when requested
    if (serviceId) {
        const filtered: Record<string, FeatureCluster> = {};
        for (const [id, cluster] of Object.entries(clustersWithDiff)) {
            if (cluster.serviceId === serviceId || cluster.diff === 'deleted') {
                filtered[id] = cluster;
            }
        }
        clustersWithDiff = filtered;
    }

    // Issue #773: workspace-level view in multi-binary repos collapses
    // to one mega-cluster per service because each service's call graph
    // is internally dense but inter-service connectivity is zero — Louvain
    // assigns each service its own community. Users land on a flat list
    // of N service nodes instead of the feature areas they expected.
    //
    // Fix: when any cluster in workspace mode carries `subClusters`,
    // splice the sub-clusters in place of their parent. The parent gets
    // dropped and each sub-cluster surfaces as its own node, tagged with
    // the parent's `serviceId` so renderers can show a service badge.
    // Per-service mode (`serviceId !== undefined`) is unchanged — that
    // view already lets users drill into a service.
    if (!serviceId) {
        const expanded: Record<string, FeatureCluster> = {};
        for (const [id, cluster] of Object.entries(clustersWithDiff)) {
            const subs = cluster.subClusters && Object.keys(cluster.subClusters).length > 0
                ? cluster.subClusters : undefined;
            if (subs) {
                for (const [subId, sub] of Object.entries(subs)) {
                    expanded[subId] = {
                        ...sub,
                        serviceId: sub.serviceId ?? cluster.serviceId,
                    };
                }
            } else {
                expanded[id] = cluster;
            }
        }
        clustersWithDiff = expanded;
    }

    const clusterIds = Object.keys(clustersWithDiff);
    const clusterNodeIds = new Map<string, string>(); // clusterId → nodeId

    // Build cluster nodes
    for (const [clusterId, cluster] of Object.entries(clustersWithDiff)) {
        const isDeleted = cluster.diff === 'deleted';
        const fileCount = cluster.files.length;
        const apiCount = cluster.apisInCluster?.length ?? cluster.entryPoints.length;
        const cohesion = cluster.internalCallCount + cluster.externalCallCount > 0
            ? Math.round((cluster.internalCallCount / (cluster.internalCallCount + cluster.externalCallCount)) * 100)
            : 0;

        // UX-8 (2026-06-04): when the workspace's Domain detector has
        // produced verb-phrase domains, cross-reference each Modules
        // cluster's files to surface the dominant domain phrase. Renders
        // as a secondary subtitle in the Feature view so the Modules
        // layer conveys both "where the code lives" (folder name) AND
        // "what it does" (verb phrase). No-op when no domains are
        // detected (small repos / pre-init).
        const domainPhrase = inferDomainPhraseForCluster(cluster.files, workingSnapshot.domains);

        const node: GraphNode = {
            id: nextId('cluster'),
            type: 'cluster',
            label: isDeleted ? `${cluster.name || cluster.label} (deleted)` : (cluster.name || cluster.label),
            subtitle: `«feature cluster» ${fileCount} file${fileCount !== 1 ? 's' : ''}`,
            body: `${apiCount} API${apiCount !== 1 ? 's' : ''} · ${cohesion}% cohesion`,
            diff: cluster.diff ?? 'unchanged',
            anchor: { filePath: cluster.files[0] ?? '' },
            clusterMembership: clusterId,
            meta: {
                clusterId,
                serviceId: cluster.serviceId,
                files: cluster.files,
                entryPoints: cluster.entryPoints,
                apisInCluster: reDiffApisAgainstBaseline(cluster.apisInCluster ?? [], workingSnapshot, baselineSnapshot),
                internalCallCount: cluster.internalCallCount,
                externalCallCount: cluster.externalCallCount,
                cohesion,
                subClusters: cluster.subClusters,
                domainPhrase: domainPhrase ?? undefined,
            },
        };
        nodes.push(node);
        clusterNodeIds.set(clusterId, node.id);
        anchors[node.id] = node.anchor!;
    }

    // Build inter-cluster edges using the call graph
    // Track call counts and cumulative confidence per cluster pair
    const edgeCounts = new Map<string, number>();         // "clusterA|clusterB" → count
    const edgeConfSum = new Map<string, number>();         // "clusterA|clusterB" → sum of confidences
    const clusterForFile = new Map<string, string>();      // filePath → clusterId

    for (const [clusterId, cluster] of Object.entries(clustersWithDiff)) {
        for (const fp of cluster.files) {
            clusterForFile.set(fp, clusterId);
        }
    }

    for (const node of callGraph.getAllNodes()) {
        const sourceCluster = clusterForFile.get(node.filePath);
        if (!sourceCluster) continue;
        for (const calleeKey of node.calls) {
            const calleeFile = calleeKey.split('::')[0];
            const targetCluster = clusterForFile.get(calleeFile ?? '');
            if (!targetCluster || targetCluster === sourceCluster) continue;
            const edgeKey = `${sourceCluster}|${targetCluster}`;
            edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + 1);
            // Accumulate confidence from callEdge meta if available
            const meta = callGraph.getEdgeMeta(node.key, calleeKey);
            edgeConfSum.set(edgeKey, (edgeConfSum.get(edgeKey) ?? 0) + (meta?.confidence ?? 1.0));
        }
    }

    // Supplement with import-based inter-cluster edges (lower confidence)
    for (const [fp, record] of Object.entries(workingSnapshot.files)) {
        const sourceCluster = clusterForFile.get(fp);
        if (!sourceCluster) continue;
        for (const imp of record.symbols?.imports ?? []) {
            if (!imp.source.startsWith('.')) continue;
            const resolved = resolveImportPath(imp.source, fp, workingSnapshot.files);
            if (!resolved) continue;
            const targetCluster = clusterForFile.get(resolved);
            if (!targetCluster || targetCluster === sourceCluster) continue;
            const edgeKey = `${sourceCluster}|${targetCluster}`;
            edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + 1);
            edgeConfSum.set(edgeKey, (edgeConfSum.get(edgeKey) ?? 0) + 0.7);
        }
    }

    for (const [edgeKey, count] of edgeCounts.entries()) {
        const [srcClusterId, tgtClusterId] = edgeKey.split('|');
        const srcNodeId = clusterNodeIds.get(srcClusterId ?? '');
        const tgtNodeId = clusterNodeIds.get(tgtClusterId ?? '');
        if (!srcNodeId || !tgtNodeId) continue;

        const srcCluster = clustersWithDiff[srcClusterId ?? ''];
        const tgtCluster = clustersWithDiff[tgtClusterId ?? ''];

        // Average confidence for this cluster-pair edge
        const confSum = edgeConfSum.get(edgeKey) ?? count;
        const avgConfidence = Math.round((confSum / count) * 100);

        // Determine diff status of this edge (deleted > added > modified > unchanged)
        let edgeDiff: DiffStatus = 'unchanged';
        if (srcCluster?.diff === 'deleted' || tgtCluster?.diff === 'deleted') edgeDiff = 'deleted';
        else if (srcCluster?.diff === 'added' || tgtCluster?.diff === 'added') edgeDiff = 'added';
        else if (srcCluster?.diff === 'modified' || tgtCluster?.diff === 'modified') edgeDiff = 'modified';

        edges.push({
            id: nextId('edge'),
            source: srcNodeId,
            target: tgtNodeId,
            label: `${count} call${count !== 1 ? 's' : ''}`,
            edgeType: 'inter-cluster',
            diff: edgeDiff,
            callCount: count,
            meta: { avgConfidence },
        });
    }

    // Compute overall graph diff status for the meta field
    const hasChanges = nodes.some((n) => n.diff && n.diff !== 'unchanged');
    const addedClusters = nodes.filter((n) => n.diff === 'added').length;
    const deletedClusters = nodes.filter((n) => n.diff === 'deleted').length;
    const modifiedClusters = nodes.filter((n) => n.diff === 'modified').length;

    return {
        graphId: serviceId ? `feature:${serviceId}` : 'feature:workspace',
        type: 'feature',
        nodes,
        edges,
        anchors,
        meta: {
            clusterCount: clusterIds.length,
            serviceId,
            hasChanges,
            addedClusters,
            deletedClusters,
            modifiedClusters,
        },
    };
}

/**
 * v2 follow-up #716 — flat list of screens for FE/mobile L2a.
 *
 * Produces a `feature:<serviceId>` graph (same id shape as the
 * cluster version) but with one node per `ScreenRecord` instead of
 * one node per Louvain cluster. The L2a renderer (FeatureView.tsx)
 * detects `meta.mode === 'screen-list'` and switches to a flat-list
 * presentation.
 *
 * Optional URL-prefix grouping: when ≥2 screens share a prefix (e.g.
 * `/admin/users` + `/admin/billing`) the renderer collapses them
 * under a single section header. The builder pre-computes the
 * grouping so the renderer doesn't need its own logic.
 */
function buildScreenListGraph(
    workingSnapshot: Snapshot,
    baselineSnapshot: Snapshot | undefined,
    // `null` = workspace-level (a pure FE/mobile monorepo): aggregate the
    // screens of EVERY service into one screen list (BUG-EXPLORE-5).
    service: ServiceRecord | null,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const anchors: Record<string, Anchor> = {};

    const screens = workingSnapshot.screens ?? {};
    const myScreens = Object.values(screens).filter((s) => (service ? s.serviceId === service.id : true));

    // Diff: which screens are new / removed / modified vs baseline?
    const baselineScreens = baselineSnapshot?.screens ?? {};
    const baselineByPath = new Map<string, ScreenRecord>();
    for (const sc of Object.values(baselineScreens)) {
        if (service ? sc.serviceId === service.id : true) baselineByPath.set(sc.routePath, sc);
    }
    const workingPaths = new Set(myScreens.map((s) => s.routePath));

    // Stable sort by route path so the L2a list is deterministic
    // across cascade rebuilds.
    myScreens.sort((a, b) => a.routePath.localeCompare(b.routePath));

    // Compute URL-prefix grouping. A "prefix" is the first path segment
    // when at least 2 screens share it (`/admin/*`, `/onboarding/*`).
    const prefixCounts = new Map<string, number>();
    for (const sc of myScreens) {
        const prefix = topPrefix(sc.routePath);
        if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    const groupingPrefixes = new Set(
        [...prefixCounts.entries()].filter(([, c]) => c >= 2).map(([p]) => p),
    );

    let addedScreens = 0, deletedScreens = 0, modifiedScreens = 0;

    // Emit one node per screen.
    for (const screen of myScreens) {
        const baseline = baselineByPath.get(screen.routePath);
        let diff: DiffStatus = 'unchanged';
        // Only compute added/modified when a baseline was ACTUALLY supplied —
        // mirrors the Louvain cluster path (guarded by `if (baselineSnapshot)`
        // above). The FIRST build passes `baselineSnapshot === undefined` (init,
        // syncOrchestrator ~1830); without this guard every screen is marked
        // `added`, and setBaselineFromWorking then freezes that into the baseline
        // copy, so the frontend feature graph shows all screens `added` forever —
        // breaking the L2a "exactly one modified cluster" invariant whenever a
        // SIBLING service is edited (py-fastapi backend+frontend). #929-adjacent.
        if (baselineSnapshot) {
            if (!baseline) {
                diff = 'added';
                addedScreens++;
            } else if (baseline.filePath !== screen.filePath || baseline.framework !== screen.framework) {
                diff = 'modified';
                modifiedScreens++;
            }
        }
        const prefix = topPrefix(screen.routePath);
        const parentNavGroup = prefix && groupingPrefixes.has(prefix) ? prefix : undefined;
        const node: GraphNode = {
            id: nextId('screen'),
            type: 'cluster',  // reused so the existing React Flow layout treats it consistently
            label: screen.routePath,
            subtitle: `«${screen.framework}»`,
            body: screen.filePath.split('/').pop() ?? screen.filePath,
            diff,
            anchor: screen.anchor,
            meta: {
                screenId: screen.screenId,
                routePath: screen.routePath,
                framework: screen.framework,
                filePath: screen.filePath,
                parentNavGroup,
                // Drives the L3 deep-link target: clicking a screen
                // row opens its `screen-content:<screenId>` graph
                // (the L2b 5-section panel).
                opensGraphId: `screen-content:${screen.screenId}`,
            },
        };
        nodes.push(node);
        anchors[node.id] = node.anchor!;
    }

    // Ghost nodes for screens that existed in baseline but disappeared.
    for (const [routePath, baseline] of baselineByPath) {
        if (workingPaths.has(routePath)) continue;
        deletedScreens++;
        const node: GraphNode = {
            id: nextId('screen-ghost'),
            type: 'cluster',
            label: `${routePath} (deleted)`,
            subtitle: `«${baseline.framework}»`,
            diff: 'deleted',
            anchor: baseline.anchor,
            meta: {
                screenId: baseline.screenId,
                routePath: baseline.routePath,
                framework: baseline.framework,
                filePath: baseline.filePath,
            },
        };
        nodes.push(node);
        anchors[node.id] = node.anchor!;
    }

    const firstSvc = Object.values(workingSnapshot.services ?? {})[0];
    return {
        graphId: service ? `feature:${service.id}` : 'feature:workspace',
        type: 'feature',
        nodes,
        edges: [],
        anchors,
        meta: {
            // v2 #716 — flat-list rendering signal for FeatureView.tsx.
            mode: 'screen-list',
            serviceId: service?.id ?? 'workspace',
            serviceCategory: service?.category ?? 'mobile',
            // BUG-POLAR-6: label the screen list by the DOMINANT per-screen
            // framework (polar's `clients` is Next.js — nextjs-app — not the old
            // hardcoded "react-native" fallback). Fall back to the service's
            // technology, then a neutral 'unknown'.
            framework: dominantScreenFramework(myScreens) ?? service?.technology ?? firstSvc?.technology ?? 'unknown',
            screenCount: myScreens.length,
            hasChanges: addedScreens + deletedScreens + modifiedScreens > 0,
            addedScreens,
            deletedScreens,
            modifiedScreens,
            // Pre-computed grouping the renderer can render as
            // collapsible section headers. Empty when no two screens
            // share a prefix.
            prefixGroups: [...groupingPrefixes].sort(),
        },
    };
}

function topPrefix(routePath: string): string {
    // `/admin/users` → `/admin`. `/` → ``. Stops at the first slash.
    if (!routePath.startsWith('/')) return '';
    const slash = routePath.indexOf('/', 1);
    if (slash < 0) return '';
    const prefix = routePath.slice(0, slash);
    if (prefix === '/') return '';
    return prefix;
}
