import { describe, it, expect } from 'vitest';
import { analyzeImpact } from '../impactAnalyzer';
import { WorkspaceCallGraph, CALL_GRAPH_VERSION } from '../../graph/callGraphResolver';
import type { Snapshot, FileRecord } from '../../graph/graphTypes';

function makeSnapshot(
    filePaths: string[],
    callGraph?: WorkspaceCallGraph
): Snapshot {
    const files: Record<string, FileRecord> = {};
    for (const fp of filePaths) {
        files[fp] = {
            content: '',
            symbols: { functions: [], vars: [], imports: [] },
            lastModified: 0,
        };
    }
    const serialized = callGraph?.serialize();
    return { files, apiIndex: {}, graphs: {}, callGraph: serialized };
}

// The optional tuple element is parenthesised deliberately. Written as
// `'calls' | 'imports'?` the `?` binds to `'imports'` alone, which sends
// TypeScript down its JSDoc-nullable parse path and makes CodeQL's extractor
// fail the whole file with "Unsupported TypeScript syntax JSDocNullableType".
// The resulting type is identical; only the parse differs.
function buildGraph(edges: Array<[string, string, number?, ('calls' | 'imports')?]>): WorkspaceCallGraph {
    const graph = new WorkspaceCallGraph();
    const seen = new Set<string>();
    for (const [caller, callee] of edges) {
        const [cf, cn] = caller.split('::');
        const [tf, tn] = callee.split('::');
        if (cf && cn && !seen.has(caller)) { graph.ensureNode(cf, cn); seen.add(caller); }
        if (tf && tn && !seen.has(callee)) { graph.ensureNode(tf, tn); seen.add(callee); }
    }
    for (const [caller, callee, confidence = 0.9, kind = 'calls'] of edges) {
        graph.addEdge(caller, callee, confidence, kind);
    }
    return graph;
}

describe('analyzeImpact — basic', () => {
    it('returns empty result for no changed files', () => {
        const snap = makeSnapshot([]);
        const result = analyzeImpact([], snap);
        expect(result.changedFiles).toHaveLength(0);
        expect(result.impactedFunctions).toHaveLength(0);
    });

    it('includes changed files in result', () => {
        const snap = makeSnapshot(['auth/login.ts']);
        const result = analyzeImpact(['auth/login.ts'], snap);
        expect(result.changedFiles).toContain('auth/login.ts');
    });

    it('finds direct callers at depth 1', () => {
        const cg = buildGraph([['api/routes.ts::handler', 'auth/login.ts::authenticate']]);
        const snap = makeSnapshot(['auth/login.ts', 'api/routes.ts'], cg);
        const result = analyzeImpact(['auth/login.ts'], snap);
        const direct = result.impactedFunctions.filter((f) => f.depth === 1);
        expect(direct.map((f) => f.key)).toContain('api/routes.ts::handler');
    });

    it('finds transitive callers at depth > 1', () => {
        const cg = buildGraph([
            ['b.ts::b', 'a.ts::a'],
            ['c.ts::c', 'b.ts::b'],
        ]);
        const snap = makeSnapshot(['a.ts', 'b.ts', 'c.ts'], cg);
        const result = analyzeImpact(['a.ts'], snap);
        const transitive = result.impactedFunctions.filter((f) => f.depth > 1);
        expect(transitive.map((f) => f.key)).toContain('c.ts::c');
    });

    it('summary counts direct and transitive separately', () => {
        const cg = buildGraph([
            ['b.ts::b', 'a.ts::a'],
            ['c.ts::c', 'b.ts::b'],
        ]);
        const snap = makeSnapshot(['a.ts', 'b.ts', 'c.ts'], cg);
        const result = analyzeImpact(['a.ts'], snap);
        // directImpacts = functions in the changed file (a.ts::a)
        expect(result.summary.directImpacts).toBe(1);
        // transitiveImpacts = all call-path callers (b.ts::b depth 1 + c.ts::c depth 2)
        expect(result.summary.transitiveImpacts).toBe(2);
    });

    it('exposes options in result', () => {
        const snap = makeSnapshot([]);
        const result = analyzeImpact([], snap, { maxDepth: 2, minConfidence: 0.5 });
        expect(result.options.maxDepth).toBe(2);
        expect(result.options.minConfidence).toBe(0.5);
    });

    it('backwards compat: accepts maxDepth as plain number', () => {
        const snap = makeSnapshot([]);
        const result = analyzeImpact([], snap, 3);
        expect(result.options.maxDepth).toBe(3);
    });
});

