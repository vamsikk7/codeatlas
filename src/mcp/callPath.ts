/**
 * callPath.ts — find the call-graph path between two functions.
 *
 * The current MCP `get_function_dependencies` walks one step at a time
 * (upstream/downstream from a single anchor). For "how does GET /articles
 * end up touching prisma.user.findUnique?" the LLM has to chain N requests
 * and stitch the result. `trace_call_path` does the BFS server-side and
 * returns the actual edge sequence.
 */
import type { Snapshot } from '../core/graph/graphTypes';
import { WorkspaceCallGraph } from '../core/graph/callGraphResolver';

export interface CallPathStep {
    /** Caller-function key. */
    from: string;
    /** Callee-function key. */
    to: string;
    /** File path of the callee. */
    toFile: string;
    /** Callee function name. */
    toFunction: string;
    /** Edge confidence (0..1), if call-graph carries it. */
    confidence?: number;
    /** Edge kind: `calls` (function call) or `imports` (module import). */
    kind?: 'calls' | 'imports';
}

export interface CallPathResult {
    fromKey: string;
    toKey: string;
    /** Empty when no path exists within maxDepth. */
    path: CallPathStep[];
    /** Number of distinct functions visited during BFS (for token budgeting). */
    visited: number;
    /** True when the BFS terminated because it hit maxDepth, not because no path exists. */
    truncated: boolean;
}

/**
 * Find a shortest call path from `fromFile::fromFn` to `toFile::toFn` via the
 * workspace call graph. BFS over outgoing edges. Capped at `maxDepth` (default
 * 8) to avoid pathological traversals on dense graphs.
 *
 * Returns the path as an array of `CallPathStep`. Length 0 with `visited > 0`
 * means BFS ran but found no route within depth. `truncated: true` means the
 * BFS bailed at the depth limit.
 */
export function traceCallPath(
    snapshot: Snapshot,
    fromFile: string,
    fromFn: string,
    toFile: string,
    toFn: string,
    maxDepth = 8,
): CallPathResult {
    const fromKey = WorkspaceCallGraph.makeKey(fromFile, fromFn);
    const toKey = WorkspaceCallGraph.makeKey(toFile, toFn);
    const empty: CallPathResult = { fromKey, toKey, path: [], visited: 0, truncated: false };
    if (!snapshot.callGraph) return empty;
    const graph = WorkspaceCallGraph.deserialize(snapshot.callGraph as any);
    if (!graph.getNode(fromKey) || !graph.getNode(toKey)) return empty;

    // BFS — record predecessor + edge metadata per visited node so we can
    // reconstruct the path once we hit the target.
    interface Pred { prev: string; edgeKind?: 'calls' | 'imports'; edgeConfidence?: number; }
    const predecessors = new Map<string, Pred>();
    const queue: Array<{ key: string; depth: number }> = [{ key: fromKey, depth: 0 }];
    predecessors.set(fromKey, { prev: '' });

    let truncated = false;
    let found = false;
    while (queue.length > 0) {
        const { key, depth } = queue.shift()!;
        if (key === toKey) { found = true; break; }
        if (depth >= maxDepth) { truncated = true; continue; }
        const reachable = graph.getReachable(key, 1);
        for (const r of reachable) {
            if (predecessors.has(r.key)) continue;
            // Look up edge metadata from the source node's outgoing edges.
            const srcNode = graph.getNode(key);
            const edgeMeta = srcNode?.callEdges?.find((e) => e.key === r.key);
            predecessors.set(r.key, {
                prev: key,
                edgeKind: edgeMeta?.kind,
                edgeConfidence: edgeMeta?.confidence,
            });
            queue.push({ key: r.key, depth: depth + 1 });
        }
    }

    if (!found) return { fromKey, toKey, path: [], visited: predecessors.size, truncated };

    // Reconstruct the path from target back to source.
    const reversed: CallPathStep[] = [];
    let cur = toKey;
    while (cur && cur !== fromKey) {
        const pred = predecessors.get(cur);
        if (!pred || !pred.prev) break;
        const sep = cur.indexOf('::');
        const file = sep >= 0 ? cur.slice(0, sep) : cur;
        const fn = sep >= 0 ? cur.slice(sep + 2) : cur;
        reversed.push({
            from: pred.prev,
            to: cur,
            toFile: file,
            toFunction: fn,
            confidence: pred.edgeConfidence,
            kind: pred.edgeKind,
        });
        cur = pred.prev;
    }
    return {
        fromKey,
        toKey,
        path: reversed.reverse(),
        visited: predecessors.size,
        truncated,
    };
}
