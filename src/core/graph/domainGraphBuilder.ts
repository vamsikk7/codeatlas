/**
 * domainGraphBuilder.ts — Issue #701 Domain graph builder.
 *
 * Renders the heuristic (and later LLM-derived) domain clusters from
 * `domainAnalyzer.detectDomains` as a workspace-wide diagram. Each
 * domain becomes one node; the node's subtitle shows the route count +
 * confidence. Drill-down navigates to the L2b api list for the first
 * route in the domain (a follow-up may add a dedicated domain detail
 * view; for the MVP, drilling into the api-list is a useful first move).
 *
 * Inter-domain edges represent file overlap: when two domains share ≥1
 * file, the renderer draws a "shares N files" edge. This surfaces
 * cross-cutting concerns (e.g. an auth file used by both "Authenticate
 * users" and "Manage profiles") that are otherwise invisible.
 */

import type {
    DiagramGraph,
    GraphNode,
    GraphEdge,
    Anchor,
    DomainCluster,
    DiffStatus,
    Snapshot,
} from './graphTypes';
import { isGraphIdOfType } from './graphIdBuilder';

let idCounter = 0;
function nextId(prefix = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

export const DOMAIN_GRAPH_ID = 'domain:workspace';

/**
 * Build the Domain layer graph.
 *
 * @param workingDomains - Per-domain records (typically from
 *                         `detectDomains(workingSnapshot)`).
 * @param workingSnapshot - The workspace snapshot the domains were
 *                          computed from. Used to look up route paths
 *                          for the per-domain drill-down target.
 * @param baselineDomains - Optional baseline domain set for diff
 *                          annotation. Pass `undefined` to render the
 *                          unchanged view.
 */
export function buildDomainGraph(
    workingDomains: Record<string, DomainCluster>,
    workingSnapshot: Snapshot,
    _baselineDomains?: Record<string, DomainCluster>,
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};

    // Issue #740 — per-route diff lookup from the cascade-updated L2b
    // api-list graphs. A domain whose route set is structurally stable
    // (same apiIds + same files between baseline and working) would
    // otherwise have `diff === undefined` even when one of its routes
    // was body-modified. Bubbling per-route modified state up to the
    // domain node closes that gap so the Domains panel reflects the
    // live cascade like every other layer.
    const apiDiffByApiId = buildApiDiffLookupForDomain(workingSnapshot);

    const sortedDomains = Object.values(workingDomains)
        // Stable order: 'Other' last, otherwise by confidence DESC then name.
        .sort((a, b) => {
            if (a.name === 'Other' && b.name !== 'Other') return 1;
            if (b.name === 'Other' && a.name !== 'Other') return -1;
            if (a.confidence !== b.confidence) return b.confidence - a.confidence;
            return a.name.localeCompare(b.name);
        });

    const domainNodeIds = new Map<string, string>();
    for (const domain of sortedDomains) {
        const id = nextId('domain');
        domainNodeIds.set(domain.id, id);
        const routeCount = domain.routes.length;
        const fileCount = domain.files.length;
        const subtitle = [
            routeCount > 0 ? `${routeCount} route${routeCount === 1 ? '' : 's'}` : null,
            fileCount > 0 ? `${fileCount} file${fileCount === 1 ? '' : 's'}` : null,
            `conf ${(domain.confidence * 100).toFixed(0)}%`,
        ].filter(Boolean).join(' · ');

        // Issue #740 — bubble per-route modified state up to the domain
        // node. Precedence: pre-stamped 'added' / 'deleted' / 'modified'
        // from `diffDomains` wins (structural change is stronger
        // evidence than route-body change); otherwise upgrade to
        // 'modified' when any contributing route is modified.
        let nodeDiff = domain.diff;
        if (!nodeDiff || nodeDiff === 'unchanged') {
            const hasModifiedRoute = domain.routes.some(rid => {
                const d = apiDiffByApiId.get(rid);
                return d === 'modified' || d === 'added' || d === 'deleted';
            });
            if (hasModifiedRoute) nodeDiff = 'modified';
        }

        nodes.push({
            id,
            type: 'cluster',
            label: domain.name,
            subtitle,
            diff: nodeDiff,
            clusterMembership: domain.id,
            serviceId: domain.serviceId,
            meta: {
                layer: 'domain',
                domainId: domain.id,
                verb: domain.verb,
                routeCount,
                fileCount,
                confidence: domain.confidence,
                source: domain.source ?? 'heuristic',
                // Drill-down: pick a representative route's L3 sequence
                // graph when one exists; otherwise fall back to the L4
                // file graph of the first contributing file.
                drillDownGraphId: pickDrillDownGraphId(domain, workingSnapshot),
            },
        });
    }

    // Inter-domain overlap edges. Walk pairs in sorted order so the edge
    // list is deterministic — important for the layout cache key.
    for (let i = 0; i < sortedDomains.length; i++) {
        for (let j = i + 1; j < sortedDomains.length; j++) {
            const a = sortedDomains[i];
            const b = sortedDomains[j];
            const overlap = countOverlap(a.files, b.files);
            if (overlap === 0) continue;
            const sourceId = domainNodeIds.get(a.id);
            const targetId = domainNodeIds.get(b.id);
            if (!sourceId || !targetId) continue;
            edges.push({
                id: nextId('edge'),
                source: sourceId,
                target: targetId,
                label: `shares ${overlap} file${overlap === 1 ? '' : 's'}`,
                edgeType: 'inter-cluster',
                meta: { overlap, layer: 'domain-overlap' },
            });
        }
    }

    return {
        graphId: DOMAIN_GRAPH_ID,
        type: 'domain',
        nodes,
        edges,
        anchors,
        meta: {
            label: 'Business Domains',
            domainCount: sortedDomains.length,
            source: sortedDomains[0]?.source ?? 'heuristic',
            // Helps the renderer label the toggle correctly ("Modules ↔
            // Domains") on the FeatureView when this graph is loaded.
            companionGraphId: 'feature:workspace',
        },
    };
}

