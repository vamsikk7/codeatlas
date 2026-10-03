/**
 * Pure decision helper extracted from `App.tsx:handleNodeClick`.
 *
 * Given the current layer mode and the clicked node's data, returns the
 * extension/standalone message that should be posted — or `null` when the
 * click should fall through to the legacy source-open path.
 *
 * Extracted so the per-mode drill-down rules can be unit-tested without
 * mounting App.tsx. Keep this file free of React + DOM imports.
 *
 * 2026-06-03 — added the `mode === 'domain'` branch (Issue UX-1). Domain
 * graph nodes carry `meta.drillDownGraphId` (set by
 * `src/core/graph/domainGraphBuilder.ts:pickDrillDownGraphId`) that already
 * resolves to a representative `sequence:<file>:<handler>` / `file:<path>`
 * graphId; we just route a `requestRoute` to it.
 */
export type NodeClickMessage =
    | { type: 'openFeatureForService'; serviceId: string; newWindow: boolean }
    | { type: 'openApiListForCluster'; clusterId: string; serviceId: string; newWindow: boolean }
    | { type: 'openSequenceForApi'; apiId: string; newWindow: boolean }
    | { type: 'requestRoute'; graphId: string };

export interface NodeClickInput {
    mode: string | undefined;
    nodeData: {
        type?: string;
        meta?: Record<string, unknown>;
        clusterMembership?: string;
        serviceId?: string;
    } | undefined | null;
    newWindow: boolean;
}

export function decideNodeClick(input: NodeClickInput): NodeClickMessage | null {
    const { mode, nodeData, newWindow } = input;
    if (!nodeData) return null;
    const meta = nodeData.meta ?? {};

    // L1 system design — service node → feature drill.
    if (mode === 'microservice' && nodeData.type === 'service' && !meta.external) {
        return { type: 'openFeatureForService', serviceId: String(meta.serviceId ?? ''), newWindow };
    }

    // Knowledge Map — different drill targets per layer.
    if (mode === 'map') {
        const layer = meta.layer as string | undefined;
        if (layer === 'cluster' && meta.clusterId) {
            return {
                type: 'openApiListForCluster',
                clusterId: String(meta.clusterId),
                serviceId: String(meta.serviceId ?? ''),
                newWindow,
            };
        }
        if (layer === 'service' && meta.serviceId && !meta.external) {
            return { type: 'openFeatureForService', serviceId: String(meta.serviceId), newWindow };
        }
        if (layer === 'api' && meta.apiId) {
            return { type: 'openSequenceForApi', apiId: String(meta.apiId), newWindow };
        }
        return null;
    }

    // Issue UX-1 (2026-06-03) — Domain view drill. Each domain cluster
    // node carries a pre-computed `drillDownGraphId` (sequence:<file>:<fn>
    // for the first route, file:<path> as a fallback). Route to it so the
    // domain → routes journey is no longer a dead click.
    if (mode === 'domain' && nodeData.type === 'cluster') {
        const drill = meta.drillDownGraphId as string | undefined;
        if (drill) return { type: 'requestRoute', graphId: drill };
        const cid = String(meta.domainId ?? meta.clusterId ?? nodeData.clusterMembership ?? '');
        if (cid) {
            return {
                type: 'openApiListForCluster',
                clusterId: cid,
                serviceId: String(meta.serviceId ?? nodeData.serviceId ?? ''),
                newWindow,
            };
        }
        return null;
    }

    // #L2merge — an api-typed node opens its sequence (L3) regardless of the
    // surrounding layer mode. The merged backend Feature view (mode 'feature')
    // renders API rows directly, so its clicks resolve here rather than falling
    // through to the source-open path. Mirrors the inline branch in App.tsx.
    if (nodeData.type === 'api' && meta.apiId) {
        return { type: 'openSequenceForApi', apiId: String(meta.apiId), newWindow };
    }

    // BUG-FE-NO-L3L4L5-L2A — a `type:'graph'` node is a pre-resolved drill
    // target (its `meta.graphId`), used by the FRONTEND L2a screen list: each
    // screen row opens its `screen-content:<id>` graph. Route via requestRoute
    // (same mechanism as the Domain drill above) so the hash changes and the
    // extension serves the screen-content L2b panel. Without this the click had
    // no matching branch and silently no-op'd — L3/L4/L5 + the screen-content
    // panel were all unreachable from the screen list.
    if (nodeData.type === 'graph' && typeof meta.graphId === 'string' && meta.graphId) {
        return { type: 'requestRoute', graphId: meta.graphId };
    }

    return null;
}