describe('analyzeImpact — minConfidence filtering', () => {
    it('excludes low-confidence callers when minConfidence is set', () => {
        const cg = buildGraph([
            ['high.ts::fn', 'target.ts::fn', 0.9, 'calls'],
            ['low.ts::fn', 'target.ts::fn', 0.3, 'calls'],
        ]);
        const snap = makeSnapshot(['target.ts', 'high.ts', 'low.ts'], cg);
        const result = analyzeImpact(['target.ts'], snap, { minConfidence: 0.8 });
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).toContain('high.ts::fn');
        expect(keys).not.toContain('low.ts::fn');
    });

    it('includes all callers when minConfidence is 0 (default)', () => {
        const cg = buildGraph([
            ['high.ts::fn', 'target.ts::fn', 0.9, 'calls'],
            ['low.ts::fn', 'target.ts::fn', 0.3, 'calls'],
        ]);
        const snap = makeSnapshot(['target.ts', 'high.ts', 'low.ts'], cg);
        const result = analyzeImpact(['target.ts'], snap);
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).toContain('high.ts::fn');
        expect(keys).toContain('low.ts::fn');
    });

    it('attaches edgeConfidence to impacted functions when filtering', () => {
        const cg = buildGraph([
            ['caller.ts::fn', 'target.ts::fn', 0.75, 'calls'],
        ]);
        const snap = makeSnapshot(['target.ts', 'caller.ts'], cg);
        const result = analyzeImpact(['target.ts'], snap, { minConfidence: 0.5 });
        const fn = result.impactedFunctions.find((f) => f.key === 'caller.ts::fn');
        expect(fn?.edgeConfidence).toBe(0.75);
    });
});

describe('analyzeImpact — relationTypes filtering', () => {
    it('only follows "calls" edges when relationTypes=["calls"]', () => {
        const cg = buildGraph([
            ['a.ts::fn', 'target.ts::fn', 0.9, 'calls'],
            ['b.ts::fn', 'target.ts::fn', 0.9, 'imports'],
        ]);
        const snap = makeSnapshot(['target.ts', 'a.ts', 'b.ts'], cg);
        const result = analyzeImpact(['target.ts'], snap, { relationTypes: ['calls'] });
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).toContain('a.ts::fn');
        expect(keys).not.toContain('b.ts::fn');
    });

    it('only follows "imports" edges when relationTypes=["imports"]', () => {
        const cg = buildGraph([
            ['a.ts::fn', 'target.ts::fn', 0.9, 'calls'],
            ['b.ts::fn', 'target.ts::fn', 0.9, 'imports'],
        ]);
        const snap = makeSnapshot(['target.ts', 'a.ts', 'b.ts'], cg);
        const result = analyzeImpact(['target.ts'], snap, { relationTypes: ['imports'] });
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).not.toContain('a.ts::fn');
        expect(keys).toContain('b.ts::fn');
    });
});

describe('analyzeImpact — includeTests filtering', () => {
    it('excludes test files when includeTests=false', () => {
        const cg = buildGraph([
            ['src/__tests__/login.test.ts::it', 'auth/login.ts::authenticate'],
            ['api/routes.ts::handler', 'auth/login.ts::authenticate'],
        ]);
        const snap = makeSnapshot(['auth/login.ts', 'src/__tests__/login.test.ts', 'api/routes.ts'], cg);
        const result = analyzeImpact(['auth/login.ts'], snap, { includeTests: false });
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).not.toContain('src/__tests__/login.test.ts::it');
        expect(keys).toContain('api/routes.ts::handler');
    });

    it('includes test files when includeTests=true (default)', () => {
        const cg = buildGraph([
            ['src/__tests__/login.test.ts::it', 'auth/login.ts::authenticate'],
        ]);
        const snap = makeSnapshot(['auth/login.ts', 'src/__tests__/login.test.ts'], cg);
        const result = analyzeImpact(['auth/login.ts'], snap);
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).toContain('src/__tests__/login.test.ts::it');
    });
});

describe('analyzeImpact — maxDepth', () => {
    it('stops traversal at maxDepth', () => {
        const cg = buildGraph([
            ['b.ts::b', 'a.ts::a'],
            ['c.ts::c', 'b.ts::b'],
            ['d.ts::d', 'c.ts::c'],
        ]);
        const snap = makeSnapshot(['a.ts', 'b.ts', 'c.ts', 'd.ts'], cg);
        const result = analyzeImpact(['a.ts'], snap, { maxDepth: 2 });
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(keys).toContain('b.ts::b');
        expect(keys).toContain('c.ts::c');
        expect(keys).not.toContain('d.ts::d');
    });
});

