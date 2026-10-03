/**
 * pathFinder.ts — Find the shortest call path between two functions.
 *
 * Issue #707. Answers the common debugging question "I see the auth
 * middleware on this route — where is the JWT actually verified?" by
 * BFS-traversing the workspace `SerializedCallGraph` from a source
 * function key to a destination function key. Returns the function-key
 * sequence (inclusive of both endpoints) plus the edge confidences along
 * the way, so the UI / MCP consumer can render the path with the same
 * diff-color affordances used elsewhere (#707 finish line).
 *
 * Pure data-in / data-out — accepts the already-serialized call graph so
 * tests can synthesize tiny graphs without touching the snapshot store.
 */

import type { SerializedCallGraph } from '../graph/graphTypes';

export interface FindCallPathOptions {
    /** BFS hop limit. Default 10 — same ceiling as the impact analyzer's depth cap. */
    maxDepth?: number;
    /** Drop edges below this confidence (0–1). Default 0 = no filter. */
    minConfidence?: number;
}

export interface CallPathResult {
    /** True when a path within `maxDepth` exists from `from` to `to`. */
    found: boolean;
    /**
     * The function keys along the path (inclusive of both endpoints), in
     * call order — `from`, intermediate hops, `to`. Empty / undefined when
     * `found === false`.
     */
    path?: string[];
    /**
     * Number of hops in the returned path. Equals `path.length - 1` when
     * `found`. Undefined when no path was found.
     */
    cost?: number;
    /**
     * Per-edge confidence scores along the path, parallel to `path` —
     * `confidences[i]` is the confidence of the call edge from
     * `path[i]` to `path[i + 1]`. Length = `path.length - 1`.
     */
    confidences?: number[];
}

/**
 * BFS the forward (`calls`) adjacency of `graph` from `from` to `to`.
 *
 * - Same-node trivial case: `from === to` returns a single-element path.
 * - Hop limit: `maxDepth` is the maximum number of edges traversed.
 * - Confidence filter: edges below `minConfidence` are skipped; if the
 *   call graph has no per-edge `callEdges` enrichment, all outgoing
 *   `calls` are treated as confidence 1.0.
 * - Predecessor reconstruction guarantees the returned path is one of the
 *   shortest paths (BFS, ties broken by adjacency-list order).
 */
export function findCallPath(
    graph: SerializedCallGraph,
    from: string,
    to: string,
    options: FindCallPathOptions = {},
): CallPathResult {
    const maxDepth = options.maxDepth ?? 10;
    const minConfidence = options.minConfidence ?? 0;

    if (!graph?.nodes?.[from] || !graph?.nodes?.[to]) {
        return { found: false };
    }
    if (from === to) {
        return { found: true, path: [from], cost: 0, confidences: [] };
    }

    // predecessor map: nodeKey → { prev, confidenceOfIncomingEdge }
    const predecessor = new Map<string, { prev: string; confidence: number }>();
    const visited = new Set<string>([from]);
    let frontier: string[] = [from];
    let depth = 0;

    while (frontier.length > 0 && depth < maxDepth) {
        const nextFrontier: string[] = [];
        for (const nodeKey of frontier) {
            const node = graph.nodes[nodeKey];
            if (!node) continue;

            // Confidence lookup: `callEdges` (enriched) wins; fall back to
            // the bare `calls` array with confidence 1.0.
            const edges = node.callEdges && node.callEdges.length > 0
                ? node.callEdges
                : node.calls.map(key => ({ key, confidence: 1, kind: 'invoke' as const }));

            for (const edge of edges) {
                if (edge.confidence < minConfidence) continue;
                if (visited.has(edge.key)) continue;
                if (!graph.nodes[edge.key]) continue;
                visited.add(edge.key);
                predecessor.set(edge.key, { prev: nodeKey, confidence: edge.confidence });
                if (edge.key === to) {
                    return reconstructPath(from, to, predecessor);
                }
                nextFrontier.push(edge.key);
            }
        }
        frontier = nextFrontier;
        depth++;
    }

    return { found: false };
}

function reconstructPath(
    from: string,
    to: string,
    predecessor: Map<string, { prev: string; confidence: number }>,
): CallPathResult {
    const path: string[] = [];
    const confidences: number[] = [];
    let cursor = to;
    while (cursor !== from) {
        const entry = predecessor.get(cursor);
        if (!entry) {
            // Should never happen if BFS marked predecessor correctly.
            return { found: false };
        }
        path.push(cursor);
        confidences.push(entry.confidence);
        cursor = entry.prev;
    }
    path.push(from);
    path.reverse();
    confidences.reverse();
    return { found: true, path, cost: path.length - 1, confidences };
}
