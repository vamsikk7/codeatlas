/**
 * l1HeaderStats.ts — #835 (2026-06-11).
 *
 * The multi-repo workspace L1 (`microservice:workspace`) is a skeletal /
 * bucketed graph by design (UX-27: >50 repos render as AWS-service
 * buckets; ≤50 render one node per repo). The header used to caption
 * that node count as "N services", so a 132-repo workspace with 209
 * services read "10 services" while the home stats — driven by
 * `aggregateMultiRepoCounts` (#831) — read 209.
 *
 * INVARIANT: the L1 header's service total must agree with the home
 * page's SERVICES stat; both derive from `workspaceInfo.serviceCount`,
 * the single counting path, so they cannot drift again; see ADR-036.
 *
 * Pure function so the decision table is unit-testable without
 * mounting ReactFlow.
 */

export interface L1ServiceHeader {
    /** Number rendered as "N services". */
    serviceTotal: number;
    /**
     * Suffix describing the condensed node set when the canvas shows
     * fewer nodes than there are services — "10 groups" on a bucketed
     * L1, "3 repos" on a per-repo skeletal L1. Null when the node
     * count IS the service count (nothing to explain).
     */
    condensedNote: string | null;
}

interface GraphLike {
    nodes: Array<{ meta?: Record<string, unknown> | null } & Record<string, unknown>>;
    meta?: Record<string, unknown> | null;
}

export function resolveL1ServiceHeader(
    graph: GraphLike,
    workspaceServiceCount?: number | null,
): L1ServiceHeader {
    const nodeTotal = graph.nodes.filter((n) => !(n.meta as { external?: boolean } | null | undefined)?.external).length;
    const meta = (graph.meta ?? {}) as { skeletal?: boolean; bucketed?: boolean; scopedRepo?: string };

    // Only the workspace-level skeletal L1 condenses services into
    // repo/bucket nodes. Single-repo L1s and sub-repo scoped rebuilds
    // (`meta.scopedRepo`) render real service nodes — count those.
    const isSkeletalWorkspace = meta.skeletal === true && !meta.scopedRepo;
    if (!isSkeletalWorkspace) return { serviceTotal: nodeTotal, condensedNote: null };

    // Pre-init / unknown count — fall back to the node count rather
    // than rendering "0 services" over a populated canvas.
    if (typeof workspaceServiceCount !== 'number' || workspaceServiceCount <= 0) {
        return { serviceTotal: nodeTotal, condensedNote: null };
    }

    if (workspaceServiceCount === nodeTotal) return { serviceTotal: nodeTotal, condensedNote: null };

    const noun = meta.bucketed === true ? 'group' : 'repo';
    return {
        serviceTotal: workspaceServiceCount,
        condensedNote: `${nodeTotal} ${noun}${nodeTotal !== 1 ? 's' : ''}`,
    };
}

/**
 * BUG-POLAR-2: compose the L1 header caption. When the canvas condenses services
 * into fewer repo/bucket NODES (`condensedNote` set), LEAD with the visible node
 * count so the caption matches what the user sees on the canvas ("4 repos · 17
 * services") instead of confusingly leading with a service count that doesn't
 * match the 4 rendered boxes. Otherwise just "N services".
 */
export function formatL1HeaderCaption(header: L1ServiceHeader): string {
    const svc = `${header.serviceTotal} service${header.serviceTotal !== 1 ? 's' : ''}`;
    return header.condensedNote ? `${header.condensedNote} · ${svc}` : svc;
}
