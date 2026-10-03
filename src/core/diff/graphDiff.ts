import type { DiagramGraph, GraphNode, GraphEdge, DiffStatus } from '../graph/graphTypes';
import { stableNodeKey, stableEdgeKey, stableEdgeTopologyKey, anchorNodeKey, buildNodeKeyMap } from './stableKey';

export interface DiffResult {
    /** The annotated graph (nodes/edges have diff status set) */
    graph: DiagramGraph;
    /** Summary statistics */
    stats: {
        addedNodes: number;
        deletedNodes: number;
        modifiedNodes: number;
        unchangedNodes: number;
        addedEdges: number;
        deletedEdges: number;
        modifiedEdges: number;
        unchangedEdges: number;
    };
}

/**
 * Compute the diff between a baseline graph and a working graph.
 * 
 * Compares nodes and edges by stable keys.
 * Returns a new graph with diff status annotations on all elements.
 */
export function diffGraphs(baseline: DiagramGraph, working: DiagramGraph): DiffResult {
    const baseNodeKeys = buildNodeKeyMap(baseline);
    const workNodeKeys = buildNodeKeyMap(working);

    // Build maps from stable key -> node for both graphs
    const baseNodeByKey = new Map<string, GraphNode>();
    for (const node of baseline.nodes) {
        const key = stableNodeKey(node);
        baseNodeByKey.set(key, node);
    }

    const workNodeByKey = new Map<string, GraphNode>();
    for (const node of working.nodes) {
        const key = stableNodeKey(node);
        workNodeByKey.set(key, node);
    }

    // Annotate working nodes with diff status
    const resultNodes: GraphNode[] = [];
    const stats = {
        addedNodes: 0, deletedNodes: 0, modifiedNodes: 0, unchangedNodes: 0,
        addedEdges: 0, deletedEdges: 0, modifiedEdges: 0, unchangedEdges: 0,
    };

    // Track provisional adds/deletes for rename-detection pass
    const provisionalAdded: GraphNode[] = [];
    const provisionalDeleted: GraphNode[] = [];

    // Maps baseline node ID → result node ID (for fixing deleted edge source/target)
    const baselineIdToResultId = new Map<string, string>();

    for (const node of working.nodes) {
        const key = stableNodeKey(node);
        const baseNode = baseNodeByKey.get(key);

        let diff: DiffStatus;
        if (!baseNode) {
            diff = 'added';
            stats.addedNodes++;
            provisionalAdded.push({ ...node, diff });
        } else if (nodeContentChanged(baseNode, node)) {
            diff = 'modified';
            stats.modifiedNodes++;
            resultNodes.push({ ...node, diff });
            baselineIdToResultId.set(baseNode.id, node.id);
        } else {
            diff = 'unchanged';
            stats.unchangedNodes++;
            resultNodes.push({ ...node, diff });
            baselineIdToResultId.set(baseNode.id, node.id);
        }
    }

    // Collect provisional deletes (in baseline but not in working by stable key)
    for (const [key, baseNode] of baseNodeByKey.entries()) {
        if (!workNodeByKey.has(key)) {
            provisionalDeleted.push(baseNode);
        }
    }

    // Rename/move detection: match provisional adds ↔ deletes by anchor identity
    const deletedByAnchor = new Map<string, GraphNode>();
    for (const d of provisionalDeleted) {
        const ak = anchorNodeKey(d);
        if (ak) deletedByAnchor.set(ak, d);
    }

    const matchedDeletedIds = new Set<string>();

    for (const addedNode of provisionalAdded) {
        const ak = anchorNodeKey(addedNode);
        const matchingDeleted = ak ? deletedByAnchor.get(ak) : undefined;

        if (matchingDeleted) {
            // Same file+symbol but different label → rename → single modified node
            matchedDeletedIds.add(matchingDeleted.id);
            stats.addedNodes--;
            stats.modifiedNodes++;
            baselineIdToResultId.set(matchingDeleted.id, addedNode.id);
            resultNodes.push({
                ...addedNode,
                diff: 'modified',
                diffDetail: { deleted: matchingDeleted.label, added: addedNode.label },
            });
        } else {
            resultNodes.push(addedNode);
        }
    }

    // Emit remaining (unmatched) deletes
    for (const baseNode of provisionalDeleted) {
        if (!matchedDeletedIds.has(baseNode.id)) {
            const newId = `deleted_${baseNode.id}`;
            baselineIdToResultId.set(baseNode.id, newId);
            resultNodes.push({
                ...baseNode,
                id: newId,
                diff: 'deleted',
                label: `${baseNode.label} (deleted)`,
            });
            stats.deletedNodes++;
        }
    }

    // ── Edge diffing ──────────────────────────────────────────────────────────
    // Build topology-key (source→target) maps for baseline, ignoring label.
    // This lets us detect edges whose label changed (→ modified).
    const baseEdgeByTopology = new Map<string, GraphEdge>();
    const baseEdgeFullKeys = new Set<string>();
    for (const edge of baseline.edges) {
        const topoKey = stableEdgeTopologyKey(edge, baseNodeKeys);
        const fullKey = stableEdgeKey(edge, baseNodeKeys);
        baseEdgeByTopology.set(topoKey, edge);
        baseEdgeFullKeys.add(fullKey);
    }

    const workEdgeTopoKeys = new Set<string>();
    const resultEdges: GraphEdge[] = [];

    for (const edge of working.edges) {
        const topoKey = stableEdgeTopologyKey(edge, workNodeKeys);
        const fullKey = stableEdgeKey(edge, workNodeKeys);
        workEdgeTopoKeys.add(topoKey);

        let diff: DiffStatus;
        const baseEdge = baseEdgeByTopology.get(topoKey);

        if (!baseEdge) {
            // No matching topology at all → added
            diff = 'added';
            stats.addedEdges++;
        } else if (!baseEdgeFullKeys.has(fullKey)) {
            // Same topology (source→target) but label changed → modified
            diff = 'modified';
            stats.modifiedEdges++;
        } else {
            diff = 'unchanged';
            stats.unchangedEdges++;
        }

        resultEdges.push({ ...edge, diff });
    }

    // Deleted edges: baseline topology keys absent from working.
    // Map source/target through baselineIdToResultId so deleted edges connect to
    // the correct result nodes (deleted nodes have `deleted_` prefix; matched nodes
    // use their working ID). Without this, deleted nodes are orphaned in the layout.
    // Issue 183: Validate that both source and target nodes exist in result to prevent dangling edges.
    const resultNodeIds = new Set(resultNodes.map(n => n.id));
    for (const edge of baseline.edges) {
        const topoKey = stableEdgeTopologyKey(edge, baseNodeKeys);
        if (!workEdgeTopoKeys.has(topoKey)) {
            const source = baselineIdToResultId.get(edge.source) ?? edge.source;
            const target = baselineIdToResultId.get(edge.target) ?? edge.target;
            // Skip edges referencing nodes that don't exist in the result graph
            if (!resultNodeIds.has(source) || !resultNodeIds.has(target)) continue;
            resultEdges.push({
                ...edge,
                id: `deleted_${edge.id}`,
                source,
                target,
                diff: 'deleted',
                styleKind: 'deleted',
            });
            stats.deletedEdges++;
        }
    }

    return {
        graph: {
            ...working,
            nodes: resultNodes,
            edges: resultEdges,
        },
        stats,
    };
}

/**
 * Check if node content has changed between baseline and working
 */
function nodeContentChanged(base: GraphNode, work: GraphNode): boolean {
    if (base.body !== work.body) return true;
    if (base.subtitle !== work.subtitle) return true;
    // Cluster and service labels are LLM-renameable cosmetic strings. The
    // structural content lives in body/subtitle (file count, API count,
    // cohesion). Treat label-only differences as unchanged so a background
    // LLM rename doesn't show up as a workspace edit on L1/L2a.
    if (base.type === 'cluster' || base.type === 'service') return false;
    // Compare normalized label (ignoring whitespace)
    const baseLabel = (base.label || '').replace(/\s+/g, ' ').trim();
    const workLabel = (work.label || '').replace(/\s+/g, ' ').trim();
    return baseLabel !== workLabel;
}

/**
 * Check if a graph has any changes compared to baseline
 */
export function hasChanges(diffResult: DiffResult): boolean {
    const { stats } = diffResult;
    return (
        stats.addedNodes > 0 ||
        stats.deletedNodes > 0 ||
        stats.modifiedNodes > 0 ||
        stats.addedEdges > 0 ||
        stats.deletedEdges > 0 ||
        stats.modifiedEdges > 0
    );
}
