/**
 * crossRepoPushScheduler.ts — #817.2 (2026-06-11).
 *
 * Cross-repo push core: when a producer repo's summary re-applies and a
 * `cross_repo_http_edges` row TARGETING that producer changes its diff
 * value, consumers' open tabs should hear about it immediately instead
 * of waiting for the user to navigate away and back.
 *
 * Design points (ISSUES.md #817 R1-R4, R7):
 *   - R1 edge-delta gating: a save that doesn't change any consumed-API
 *     hash produces zero transitions → zero pushes. Implemented by
 *     snapshotting the producer's edge set (via the shared #817.1
 *     `listCrossRepoEdgesForProducer` helper) before the apply and
 *     diffing after.
 *   - R2 per-producer debounce: bursts coalesce to one payload per
 *     producer per window (default 2s). A transition that nets out
 *     inside the window (probe + revert) is dropped entirely.
 *   - R3 fan-out: one payload carries every affected consumer edge.
 *   - R4 revert-clear: `modified→null` is a transition like any other —
 *     consumers receive `diff:null` and drop their `~` marker.
 *   - R7 settings gate: `enabled()` is consulted per apply; when false
 *     the wrapped apply still runs but no delta is computed or pushed.
 *
 * Shared by the extension's WorkspaceWatcher summary re-emit hook and
 * the standalone bootstrap's flushRebuild hook — parity by construction.
 */

import type { IAggregatorStore } from '../storage/storeInterfaces';
import { listCrossRepoEdgesForProducer } from '../analysis/crossRepoHttpAnalyzer';

export interface CrossRepoEdgeChange {
    consumerRepoId: string;
    consumerRepoName: string;
    method: string;
    route: string;
    /** New diff value; the literal 'deleted' when the edge row disappeared. */
    diff: string | null;
    /** Diff before the transition; the literal 'absent' when the edge is new. */
    prevDiff: string | null;
}

export interface CrossRepoPushPayload {
    type: 'crossRepoEdgeChanged';
    producerRepoId: string;
    producerRepoName: string;
    edges: CrossRepoEdgeChange[];
    at: number;
}

interface PendingProducer {
    timer: ReturnType<typeof setTimeout>;
    /** edgeKey → accumulated change. `firstPrev` pins the diff value at the
     *  START of the window so net-zero transitions can be dropped at flush. */
    edges: Map<string, { firstPrev: string | null; change: CrossRepoEdgeChange }>;
    producerRepoName: string;
}

export interface CrossRepoPushSchedulerOptions {
    broadcast: (payload: CrossRepoPushPayload) => void;
    /** Settings gate (R7). Default: always enabled. */
    enabled?: () => boolean;
    /** Per-producer coalescing window (R2). Default 2000ms. */
    debounceMs?: number;
    log?: (msg: string) => void;
    /** Telemetry hook (R8) — called once per flushed payload. */
    onPush?: (payload: CrossRepoPushPayload) => void;
}

const edgeKey = (consumerRepoId: string, method: string, route: string): string =>
    `${consumerRepoId}|${method}|${route}`;

export class CrossRepoPushScheduler {
    private readonly pending = new Map<string, PendingProducer>();
    private disposed = false;

    constructor(private readonly opts: CrossRepoPushSchedulerOptions) {}

