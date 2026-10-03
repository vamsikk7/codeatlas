/**
 * mapGraphBuilder.ts
 *
 * Issue #700 — Knowledge Map view (single-canvas unified diagram).
 *
 * Today CodeAtlas's home page surfaces six diagram cards (L1 microservice
 * / L2a feature / L2b api-list / L3 sequence / L4 file / L5 flow). New
 * users have to know which layer they want before they can see anything.
 * The Knowledge Map is a 7th view that shows *everything* on one canvas
 * with layer toggles — services contain clusters contain APIs, plus
 * sibling infrastructure peers — so the user can pan + zoom around their
 * codebase without committing to a specific layer first.
 *
 * Click-through: every node carries `meta.drillDownGraphId` pointing at
 * the existing layer view to open when the user clicks (service → L2a
 * feature, cluster → L2b api-list, api → L3 sequence). The Map is purely
 * additive — existing six layers stay unchanged and remain the canonical
 * deep-dive views.
 *
 * Diff behavior: every node carries `diff` propagated from its source
 * record. Edges get `diff` based on participant diff + side data (cluster
 * membership changes, api count deltas). The view renders the standard
 * three-channel diff (color + symbol + border-style) so the map doubles
 * as a workspace-wide change visualization without the user opening L1.
 *
 * Sources used (all optional — the builder degrades gracefully on
 * partial snapshots so it's safe to call mid-init):
 *   - `snapshot.services`            → service group nodes (L1 cluster)
 *   - `snapshot.clusters`            → cluster nodes (L2a)
 *   - `snapshot.apiIndex`            → api leaf nodes (L2b)
 *   - infra via `detectInfrastructureServices(snapshot)` → infra peers
 *
 * NOT sourced yet (future expansion handled by the same shape):
 *   - File nodes — too many for a single-canvas render; deferred until
 *     the renderer implements per-cluster expand/collapse.
 *   - Call-graph function nodes — same reason; reach via drill-down
 *     into the existing L3 sequence view instead.
 *
 * Output: a single `DiagramGraph` with `type: 'map'` and
 * `graphId: 'map:workspace'`.
 */

import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    ApiRecord,
    ServiceRecord,
    FeatureCluster,
    InfrastructureService,
    Snapshot,
    DiffStatus,
} from './graphTypes';
import { detectServices, detectInfrastructureServices, type ContentProvider } from '../analysis/serviceDetector';
import { isGraphIdOfType } from './graphIdBuilder';

