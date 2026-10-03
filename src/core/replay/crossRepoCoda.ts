/**
 * crossRepoCoda.ts — #818 (2026-06-11).
 *
 * Replay coda: when a replay covers a PRODUCER repo whose API surface
 * changed, append frames that walk the DIRECT consumer repos so the user
 * sees who downstream is affected without leaving the player.
 *
 * Frame composition per consumer (#818 R2):
 *   (a) workspace L1 with the producer→consumer consumes-edge carrying
 *       its `~` diff (the #817 hash-staleness recompute stamps it);
 *   (b) the consumer's L3 sequence that references the consumed route
 *       (resolved by route-fragment search across the consumer's
 *       sequence graphs — skipped with a log when unresolvable);
 *   (c) the consumer's L4 file diagram of the calling file (resolved by
 *       route-fragment search over the consumer's file contents via the
 *       lazy `getFileContent` reader — skipped with a log when
 *       unresolvable; never fails the coda).
 *
 * Rules:
 *   - R1: depth 1 — direct consumers only.
 *   - R3: consumers ordered by affected-edge count desc, then name; capped
 *     at `maxConsumers` (default 5); a summary frame lists the overflow.
 *   - R4: every frame carries `replayKind: 'cross-repo-coda'` so the
 *     player renders the 🔗 chip + skip control.
 *   - R6: zero affected consumers → zero frames; single-repo callers
 *     never invoke this.
 *
 * Shared by the extension's replay handler and the standalone replay —
 * frames are computed server-side once (R7 parity).
 */

import type { DiagramGraph, Snapshot } from '../graph/graphTypes';
import type { IAggregatorStore } from '../storage/storeInterfaces';
import { listCrossRepoEdgesForProducer } from '../analysis/crossRepoHttpAnalyzer';

export interface CodaFrame {
    graphId: string;
    mode: string;
    label: string;
    layer: string;
    changedEntity: string;
    graph: DiagramGraph;
    replayKind: 'cross-repo-coda';
    codaProducer: string;
    codaConsumer: string;
}

/** Minimal store surface the builder needs — satisfied by SnapshotStore. */
export interface CodaStoreLike {
    getWorking(): Snapshot;
    getFileContent?(kind: 'working' | 'baseline', filePath: string): string | undefined;
}

export interface BuildCodaOptions {
    aggregator: IAggregatorStore;
    /** Replayed (producer) repo — repoId, name, or rootPath. */
    producer: string;
    /** repoId → per-repo store. */
    perRepoStores: ReadonlyMap<string, CodaStoreLike>;
    /** Workspace L1 graph for frames (a) + the overflow summary. */
    workspaceL1?: DiagramGraph | null;
    /** R3 cap (setting `codeatlas.replayCodaMaxConsumers`). Default 5. */
    maxConsumers?: number;
    log?: (msg: string) => void;
    /** Cap on per-consumer file-content scans for frame (c). Default 300. */
    maxFileScan?: number;
}

/** Route → stable search fragment: the static prefix before any param
 *  token, so `/api/items/${id}`, `/api/items/:id`, `/api/items/{id}` all
 *  reduce to `/api/items`. */
