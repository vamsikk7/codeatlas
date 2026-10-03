/**
 * scopedSubRepoView.ts — #819 (2026-06-10).
 *
 * Shared, transport-agnostic helpers for the "pick a sub-repo, see its
 * slice" Knowledge-Map flows. Consumed by BOTH `extension.ts`'s
 * requestRoute map handler AND `standalone/messageHandler.ts` so the
 * VSIX webview (7742) and the MCP standalone browser (7842) stay in
 * parity by construction (the #815 lesson — duplicated handler logic
 * silently diverges).
 *
 * Two failure modes this module closes (dev-walkthrough 2026-06-10):
 *
 *  1. WRONG-REPO / HASH-STRIP — `filterMapGraphForRepo` matched nodes
 *     by `service:<repoFolderName>`, but Phase-5-scoped per-repo maps
 *     name their service node by the INNER detected service name
 *     (`node-app`), so the filter kept 0 nodes, fell through without a
 *     `meta.scopedRepo` stamp (frontend stripped the hash), and the
 *     UX-57 fold then rendered another repo's content.
 *     → `buildScopedSubRepoMapGraph` rebuilds the map FRESH from the
 *     sub-repo's own snapshot (rootPath-filtered defensively, cached
 *     graphs cleared) and stamps `meta.scopedRepo`, so the result is
 *     correct regardless of how the per-repo store names its services.
 *
 *  2. FOLD ID-COLLISION — the bare-`#/map` fold deduped nodes by id,
 *     but every per-repo map uses the same generated ids (`map-1`,
 *     `map-2`, …), so the second repo's nodes silently vanished.
 *     → `foldPerRepoMapGraphs` namespaces every node/edge/anchor id by
 *     repo before merging; all repos' content survives.
 */

import type { Snapshot, DiagramGraph } from './graphTypes';
import { buildMapGraph } from './mapGraphBuilder';

export interface MatchedRepo {
    repoId: string;
    name: string;
    rootPath: string;
}

/**
 * Filter a snapshot down to the sub-repo's own entities. Defensive: a
 * per-repo state.db written by older builds (or the WorkspaceOrchestrator
 * post-init pass) can carry WORKSPACE-wide services / apis / files.
 * Post-Phase-5 stores pass through unchanged (everything already in
 * scope). Cached `graphs` are always cleared so a stale workspace-
 * overview `map:workspace` can't win over the fresh rebuild.
 */
export function filterSnapshotToSubRepo(rawSnapshot: Snapshot, rootPath: string): Snapshot {
    const prefix = (rootPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const inScope = (fp: string): boolean => {
        if (!prefix) return true;
        const norm = (fp || '').replace(/\\/g, '/').replace(/^\.\//, '');
        return norm === prefix || norm.startsWith(prefix + '/');
    };
    const snap: any = rawSnapshot;
    return {
        ...snap,
        // #846b — three legitimate service-record shapes must survive the
        // scope filter (the #811 defensive contract only needs to drop
        // FOREIGN workspace rows):
        //   • rootPath ''            — the repo's OWN record (live detector
        //     runs repo-relative; #831 signature). Dropping it erased the
        //     service card + infra siblings from small repos' scoped maps.
        //   • workspace-prefixed     — inside this repo's prefix.
        //   • repo-RELATIVE subpath  — multi-service repos (per-lambda).
        services: Object.fromEntries(Object.entries(snap.services ?? {})
            .filter(([, s]: [string, any]) => {
                if (s?.rootPath === undefined) return false;
                const rp = String(s.rootPath ?? '');
                if (rp === '') return true;
                if (inScope(rp)) return true;
                // Repo-RELATIVE subpath (multi-service repos): only when the
                // synthesized workspace path is backed by REAL files in scope
                // — otherwise a foreign row ('payments-service') would
                // masquerade as 'api-service/payments-service' and slip
                // through the #811 defensive contract.
                if (!prefix) return false;
                const synthesized = `${prefix}/${rp.replace(/\\/g, '/').replace(/^\.\//, '')}`;
                return Object.keys(snap.files ?? {}).some((fp: string) => {
                    const norm = fp.replace(/\\/g, '/');
                    return norm === synthesized || norm.startsWith(synthesized + '/');
                });
            })),
        apiIndex: Object.fromEntries(Object.entries(snap.apiIndex ?? {})
            .filter(([, a]: [string, any]) => a?.filePath && inScope(a.filePath))),
        files: Object.fromEntries(Object.entries(snap.files ?? {})
            .filter(([fp]) => inScope(fp))),
        clusters: Object.fromEntries(Object.entries(snap.clusters ?? {})
            .filter(([, c]: [string, any]) => Array.isArray(c?.files) && c.files.length > 0 && inScope(c.files[0]))),
        graphs: {},
    } as Snapshot;
}

/**
 * Build the picked sub-repo's Knowledge Map fresh from its snapshot.
 * Returns null when the rebuild produced no nodes (caller falls back).
 */
export function buildScopedSubRepoMapGraph(opts: {
    matched: MatchedRepo;
    subSnapshot: Snapshot;
    workspaceRoot: string;
    scopedRepo: string;
    contentProvider?: (filePath: string) => string | undefined;
    joinPath?: (...parts: string[]) => string;
}): DiagramGraph | null {
    const join = opts.joinPath ?? ((...p: string[]) => p.join('/'));
    const subRepoAbs = opts.matched.rootPath
        ? join(opts.workspaceRoot, opts.matched.rootPath)
        : opts.workspaceRoot;
    const filtered = filterSnapshotToSubRepo(opts.subSnapshot, opts.matched.rootPath);
    const graph: any = buildMapGraph(filtered, undefined, {
        workspaceRoot: subRepoAbs,
        contentProvider: opts.contentProvider,
    });
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
    graph.meta = { ...(graph.meta ?? {}), scopedRepo: opts.scopedRepo };
    return graph as DiagramGraph;
}

type AnyGraph = {
    nodes?: any[];
    edges?: any[];
    anchors?: Record<string, any>;
} & Record<string, unknown>;

/**
 * Fold per-repo `map:workspace` graphs into one workspace overview,
 * namespacing ids per repo so generated-id collisions can't drop a
 * repo's content. Node ids become `<repoKey>::<id>`; edge endpoints +
 * anchor keys are rekeyed consistently.
 */
export function foldPerRepoMapGraphs(
    perRepoMaps: ReadonlyArray<{ repoKey: string; graph: AnyGraph }>,
): { nodes: any[]; edges: any[]; anchors: Record<string, any>; repoContributors: string[] } {
    const nodes: any[] = [];
    const edges: any[] = [];
    const anchors: Record<string, any> = {};
    const repoContributors: string[] = [];

    for (const { repoKey, graph } of perRepoMaps) {
        const gNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
        if (gNodes.length === 0) continue;
        const ns = (id: unknown) => `${repoKey}::${String(id)}`;
        for (const n of gNodes) {
            if (!n?.id) continue;
            nodes.push({
                ...n,
                id: ns(n.id),
                meta: { ...(n.meta ?? {}), foldRepo: repoKey },
            });
        }
        for (const e of (Array.isArray(graph?.edges) ? graph.edges : [])) {
            if (!e?.source || !e?.target) continue;
            edges.push({
                ...e,
                id: e.id ? ns(e.id) : undefined,
                source: ns(e.source),
                target: ns(e.target),
            });
        }
        for (const [k, v] of Object.entries(graph?.anchors ?? {})) {
            anchors[ns(k)] = v;
        }
        repoContributors.push(repoKey);
    }
    return { nodes, edges, anchors, repoContributors };
}
