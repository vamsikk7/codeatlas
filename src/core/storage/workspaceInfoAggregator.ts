/**
 * workspaceInfoAggregator.ts — UX-21 (2026-06-03 v2)
 *
 * Multi-repo home page surfaces inflated counts when buildWorkspaceInfo
 * naively sums each per-repo store's services / clusters / etc. without
 * deduping: cross-repo HTTP analysis and service detection leave stub
 * service rows for sibling repos in each store, so a workspace of 8
 * repos reports 64 services (8 × 8) instead of 8.
 *
 * This helper takes the per-repo Snapshot.working objects and returns a
 * deduplicated aggregate suitable for the home page workspaceInfo payload.
 *
 *  - Services are deduped by `service.id`.
 *  - Worker-stub services (`meta.worker === true`) are excluded from
 *    `serviceCount` so the count matches the L1 system-design diagram's
 *    visible service node count (workers are siblings, not services).
 *  - Files / apis / clusters / screens are keyed by their natural id and
 *    union-merged across repos.
 *  - Graph counts (file:/flow:/sequence:) are summed directly — these are
 *    per-repo by construction (graph id includes the file path) so no
 *    duplication is possible.
 */

import { isHeadlineApiRecord } from '../graph/entryPointCounts';

export interface AggregatedSnapshotLite {
    files?: Record<string, unknown>;
    apiIndex?: Record<string, unknown>;
    services?: Record<string, { id?: string; name?: string; rootPath?: string; meta?: { worker?: boolean } | null }>;
    clusters?: Record<string, unknown>;
    screens?: Record<string, unknown>;
    graphs?: Record<string, unknown>;
}

export interface WorkspaceCountsAggregate {
    fileCount: number;
    apiCount: number;
    serviceCount: number;
    clusterCount: number;
    screenCount: number;
    fileGraphCount: number;
    flowGraphCount: number;
    sequenceGraphCount: number;
    services: Array<{ id: string; name: string; rootPath?: string }>;
}

/**
 * #840 (2026-06-11) — strip FOREIGN service rows from a per-repo working
 * snapshot before aggregation. PERSISTED per-repo state.dbs carry
 * workspace-wide service rows written by the aggregator post-init pass
 * (the known pollution trap); those rows carry OTHER repos' workspace-
 * relative rootPaths and survive the #831 (id, rootPath) dedupe, so the
 * MCP standalone's home over-counted services (339 vs 209 on the 132-repo
 * fixture). The VS Code extension is immune (it aggregates live in-memory
 * workings). Rule: drop a service row whose rootPath is non-empty, matches
 * a DIFFERENT repo's registered rootPath, and isn't this repo's own.
 * Legitimate multi-service repos keep their rows — those carry
 * repo-RELATIVE rootPaths that aren't in the workspace repo registry.
 */
export function stripForeignServiceRows<T extends AggregatedSnapshotLite>(
    working: T,
    ownRootPath: string,
    allRepoRootPaths: ReadonlySet<string>,
): T {
    const services = working?.services;
    if (!services) return working;
    const filtered: Record<string, NonNullable<AggregatedSnapshotLite['services']>[string]> = {};
    let dropped = 0;
    for (const [id, s] of Object.entries(services)) {
        const rp = s?.rootPath ?? '';
        if (rp && rp !== ownRootPath && allRepoRootPaths.has(rp)) { dropped++; continue; }
        filtered[id] = s;
    }
    if (dropped === 0) return working;
    return { ...working, services: filtered };
}

