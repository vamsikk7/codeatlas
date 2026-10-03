/**
 * UX-65e (2026-06-09)
 *
 * Pure filter that scopes a workspace Knowledge Map graph to a single
 * sub-repo. Knowledge Map nodes carry `meta.serviceId = 'service:<n>'`
 * for service / cluster / api / participant entries and `meta.infraId`
 * for infra (database / queue / sdk) entries. We keep any node whose
 * serviceId matches, walk edges to pull in infra + cross-repo service
 * neighbours, and stamp `meta.crossRepoTarget` / `meta.crossRepoEdge`
 * for the SPA hop affordance.
 *
 * Mirrors `scopedMicroserviceGraphFilter.ts`. Tests at
 * `__tests__/scopedMapGraphFilter.test.ts`.
 */

interface NodeLike {
    id: string;
    type?: string;
    kind?: string;
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

export interface FilteredMapGraph extends GraphLike {
    /** Number of cross-repo service neighbours pulled into the kept set. */
    crossRepoCount: number;
}

const INFRA_KINDS = new Set(['database', 'queue', 'sdk', 'topic', 'cache']);

function isInfraOrExternal(n: NodeLike): boolean {
    return !!(n.meta?.infra
        || n.meta?.external
        || n.meta?.infraId
        || (n.kind && INFRA_KINDS.has(String(n.kind))));
}

function serviceIdOf(n: NodeLike): string {
    return String(n?.meta?.serviceId ?? n?.serviceId ?? '');
}

/**
 * Filter `graph` to the Knowledge Map slice belonging to
 * `repoIdentifier`. The match key is `meta.serviceId === 'service:<id>'`.
 *
 * Returns `null` when no nodes match — caller falls through.
 */
export function filterMapGraphForRepo(
    graph: GraphLike,
    repoIdentifier: string,
): FilteredMapGraph | null {
    const allNodes: NodeLike[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const allEdges: EdgeLike[] = Array.isArray(graph?.edges) ? graph.edges : [];
    if (allNodes.length === 0) return null;

    // 2026-06-09 — match on three keys to support both the legacy
    // `buildMapGraph` workspace output (`meta.serviceId =
    // 'service:<name>'`) and the new `buildWorkspaceMapGraph` aggregator
    // output (`meta.repoId = '<hash>'` + `meta.rootPath = '<rel>'`). The
    // caller passes whatever the URL hash carries (name OR rootPath OR
    // repoId hash); we accept any of them as a match.
    const targetServiceId = `service:${repoIdentifier}`;
    const keepIds = new Set<string>();
    for (const n of allNodes) {
        const sid = serviceIdOf(n);
        if (sid === targetServiceId) { keepIds.add(n.id); continue; }
        const meta = n.meta ?? {};
        if (meta.repoId === repoIdentifier
            || meta.rootPath === repoIdentifier
            || meta.name === repoIdentifier) {
            keepIds.add(n.id);
        }
    }

    const crossRepoTargets = new Map<string, string>();
    let grew = true;
    while (grew) {
        grew = false;
        for (const e of allEdges) {
            const s = String(e.source ?? '');
            const t = String(e.target ?? '');
            if (keepIds.has(s) && !keepIds.has(t)) {
                const n = allNodes.find(x => x.id === t);
                if (!n) continue;
                if (isInfraOrExternal(n)) {
                    keepIds.add(t); grew = true;
                } else {
                    const otherSid = serviceIdOf(n);
                    if (otherSid && otherSid !== targetServiceId && otherSid.startsWith('service:')) {
                        keepIds.add(t); grew = true;
                        crossRepoTargets.set(t, otherSid.slice('service:'.length));
                    }
                }
            }
            if (keepIds.has(t) && !keepIds.has(s)) {
                const n = allNodes.find(x => x.id === s);
                if (!n) continue;
                if (isInfraOrExternal(n)) {
                    keepIds.add(s); grew = true;
                } else {
                    const otherSid = serviceIdOf(n);
                    if (otherSid && otherSid !== targetServiceId && otherSid.startsWith('service:')) {
                        keepIds.add(s); grew = true;
                        crossRepoTargets.set(s, otherSid.slice('service:'.length));
                    }
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
        if (sIsCross || tIsCross) return { ...e, meta: { ...(e.meta ?? {}), crossRepoEdge: true } };
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