    /**
     * Wrap a summary apply with edge-delta detection. Always executes
     * `apply()`; computes/queues transitions only when the gate is open.
     * Returns this apply's transitions (pre-coalescing) for tests/logging.
     */
    applyWithDelta(store: IAggregatorStore, producerRepoId: string, apply: () => void): CrossRepoEdgeChange[] {
        if (this.disposed || this.opts.enabled?.() === false) {
            apply();
            return [];
        }
        const before = new Map<string, { diff: string | null; consumerRepoName: string }>();
        for (const e of listCrossRepoEdgesForProducer(store, producerRepoId)) {
            before.set(edgeKey(e.consumerRepoId, e.method, e.route), { diff: e.diff, consumerRepoName: e.consumerRepoName });
        }

        apply();

        const after = listCrossRepoEdgesForProducer(store, producerRepoId);
        const transitions: CrossRepoEdgeChange[] = [];
        const seen = new Set<string>();
        for (const e of after) {
            const k = edgeKey(e.consumerRepoId, e.method, e.route);
            seen.add(k);
            const prev = before.get(k);
            if (!prev) {
                transitions.push({
                    consumerRepoId: e.consumerRepoId, consumerRepoName: e.consumerRepoName,
                    method: e.method, route: e.route, diff: e.diff, prevDiff: 'absent',
                });
            } else if (prev.diff !== e.diff) {
                transitions.push({
                    consumerRepoId: e.consumerRepoId, consumerRepoName: e.consumerRepoName,
                    method: e.method, route: e.route, diff: e.diff, prevDiff: prev.diff,
                });
            }
        }
        for (const [k, prev] of before) {
            if (seen.has(k)) continue;
            const [consumerRepoId, method, route] = k.split('|');
            transitions.push({
                consumerRepoId, consumerRepoName: prev.consumerRepoName,
                method, route, diff: 'deleted', prevDiff: prev.diff,
            });
        }

        if (transitions.length > 0) this.queue(store, producerRepoId, transitions);
        return transitions;
    }

    private queue(store: IAggregatorStore, producerRepoId: string, transitions: CrossRepoEdgeChange[]): void {
        let entry = this.pending.get(producerRepoId);
        if (!entry) {
            const producerRepoName =
                [...store.listRepos()].find((r) => r.repoId === producerRepoId)?.name ?? producerRepoId;
            entry = {
                edges: new Map(),
                producerRepoName,
                timer: setTimeout(() => this.flush(producerRepoId), this.opts.debounceMs ?? 2000),
            };
            this.pending.set(producerRepoId, entry);
        } else {
            // Extend the window — trailing debounce per producer.
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => this.flush(producerRepoId), this.opts.debounceMs ?? 2000);
        }
        for (const t of transitions) {
            const k = edgeKey(t.consumerRepoId, t.method, t.route);
            const existing = entry.edges.get(k);
            if (!existing) {
                entry.edges.set(k, { firstPrev: t.prevDiff, change: t });
            } else {
                // Latest state wins, but keep the window-start prev so a
                // net-zero round trip can be dropped at flush.
                existing.change = { ...t, prevDiff: existing.firstPrev };
            }
        }
    }

    /** Flush one producer's pending window now (timer path + tests). */
    flush(producerRepoId: string): void {
        const entry = this.pending.get(producerRepoId);
        if (!entry) return;
        this.pending.delete(producerRepoId);
        clearTimeout(entry.timer);
        const edges = [...entry.edges.values()]
            .filter((e) => e.change.diff !== e.firstPrev)   // net-zero → drop
            .map((e) => e.change)
            .sort((a, b) =>
                a.consumerRepoName.localeCompare(b.consumerRepoName)
                || a.route.localeCompare(b.route)
                || a.method.localeCompare(b.method));
        if (edges.length === 0) return;
        const payload: CrossRepoPushPayload = {
            type: 'crossRepoEdgeChanged',
            producerRepoId,
            producerRepoName: entry.producerRepoName,
            edges,
            at: Date.now(),
        };
        try {
            this.opts.broadcast(payload);
            this.opts.onPush?.(payload);
            this.opts.log?.(`[crossRepoPush] ${entry.producerRepoName}: pushed ${edges.length} edge change(s) to consumers`);
        } catch (err: any) {
            this.opts.log?.(`[crossRepoPush] broadcast failed: ${err?.message ?? err}`);
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const entry of this.pending.values()) clearTimeout(entry.timer);
        this.pending.clear();
    }
}