describe('analyzeImpact — impactKind', () => {
    it('changed file\'s own functions get impactKind: direct', () => {
        const cg = buildGraph([['b.ts::b', 'a.ts::a']]);
        const snap = makeSnapshot(['a.ts', 'b.ts'], cg);
        const result = analyzeImpact(['a.ts'], snap);
        const fn = result.impactedFunctions.find((f) => f.key === 'a.ts::a');
        expect(fn?.impactKind).toBe('direct');
        expect(fn?.depth).toBe(0);
    });

    it('BFS-impacted callers get impactKind: transitive', () => {
        const cg = buildGraph([
            ['b.ts::b', 'a.ts::a'],
            ['c.ts::c', 'b.ts::b'],
        ]);
        const snap = makeSnapshot(['a.ts', 'b.ts', 'c.ts'], cg);
        const result = analyzeImpact(['a.ts'], snap);
        const b = result.impactedFunctions.find((f) => f.key === 'b.ts::b');
        const c = result.impactedFunctions.find((f) => f.key === 'c.ts::c');
        expect(b?.impactKind).toBe('transitive');
        expect(c?.impactKind).toBe('transitive');
    });

    it('leaf function with no callers returns only direct entries', () => {
        const cg = buildGraph([]);
        cg.ensureNode('leaf.ts', 'fn');
        const snap = makeSnapshot(['leaf.ts'], cg);
        const result = analyzeImpact(['leaf.ts'], snap);
        const kinds = result.impactedFunctions.map((f) => f.impactKind);
        expect(kinds.every((k) => k === 'direct')).toBe(true);
        expect(result.summary.transitiveImpacts).toBe(0);
        expect(result.summary.reviewRequired).toBe(0);
    });

    it('import-only dependents get impactKind: review-required', () => {
        const dummySpan = { start: 0, end: 0 };
        // b.ts imports from a.ts but has no call-graph edge to it
        const cg = buildGraph([]);
        cg.ensureNode('a.ts', 'foo');
        cg.ensureNode('b.ts', 'bar'); // has no edge to a.ts in call graph
        const snap: any = {
            files: {
                'a.ts': { content: '', symbols: { functions: [{ name: 'foo' }], variables: [], imports: [] }, hash: 'h1', mtime: 0 },
                'b.ts': {
                    content: '',
                    hash: 'h2',
                    mtime: 0,
                    symbols: {
                        functions: [{ name: 'bar' }],
                        variables: [],
                        imports: [{ source: './a', specifiers: [], span: dummySpan, stableKey: 'i1' }],
                    },
                },
            },
            apiIndex: {},
            graphs: {},
            callGraph: cg.serialize(),
        };
        const result = analyzeImpact(['a.ts'], snap);
        const b = result.impactedFunctions.find((f) => f.key === 'b.ts::bar');
        expect(b?.impactKind).toBe('review-required');
        expect(result.summary.reviewRequired).toBe(1);
    });

    it('running blast radius twice does not duplicate entries', () => {
        const cg = buildGraph([['b.ts::b', 'a.ts::a']]);
        const snap = makeSnapshot(['a.ts', 'b.ts'], cg);
        const result1 = analyzeImpact(['a.ts'], snap);
        const result2 = analyzeImpact(['a.ts'], snap);
        const keys1 = result1.impactedFunctions.map((f) => f.key);
        const keys2 = result2.impactedFunctions.map((f) => f.key);
        expect(new Set(keys1).size).toBe(keys1.length);
        expect(keys1).toEqual(keys2);
    });

    it('review-required entries excluded from transitive', () => {
        const dummySpan = { start: 0, end: 0 };
        const cg = buildGraph([['b.ts::caller', 'a.ts::changed']]);
        cg.ensureNode('c.ts', 'importer'); // c.ts imports a.ts but no call edge
        const snap: any = {
            files: {
                'a.ts': { content: '', symbols: { functions: [{ name: 'changed' }], variables: [], imports: [] }, hash: 'h1', mtime: 0 },
                'b.ts': { content: '', symbols: { functions: [{ name: 'caller' }], variables: [], imports: [] }, hash: 'h2', mtime: 0 },
                'c.ts': {
                    content: '',
                    hash: 'h3',
                    mtime: 0,
                    symbols: {
                        functions: [{ name: 'importer' }],
                        variables: [],
                        imports: [{ source: './a', specifiers: [], span: dummySpan, stableKey: 'i1' }],
                    },
                },
            },
            apiIndex: {},
            graphs: {},
            callGraph: cg.serialize(),
        };
        const result = analyzeImpact(['a.ts'], snap);
        const bFn = result.impactedFunctions.find((f) => f.key === 'b.ts::caller');
        const cFn = result.impactedFunctions.find((f) => f.key === 'c.ts::importer');
        expect(bFn?.impactKind).toBe('transitive');
        expect(cFn?.impactKind).toBe('review-required');
        // No overlap
        const keys = result.impactedFunctions.map((f) => f.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
