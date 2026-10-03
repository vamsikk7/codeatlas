/**
 * multiRepoL1Diff.ts — #852 (2026-06-12).
 *
 * The multi-repo workspace L1 (`microservice:workspace`) is built on demand
 * from the repo registry (skeletal) or the aggregator copy — neither carries
 * per-repo diff state. So when a sub-repo has an in-repo edit, its L1 service
 * node stayed `unchanged` even though that repo's own per-repo cascade marks
 * its cluster/service modified. This post-processes the served L1 so each
 * service node reflects whether its repo has working-vs-baseline changes.
 *
 * Pure + injectable (`repoHasChanges(repoId)`) so it unit-tests without stores.
 */
import type { DiagramGraph } from '../graph/graphTypes';

/**
 * Mark each `service` node of a multi-repo L1 graph `modified` when its repo
 * has changes. Returns a NEW graph (does not mutate the input) so the served
 * copy is independent of the cached aggregator/skeletal graph. Service nodes
 * resolve their repo via `meta.repoId` (skeletal) or `meta.serviceId`
 * (aggregator copy, where serviceId === repoId in the multi-repo build).
 * Bucketed nodes (`meta.awsBucket`) carry many repos — marked modified if ANY
 * member repo changed. Worker-node siblings (`meta.worker`) and external nodes
 * are left untouched.
 */
export function markMultiRepoL1Diff(
    graph: DiagramGraph,
    repoHasChanges: (repoId: string) => boolean,
): DiagramGraph {
    let touched = false;
    const nodes = graph.nodes.map((n) => {
        if (n.type !== 'service') return n;
        if ((n.meta as any)?.external || (n.meta as any)?.worker) return n;
        const meta = (n.meta ?? {}) as any;
        let changed = false;
        const members: string[] | undefined = meta.bucketedFrom;
        if (Array.isArray(members) && members.length > 0) {
            changed = members.some((id) => repoHasChanges(id));
        } else {
            const repoId: string | undefined = meta.repoId ?? meta.serviceId;
            changed = !!repoId && repoHasChanges(repoId);
        }
        if (changed && n.diff !== 'modified' && n.diff !== 'added' && n.diff !== 'deleted') {
            touched = true;
            return { ...n, diff: 'modified' as const };
        }
        return n;
    });
    if (!touched) return graph;
    return { ...graph, nodes };
}
