/**
 * graphMatchers.ts — Issue #389
 *
 * Fluent matcher for `DiagramGraph` assertions inside T3 scenarios.
 * Replaces ad-hoc `graph.nodes.filter(n => n.diff && n.diff !== 'unchanged').map(...)`
 * boilerplate that repeats across every scenario file.
 *
 * Usage:
 *
 *     expectGraph(workingGraph)
 *         .hasModifiedFunctions(['getCurrentUser'])
 *         .hasUnchangedFunctions(['createUser', 'login', 'updateUser'])
 *         .hasFileRootDiff('modified')
 *         .hasSectionLabel(/^Functions \(1 changed \+ 4\)$/)
 *         .done();
 *
 * Each chainable method runs an `expect(...)` internally so failures
 * surface at the matcher line in jest/vitest output. The terminal
 * `.done()` is a no-op for readability — the assertions have already
 * fired.
 */

import { expect } from 'vitest';
import type { DiagramGraph } from '../../src/core/graph/graphTypes';

/** Subset of node-type strings the matcher recognises. */
type NodeType = 'file' | 'function' | 'section' | string;

class GraphAssertion {
    constructor(private readonly graph: DiagramGraph | undefined, private readonly description: string) {
        expect(this.graph, `${this.description}: graph must be defined`).toBeDefined();
    }

    /** Function-node labels (sorted) that have a non-`unchanged` diff. */
    private modifiedLabels(type: NodeType): string[] {
        return (this.graph!.nodes ?? [])
            .filter(n => n.type === type && n.diff && n.diff !== 'unchanged')
            .map(n => (n.label as string) ?? '')
            .sort();
    }

    private unchangedLabels(type: NodeType): string[] {
        return (this.graph!.nodes ?? [])
            .filter(n => n.type === type && (!n.diff || n.diff === 'unchanged'))
            .map(n => (n.label as string) ?? '')
            .sort();
    }

    /** Assert the modified-function-label set equals `labels` (sorted). */
    hasModifiedFunctions(labels: string[]): this {
        const observed = this.modifiedLabels('function');
        expect(observed, `${this.description}: modified function labels`).toEqual(labels.slice().sort());
        return this;
    }

    /** Assert each of `labels` is present and unchanged. */
    hasUnchangedFunctions(labels: string[]): this {
        const observed = this.unchangedLabels('function');
        for (const l of labels) {
            expect(observed, `${this.description}: ${l} should be unchanged`).toContain(l);
        }
        return this;
    }

    /** Assert the count of nodes whose `diff` is not `unchanged`. */
    hasModifiedCount(type: NodeType, n: number): this {
        const observed = (this.graph!.nodes ?? [])
            .filter(node => node.type === type && node.diff && node.diff !== 'unchanged').length;
        expect(observed, `${this.description}: ${type} modified count`).toBe(n);
        return this;
    }

    /** Assert the count of nodes with a specific diff status. */
    hasDiffStatusCount(type: NodeType, status: 'added' | 'deleted' | 'modified' | 'unchanged', n: number): this {
        const observed = (this.graph!.nodes ?? [])
            .filter(node => node.type === type && (node.diff ?? 'unchanged') === status).length;
        expect(observed, `${this.description}: ${type} ${status} count`).toBe(n);
        return this;
    }

    /** Assert the `file`-type root node has the given diff. */
    hasFileRootDiff(diff: 'added' | 'deleted' | 'modified' | 'unchanged'): this {
        const root = (this.graph!.nodes ?? []).find(n => n.type === 'file');
        expect(root, `${this.description}: file root node must exist`).toBeDefined();
        expect(root!.diff ?? 'unchanged', `${this.description}: file root diff`).toBe(diff);
        return this;
    }

    /** Assert there's a section-type node whose label matches the regex/string. */
    hasSectionLabel(matcher: RegExp | string): this {
        const sections = (this.graph!.nodes ?? []).filter(n => n.type === 'section');
        const labels = sections.map(s => (s.label as string) ?? '');
        const ok = labels.some(l => typeof matcher === 'string' ? l === matcher : matcher.test(l));
        expect(ok, `${this.description}: section labels ${JSON.stringify(labels)} should include ${matcher}`).toBe(true);
        return this;
    }

    /** Assert ZERO entity nodes (function/class etc) are modified — used by clean-state checks. */
    hasNoEntityModifications(): this {
        const dirty = (this.graph!.nodes ?? []).filter(
            n => n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged',
        );
        expect(dirty.map(n => n.label), `${this.description}: expected no entity modifications`).toEqual([]);
        return this;
    }

    /** Terminal no-op for readability — assertions fire as the chain runs. */
    done(): void {
        // intentionally empty
    }
}

/** Entry point: returns a fluent assertion over a graph. */
export function expectGraph(graph: DiagramGraph | undefined, description: string = 'graph'): GraphAssertion {
    return new GraphAssertion(graph, description);
}
