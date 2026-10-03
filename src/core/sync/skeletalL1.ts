/**
 * ADR-034 Phase B — skeletal L1 graph builder (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)).
 *
 * Pure function. Given the aggregator's `RepoRow[]`, produce a minimal
 * `microservice:workspace` graph: one service node per repo, no edges, no
 * consolidated state. The browser renders this skeleton within a second
 * of init starting, so the user sees the multi-repo topology immediately
 * — and the full L1 (with inter-service edges, shared infra, etc.) lands
 * later via the normal Phase C / Phase J cascade refresh.
 *
 * The skeletal graph carries `meta.skeletal = true` so the renderer can
 * either dim it (signal "still loading") or treat it identically to the
 * full graph — that choice lives in the React layer. The full graph
 * built later replaces this one in-place via the standard `notifyRefresh`
 * mechanism.
 */
import type { DiagramGraph, GraphNode, GraphEdge } from '../graph/graphTypes';
import type { RepoRow, CrossRepoHttpEdgeRow } from '../storage/storeInterfaces';
import { bucketServicesByAwsService } from '../analysis/awsServiceBucketing';

// UX-27 (2026-06-05) — when a multi-repo workspace exceeds this many
// repos (serverless-patterns has 796), render the skeletal L1 as one
// node per AWS service instead of one per repo. Without this the L1 is
// unreadable.
const AWS_BUCKET_THRESHOLD = 50;

/**
 * Build cross-repo HTTP edges (consumer → provider) between L1 service nodes from
 * the `cross_repo_http_edges` rows. Exported so the SERVE path can INJECT these at
 * render time — the stored skeletal graph may have been written before the
 * cross-repo edge pass populated the table (init-ordering fragility that dropped
 * the clients→server edge on a fresh multi-repo init, BUG-L1-CROSSREPO-EDGE).
 */
export function buildCrossRepoEdges(
    nodes: ReadonlyArray<GraphNode>,
    httpEdges: ReadonlyArray<CrossRepoHttpEdgeRow>,
): GraphEdge[] {
    const nodeByRepo = new Map(nodes.map((n) => [(n.meta as any)?.repoId as string, n.id]));
    const edges: GraphEdge[] = [];
    const seen = new Set<string>();
    for (const e of httpEdges) {
        const src = nodeByRepo.get(e.sourceRepo);
        const dst = nodeByRepo.get(e.targetRepo);
        if (!src || !dst || src === dst) continue;
        const id = `e_http_${e.sourceRepo}_${e.targetRepo}_${e.method}_${e.route}`;
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({
            id,
            source: src,
            target: dst,
            edgeType: 'calls',
            label: `${e.method} ${e.route}`,
            diff: (e.diff as any) ?? 'unchanged',
            meta: { kind: 'cross-repo-http', method: e.method, route: e.route },
        } as GraphEdge);
    }
    return edges;
}

/**
 * Build the workspace's skeletal L1 from the repo registry alone. No
 * per-repo snapshot data is touched; this can run before any per-repo
 * `RepoOrchestrator.initialize()` has produced a `state.db`.
 *
 * Node id convention matches the full L1 builder (`microserviceGraphBuilder`):
 *   - `service:<repoId>` so drill-in routes through the same handler.
 *
 * Status mapping:
 *   - `parsing` / `failed` / `stale` → `meta.status` propagates so the
 *     renderer can badge the node. Phase E (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)) wires the per-repo
 *     failure UX on top of this.
 *   - `ready` → node renders normally.
 */
export function buildSkeletalL1(
    repos: ReadonlyArray<RepoRow>,
    workspaceRoot: string,
    // BUG-L1-CROSSREPO-EDGE: the workspace L1 (`microservice:workspace`) used to
    // hard-code `edges: []`, so the detected consumer->provider cross-repo HTTP
    // edges (only drawn on `map:workspace`) never appeared between the L1 repo
    // cards. Pass the aggregator's edges here to draw them.
    httpEdges: ReadonlyArray<CrossRepoHttpEdgeRow> = [],
): DiagramGraph {
    // UX-27 (2026-06-05) — bucket by AWS service when there are too
    // many repos to render individually. The bucketed L1 is a useful
    // entry point; per-repo drill-down still works via the per-bucket
    // member list (Phase 2 follow-up).
    if (repos.length > AWS_BUCKET_THRESHOLD) {
        try {
            const flat = repos.map((r) => ({ id: r.repoId, name: r.name || r.rootPath || r.repoId }));
            const buckets = bucketServicesByAwsService(flat);
            const bucketNodes: GraphNode[] = buckets.map((b) => ({
                id: `service:aws:${b.awsService}`,
                type: 'service' as const,
                label: b.label,
                meta: {
                    serviceId: `aws:${b.awsService}`,
                    awsBucket: b.awsService,
                    bucketedFrom: b.members.map((m) => m.id),
                    patternCount: b.members.length,
                    skeletal: true,
                } as any,
                subtitle: `«aws» ${b.members.length} pattern${b.members.length !== 1 ? 's' : ''}`,
            } as GraphNode));
            return {
                graphId: 'microservice:workspace',
                type: 'microservice',
                nodes: bucketNodes,
                edges: [],
                anchors: {},
                meta: {
                    skeletal: true,
                    bucketed: true,
                    bucketReason: 'aws-services',
                    workspaceRoot,
                    repoCount: repos.length,
                    bucketCount: bucketNodes.length,
                    builtAt: Date.now(),
                },
            };
        } catch {
            // Fall through to the regular per-repo build on any
            // bucketing failure — better to render too many cards than none.
        }
    }
    const nodes: GraphNode[] = repos.map((r) => ({
        id: `service:${r.repoId}`,
        type: 'service' as const,
        label: r.name || r.rootPath || r.repoId,
        meta: {
            // Same shape as today's microservice graph builder so the
            // renderer keeps working without any conditional branching on
            // `meta.skeletal`.
            // UX-18 pt2 live-fix: the SPA's L1 click handler reads
            // `meta.serviceId` to build `openFeatureForService` — without
            // this field the dispatched message had `serviceId: ''` and
            // fell through to the workspace-wide (empty) feature graph.
            // Set serviceId = repoId so the handler's multi-repo branch
            // can match against `aggregator.listRepos()`.
            serviceId: r.repoId,
            repoId: r.repoId,
            // UX-19: pass the human name through so the repo chip can show
            // `api` instead of `dc2ef130f90896f2`.
            repoName: r.name ?? null,
            rootPath: r.rootPath,
            technology: r.technology ?? null,
            status: r.status,
            errorMessage: r.errorMessage ?? null,
            // Skeletal-only marker — Phase C populates `apiCount`, `clusterCount`,
            // etc. from the per-repo summary once it lands.
            skeletal: true,
        },
    }));

    // Cross-repo HTTP edges (consumer -> provider), mirroring the map builder.
    const edges = buildCrossRepoEdges(nodes, httpEdges);

    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes,
        edges,
        anchors: {},
        meta: {
            skeletal: true,
            workspaceRoot,
            repoCount: repos.length,
            // Timestamp helps the browser distinguish a stale broadcast from
            // a fresh skeletal one when multiple cascades fire in quick
            // succession (e.g. user hits Re-sync mid-init).
            builtAt: Date.now(),
        },
    };
}