function pickDrillDownGraphId(domain: DomainCluster, snapshot: Snapshot): string {
    // Prefer the first route's sequence graph; fall back to the first
    // file's file graph; ultimate fallback is L1 system design.
    for (const apiId of domain.routes) {
        const api = snapshot.apiIndex?.[apiId];
        if (api && api.filePath && api.handlerName) {
            return `sequence:${api.filePath}:${api.handlerName}`;
        }
    }
    if (domain.files.length > 0) {
        return `file:${domain.files[0]}`;
    }
    return 'microservice:workspace';
}

/**
 * Issue #740 — same shape as the mapGraphBuilder helper. Walks every
 * `api-list:<clusterId>` graph in the snapshot and indexes each entry's
 * `apiId → diff` pair. Centralised here too (rather than imported from
 * mapGraphBuilder) so the domain builder stays a standalone module that
 * doesn't pull in map-specific code paths.
 */
function buildApiDiffLookupForDomain(snapshot: Snapshot): Map<string, DiffStatus> {
    const out = new Map<string, DiffStatus>();
    const graphs = snapshot.graphs ?? {};
    for (const [graphId, graph] of Object.entries(graphs)) {
        if (!isGraphIdOfType(graphId, 'api-list')) continue;
        const apis = (graph?.meta as { apis?: Array<{ apiId?: string; diff?: DiffStatus }> } | undefined)?.apis ?? [];
        for (const a of apis) {
            if (!a?.apiId || !a.diff || a.diff === 'unchanged') continue;
            out.set(a.apiId, a.diff);
        }
    }
    return out;
}

function countOverlap<T>(a: T[], b: T[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const setB = new Set(b);
    let n = 0;
    for (const x of a) if (setB.has(x)) n++;
    return n;
}

// Convenience re-exports for callers wiring the analyzer + builder
// together (most callers want one or the other, not both).
export { detectDomains, diffDomains } from '../analysis/domainAnalyzer';
