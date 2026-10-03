/**
 * domainRouteResolver.ts — #832 (2026-06-11).
 *
 * Bare `#/domain` on a multi-repo workspace hung forever: no
 * `domain:workspace` graph exists at workspace scope, the merged view
 * came back empty (per-repo stores past the registry LRU cap aren't
 * loaded), and the SPA's 5s fallback then bounced the user off the
 * route. The MCP standalone never had this problem because it rebuilds
 * the domain graph on demand from the primary snapshot.
 *
 * This resolver gives the extension the same on-demand semantics:
 *   1. merged `domain:workspace` non-empty → serve it;
 *   2. else scan the repo registry (bounded) for a per-repo store whose
 *      working snapshot already has a non-empty domain graph → serve it
 *      scoped to that repo;
 *   3. else build one on demand from the first repo with clusters;
 *   4. else null → caller keeps the "not built yet" toast.
 */

import type { Snapshot, DiagramGraph } from './graphTypes';
import { detectDomains } from '../analysis/domainAnalyzer';
import { buildDomainGraph } from './domainGraphBuilder';

export interface DomainRouteStoreLike {
    getWorking(): Snapshot;
}

export interface ResolveBareDomainOptions {
    /** Merged workspace-view graphs (post `mergeGraphsForView`). */
    mergedGraphs: Record<string, DiagramGraph | undefined>;
    repos: ReadonlyArray<{ repoId: string; name: string; rootPath: string }>;
    /** Resolve a repo's store by its ABSOLUTE root path; undefined = skip. */
    getStore: (repoRootAbsolute: string) => DomainRouteStoreLike | undefined;
    workspaceRoot: string;
    joinPath: (a: string, b: string) => string;
    /** Bound on per-repo scans (LRU re-opens cost ~ms each). Default 20. */
    maxScan?: number;
    log?: (msg: string) => void;
}

const nonEmpty = (g: DiagramGraph | undefined | null): g is DiagramGraph =>
    !!g && Array.isArray((g as { nodes?: unknown[] }).nodes) && (g as { nodes: unknown[] }).nodes.length > 0;

export function resolveBareDomainGraph(
    opts: ResolveBareDomainOptions,
): { graph: DiagramGraph; scopedRepo?: string } | null {
    const log = opts.log ?? (() => { /* silent */ });

    const merged = opts.mergedGraphs['domain:workspace'];
    if (nonEmpty(merged)) return { graph: merged };

    const maxScan = opts.maxScan ?? 20;
    for (const repo of opts.repos.slice(0, maxScan)) {
        let store: DomainRouteStoreLike | undefined;
        try {
            store = opts.getStore(opts.joinPath(opts.workspaceRoot, repo.rootPath));
        } catch { continue; }
        if (!store) continue;
        let working: Snapshot;
        try { working = store.getWorking(); } catch { continue; }

        const existing = (working.graphs ?? {})['domain:workspace'] as DiagramGraph | undefined;
        if (nonEmpty(existing)) {
            log(`[domainRoute] bare multi-repo: serving ${repo.name}'s existing domain graph (#832)`);
            return {
                graph: { ...existing, meta: { ...(existing.meta ?? {}), scopedRepo: repo.name } },
                scopedRepo: repo.name,
            };
        }

        if (Object.keys(working.clusters ?? {}).length > 0) {
            try {
                const built = buildDomainGraph(detectDomains(working), working);
                if (nonEmpty(built)) {
                    log(`[domainRoute] bare multi-repo: built ${repo.name}'s domain graph on demand (#832)`);
                    return {
                        graph: { ...built, meta: { ...(built.meta ?? {}), scopedRepo: repo.name } },
                        scopedRepo: repo.name,
                    };
                }
            } catch (err: unknown) {
                log(`[domainRoute] on-demand build failed for ${repo.name}: ${(err as Error)?.message ?? err}`);
            }
        }
    }
    return null;
}