export function aggregateMultiRepoCounts(workings: ReadonlyArray<AggregatedSnapshotLite>): WorkspaceCountsAggregate {
    const fileIds = new Set<string>();
    const apiIds = new Set<string>();
    const clusterIds = new Set<string>();
    const screenIds = new Set<string>();
    const rawServices: Array<{ id: string; name: string; rootPath?: string; isWorker: boolean; storeIndex: number }> = [];

    let fileGraphCount = 0;
    let flowGraphCount = 0;
    let sequenceGraphCount = 0;

    let storeIndex = -1;
    for (const w of workings) {
        storeIndex++;
        if (!w) continue;
        for (const k of Object.keys(w.files ?? {})) fileIds.add(k);
        // TICKET-MOBILE-1 — "APIs" excludes UI navigation (SCREEN/NAV_ROUTE) so
        // the headline isn't inflated by screens. NOTE: screens are counted from
        // `w.screens` (below), NOT apiIndex SCREEN — in a cross-contaminated
        // monorepo the per-repo apiIndexes carry workspace-wide SCREEN records
        // with per-repo apiIds that don't dedup, so summing them 6× over-counts
        // (the pre-existing aggregator-pollution issue in this file's header).
        for (const [k, a] of Object.entries(w.apiIndex ?? {})) {
            if (isHeadlineApiRecord(a as { method?: string })) apiIds.add(k);
        }
        for (const k of Object.keys(w.clusters ?? {})) clusterIds.add(k);
        for (const k of Object.keys(w.screens ?? {})) screenIds.add(k);

        // #847 — within ONE store, a bare generic `service:main` row
        // alongside another bare NAMED service is a detector stub left by a
        // post-init pass; counting it double-counted the repo (209 vs 208
        // live). Skip the generic when a named bare sibling exists.
        const storeServices = Object.entries(w.services ?? {});
        const bareIds = storeServices
            .filter(([, s]) => !(s?.rootPath))
            .map(([id, s]) => s?.id ?? id);
        const skipGenericMain = bareIds.includes('service:main') && bareIds.some((i) => i !== 'service:main');
        for (const [id, s] of storeServices) {
            const sid = s?.id ?? id;
            if (skipGenericMain && sid === 'service:main' && !(s?.rootPath)) continue;
            // Collect every occurrence; resolution happens after the loop.
            const meta = (s?.meta ?? null) as { worker?: boolean } | null;
            rawServices.push({
                id: s?.id ?? id,
                name: s?.name ?? id,
                rootPath: s?.rootPath,
                isWorker: !!meta?.worker,
                storeIndex,
            });
        }

        for (const gid of Object.keys(w.graphs ?? {})) {
            if (gid.startsWith('file:')) fileGraphCount++;
            else if (gid.startsWith('flow:')) flowGraphCount++;
            else if (gid.startsWith('sequence:')) sequenceGraphCount++;
        }
    }

    // #831 (2026-06-11) — service resolution. UX-21 deduped by id alone,
    // which collapsed two sub-repos that BOTH legitimately expose the
    // default `service:main` id ("1 SERVICE" on a 2-repo workspace while
    // L1 correctly showed 2). Live per-repo records carry rootPath '' (the
    // detector runs repo-relative), so rootPath alone can't separate them
    // either. Rules, order-independent:
    //   - records WITH a non-empty rootPath are real: dedupe per
    //     (id, rootPath) — one count per repo location;
    //   - records WITHOUT a rootPath: absorbed when ANY real record shares
    //     the id (the legacy Phase-B sibling-stub signature); otherwise
    //     they're each store's OWN service — dedupe per (id, store), so
    //     `service:main` from two different sub-repos counts twice.
    // First occurrence wins for naming (avoids label churn mid-render).
    const realByKey = new Map<string, { id: string; name: string; rootPath?: string; isWorker: boolean }>();
    const bareByStoreKey = new Map<string, { id: string; name: string; rootPath?: string; isWorker: boolean }>();
    const idsWithReal = new Set<string>();
    for (const s of rawServices) {
        if (s.rootPath) {
            const key = `${s.id}|${s.rootPath}`;
            if (!realByKey.has(key)) realByKey.set(key, s);
            idsWithReal.add(s.id);
        } else {
            const key = `${s.id}|store:${s.storeIndex}`;
            if (!bareByStoreKey.has(key)) bareByStoreKey.set(key, s);
        }
    }
    const services: Array<{ id: string; name: string; rootPath?: string }> = [];
    let serviceCount = 0;
    for (const s of realByKey.values()) {
        if (s.isWorker) continue;
        serviceCount++;
        services.push({ id: s.id, name: s.name, rootPath: s.rootPath });
    }
    for (const s of bareByStoreKey.values()) {
        if (idsWithReal.has(s.id) || s.isWorker) continue;
        serviceCount++;
        services.push({ id: s.id, name: s.name, rootPath: s.rootPath });
    }

    return {
        fileCount: fileIds.size,
        apiCount: apiIds.size,
        serviceCount,
        clusterCount: clusterIds.size,
        screenCount: screenIds.size,
        fileGraphCount,
        flowGraphCount,
        sequenceGraphCount,
        services,
    };
}
