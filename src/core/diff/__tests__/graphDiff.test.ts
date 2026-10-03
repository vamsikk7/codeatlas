import { describe, it, expect } from 'vitest';
import { stableNodeKey, stableEdgeKey, stableEdgeTopologyKey, anchorNodeKey, buildNodeKeyMap } from '../stableKey';
import { diffGraphs, hasChanges } from '../graphDiff';
import type { DiagramGraph, GraphNode, GraphEdge } from '../../graph/graphTypes';

describe('stableKey', () => {
    it('should generate a stable key from node type and label', () => {
        const node: GraphNode = { id: '1', type: 'function', label: 'fetchUsers', diff: 'unchanged' };
        const key = stableNodeKey(node);

        expect(key).toBe('function:fetchUsers');
    });

    it('should normalize numeric arguments in function calls', () => {
        // Issue 199: foo(42) and foo(99) should match — args are normalized to (...)
        const node1: GraphNode = { id: '1', type: 'statement', label: 'foo(42)', diff: 'unchanged' };
        const node2: GraphNode = { id: '2', type: 'statement', label: 'foo(99)', diff: 'unchanged' };
        expect(stableNodeKey(node1)).toBe(stableNodeKey(node2));
    });

    it('should NOT normalize standalone numeric literals', () => {
        // Issue 199: x = 42 and x = 99 are semantically different — should NOT match
        const node1: GraphNode = { id: '1', type: 'statement', label: 'x = 42', diff: 'unchanged' };
        const node2: GraphNode = { id: '2', type: 'statement', label: 'x = 99', diff: 'unchanged' };
        expect(stableNodeKey(node1)).not.toBe(stableNodeKey(node2));
    });

    it('should differentiate string literals via hash', () => {
        // Issue 199: log("hello") and log("world") should have different keys
        const node1: GraphNode = { id: '1', type: 'statement', label: 'log("hello")', diff: 'unchanged' };
        const node2: GraphNode = { id: '2', type: 'statement', label: 'log("world")', diff: 'unchanged' };
        expect(stableNodeKey(node1)).not.toBe(stableNodeKey(node2));
    });

    it('should match same string literals', () => {
        const node1: GraphNode = { id: '1', type: 'statement', label: 'log("hello")', diff: 'unchanged' };
        const node2: GraphNode = { id: '2', type: 'statement', label: 'log("hello")', diff: 'unchanged' };
        expect(stableNodeKey(node1)).toBe(stableNodeKey(node2));
    });

    it('should differentiate node types', () => {
        const fn: GraphNode = { id: '1', type: 'function', label: 'foo', diff: 'unchanged' };
        const variable: GraphNode = { id: '2', type: 'variable', label: 'foo', diff: 'unchanged' };

        expect(stableNodeKey(fn)).not.toBe(stableNodeKey(variable));
    });

    it('should generate edge keys using node keys', () => {
        const nodeKeyMap = new Map([['n1', 'function:foo'], ['n2', 'function:bar']]);
        const edge: GraphEdge = { id: 'e1', source: 'n1', target: 'n2', label: 'calls', diff: 'unchanged' };

        const key = stableEdgeKey(edge, nodeKeyMap);
        expect(key).toBe('function:foo->function:bar:calls');
    });

    it('stableEdgeTopologyKey omits label', () => {
        const nodeKeyMap = new Map([['n1', 'function:foo'], ['n2', 'function:bar']]);
        const e1: GraphEdge = { id: 'e1', source: 'n1', target: 'n2', label: 'calls', diff: 'unchanged' };
        const e2: GraphEdge = { id: 'e2', source: 'n1', target: 'n2', label: 'returns', diff: 'unchanged' };
        expect(stableEdgeTopologyKey(e1, nodeKeyMap)).toBe(stableEdgeTopologyKey(e2, nodeKeyMap));
        expect(stableEdgeKey(e1, nodeKeyMap)).not.toBe(stableEdgeKey(e2, nodeKeyMap));
    });

    it('anchorNodeKey returns empty string when anchor is missing', () => {
        const node: GraphNode = { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' };
        expect(anchorNodeKey(node)).toBe('');
    });

    it('anchorNodeKey returns non-empty string when anchor has filePath + symbol', () => {
        const node: GraphNode = {
            id: 'n1', type: 'function', label: 'foo', diff: 'unchanged',
            anchor: { filePath: 'auth/login.ts', symbol: 'handleLogin' },
        };
        expect(anchorNodeKey(node)).toBe('anchor:auth/login.ts::handleLogin');
    });

    it('should build node key map for a graph', () => {
        const graph: DiagramGraph = {
            graphId: 'test',
            type: 'file',
            nodes: [
                { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' },
                { id: 'n2', type: 'variable', label: 'bar', diff: 'unchanged' },
            ],
            edges: [],
            anchors: {},
            meta: {},
        };

        const map = buildNodeKeyMap(graph);
        expect(map.get('n1')).toBe('function:foo');
        expect(map.get('n2')).toBe('variable:bar');
    });
});

describe('graphDiff', () => {
    function makeGraph(nodes: GraphNode[], edges: GraphEdge[] = []): DiagramGraph {
        return { graphId: 'test', type: 'file', nodes, edges, anchors: {}, meta: {} };
    }

    it('should detect added nodes', () => {
        const baseline = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' },
        ]);
        const working = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' },
            { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);

        expect(result.stats.addedNodes).toBe(1);
        const addedNode = result.graph.nodes.find((n) => n.diff === 'added');
        expect(addedNode).toBeDefined();
        expect(addedNode!.label).toBe('bar');
    });

    it('should detect deleted nodes', () => {
        const baseline = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' },
            { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' },
        ]);
        const working = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);

        expect(result.stats.deletedNodes).toBe(1);
        const deletedNode = result.graph.nodes.find((n) => n.diff === 'deleted');
        expect(deletedNode).toBeDefined();
        expect(deletedNode!.label).toContain('bar');
    });

    it('should detect modified nodes', () => {
        const baseline = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', body: 'return 1', diff: 'unchanged' },
        ]);
        const working = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', body: 'return 2', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);

        expect(result.stats.modifiedNodes).toBe(1);
    });

    it('should detect unchanged nodes', () => {
        const baseline = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', body: 'return 1', diff: 'unchanged' },
        ]);
        const working = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', body: 'return 1', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);

        expect(result.stats.unchangedNodes).toBe(1);
    });

    it('should detect added edges', () => {
        const baseline = makeGraph(
            [{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }, { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' }],
            [],
        );
        const working = makeGraph(
            [{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }, { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' }],
            [{ id: 'e1', source: 'n1', target: 'n2', label: 'calls', diff: 'unchanged' }],
        );

        const result = diffGraphs(baseline, working);

        expect(result.stats.addedEdges).toBe(1);
    });

    it('should detect deleted edges', () => {
        const baseline = makeGraph(
            [{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }, { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' }],
            [{ id: 'e1', source: 'n1', target: 'n2', label: 'calls', diff: 'unchanged' }],
        );
        const working = makeGraph(
            [{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }, { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' }],
            [],
        );

        const result = diffGraphs(baseline, working);

        expect(result.stats.deletedEdges).toBe(1);
    });

    it('hasChanges should return true when there are changes', () => {
        const baseline = makeGraph([{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }]);
        const working = makeGraph([
            { id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' },
            { id: 'n2', type: 'function', label: 'bar', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);
        expect(hasChanges(result)).toBe(true);
    });

    it('hasChanges should return false when identical', () => {
        const baseline = makeGraph([{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }]);
        const working = makeGraph([{ id: 'n1', type: 'function', label: 'foo', diff: 'unchanged' }]);

        const result = diffGraphs(baseline, working);
        expect(hasChanges(result)).toBe(false);
    });

    it('should detect modified edges when label changes but topology is the same', () => {
        const nodes = [
            { id: 'n1', type: 'function' as const, label: 'foo', diff: 'unchanged' as const },
            { id: 'n2', type: 'function' as const, label: 'bar', diff: 'unchanged' as const },
        ];
        const baseline = makeGraph(nodes, [
            { id: 'e1', source: 'n1', target: 'n2', label: 'GET /old', diff: 'unchanged' },
        ]);
        const working = makeGraph(nodes, [
            { id: 'e1', source: 'n1', target: 'n2', label: 'POST /new', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);
        expect(result.stats.modifiedEdges).toBe(1);
        expect(result.stats.addedEdges).toBe(0);
        expect(result.stats.deletedEdges).toBe(0);
        expect(result.graph.edges[0]?.diff).toBe('modified');
    });

    it('should NOT report modified edge when source→target topology itself changes', () => {
        const nodes = [
            { id: 'n1', type: 'function' as const, label: 'foo', diff: 'unchanged' as const },
            { id: 'n2', type: 'function' as const, label: 'bar', diff: 'unchanged' as const },
            { id: 'n3', type: 'function' as const, label: 'baz', diff: 'unchanged' as const },
        ];
        const baseline = makeGraph(nodes, [
            { id: 'e1', source: 'n1', target: 'n2', label: 'calls', diff: 'unchanged' },
        ]);
        const working = makeGraph(nodes, [
            { id: 'e1', source: 'n1', target: 'n3', label: 'calls', diff: 'unchanged' },
        ]);

        const result = diffGraphs(baseline, working);
        expect(result.stats.deletedEdges).toBe(1);
        expect(result.stats.addedEdges).toBe(1);
    });

    it('should detect renamed node as modified (not delete+add) when anchor matches', () => {
        const baseline = makeGraph([{
            id: 'n1', type: 'function', label: 'handleLogin', diff: 'unchanged',
            anchor: { filePath: 'auth/login.ts', symbol: 'handleLogin' },
        }]);
        const working = makeGraph([{
            id: 'n1', type: 'function', label: 'loginHandler', diff: 'unchanged',
            anchor: { filePath: 'auth/login.ts', symbol: 'handleLogin' },
        }]);

        const result = diffGraphs(baseline, working);
        expect(result.stats.modifiedNodes).toBe(1);
        expect(result.stats.addedNodes).toBe(0);
        expect(result.stats.deletedNodes).toBe(0);

        const modNode = result.graph.nodes.find((n) => n.diff === 'modified');
        expect(modNode?.diffDetail?.deleted).toBe('handleLogin');
        expect(modNode?.diffDetail?.added).toBe('loginHandler');
    });

    it('should treat nodes without anchor as normal delete+add when label changes', () => {
        const baseline = makeGraph([{
            id: 'n1', type: 'function', label: 'foo', diff: 'unchanged',
        }]);
        const working = makeGraph([{
            id: 'n1', type: 'function', label: 'bar', diff: 'unchanged',
        }]);

        const result = diffGraphs(baseline, working);
        // No anchor → can't match → delete + add
        expect(result.stats.deletedNodes).toBe(1);
        expect(result.stats.addedNodes).toBe(1);
        expect(result.stats.modifiedNodes).toBe(0);
    });

    it('treats LLM cluster rename as unchanged on the L2a feature graph', () => {
        // Regression: the LLM naming pass swaps `cluster.name` from the raw
        // slug to a friendly label after baseline has already been snapshotted.
        // Using `clusterMembership` as the stable key (and ignoring label-only
        // changes for cluster nodes) keeps replay clean of phantom add/delete.
        const baseline = makeGraph([{
            id: 'c1', type: 'cluster', label: 'article', diff: 'unchanged',
            clusterMembership: 'cluster:article',
            subtitle: '«feature cluster» 4 files',
            body: '8 APIs · 72% cohesion',
        }]);
        const working = makeGraph([{
            id: 'c1', type: 'cluster', label: 'Article Management', diff: 'unchanged',
            clusterMembership: 'cluster:article',
            subtitle: '«feature cluster» 4 files',
            body: '8 APIs · 72% cohesion',
        }]);
        const result = diffGraphs(baseline, working);
        expect(result.stats.unchangedNodes).toBe(1);
        expect(result.stats.addedNodes).toBe(0);
        expect(result.stats.deletedNodes).toBe(0);
        expect(result.stats.modifiedNodes).toBe(0);
    });

    it('still flags cluster as modified when its body changes (file/api count)', () => {
        const baseline = makeGraph([{
            id: 'c1', type: 'cluster', label: 'article', diff: 'unchanged',
            clusterMembership: 'cluster:article',
            body: '8 APIs · 72% cohesion',
        }]);
        const working = makeGraph([{
            id: 'c1', type: 'cluster', label: 'Article Management', diff: 'unchanged',
            clusterMembership: 'cluster:article',
            body: '11 APIs · 75% cohesion',
        }]);
        const result = diffGraphs(baseline, working);
        expect(result.stats.modifiedNodes).toBe(1);
        expect(result.stats.addedNodes).toBe(0);
        expect(result.stats.deletedNodes).toBe(0);
    });

    it('treats LLM service rename as unchanged on the L1 system graph', () => {
        const baseline = makeGraph([{
            id: 's1', type: 'service', label: 'main', diff: 'unchanged',
            serviceId: 'service:main',
            body: '25 APIs exposed',
        }]);
        const working = makeGraph([{
            id: 's1', type: 'service', label: 'Express API', diff: 'unchanged',
            serviceId: 'service:main',
            body: '25 APIs exposed',
        }]);
        const result = diffGraphs(baseline, working);
        expect(result.stats.unchangedNodes).toBe(1);
        expect(result.stats.modifiedNodes).toBe(0);
    });
});
