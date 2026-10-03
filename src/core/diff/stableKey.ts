import type { DiagramGraph, GraphNode, GraphEdge } from '../graph/graphTypes';

/**
 * Generate a stable key for a graph node based on its type, label, and context.
 * Normalizes literal values to reduce noise from minor changes.
 */
export function stableNodeKey(node: GraphNode): string {
    // Cluster and service nodes carry stable IDs (`clusterMembership`,
    // `serviceId`) that survive LLM-driven label renames. Without this branch,
    // an LLM renaming `cluster:article` from "article" to "Article Management"
    // changes the label-derived key and the diff layer reports the rename as
    // a delete + add pair on the L2a Feature Areas view.
    if (node.type === 'cluster' && node.clusterMembership) {
        return `cluster:${node.clusterMembership}`;
    }
    if (node.type === 'service' && node.serviceId) {
        return `service:${node.serviceId}`;
    }

    // Issue 199: Use selective normalization — only normalize numeric literals
    // inside parentheses/brackets (arguments), not in identifiers. Preserve
    // string content as a hash to prevent false matches between genuinely
    // different nodes like log("error") vs log("warning").
    const label = (node.label || '')
        .replace(/\(\s*\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*\s*\)/g, '(...)') // normalize numeric args: foo(123) → foo(...)
        .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, (m) => `"${simpleHash(m)}"`) // strings: preserve hash for uniqueness
        .trim();
    return `${node.type}:${label}`;
}

/** Simple string hash for stable key disambiguation */
function simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

/**
 * Anchor-based identity key — used as a secondary identity for rename detection.
 * Returns a non-empty string only when the node has a meaningful anchor symbol.
 */
export function anchorNodeKey(node: GraphNode): string {
    const fp = node.anchor?.filePath;
    const sym = node.anchor?.symbol;
    if (!fp || !sym) return '';
    return `anchor:${fp}::${sym}`;
}

/**
 * Generate a stable key for a graph edge (includes label — used for full match).
 */
export function stableEdgeKey(edge: GraphEdge, nodeKeyMap: Map<string, string>): string {
    const sourceKey = nodeKeyMap.get(edge.source) || edge.source;
    const targetKey = nodeKeyMap.get(edge.target) || edge.target;
    const label = normalizeLabel(edge.label || '');
    return `${sourceKey}->${targetKey}:${label}`;
}

/**
 * Topology-only edge key (source→target, NO label).
 * Used to detect edges whose label changed (→ modified instead of delete+add).
 */
export function stableEdgeTopologyKey(edge: GraphEdge, nodeKeyMap: Map<string, string>): string {
    const sourceKey = nodeKeyMap.get(edge.source) || edge.source;
    const targetKey = nodeKeyMap.get(edge.target) || edge.target;
    return `${sourceKey}->${targetKey}`;
}

function normalizeLabel(label: string): string {
    return label
        .replace(/\b\d+(\.\d+)?\b/g, '#')
        .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"STR"')
        .trim();
}

/**
 * Build a map of node IDs to stable keys for a graph
 */
export function buildNodeKeyMap(graph: DiagramGraph): Map<string, string> {
    const map = new Map<string, string>();
    for (const node of graph.nodes) {
        map.set(node.id, stableNodeKey(node));
    }
    return map;
}