export function routeSearchFragment(route: string): string {
    const cut = route.search(/[:{$]/);
    const prefix = cut === -1 ? route : route.slice(0, cut);
    return prefix.replace(/\/+$/, '') || route;
}

export function buildCrossRepoCodaFrames(opts: BuildCodaOptions): CodaFrame[] {
    const log = opts.log ?? (() => { /* silent */ });
    const maxConsumers = Math.max(1, opts.maxConsumers ?? 5);

    const edges = listCrossRepoEdgesForProducer(opts.aggregator, opts.producer);
    const affected = edges.filter((e) => e.diff === 'modified' || e.diff === 'added');
    if (affected.length === 0) return [];

    const producerName =
        [...opts.aggregator.listRepos()].find(
            (r) => r.repoId === opts.producer || r.name === opts.producer || r.rootPath === opts.producer,
        )?.name ?? opts.producer;

    // Group by consumer; R3 ordering: affected-edge count desc, name asc.
    const byConsumer = new Map<string, { name: string; edges: typeof affected }>();
    for (const e of affected) {
        const entry = byConsumer.get(e.consumerRepoId) ?? { name: e.consumerRepoName, edges: [] as typeof affected };
        entry.edges.push(e);
        byConsumer.set(e.consumerRepoId, entry);
    }
    const ordered = [...byConsumer.entries()].sort((a, b) =>
        b[1].edges.length - a[1].edges.length || a[1].name.localeCompare(b[1].name));

    const within = ordered.slice(0, maxConsumers);
    const overflow = ordered.slice(maxConsumers);

    const frames: CodaFrame[] = [];
    const frame = (partial: Omit<CodaFrame, 'replayKind' | 'codaProducer'>): CodaFrame => ({
        ...partial,
        replayKind: 'cross-repo-coda',
        codaProducer: producerName,
    });

    for (const [consumerRepoId, { name: consumerName, edges: consumerEdges }] of within) {
        const routeList = consumerEdges.map((e) => `${e.method} ${e.route}`).join(', ');

        // (a) workspace L1 — the consumes-edge carries its diff marker.
        if (opts.workspaceL1) {
            frames.push(frame({
                graphId: 'microservice:workspace',
                mode: 'microservice',
                label: `🔗 ${producerName} → ${consumerName} — impacted consumer (${routeList})`,
                layer: 'L1 Cross-repo',
                changedEntity: consumerName,
                graph: opts.workspaceL1,
                codaConsumer: consumerName,
            }));
        }

        const store = opts.perRepoStores.get(consumerRepoId);
        if (!store) {
            log(`[crossRepoCoda] no store for consumer ${consumerName} — L3/L4 frames skipped`);
            continue;
        }
        const working = store.getWorking();
        const fragment = routeSearchFragment(consumerEdges[0].route);

        // (b) consumer L3 — first sequence graph referencing the route.
        let l3Found = false;
        for (const [gid, g] of Object.entries(working.graphs ?? {})) {
            if (!gid.startsWith('sequence:') || !g) continue;
            try {
                if (JSON.stringify(g).includes(fragment)) {
                    frames.push(frame({
                        graphId: gid,
                        mode: 'sequence',
                        label: `🔗 ${producerName} → ${consumerName} — consuming flow (L3)`,
                        layer: 'L3 Cross-repo',
                        changedEntity: consumerName,
                        graph: g as DiagramGraph,
                        codaConsumer: consumerName,
                    }));
                    l3Found = true;
                    break;
                }
            } catch { /* skip unserialisable graph */ }
        }
        if (!l3Found) log(`[crossRepoCoda] ${consumerName}: no L3 sequence references "${fragment}" — frame (b) skipped`);

        // (c) consumer L4 — file whose content contains the route fragment.
        let l4Found = false;
        if (typeof store.getFileContent === 'function') {
            const files = Object.keys(working.files ?? {}).slice(0, opts.maxFileScan ?? 300);
            for (const fp of files) {
                let content: string | undefined;
                try { content = store.getFileContent('working', fp); } catch { content = undefined; }
                if (!content || !content.includes(fragment)) continue;
                const fileGraph = (working.graphs ?? {})[`file:${fp}`];
                if (!fileGraph) continue;
                frames.push(frame({
                    graphId: `file:${fp}`,
                    mode: 'file',
                    label: `🔗 ${producerName} → ${consumerName} — calling file (L4)`,
                    layer: 'L4 Cross-repo',
                    changedEntity: consumerName,
                    graph: fileGraph as DiagramGraph,
                    codaConsumer: consumerName,
                }));
                l4Found = true;
                break;
            }
        }
        if (!l4Found) log(`[crossRepoCoda] ${consumerName}: calling file for "${fragment}" not resolved — frame (c) skipped`);
    }

    // R3 overflow — one summary frame naming the rest.
    if (overflow.length > 0 && opts.workspaceL1) {
        const names = overflow.map(([, v]) => v.name).join(', ');
        frames.push(frame({
            graphId: 'microservice:workspace',
            mode: 'microservice',
            label: `🔗 ${producerName} — ${overflow.length} more consumer(s) affected: ${names}`,
            layer: 'L1 Cross-repo',
            changedEntity: names,
            graph: opts.workspaceL1,
            codaConsumer: names,
        }));
    }

    return frames;
}
