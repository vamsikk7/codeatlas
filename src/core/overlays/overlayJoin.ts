/**
 * overlayJoin.ts — #826 R3/R4 (2026-06-11).
 *
 * ONE join engine + ONE roll-up engine for every overlay.
 *
 * Join: data points resolve onto graph nodes via the same key shapes the
 * diff matcher uses — node anchors (filePath[+functionName]), apiIds, and
 * service ids — with workspace-relative path normalization. Unresolved
 * points are counted and returned, never silently dropped.
 *
 * Roll-up: values aggregate up the parent chain the cascade already
 * maintains (function → file handled at join time via anchors; file →
 * cluster → service via snapshot membership), with a per-overlay
 * aggregator (sum for counts, max for severities, avg for latencies).
 */

import type { DiagramGraph, Snapshot } from '../graph/graphTypes';
import type {
    OverlayDataPoint,
    OverlayDescriptor,
    OverlayJoinResult,
    OverlayNodeValue,
} from './overlayTypes';

const SEV_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };

function normalisePath(p: string | undefined): string {
    if (!p) return '';
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function maxSeverity(a?: 'info' | 'warn' | 'error', b?: 'info' | 'warn' | 'error') {
    if (!a) return b;
    if (!b) return a;
    return SEV_RANK[a] >= SEV_RANK[b] ? a : b;
}

function numeric(v: number | string): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : 1; // string labels count as 1 occurrence
}

interface Accumulator { sum: number; max: number; count: number; severity?: 'info' | 'warn' | 'error' }

function accumulate(acc: Accumulator | undefined, point: OverlayDataPoint): Accumulator {
    const v = numeric(point.value);
    if (!acc) return { sum: v, max: v, count: 1, severity: point.severity };
    return {
        sum: acc.sum + v,
        max: Math.max(acc.max, v),
        count: acc.count + 1,
        severity: maxSeverity(acc.severity, point.severity),
    };
}

function finalise(overlayId: string, acc: Accumulator, aggregation: 'sum' | 'max' | 'avg'): OverlayNodeValue {
    const value = aggregation === 'max' ? acc.max
        : aggregation === 'avg' ? acc.sum / acc.count
        : acc.sum;
    return { overlayId, value, severity: acc.severity, pointCount: acc.count };
}

/**
 * Join `points` onto `graph` nodes per the descriptor's join kind, then
 * roll the same points up onto cluster/service nodes present in the graph
 * using snapshot membership.
 */
export function joinOverlay(
    descriptor: Pick<OverlayDescriptor, 'id' | 'join' | 'aggregation'>,
    points: ReadonlyArray<OverlayDataPoint>,
    graph: DiagramGraph,
    snapshot?: Snapshot,
): OverlayJoinResult {
    const aggregation = descriptor.aggregation ?? 'sum';
    const accByNode = new Map<string, Accumulator>();
    const unresolved: OverlayDataPoint[] = [];

    // ── Node index by join key ───────────────────────────────────────────
    const byFile = new Map<string, string[]>();          // filePath → nodeIds
    const byFileFn = new Map<string, string[]>();        // filePath::fn → nodeIds
    const byApiId = new Map<string, string[]>();
    const byServiceId = new Map<string, string[]>();
    const clusterNodeByFile = new Map<string, string[]>(); // member file → cluster nodeIds
    const serviceNodeById = new Map<string, string>();

    const push = (m: Map<string, string[]>, k: string, nodeId: string) => {
        const arr = m.get(k) ?? [];
        arr.push(nodeId);
        m.set(k, arr);
    };

    for (const node of graph.nodes ?? []) {
        const anchor = (node as { anchor?: { filePath?: string; symbol?: string } }).anchor;
        const meta = (node as { meta?: Record<string, unknown> }).meta ?? {};
        const fp = normalisePath(anchor?.filePath ?? (meta.filePath as string | undefined));
        if (fp) {
            push(byFile, fp, node.id);
            const fn = anchor?.symbol ?? (meta.functionName as string | undefined);
            if (fn) push(byFileFn, `${fp}::${fn}`, node.id);
        }
        const apiId = meta.apiId as string | undefined;
        if (apiId) push(byApiId, apiId, node.id);
        if (node.id.startsWith('service:')) serviceNodeById.set(node.id, node.id);
        const svcId = meta.serviceId as string | undefined;
        if (svcId) push(byServiceId, svcId, node.id);
    }

    // Cluster membership (graph cluster nodes ↔ snapshot cluster files).
    if (snapshot) {
        for (const node of graph.nodes ?? []) {
            if (!node.id.startsWith('cluster:')) continue;
            const cluster = (snapshot.clusters ?? {})[node.id] as { files?: string[] } | undefined;
            for (const f of cluster?.files ?? []) {
                push(clusterNodeByFile, normalisePath(f), node.id);
            }
        }
    }

    // ── Resolve points ───────────────────────────────────────────────────
    // Primary targets decide RESOLUTION (an unmatched point is unresolved
    // even if a catch-all service would technically contain its file);
    // roll-up targets (cluster/service parents) only attach once a primary
    // match exists.
    for (const point of points) {
        const primary = new Set<string>();
        if (descriptor.join === 'anchor') {
            const fp = normalisePath(point.key.filePath);
            if (fp && point.key.functionName) {
                for (const id of byFileFn.get(`${fp}::${point.key.functionName}`) ?? []) primary.add(id);
            }
            if (fp && primary.size === 0) {
                for (const id of byFile.get(fp) ?? []) primary.add(id);
            }
        } else if (descriptor.join === 'apiRecord') {
            if (point.key.apiId) for (const id of byApiId.get(point.key.apiId) ?? []) primary.add(id);
        } else {
            const sid = point.key.serviceId;
            if (sid) {
                if (serviceNodeById.has(sid)) primary.add(sid);
                for (const id of byServiceId.get(sid) ?? []) primary.add(id);
            }
        }

        if (primary.size === 0) {
            unresolved.push(point);
            continue;
        }

        const targets = new Set<string>(primary);
        if (descriptor.join !== 'service') {
            const fp = normalisePath(point.key.filePath);
            // Cluster roll-up: clusters whose membership contains the file.
            if (fp) for (const id of clusterNodeByFile.get(fp) ?? []) targets.add(id);
            // Service roll-up via snapshot membership.
            if (snapshot && fp) {
                for (const [sid, svc] of Object.entries(snapshot.services ?? {})) {
                    const root = normalisePath((svc as { rootPath?: string }).rootPath);
                    const inService = root === '' ? true : fp.startsWith(`${root}/`) || fp === root;
                    if (inService && serviceNodeById.has(sid)) targets.add(sid);
                }
            }
        }

        for (const nodeId of targets) {
            accByNode.set(nodeId, accumulate(accByNode.get(nodeId), point));
        }
    }

    const values = new Map<string, OverlayNodeValue>();
    for (const [nodeId, acc] of accByNode) {
        values.set(nodeId, finalise(descriptor.id, acc, aggregation));
    }
    return { values, unresolved };
}
