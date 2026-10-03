/**
 * UX-65 / UX-67-test-debt (2026-06-09)
 *
 * Pure filter that scopes a workspace-level L1 microservice graph to a
 * single sub-repo. Extracted from `case 'system-design':` in
 * `extension.ts` so we can unit-test the cross-repo neighbour walk in
 * isolation. The Knowledge Map (`case 'map':`) uses a sibling helper
 * (`scopedMapGraphFilter.ts`) — same shape, different match key.
 *
 * Returns `null` when no nodes match (caller falls through to the
 * unscoped workspace graph). Returns a fresh graph object on success
 * with `meta.scopedRepo` stamped + the cross-repo neighbour count for
 * logging.
 *
 * Tests: `__tests__/scopedMicroserviceGraphFilter.test.ts`.
 */

interface NodeLike {
    id: string;
    type?: string;
    meta?: Record<string, any>;
    [k: string]: any;
}
interface EdgeLike {
    id?: string;
    source: string;
    target: string;
    meta?: Record<string, any>;
    [k: string]: any;
}
interface GraphLike {
    nodes?: NodeLike[];
    edges?: EdgeLike[];
    meta?: Record<string, any>;
    [k: string]: any;
}

export interface FilteredMicroserviceGraph extends GraphLike {
    /** Number of cross-repo service neighbours pulled into the kept set. */
    crossRepoCount: number;
}

/**
 * Filter `graph` to the slice belonging to `repoIdentifier` — matching
 * via `meta.rootPath` or `meta.repoId` on service nodes. Walks edges to
 * pull in:
 *   - infra / external neighbours (non-service nodes or nodes flagged
 *     `meta.infra` / `meta.external`)
 *   - cross-repo service neighbours (other service nodes whose
 *     `meta.rootPath` differs), which get `meta.crossRepoTarget`
 *     stamped so the SPA click handler can hop scope.
 *
 * Returns `null` when no nodes match — the caller should fall through
 * to the workspace-wide graph.
 */
export function filterMicroserviceGraphForRepo(
    graph: GraphLike,
    repoIdentifier: string,
): FilteredMicroserviceGraph | null {
    const allNodes: NodeLike[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const allEdges: EdgeLike[] = Array.isArray(graph?.edges) ? graph.edges : [];
    if (allNodes.length === 0) return null;

    const keepIds = new Set<string>();
    for (const n of allNodes) {
        const mp = n?.meta?.rootPath ?? n?.meta?.repoId ?? '';
        if (mp === repoIdentifier) keepIds.add(n.id);
    }

    const crossRepoTargets = new Map<string, string>(); // nodeId → other-repo rootPath
    let grew = true;
    while (grew) {
        grew = false;
        for (const e of allEdges) {
            const s = String(e.source ?? '');
            const t = String(e.target ?? '');
            if (keepIds.has(s) && !keepIds.has(t)) {
                const n = allNodes.find(x => x.id === t);
                if (!n) continue;
                if (n.meta?.infra || n.meta?.external || n.type !== 'service') {
                    keepIds.add(t); grew = true;
                } else if (n.type === 'service' && n.meta?.rootPath && n.meta.rootPath !== repoIdentifier) {
                    keepIds.add(t); grew = true;
                    crossRepoTargets.set(t, n.meta.rootPath);
                }
            }
            if (keepIds.has(t) && !keepIds.has(s)) {
                const n = allNodes.find(x => x.id === s);
                if (!n) continue;
                if (n.meta?.infra || n.meta?.external || n.type !== 'service') {
                    keepIds.add(s); grew = true;
                } else if (n.type === 'service' && n.meta?.rootPath && n.meta.rootPath !== repoIdentifier) {
                    keepIds.add(s); grew = true;
                    crossRepoTargets.set(s, n.meta.rootPath);
                }
            }
        }
    }

    if (keepIds.size === 0) return null;

    const fNodes = allNodes.filter(n => keepIds.has(n.id)).map(n => {
        const tgt = crossRepoTargets.get(n.id);
        return tgt ? { ...n, meta: { ...(n.meta ?? {}), crossRepoTarget: tgt } } : n;
    });
    const fEdges = allEdges.filter(e => keepIds.has(String(e.source)) && keepIds.has(String(e.target))).map(e => {
        const sIsCross = crossRepoTargets.has(String(e.source));
        const tIsCross = crossRepoTargets.has(String(e.target));
        if (sIsCross || tIsCross) {
            return { ...e, meta: { ...(e.meta ?? {}), crossRepoEdge: true } };
        }
        return e;
    });

    return {
        ...graph,
        nodes: fNodes,
        edges: fEdges,
        meta: { ...(graph.meta ?? {}), scopedRepo: repoIdentifier },
        crossRepoCount: crossRepoTargets.size,
    };
}