let idCounter = 0;
function nextId(prefix = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

/**
 * The stable workspace-wide graph id. Singleton — there's at most one
 * Map graph per workspace, distinct from the six layer-specific graphs.
 */
export const MAP_GRAPH_ID = 'map:workspace';

export interface BuildMapGraphOptions {
    /**
     * Workspace root — required by `detectServices` /
     * `detectInfrastructureServices` when the snapshot doesn't already
     * carry `services` / hasn't had infra detection run. When omitted
     * the Map degrades gracefully: it uses whatever's already on the
     * snapshot and skips infra detection entirely (no infra nodes).
     */
    workspaceRoot?: string;
    /** Mirrors the contract used by `microserviceGraphBuilder`. */
    contentProvider?: ContentProvider;
}

/**
 * Build the Knowledge Map graph from `workingSnapshot` (and optionally
 * compare against `baselineSnapshot` for diff annotations).
 *
 * Layer ordering inside `nodes` is deterministic: infrastructure first,
 * then services in name order, then per-service clusters in id order,
 * then per-cluster APIs in apiId order. This produces stable diffs +
 * stable layout caching (the LRU in `webview-ui/src/layout.ts` keys
 * off node id list).
 */
export function buildMapGraph(
    workingSnapshot: Snapshot,
    baselineSnapshot?: Snapshot,
    options: BuildMapGraphOptions = {},
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    // ── Resolve services + infrastructure + clusters ───────────────────────
    // Services + clusters live on the snapshot itself. Infrastructure is
    // *not* persisted (the L1 microservice graph detects it lazily on
    // each rebuild — see `microserviceGraphBuilder.ts`), so we re-detect
    // here when `workspaceRoot` is supplied. Without `workspaceRoot` we
    // skip infra entirely; the Map then shows services + clusters + APIs
    // only, which is still a valid (just less complete) overview.
    const services: Record<string, ServiceRecord> = workingSnapshot.services
        ?? (options.workspaceRoot
            ? detectServices(options.workspaceRoot, workingSnapshot, options.contentProvider)
            : {});
    const infra: InfrastructureService[] = options.workspaceRoot
        ? detectInfrastructureServices(options.workspaceRoot, workingSnapshot, services, options.contentProvider)
        : [];
    const clusters: Record<string, FeatureCluster> = workingSnapshot.clusters ?? {};
    const apiIndex: Record<string, ApiRecord> = workingSnapshot.apiIndex ?? {};

    // Baseline lookups for diff annotation. Absence = added; presence with
    // different shape = modified.
    const baselineServiceIds = new Set(Object.keys(baselineSnapshot?.services ?? {}));
    const baselineClusterIds = new Set(Object.keys(baselineSnapshot?.clusters ?? {}));
    const baselineApiIds = new Set(Object.keys(baselineSnapshot?.apiIndex ?? {}));

    // Issue #739 — per-API diff lookup. The L2b cascade flips
    // `api.diff = 'modified'` on the api-list graphs' `meta.apis[]`
    // entries when an underlying handler body changes. Map's API leaf
    // nodes need to consult this so they don't appear unchanged when
    // the underlying route was edited (the most common live edit shape).
    const apiDiffByApiId = buildApiDiffLookup(workingSnapshot);

    // ── Infrastructure peers ───────────────────────────────────────────────
    // Render infra first so the layout puts them as siblings at the top of
    // the canvas (Dagre's rank-direction). Each infra node is consumed by
    // ≥1 service; we'll draw the consume edges in the service pass below.
    const infraNodeIds = new Map<string, string>(); // infra.id → node id
    for (const inf of [...infra].sort((a, b) => a.id.localeCompare(b.id))) {
        const id = nextId('map');
        infraNodeIds.set(inf.id, id);
        nodes.push({
            id,
            type: 'service', // re-use the existing service kind — renderer keys off `meta.layer`
            kind: inf.kind,
            label: inf.name,
            subtitle: `«${inf.kind}»`,
            diff: inf.diff,
            meta: {
                layer: 'infrastructure',
                infraId: inf.id,
                infraKind: inf.kind,
                sdkId: inf.sdkId,
                sdkCategory: inf.sdkCategory,
                // The Map's drill-down for infra goes back to L1 since infra
                // doesn't have its own dedicated layer view.
                drillDownGraphId: 'microservice:workspace',
            },
        });
    }

    // ── Service group nodes ────────────────────────────────────────────────
    const serviceNodeIds = new Map<string, string>(); // service.id → node id
    const sortedServices = Object.values(services).sort((a, b) => a.name.localeCompare(b.name));
    for (const svc of sortedServices) {
        const id = nextId('map');
        serviceNodeIds.set(svc.id, id);
        const diff: DiffStatus | undefined = svc.diff
            ?? (baselineServiceIds.has(svc.id) ? undefined : 'added');
        // BUG-MAP-CATEGORY: FE/mobile services (e.g. Flutter/Dart) have
        // technology 'unknown' but a real category ('mobile'/'frontend'). L1
        // avoids printing "unknown" via TECH_ICONS + meta.category rendering;
        // the Map badge hard-coded svc.technology, so it showed «unknown». Fall
        // back to the category label when technology is unknown.
        const techLabel = svc.technology && svc.technology !== 'unknown'
            ? svc.technology
            : (svc.category && svc.category !== 'unknown' ? svc.category : 'service');
        nodes.push({
            id,
            type: 'service',
            label: svc.name,
            subtitle: `«${techLabel}»${svc.exposedApiCount > 0 ? ` · ${svc.exposedApiCount} apis` : ''}`,
            diff,
            serviceId: svc.id,
            meta: {
                layer: 'service',
                serviceId: svc.id,
                technology: svc.technology,
                category: svc.category,
                // Drill into the service's L2a feature view.
                drillDownGraphId: `feature:${svc.id}`,
            },
        });

        // Service → infrastructure edges (consumes).
        for (const infraId of [...infra.filter(i => i.consumedBy.includes(svc.id)).map(i => i.id)].sort()) {
            const target = infraNodeIds.get(infraId);
            if (!target) continue;
            edges.push({
                id: nextId('edge'),
                source: id,
                target,
                label: 'consumes',
                edgeType: 'depends',
                meta: { layer: 'service→infra' },
            });
        }
    }

    // Service → Service inter-service call edges.
    for (const svc of sortedServices) {
        const sourceId = serviceNodeIds.get(svc.id);
        if (!sourceId) continue;
        for (const consumedSvcId of [...svc.consumedServices].sort()) {
            const targetId = serviceNodeIds.get(consumedSvcId);
            if (!targetId || targetId === sourceId) continue;
            edges.push({
                id: nextId('edge'),
                source: sourceId,
                target: targetId,
                label: 'calls',
                edgeType: 'inter-service',
                meta: { layer: 'service→service' },
            });
        }
    }

    // ── Cluster nodes (grouped under their service) ────────────────────────
    const clusterNodeIds = new Map<string, string>();
    const sortedClusters = Object.values(clusters).sort((a, b) => a.id.localeCompare(b.id));
    for (const cluster of sortedClusters) {
        const id = nextId('map');
        clusterNodeIds.set(cluster.id, id);
        const apiCount = cluster.apisInCluster?.length ?? 0;
        const diff: DiffStatus | undefined = (cluster as FeatureCluster & { diff?: DiffStatus }).diff
            ?? (baselineClusterIds.has(cluster.id) ? undefined : 'added');
        nodes.push({
            id,
            type: 'cluster',
            label: cluster.name ?? cluster.label,
            subtitle: apiCount > 0 ? `${apiCount} apis` : `${cluster.files.length} files`,
            diff,
            clusterMembership: cluster.id,
            serviceId: cluster.serviceId,
            meta: {
                layer: 'cluster',
                clusterId: cluster.id,
                serviceId: cluster.serviceId,
                fileCount: cluster.files.length,
                apiCount,
                // Drill into the cluster's L2b api list.
                drillDownGraphId: `api-list:${cluster.id}`,
            },
        });
        // Service → Cluster containment edge.
        if (cluster.serviceId) {
            const serviceNodeId = serviceNodeIds.get(cluster.serviceId);
            if (serviceNodeId) {
                edges.push({
                    id: nextId('edge'),
                    source: serviceNodeId,
                    target: id,
                    label: 'contains',
                    edgeType: 'contains',
                    meta: { layer: 'service→cluster' },
                });
            }
        }
    }

    // ── API leaf nodes (grouped under their cluster) ───────────────────────
    // Build a quick lookup from filePath → clusterId so we can attach each
    // API to its owning cluster. Skip APIs whose file doesn't belong to any
    // cluster — they're typically utility / shared endpoints rendered via
    // the L2b view instead.
    const fileToClusterId = new Map<string, string>();
    for (const cluster of sortedClusters) {
        for (const fp of cluster.files) fileToClusterId.set(fp, cluster.id);
    }
    const sortedApis = Object.values(apiIndex).sort((a, b) => a.apiId.localeCompare(b.apiId));
    // Issue #757: when an API has no parent cluster (e.g. a DB_SEED
    // detected outside the feature-clustering pass) the Map silently
    // dropped it, leaving the count one short of the home-page total.
    // We now attach orphans to the service that owns their file via a
    // rootPath-prefix match. Use the longest matching rootPath so a
    // nested service wins over its parent.
    const orphanServiceFor = (filePath: string): string | undefined => {
        let best: { id: string; len: number } | undefined;
        for (const svc of sortedServices) {
            const root = svc.rootPath ?? '';
            // Empty rootPath = workspace root (the default single-service
            // case). Match on prefix; track the longest one.
            if (!root || filePath === root || filePath.startsWith(root.endsWith('/') ? root : root + '/')) {
                if (!best || root.length > best.len) {
                    best = { id: svc.id, len: root.length };
                }
            }
        }
        return best?.id;
    };
    for (const api of sortedApis) {
        const clusterId = fileToClusterId.get(api.filePath);
        const parentNodeId = clusterId
            ? clusterNodeIds.get(clusterId)
            : (() => {
                // Issue #757: orphan API — emit a node attached to the
                // service that owns the file (by rootPath prefix). Falls
                // back to skipping when no service owns the file (truly
                // external — typical for synthetic entries the detector
                // emits for project-level seeds, though those usually
                // have a service home too).
                const orphanServiceId = orphanServiceFor(api.filePath);
                return orphanServiceId ? serviceNodeIds.get(orphanServiceId) : undefined;
            })();
        if (!parentNodeId) continue;
        const clusterNodeId = parentNodeId;

        const id = nextId('map');
        // Issue #739 — three-channel precedence:
        //   1. 'added' when the apiId is new since baseline
        //   2. cascade-derived 'modified' from the api-list graph
        //   3. otherwise undefined (unchanged)
        const diff: DiffStatus | undefined = !baselineApiIds.has(api.apiId)
            ? 'added'
            : apiDiffByApiId.get(api.apiId);
        const drillId = sequenceGraphIdFor(api);
        nodes.push({
            id,
            type: 'participant', // re-use existing leaf kind
            label: `${api.method} ${api.route}`,
            subtitle: api.handlerName,
            diff,
            anchor: api.anchor,
            meta: {
                layer: 'api',
                apiId: api.apiId,
                clusterId,
                method: api.method,
                route: api.route,
                handler: api.handlerName,
                drillDownGraphId: drillId,
            },
        });
        if (api.anchor) anchors[id] = api.anchor;
        edges.push({
            id: nextId('edge'),
            source: clusterNodeId,
            target: id,
            label: 'has',
            edgeType: 'contains',
            meta: { layer: 'cluster→api' },
        });
    }

    // ── Mark deleted services / clusters / APIs from baseline ──────────────
    // The L1 / L2a / L2b builders compute these themselves but the Map view
    // wants them surfaced inline so the user sees what's gone without having
    // to switch layers. Add tombstone nodes with `diff: 'deleted'`.
    if (baselineSnapshot) {
        for (const svc of Object.values(baselineSnapshot.services ?? {})) {
            if (services[svc.id]) continue; // still present
            const id = nextId('map');
            nodes.push({
                id,
                type: 'service',
                label: svc.name,
                subtitle: `«${svc.technology}» (deleted)`,
                diff: 'deleted',
                serviceId: svc.id,
                meta: { layer: 'service', serviceId: svc.id, deleted: true },
            });
        }
        for (const cluster of Object.values(baselineSnapshot.clusters ?? {})) {
            if (clusters[cluster.id]) continue;
            const id = nextId('map');
            nodes.push({
                id,
                type: 'cluster',
                label: cluster.name ?? cluster.label,
                subtitle: '(deleted)',
                diff: 'deleted',
                clusterMembership: cluster.id,
                meta: { layer: 'cluster', clusterId: cluster.id, deleted: true },
            });
        }
        for (const api of Object.values(baselineSnapshot.apiIndex ?? {})) {
            if (apiIndex[api.apiId]) continue;
            const id = nextId('map');
            nodes.push({
                id,
                type: 'participant',
                label: `${api.method} ${api.route}`,
                subtitle: `(deleted) ${api.handlerName}`,
                diff: 'deleted',
                meta: { layer: 'api', apiId: api.apiId, deleted: true },
            });
        }
    }

    // Issue #739 — bubble cascade modified state up through cluster
    // and service nodes so a body-only edit isn't visible only at the
    // API leaf but also at the parent containers. Precedence:
    //   - existing 'added' / 'deleted' / pre-stamped 'modified' stays
    //   - only `undefined` ↔ 'unchanged' upgrades to 'modified' when
    //     a child carries 'modified'/'added'/'deleted'.
    propagateContainerDiffs(nodes, edges);

    return {
        graphId: MAP_GRAPH_ID,
        type: 'map',
        nodes,
        edges,
        anchors,
        meta: {
            label: 'Knowledge Map',
            serviceCount: sortedServices.length,
            infraCount: infra.length,
            clusterCount: sortedClusters.length,
            apiCount: sortedApis.length,
            // The renderer reads this to pre-populate the overlay toggle
            // state. Order matches the visual top→bottom legend order.
            overlayLayers: ['service', 'cluster', 'api', 'infrastructure'],
        },
    };
}

/**
 * Issue #739 — read per-API diff from the cascade-updated L2b api-list
 * graphs. The `api-list:<clusterId>.meta.apis[]` entries carry `diff`
 * stamped by the L2b cascade pass; this is the authoritative source
 * for "the underlying handler was edited" semantics that the Map node
 * for the API should reflect.
 *
 * Returns a Map of apiId → DiffStatus. APIs not in the map are
 * implicitly unchanged.
 */
function buildApiDiffLookup(snapshot: Snapshot): Map<string, DiffStatus> {
    const out = new Map<string, DiffStatus>();
    const graphs = snapshot.graphs ?? {};
    for (const [graphId, graph] of Object.entries(graphs)) {
        if (!isGraphIdOfType(graphId, 'api-list')) continue;
        const apis = (graph?.meta as { apis?: Array<{ apiId?: string; diff?: DiffStatus }> } | undefined)?.apis ?? [];
        for (const a of apis) {
            if (!a?.apiId || !a.diff) continue;
            if (a.diff === 'unchanged') continue;
            out.set(a.apiId, a.diff);
        }
    }
    return out;
}

/**
 * Issue #739 — walk the `contains` edges (cluster→api, service→cluster)
 * and bubble child diff state up. A modified API marks its cluster
 * modified; a modified cluster marks its service modified. 'added' and
 * 'deleted' on existing leaves don't propagate (those are independent
 * concerns); only 'modified' bubbles.
 *
 * Pre-stamped diff on a container (e.g. a service with `added` from a
 * brand-new monorepo workspace) takes precedence — we don't downgrade.
 */
function propagateContainerDiffs(nodes: GraphNode[], edges: GraphEdge[]): void {
    const byId = new Map(nodes.map(n => [n.id, n]));
    // Group children by parent for both layers in one pass.
    const childrenByParent = new Map<string, GraphNode[]>();
    for (const e of edges) {
        if (e.edgeType !== 'contains') continue;
        const child = byId.get(e.target);
        if (!child) continue;
        const list = childrenByParent.get(e.source) ?? [];
        list.push(child);
        childrenByParent.set(e.source, list);
    }
    // Two-pass: first promote clusters from APIs, then services from clusters.
    // Order matters — service bubbling reads its children's POST-bubble state.
    const layerOrder: Array<'cluster' | 'service'> = ['cluster', 'service'];
    for (const targetLayer of layerOrder) {
        for (const parent of nodes) {
            if (parent.meta?.layer !== targetLayer) continue;
            if (parent.diff === 'added' || parent.diff === 'deleted' || parent.diff === 'modified') continue;
            const children = childrenByParent.get(parent.id) ?? [];
            const hasChange = children.some(c => c.diff === 'modified' || c.diff === 'added' || c.diff === 'deleted');
            if (hasChange) parent.diff = 'modified';
        }
    }
}

/**
 * Resolve the L3 sequence-graph id an API drills down to. Falls back to
 * the file graph when the API has no handler name (an anonymous catch-all
 * route from the API detector).
 */
function sequenceGraphIdFor(api: ApiRecord): string {
    if (api.handlerName) {
        return `sequence:${api.filePath}:${api.handlerName}`;
    }
    return `file:${api.filePath}`;
}

// ─── ADR-034 Phase F (#791 — Phase F: Knowledge Map per-repo split (ADR-034)) — workspace-level Knowledge Map ─────────────
//
// Built from the aggregator's cross-repo tables only — never touches any
// per-repo state.db. The browser opens this on `#/map` in multi-repo
// workspaces; per-repo Knowledge Maps stay at `map:<repoId>` and route
// through the per-repo SnapshotStore via `resolveStoreFor`.
//
// Layout — three lanes top-to-bottom:
//   1. Shared lane — externals + DB schemas consumed by ≥1 repo (a
//      consumers.length >= 2 filter could be applied here, but Phase F
//      surfaces every shared row so single-consumer externals still
//      render as workspace-visible peers).
//   2. Service lane — one card per repo, status badges, error excerpts,
//      cross-repo HTTP edges drawn from `cross_repo_http_edges`.
//   3. (reserved for Phase J — diff annotations / workspace-mode banner.)
//
// `meta.drillDownGraphId` on each repo card points at `map:<repoId>` so
// clicking drills into that repo's full Knowledge Map (built by
// `buildMapGraph`).

interface WorkspaceMapAggregatorView {
    listRepos(): ReadonlyArray<{
        repoId: string;
        name: string;
        rootPath: string;
        technology: string | null;
        status: 'parsing' | 'ready' | 'failed' | 'stale';
        errorMessage: string | null;
    }>;
    listSharedExternals(): ReadonlyArray<{
        providerId: string;
        name: string;
        category: string;
        consumers: ReadonlyArray<string>;
    }>;
    listSharedSchemas(): ReadonlyArray<{
        engine: string;
        tableName: string;
        consumers: ReadonlyArray<string>;
    }>;
    listCrossRepoHttpEdges(): ReadonlyArray<{
        sourceRepo: string;
        targetRepo: string;
        method: string;
        route: string;
    }>;
    // 2026-06-09 — used by `buildWorkspaceMapGraph` to surface the
    // per-repo api count in the L2 Map subtitle. Optional so test doubles
    // that pre-date this change still satisfy the interface.
    getRepoSummary?(repoId: string): { apis: ReadonlyArray<unknown> } | undefined;
}

export function buildWorkspaceMapGraph(
    aggregator: WorkspaceMapAggregatorView,
    workspaceRoot: string,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    // Stable iteration order for diff stability.
    const repos = [...aggregator.listRepos()].sort((a, b) => a.rootPath.localeCompare(b.rootPath));
    const externals = [...aggregator.listSharedExternals()].sort((a, b) => a.providerId.localeCompare(b.providerId));
    const schemas = [...aggregator.listSharedSchemas()].sort((a, b) =>
        a.engine.localeCompare(b.engine) || a.tableName.localeCompare(b.tableName));
    const httpEdges = [...aggregator.listCrossRepoHttpEdges()].sort((a, b) =>
        a.sourceRepo.localeCompare(b.sourceRepo) ||
        a.targetRepo.localeCompare(b.targetRepo) ||
        a.route.localeCompare(b.route));

    // Track which node id each repoId maps to so we can wire HTTP edges.
    const repoIdToNodeId = new Map<string, string>();

    // ── Service lane — one card per repo ──────────────────────────────
    for (const r of repos) {
        const nodeId = `repo_${r.repoId}`;
        repoIdToNodeId.set(r.repoId, nodeId);
        // 2026-06-09 — pull api count from this repo's summary when the
        // aggregator exposes one. Surfaces the "«technology» · N apis"
        // subtitle the legacy per-repo `buildMapGraph` set; without this
        // the workspace L2 Map showed every repo card as plain unlabelled
        // even after init was complete and summaries had landed.
        const summary = aggregator.getRepoSummary?.(r.repoId);
        const apiCount = summary?.apis?.length ?? 0;
        const technology = r.technology ?? 'unknown';
        const subtitle = apiCount > 0
            ? `«${technology}» · ${apiCount} api${apiCount !== 1 ? 's' : ''}`
            : `«${technology}»`;
        nodes.push({
            id: nodeId,
            type: 'service',
            label: r.name || r.rootPath || r.repoId,
            subtitle,
            meta: {
                repoId: r.repoId,
                rootPath: r.rootPath,
                technology,
                apiCount,
                status: r.status,
                errorMessage: r.errorMessage,
                // Drill-down — clicking opens the per-repo Knowledge Map.
                drillDownGraphId: `map:${r.repoId}`,
                workspaceMap: true,
            },
        });
    }

    // ── Shared lane — externals ──────────────────────────────────────
    for (const ext of externals) {
        const nodeId = `ext_${ext.providerId}`;
        nodes.push({
            id: nodeId,
            type: 'service',
            label: ext.name,
            meta: {
                external: true,
                kind: 'external',
                providerId: ext.providerId,
                category: ext.category,
                consumers: ext.consumers,
                consumerCount: ext.consumers.length,
                workspaceMap: true,
            },
        });
        // Edges from each consumer to the external.
        for (const consumerRepoId of ext.consumers) {
            const repoNodeId = repoIdToNodeId.get(consumerRepoId);
            if (!repoNodeId) continue;
            edges.push({
                id: `e_ext_${ext.providerId}_${consumerRepoId}`,
                source: repoNodeId,
                target: nodeId,
                edgeType: 'uses',
                label: ext.category,
                meta: { workspaceMap: true, kind: 'external-usage' },
            });
        }
    }

    // ── Shared lane — DB schemas ──────────────────────────────────────
    for (const sch of schemas) {
        const nodeId = `schema_${sch.engine}_${sch.tableName}`;
        nodes.push({
            id: nodeId,
            type: 'service',
            label: `${sch.engine === 'postgresql' ? 'Postgres' :
                     sch.engine === 'mysql' ? 'MySQL' :
                     sch.engine === 'mongodb' ? 'Mongo' : sch.engine}·${sch.tableName}`,
            meta: {
                infra: true,
                kind: 'database',
                engine: sch.engine,
                tableName: sch.tableName,
                consumers: sch.consumers,
                consumerCount: sch.consumers.length,
                workspaceMap: true,
            },
        });
        for (const consumerRepoId of sch.consumers) {
            const repoNodeId = repoIdToNodeId.get(consumerRepoId);
            if (!repoNodeId) continue;
            edges.push({
                id: `e_schema_${sch.engine}_${sch.tableName}_${consumerRepoId}`,
                source: repoNodeId,
                target: nodeId,
                edgeType: 'depends',
                label: 'stores',
                meta: { workspaceMap: true, kind: 'schema-usage' },
            });
        }
    }

    // ── Cross-repo HTTP edges ─────────────────────────────────────────
    for (const edge of httpEdges) {
        const src = repoIdToNodeId.get(edge.sourceRepo);
        const dst = repoIdToNodeId.get(edge.targetRepo);
        if (!src || !dst) continue;
        edges.push({
            id: `e_http_${edge.sourceRepo}_${edge.targetRepo}_${edge.method}_${edge.route}`,
            source: src,
            target: dst,
            edgeType: 'calls',
            label: `${edge.method} ${edge.route}`,
            meta: { workspaceMap: true, kind: 'cross-repo-http', method: edge.method, route: edge.route },
        });
    }

    return {
        graphId: MAP_GRAPH_ID,
        type: 'map',
        nodes,
        edges,
        anchors,
        meta: {
            workspaceMap: true,
            workspaceRoot,
            repoCount: repos.length,
            sharedExternalCount: externals.length,
            sharedSchemaCount: schemas.length,
            crossRepoHttpEdgeCount: httpEdges.length,
            builtAt: Date.now(),
        },
    };
}
