/**
 * pathFinder.test.ts — Issue #707 BFS path-finder tests.
 *
 * Synthetic mini call graphs prove the BFS picks the shortest path,
 * honors the depth cap, returns the trivial result for `from === to`,
 * and respects the confidence filter.
 */

import { describe, it, expect } from 'vitest';
import { findCallPath } from '../pathFinder';
import type { SerializedCallGraph, SerializedCallGraphNode } from '../../graph/graphTypes';

function node(key: string, calls: string[]): SerializedCallGraphNode {
    return {
        key,
        filePath: key.split('::')[0],
        functionName: key.split('::')[1],
        calls,
        calledBy: [],
    };
}

function buildGraph(nodes: SerializedCallGraphNode[]): SerializedCallGraph {
    const out: SerializedCallGraph = { nodes: {}, edges: [], version: 1 };
    for (const n of nodes) {
        out.nodes[n.key] = n;
        for (const callee of n.calls) {
            out.edges.push({ callerKey: n.key, calleeKey: callee, confidence: 1, kind: 'invoke' });
        }
    }
    return out;
}

describe('findCallPath', () => {
    it('returns the trivial single-node path when from === to', () => {
        const g = buildGraph([node('a.ts::foo', [])]);
        const r = findCallPath(g, 'a.ts::foo', 'a.ts::foo');
        expect(r.found).toBe(true);
        expect(r.path).toEqual(['a.ts::foo']);
        expect(r.cost).toBe(0);
    });

    it('finds a direct A → B path', () => {
        const g = buildGraph([
            node('a.ts::foo', ['b.ts::bar']),
            node('b.ts::bar', []),
        ]);
        const r = findCallPath(g, 'a.ts::foo', 'b.ts::bar');
        expect(r.found).toBe(true);
        expect(r.path).toEqual(['a.ts::foo', 'b.ts::bar']);
        expect(r.cost).toBe(1);
    });

    it('finds a 3-hop transitive path', () => {
        const g = buildGraph([
            node('a.ts::foo', ['b.ts::bar']),
            node('b.ts::bar', ['c.ts::baz']),
            node('c.ts::baz', ['d.ts::qux']),
            node('d.ts::qux', []),
        ]);
        const r = findCallPath(g, 'a.ts::foo', 'd.ts::qux');
        expect(r.found).toBe(true);
        expect(r.path).toEqual(['a.ts::foo', 'b.ts::bar', 'c.ts::baz', 'd.ts::qux']);
        expect(r.cost).toBe(3);
    });

    it('returns the SHORTEST path when multiple paths exist', () => {
        const g = buildGraph([
            // Two paths from foo → qux: foo→bar→qux (2 hops) and foo→a→b→c→qux (4 hops).
            node('a.ts::foo', ['b.ts::bar', 'a.ts::a']),
            node('b.ts::bar', ['d.ts::qux']),
            node('a.ts::a', ['a.ts::b']),
            node('a.ts::b', ['a.ts::c']),
            node('a.ts::c', ['d.ts::qux']),
            node('d.ts::qux', []),
        ]);
        const r = findCallPath(g, 'a.ts::foo', 'd.ts::qux');
        expect(r.found).toBe(true);
        expect(r.path).toEqual(['a.ts::foo', 'b.ts::bar', 'd.ts::qux']);
        expect(r.cost).toBe(2);
    });

    it('returns found=false when no path exists', () => {
        const g = buildGraph([
            node('a.ts::foo', []),
            node('b.ts::bar', []),
        ]);
        const r = findCallPath(g, 'a.ts::foo', 'b.ts::bar');
        expect(r.found).toBe(false);
        expect(r.path).toBeUndefined();
    });

    it('respects the maxDepth hop cap', () => {
        // 5-hop chain, cap at 3 → no path.
        const g = buildGraph([
            node('a::1', ['a::2']),
            node('a::2', ['a::3']),
            node('a::3', ['a::4']),
            node('a::4', ['a::5']),
            node('a::5', ['a::6']),
            node('a::6', []),
        ]);
        const r = findCallPath(g, 'a::1', 'a::6', { maxDepth: 3 });
        expect(r.found).toBe(false);
    });

    it('returns found=false when either endpoint is missing', () => {
        const g = buildGraph([node('a::1', [])]);
        expect(findCallPath(g, 'a::1', 'missing::node').found).toBe(false);
        expect(findCallPath(g, 'missing::node', 'a::1').found).toBe(false);
    });

    it('honors minConfidence by dropping low-confidence edges', () => {
        // Build a graph with the SHORT path going through a low-confidence edge.
        const lowConfNode: SerializedCallGraphNode = {
            key: 'a::1',
            filePath: 'a',
            functionName: '1',
            calls: ['a::low', 'a::2'],
            calledBy: [],
            callEdges: [
                { key: 'a::low', confidence: 0.3, kind: 'invoke' },
                { key: 'a::2', confidence: 0.9, kind: 'invoke' },
            ],
        };
        const g: SerializedCallGraph = {
            nodes: {
                'a::1': lowConfNode,
                'a::low': node('a::low', ['a::target']),
                'a::2': node('a::2', ['a::3']),
                'a::3': node('a::3', ['a::target']),
                'a::target': node('a::target', []),
            },
            edges: [],
            version: 1,
        };
        // With no filter: shortest is 2 hops via a::low.
        const noFilter = findCallPath(g, 'a::1', 'a::target');
        expect(noFilter.path).toEqual(['a::1', 'a::low', 'a::target']);
        // With 0.5 minimum confidence: a::low edge is skipped, longer path wins.
        const filtered = findCallPath(g, 'a::1', 'a::target', { minConfidence: 0.5 });
        expect(filtered.found).toBe(true);
        expect(filtered.path).toEqual(['a::1', 'a::2', 'a::3', 'a::target']);
    });

    it('includes per-edge confidences along the returned path', () => {
        const callEdges = [{ key: 'a::2', confidence: 0.85, kind: 'invoke' as const }];
        const g: SerializedCallGraph = {
            nodes: {
                'a::1': { key: 'a::1', filePath: 'a', functionName: '1', calls: ['a::2'], calledBy: [], callEdges },
                'a::2': node('a::2', []),
            },
            edges: [],
            version: 1,
        };
        const r = findCallPath(g, 'a::1', 'a::2');
        expect(r.confidences).toEqual([0.85]);
    });
});
