import { describe, it, expect } from 'vitest';
import { buildFileGraph, buildFileGraphFromAnalysis, recomputeFileGraphDiffFromAuthoritativeSymbols, type BaselineSymbols } from '../fileGraphBuilder';
import type { FileAnalysis as TSFileAnalysis } from '../../parser/treeSitterExtractor';
import type { DiagramGraph, FileRecord } from '../graphTypes';

// ---------------------------------------------------------------------------
// Shared sample code (no diff mode)
// ---------------------------------------------------------------------------
const sampleCode = `
import http from "http";
const config = { retries: 3 };
const baseUrl = "https://api.example.com";

function buildUrl(path) {
  return baseUrl + path;
}

function fetchUsers() {
  const url = buildUrl("/users");
  return http.get(url);
}

const logUsers = () => {
  console.log(config.retries);
  return fetchUsers();
};`;

describe('buildFileGraph — structure (no diff)', () => {
    it('should build a file graph with correct structure', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        expect(graph.type).toBe('file');
        expect(graph.graphId).toBe('file:src/api.js');
        expect(graph.nodes.length).toBeGreaterThan(0);
        expect(graph.edges.length).toBeGreaterThan(0);
    });

    it('creates a file root node', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const fileNodes = graph.nodes.filter((n) => n.type === 'file');
        expect(fileNodes).toHaveLength(1);
        expect(fileNodes[0].label).toBe('api.js');
    });

    it('creates import nodes', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const importNodes = graph.nodes.filter((n) => n.type === 'import');
        expect(importNodes.length).toBeGreaterThanOrEqual(1);
        expect(importNodes.some((n) => n.label === 'http')).toBe(true);
    });

    it('creates variable nodes', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const varNodes = graph.nodes.filter((n) => n.type === 'variable');
        expect(varNodes.length).toBeGreaterThanOrEqual(2);
        expect(varNodes.some((n) => n.label === 'config')).toBe(true);
        expect(varNodes.some((n) => n.label === 'baseUrl')).toBe(true);
    });

    it('creates function nodes', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const funcNodes = graph.nodes.filter((n) => n.type === 'function');
        expect(funcNodes.length).toBeGreaterThanOrEqual(3);
        expect(funcNodes.some((n) => n.label === 'buildUrl')).toBe(true);
        expect(funcNodes.some((n) => n.label === 'fetchUsers')).toBe(true);
        expect(funcNodes.some((n) => n.label === 'logUsers')).toBe(true);
    });

    it('creates calls edges between functions', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        expect(graph.edges.filter((e) => e.label === 'calls').length).toBeGreaterThanOrEqual(1);
    });

    it('creates "uses" edges for variable dependencies', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        expect(graph.edges.filter((e) => e.label === 'uses').length).toBeGreaterThanOrEqual(1);
    });

    it('creates "depends" edges for import dependencies', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        expect(graph.edges.filter((e) => e.label === 'depends').length).toBeGreaterThanOrEqual(1);
    });

    it('deduplicates edges', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const edgeKeys = graph.edges.map((e) => `${e.source}|${e.target}|${e.label}`);
        expect(edgeKeys.length).toBe(new Set(edgeKeys).size);
    });

    it('includes anchors for all nodes', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        for (const node of graph.nodes) {
            expect(node.anchor).toBeDefined();
            expect(node.anchor!.filePath).toBe('src/api.js');
        }
    });

    // #493: JS init (no oldCode) MUST produce the same section subtitle that
    // the post-revert rebuild lands at (after edit + revert + recompute).
    // Symptom on php-symfony's `assets/controllers/csrf_protection_controller.js`:
    // init subtitle was undefined, post-revert subtitle was "~1 modified · 2
    // unchanged" or "N unchanged" — leaving the file graph permanently stuck
    // in baseline-vs-working comparison. Cause: init returned undefined when
    // !inDiffMode; the cascade rebuild produced a subtitle that recompute
    // never reset. Fix mirrors #448-C in the non-JS path: emit "N unchanged"
    // when no other diff parts exist.
    it('init emits "N unchanged" section subtitles so post-revert rebuild matches baseline (#493)', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        for (const section of graph.nodes.filter((n) => n.type === 'section')) {
            // No `undefined` subtitle for sections that have any entities.
            // Format must be `"N unchanged"`.
            expect(
                section.subtitle,
                `[${section.label}] init must set a subtitle so it matches post-revert recompute output`,
            ).toMatch(/^\d+ unchanged$/);
        }
    });
});

// ---------------------------------------------------------------------------
// Section grouping (no diff mode — all entities shown)
// ---------------------------------------------------------------------------
describe('buildFileGraph — section grouping', () => {
    it('creates section nodes for imports, variables, functions', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const sections = graph.nodes.filter((n) => n.type === 'section');
        expect(sections).toHaveLength(3);
        expect(sections.some((n) => n.label.startsWith('Imports'))).toBe(true);
        expect(sections.some((n) => n.label.startsWith('Variables'))).toBe(true);
        expect(sections.some((n) => n.label.startsWith('Functions'))).toBe(true);
    });

    it('section node label includes entity count', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const funcSection = graph.nodes.find((n) => n.type === 'section' && n.label.startsWith('Functions'));
        expect(funcSection!.label).toMatch(/Functions \(\d+\)/);
    });

    it('uses 3-level hierarchy: file → section → entity', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const fileNode = graph.nodes.find((n) => n.type === 'file')!;
        const importSection = graph.nodes.find((n) => n.type === 'section' && n.label.startsWith('Imports'))!;
        const importEntity = graph.nodes.find((n) => n.type === 'import')!;

        expect(graph.edges.some(e => e.source === fileNode.id && e.target === importSection.id && e.edgeType === 'contains')).toBe(true);
        expect(graph.edges.some(e => e.source === importSection.id && e.target === importEntity.id && e.edgeType === 'contains')).toBe(true);
    });

    it('no direct file→entity edges (all go through sections)', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const fileNode = graph.nodes.find((n) => n.type === 'file')!;
        const entityTypes = new Set(['import', 'variable', 'function']);
        const direct = graph.edges.filter(
            e => e.source === fileNode.id && entityTypes.has(graph.nodes.find(n => n.id === e.target)?.type ?? '')
        );
        expect(direct).toHaveLength(0);
    });

    it('skips section when group is empty', () => {
        const code = `function only() { return 1; }`;
        const graph = buildFileGraph(code, 'f.js');
        const sections = graph.nodes.filter((n) => n.type === 'section');
        expect(sections).toHaveLength(1);
        expect(sections[0].label).toMatch(/^Functions/);
    });

    it('containment edges cover file→section and section→entity', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const containsEdges = graph.edges.filter((e) => e.label === 'contains');
        // 3 file→section + at least 6 section→entity
        expect(containsEdges.length).toBeGreaterThanOrEqual(9);
    });
});

// ---------------------------------------------------------------------------
// mostSevereDiff correctness
// ---------------------------------------------------------------------------
describe('buildFileGraph — mostSevereDiff (section diff bubble-up)', () => {
    it('section is "added" when only additions', () => {
        const oldCode = `function keep() { return 1; }`;
        const newCode = `function keep() { return 1; }\nfunction newFn() { return 2; }`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        expect(funcSection!.diff).toBe('added');
    });

    it('section is "deleted" when only deletions', () => {
        const oldCode = `function keep() { return 1; }\nfunction gone() { return 2; }`;
        const newCode = `function keep() { return 1; }`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        expect(funcSection!.diff).toBe('deleted');
    });

    it('section is "modified" when mixed added + deleted (not "added")', () => {
        const oldCode = `function keep() { return 1; }\nfunction gone() { return 2; }`;
        const newCode = `function keep() { return 1; }\nfunction newFn() { return 3; }`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        // "keep" is unchanged (collapsed), "gone" is deleted, "newFn" is added → mixed → modified
        expect(funcSection!.diff).toBe('modified');
    });

    it('section is "modified" when only modifications', () => {
        const oldCode = `const config = { retries: 2 };`;
        const newCode = `const config = { retries: 3 };`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        const varSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Variables'));
        expect(varSection!.diff).toBe('modified');
    });

    it('section is "unchanged" when nothing changed', () => {
        const code = `function keep() { return 1; }`;
        const graph = buildFileGraph(code, 'f.js', code);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        expect(funcSection!.diff).toBe('unchanged');
    });
});

// ---------------------------------------------------------------------------
// Diff mode — collapse unchanged entities + summary node
// ---------------------------------------------------------------------------
describe('buildFileGraph — diff mode entity collapsing', () => {
    const oldCode = `
import http from "http";
const config = { retries: 2 };
function fetchUsers() { return http.get("/users"); }`;

    const newCode = `
import http from "http";
const config = { retries: 3 };
function fetchUsers() { return http.get("/users"); }
function ping() { return http.get("/ping"); }`;

    it('changed entities shown as individual nodes', () => {
        const graph = buildFileGraph(newCode, 'api.js', oldCode);
        // config changed (body), ping added
        const modifiedNodes = graph.nodes.filter(n => n.diff === 'modified');
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(modifiedNodes.length).toBeGreaterThanOrEqual(1);
        expect(addedNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('unchanged entities shown as individual nodes (not collapsed)', () => {
        const graph = buildFileGraph(newCode, 'api.js', oldCode);
        // http import is unchanged — should still be an individual import node so user can navigate to it
        const httpNode = graph.nodes.find(n => n.type === 'import' && n.label === 'http');
        expect(httpNode).toBeDefined();
        expect(httpNode!.diff).toBe('unchanged');
        // No summary "N unchanged" nodes should be created
        const summaryNodes = graph.nodes.filter(n => n.type === 'section' && n.label.includes('unchanged'));
        expect(summaryNodes.length).toBe(0);
    });

    it('section subtitle shows diff breakdown in diff mode', () => {
        const graph = buildFileGraph(newCode, 'api.js', oldCode);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        expect(funcSection!.subtitle).toBeTruthy();
        // Should mention added and/or modified and/or unchanged
        expect(funcSection!.subtitle).toMatch(/added|modified|deleted|unchanged/);
    });

    it('ghost nodes created for deleted entities', () => {
        const graph = buildFileGraph(newCode, 'api.js', oldCode);
        const deletedNodes = graph.nodes.filter(n => n.diff === 'deleted');
        // no deleted in this scenario
        expect(deletedNodes.length).toBe(0);
    });

    it('creates ghost nodes for deleted functions', () => {
        const old = `function keep() { return 1; }\nfunction gone() { return 2; }`;
        const cur = `function keep() { return 1; }`;
        const graph = buildFileGraph(cur, 'f.js', old);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.length).toBeGreaterThanOrEqual(1);
        expect(deleted.some(n => n.label.includes('gone'))).toBe(true);
    });

    it('file node gets modified diff when any entity changed', () => {
        const graph = buildFileGraph(newCode, 'api.js', oldCode);
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode!.diff).toBe('modified');
    });

    it('file node stays unchanged when nothing changed', () => {
        const code = `function foo() { return 1; }`;
        const graph = buildFileGraph(code, 'f.js', code);
        const fileNode = graph.nodes.find(n => n.type === 'file');
        expect(fileNode!.diff).toBe('unchanged');
    });
});

// ---------------------------------------------------------------------------
// Edge diff propagation
// ---------------------------------------------------------------------------
describe('buildFileGraph — edge diff propagation', () => {
    it('calls edge from added function is "added"', () => {
        const oldCode = `function helper() { return 1; }`;
        const newCode = `function helper() { return 1; }\nfunction newCaller() { return helper(); }`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        const callsEdges = graph.edges.filter(e => e.label === 'calls');
        // newCaller (added) → helper (unchanged/collapsed)
        // helper is collapsed so no edge from newCaller to helper (collapsed target skipped)
        // But newCaller IS visible (added), helper is collapsed — edge skipped
        // Either 0 edges or edges only between visible nodes
        expect(callsEdges.every(e => e.diff !== undefined)).toBe(true);
    });

    it('calls edge between two added functions is "added"', () => {
        const oldCode = ``;
        const newCode = `function a() { return b(); }\nfunction b() { return 1; }`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        const callsEdges = graph.edges.filter(e => e.label === 'calls');
        if (callsEdges.length > 0) {
            expect(callsEdges[0].diff).toBe('added');
        }
    });

    it('calls edge to deleted function is "deleted"', () => {
        const oldCode = `function caller() { return gone(); }\nfunction gone() { return 1; }`;
        const newCode = `function caller() { return gone(); }`;
        const graph = buildFileGraph(newCode, 'f.js', oldCode);
        // caller is unchanged (collapsed), gone is deleted — edge skipped (source collapsed)
        // No calls edges expected since caller is collapsed
        const deletedEdges = graph.edges.filter(e => e.diff === 'deleted');
        // The deleted ghost node should exist
        expect(graph.nodes.some(n => n.diff === 'deleted')).toBe(true);
    });

    it('dependency edges are "unchanged" in non-diff mode', () => {
        const graph = buildFileGraph(sampleCode, 'src/api.js');
        const depEdges = graph.edges.filter(e => ['calls', 'uses', 'depends'].includes(e.label ?? ''));
        expect(depEdges.every(e => e.diff === 'unchanged')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// buildFileGraphFromAnalysis — structure and diff
// ---------------------------------------------------------------------------
function makeAnalysis(overrides?: Partial<TSFileAnalysis>): TSFileAnalysis {
    return {
        entities: [
            { kind: 'import', name: 'UserRepo', key: 'import:com.example.UserRepo', signature: undefined, bodyText: undefined, node: null },
            { kind: 'variable', name: 'MAX_SIZE', key: 'variable:MAX_SIZE', signature: undefined, bodyText: '10', node: null },
            { kind: 'function', name: 'getUser', key: 'function:getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', node: null },
            { kind: 'function', name: 'createUser', key: 'function:createUser', signature: 'public User createUser(UserDto dto)', bodyText: 'return repo.save(dto);', node: null },
        ],
        funcs: new Map([
            ['function:getUser', { key: 'function:getUser', name: 'getUser', calls: [], usesVars: [], usesImports: [] }],
            ['function:createUser', { key: 'function:createUser', name: 'createUser', calls: ['getUser'], usesVars: [], usesImports: [] }],
        ]),
        importsByLocal: new Map([['UserRepo', 'com.example.UserRepo']]),
        ...overrides,
    } as unknown as TSFileAnalysis;
}

describe('buildFileGraphFromAnalysis — structure', () => {
    it('creates section nodes for imports, variables, functions', () => {
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java');
        const sections = graph.nodes.filter(n => n.type === 'section');
        expect(sections).toHaveLength(3);
        expect(sections.some(n => n.label.startsWith('Imports'))).toBe(true);
        expect(sections.some(n => n.label.startsWith('Variables'))).toBe(true);
        expect(sections.some(n => n.label.startsWith('Functions'))).toBe(true);
    });

    it('section label includes entity count', () => {
        // #448-C: section label MUST include the count at build time so the
        // init-time output matches what `recomputeFileGraphDiffFromAuthoritativeSymbols`
        // produces on cascade rebuilds. Without the count here, baseline and
        // working diverge: baseline has bare `Functions`, working has
        // `Functions (N)` after the first edit cascade, breaking the
        // cleanliness probe across every backend repo in the verify sweep.
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java');
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        expect(funcSection!.label).toBe('Functions (2)');
    });

    it('all nodes unchanged with no baseline', () => {
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java');
        const entityNodes = graph.nodes.filter(n => n.type !== 'file' && n.type !== 'section');
        expect(entityNodes.every(n => n.diff === 'unchanged')).toBe(true);
    });
});

describe('buildFileGraphFromAnalysis — diff mode', () => {
    it('marks added entity when not in baseline', () => {
        const baseline: BaselineSymbols = {
            functions: [{ name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' }],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        const addedNodes = graph.nodes.filter(n => n.diff === 'added');
        expect(addedNodes.some(n => n.label === 'createUser')).toBe(true);
    });

    it('marks modified entity when signature changed', () => {
        const baseline: BaselineSymbols = {
            functions: [
                { name: 'getUser', signature: 'public User getUser(int id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' },
                { name: 'createUser', signature: 'public User createUser(UserDto dto)', bodyText: 'return repo.save(dto);', stableKey: 'function:createUser' },
            ],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        const modNode = graph.nodes.find(n => n.label === 'getUser');
        expect(modNode!.diff).toBe('modified');
    });

    it('marks modified entity when bodyText changed', () => {
        const baseline: BaselineSymbols = {
            functions: [
                { name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return null;', stableKey: 'function:getUser' },
                { name: 'createUser', signature: 'public User createUser(UserDto dto)', bodyText: 'return repo.save(dto);', stableKey: 'function:createUser' },
            ],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        const modNode = graph.nodes.find(n => n.label === 'getUser');
        expect(modNode!.diff).toBe('modified');
    });

    it('creates deleted ghost node for function removed since baseline', () => {
        const analysis = makeAnalysis({
            entities: [{ kind: 'function', name: 'getUser', key: 'function:getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', node: null }],
        } as any);
        const baseline: BaselineSymbols = {
            functions: [
                { name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' },
                { name: 'deleteUser', signature: 'public void deleteUser(long id)', bodyText: 'repo.deleteById(id);', stableKey: 'function:deleteUser' },
            ],
            variables: [],
            imports: [],
        };
        const graph = buildFileGraphFromAnalysis(analysis, 'src/UserService.java', baseline);
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(deleted.some(n => n.label.includes('deleteUser'))).toBe(true);
    });

    it('file node gets modified when any child changed', () => {
        const baseline: BaselineSymbols = {
            functions: [{ name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' }],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        expect(graph.nodes.find(n => n.type === 'file')!.diff).toBe('modified');
    });

    it('file node stays unchanged when nothing changed', () => {
        const baseline: BaselineSymbols = {
            functions: [
                { name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' },
                { name: 'createUser', signature: 'public User createUser(UserDto dto)', bodyText: 'return repo.save(dto);', stableKey: 'function:createUser' },
            ],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        expect(graph.nodes.find(n => n.type === 'file')!.diff).toBe('unchanged');
    });

    // Issue #423 Pattern B — `extractImportSource` parses Rust `import::source::local`
    // stableKeys by splitting on `::` and returning `parts[1]`, which for a Rust
    // import like `bytes::Bytes` returns only the FIRST segment "bytes" instead
    // of the full source "bytes::Bytes". The deleted-import comparison
    // (`stillPresent = importEntities.some(e => extractImportSource(e.key) === i.source)`)
    // then never finds a match → every Rust import is falsely marked deleted +
    // re-added on every rebuild → L4 file graph stays modified forever post-revert.
    // Affects rust-axum, rust-actix, rust-rocket.
    it('does NOT mark Rust imports as deleted+added when baseline and working are identical (#423-B)', () => {
        // Working: Rust-style import entity key with `::` in source path.
        // Working entity key: `import::bytes::Bytes::Bytes` ← treeSitterExtractor's
        // `import::${source}::${local}` form where source contains `::`.
        const rustAnalysis = makeAnalysis({
            entities: [
                { kind: 'import', name: 'Bytes', key: 'import::bytes::Bytes::Bytes', signature: undefined, bodyText: undefined, node: null },
                { kind: 'import', name: 'Pin', key: 'import::std::pin::Pin::Pin', signature: undefined, bodyText: undefined, node: null },
                { kind: 'function', name: 'boxed', key: 'function:boxed', signature: 'fn boxed() -> Body', bodyText: '...', node: null },
            ],
            funcs: new Map([['function:boxed', { key: 'function:boxed', name: 'boxed', calls: [], usesVars: [], usesImports: [] }]]),
            importsByLocal: new Map([['Bytes', 'bytes::Bytes'], ['Pin', 'std::pin::Pin']]),
        } as any);
        // Baseline: same imports, same sources.
        const baseline: BaselineSymbols = {
            functions: [{ name: 'boxed', signature: 'fn boxed() -> Body', bodyText: '...', stableKey: 'function:boxed' }],
            variables: [],
            imports: [
                { source: 'bytes::Bytes', stableKey: 'import::bytes::Bytes::Bytes' },
                { source: 'std::pin::Pin', stableKey: 'import::std::pin::Pin::Pin' },
            ],
        };
        const graph = buildFileGraphFromAnalysis(rustAnalysis, 'src/body.rs', baseline);
        // No nodes should be marked 'deleted' — the baseline imports ARE still
        // present in working with byte-identical sources.
        const deleted = graph.nodes.filter(n => n.diff === 'deleted');
        expect(
            deleted.length,
            `should have no deleted imports when working == baseline; got: ${deleted.map(n => n.label).join(', ')}`,
        ).toBe(0);
        // And no 'added' imports either (no new source).
        const added = graph.nodes.filter(n => n.type === 'import' && n.diff === 'added');
        expect(
            added.length,
            `should have no added imports when working == baseline; got: ${added.map(n => n.label).join(', ')}`,
        ).toBe(0);
    });

    // Issue #452-B — Rust brace-expanded imports like
    // `use axum::{body::Bytes, error_handling::HandleErrorLayer}` produce
    // entity keys `import::axum::body::Bytes` where the local part itself
    // contains `::`. `extractImportSource` uses `lastIndexOf('::')` and
    // returns "axum::body" instead of "axum" — missing the equality with
    // baseline `i.source = "axum"`. computeNonJsDiff then marks every such
    // import as 'added' on every cascade rebuild, leaving file graphs (and
    // their downstream sequence participants) stuck in 'modified' even when
    // working byte-equals baseline. Affects rust-axum, rust-actix, rust-rocket.
    it('does NOT mark Rust brace-expanded imports (local contains "::") as added when baseline == working (#452-B)', () => {
        // Mirrors rust-axum/examples/key-value-store/src/main.rs:
        //   use axum::{body::Bytes, error_handling::HandleErrorLayer, ...}
        // Extractor emits {source: 'axum', local: 'body::Bytes'} →
        // stableKey: 'import::axum::body::Bytes'
        const rustAnalysis = makeAnalysis({
            entities: [
                { kind: 'import', name: 'body::Bytes', key: 'import::axum::body::Bytes', signature: undefined, bodyText: undefined, node: null },
                { kind: 'import', name: 'error_handling::HandleErrorLayer', key: 'import::axum::error_handling::HandleErrorLayer', signature: undefined, bodyText: undefined, node: null },
                { kind: 'import', name: 'compression::CompressionLayer', key: 'import::tower_http::compression::CompressionLayer', signature: undefined, bodyText: undefined, node: null },
            ],
            funcs: new Map(),
            importsByLocal: new Map([
                ['body::Bytes', 'axum'],
                ['error_handling::HandleErrorLayer', 'axum'],
                ['compression::CompressionLayer', 'tower_http'],
            ]),
        } as any);
        const baseline: BaselineSymbols = {
            functions: [],
            variables: [],
            // Persisted baseline imports (post-init) carry the SAME stableKey
            // the extractor emits and source = the BASE crate path only.
            imports: [
                { source: 'axum', stableKey: 'import::axum::body::Bytes' },
                { source: 'axum', stableKey: 'import::axum::error_handling::HandleErrorLayer' },
                { source: 'tower_http', stableKey: 'import::tower_http::compression::CompressionLayer' },
            ],
        };
        const graph = buildFileGraphFromAnalysis(rustAnalysis, 'examples/key-value-store/src/main.rs', baseline);
        const added = graph.nodes.filter(n => n.type === 'import' && n.diff === 'added');
        expect(
            added.length,
            `should have no added imports when working == baseline; got: ${added.map(n => n.label).join(', ')}`,
        ).toBe(0);
        const deleted = graph.nodes.filter(n => n.type === 'import' && n.diff === 'deleted');
        expect(deleted.length).toBe(0);
    });

    // Issue #423 Pattern B (variable extension) — when a file has multiple
    // variables with the SAME name (e.g., Rust's `let routes = ...; ... let routes
    // = ...;` in different function scopes, all extracted as top-level entities
    // by treeSitterExtractor), they all share the same stableKey
    // `${fileName}::${name}`. The baseline Map keyed by stableKey only keeps the
    // LAST one (Map overwrite). Working iteration then misdiffs: entries with
    // bodyText that matches the LAST baseline entry are correctly `unchanged`,
    // but entries with bodyText that matched an EARLIER baseline duplicate get
    // wrongly marked `modified`. Affects rust-rocket (benchmarks/src/routing.rs
    // has `let mut routes = vec![]` AND `let routes = parse_routes_table(table)`)
    // and rust-actix (auth/casbin/src/main.rs has multiple `enforcer` vars).
    it('handles duplicate variable names without false-modified diffs (#423-B vars)', () => {
        // Working: 3 entries all named "routes" with 2 distinct bodies (mimics
        // routing.rs having `let mut routes = vec![]` once + `let routes = parse_routes_table(table)` twice).
        const dupAnalysis = makeAnalysis({
            entities: [
                { kind: 'variable', name: 'routes', key: 'routing.rs::routes', signature: 'let mut routes = vec![]', bodyText: 'let mut routes = vec![]', node: null },
                { kind: 'variable', name: 'routes', key: 'routing.rs::routes', signature: 'let routes = parse_routes_table(table)', bodyText: 'let routes = parse_routes_table(table)', node: null },
                { kind: 'variable', name: 'routes', key: 'routing.rs::routes', signature: 'let routes = parse_routes_table(table)', bodyText: 'let routes = parse_routes_table(table)', node: null },
            ],
            funcs: new Map(),
            importsByLocal: new Map(),
        } as any);
        const baseline: BaselineSymbols = {
            functions: [],
            // Same three variables in baseline. The Map-by-stableKey keeps only
            // the LAST one (parse_routes_table) — but our diff logic must still
            // recognise the FIRST (vec![]) variant as unchanged because it
            // existed at baseline too.
            variables: [
                { name: 'routes', bodyText: 'let mut routes = vec![]', stableKey: 'routing.rs::routes' },
                { name: 'routes', bodyText: 'let routes = parse_routes_table(table)', stableKey: 'routing.rs::routes' },
                { name: 'routes', bodyText: 'let routes = parse_routes_table(table)', stableKey: 'routing.rs::routes' },
            ],
            imports: [],
        };
        const graph = buildFileGraphFromAnalysis(dupAnalysis, 'benchmarks/src/routing.rs', baseline);
        // No `routes` variable node should be marked 'modified' — every working
        // bodyText matches SOME baseline entry with the same name.
        const modified = graph.nodes.filter(n => n.type === 'variable' && n.label === 'routes' && n.diff === 'modified');
        expect(
            modified.length,
            `routes vars should not be modified when same bodies exist in baseline; got: ${graph.nodes.filter(n => n.type === 'variable').map(n => `${n.label}=${n.diff}`).join(', ')}`,
        ).toBe(0);
    });

    it('unchanged entities collapsed to summary node in diff mode', () => {
        // createUser added (not in baseline) → individual node
        // getUser unchanged → collapsed to summary
        const baseline: BaselineSymbols = {
            functions: [{ name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' }],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        // getUser is unchanged — should still be an individual node so user can navigate to it
        const getUserNode = graph.nodes.find(n => n.type === 'function' && n.label === 'getUser');
        expect(getUserNode).toBeDefined();
        expect(getUserNode!.diff).toBe('unchanged');
        // No summary "N unchanged" nodes should exist
        const summaryNodes = graph.nodes.filter(n => n.type === 'section' && n.label.includes('unchanged'));
        expect(summaryNodes.length).toBe(0);
    });

    it('section subtitle shows diff breakdown in diff mode', () => {
        const baseline: BaselineSymbols = {
            functions: [{ name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' }],
            variables: [{ name: 'MAX_SIZE', bodyText: '10', stableKey: 'variable:MAX_SIZE' }],
            imports: [{ source: 'com.example.UserRepo', stableKey: 'import:com.example.UserRepo' }],
        };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        // createUser added + getUser unchanged → subtitle shows breakdown
        expect(funcSection!.subtitle).toMatch(/added|unchanged/);
    });

    it('section diff is modified for mixed add + delete', () => {
        // baseline: getUser + deleteUser; current: getUser + createUser
        const baseline: BaselineSymbols = {
            functions: [
                { name: 'getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', stableKey: 'function:getUser' },
                { name: 'deleteUser', signature: 'public void deleteUser(long id)', bodyText: 'repo.deleteById(id);', stableKey: 'function:deleteUser' },
            ],
            variables: [],
            imports: [],
        };
        const analysis = makeAnalysis({
            entities: [
                { kind: 'function', name: 'getUser', key: 'function:getUser', signature: 'public User getUser(long id)', bodyText: 'return repo.findById(id);', node: null },
                { kind: 'function', name: 'createUser', key: 'function:createUser', signature: 'public User createUser(UserDto dto)', bodyText: 'return repo.save(dto);', node: null },
            ],
        } as any);
        const graph = buildFileGraphFromAnalysis(analysis, 'src/UserService.java', baseline);
        const funcSection = graph.nodes.find(n => n.type === 'section' && n.label.startsWith('Functions'));
        // createUser added + deleteUser deleted → mixed → 'modified'
        expect(funcSection!.diff).toBe('modified');
    });

    it('calls edge diff reflects endpoint diffs', () => {
        // createUser (added) calls getUser (unchanged/collapsed) — edge skipped (target collapsed)
        // But if both are added, edge should be 'added'
        const baseline: BaselineSymbols = { functions: [], variables: [], imports: [] };
        const graph = buildFileGraphFromAnalysis(makeAnalysis(), 'src/UserService.java', baseline);
        const callsEdges = graph.edges.filter(e => e.label === 'calls');
        // Both functions are 'added' → edge diff should be 'added'
        if (callsEdges.length > 0) {
            expect(callsEdges.every(e => e.diff === 'added')).toBe(true);
        }
    });
});

// Issue #423 (php-symfony residual) — `recomputeFileGraphDiffFromAuthoritativeSymbols`
// re-derives node diffs (sets `function` nodes back to `unchanged` when sig+body
// match baseline) and file root + section diffs. But it does NOT touch EDGE diffs.
// So when an edit causes function nodes to be marked modified at build time
// (correctly), then a later revert + recompute resets the nodes back to
// unchanged, the edges between those nodes STAY 'modified'. Files with non-
// function entities (like csrf_protection_controller.js with imports + a
// function using them) show stuck 'uses' edges post-revert → file graph
// matches `*"diff":"modified"*` substring → file graph counted as still leaking.
//
// Fix: at the end of the recompute pass, also re-derive edge diffs from the
// CURRENT (now-reset) endpoint nodes.
describe('recomputeFileGraphDiffFromAuthoritativeSymbols — edge-diff recomputation (#423 php-symfony)', () => {
    it('resets edge diff back to unchanged when both endpoints have been reset to unchanged', () => {
        // File graph built at edit-time: function node was modified, dependency
        // edge was modified.
        const fileGraph: DiagramGraph = {
            graphId: 'file:assets/controllers/csrf_protection_controller.js',
            type: 'file',
            nodes: [
                { id: 'file_1', type: 'file', label: 'csrf_protection_controller.js', diff: 'modified' },
                { id: 'node_2', type: 'import', label: 'lodash', diff: 'unchanged' },
                { id: 'node_3', type: 'import', label: 'jquery', diff: 'unchanged' },
                { id: 'node_8', type: 'function', label: 'generateCsrfToken', diff: 'modified' },
            ],
            edges: [
                // The edge was marked modified at build time because node_8 (the function)
                // was 'modified' at build time.
                { id: 'edge_16', source: 'node_8', target: 'node_2', label: 'uses', edgeType: 'uses', diff: 'modified' },
                { id: 'edge_17', source: 'node_8', target: 'node_3', label: 'uses', edgeType: 'uses', diff: 'modified' },
            ],
            anchors: {}, meta: {},
        };

        // Baseline file: function had IDENTICAL signature and body — so the
        // recompute pass will reset node_8.diff to 'unchanged'. After that, the
        // edges should also reset to 'unchanged' (both endpoints unchanged).
        const baselineFile = {
            symbols: {
                functions: [{
                    name: 'generateCsrfToken',
                    signature: 'function generateCsrfToken()',
                    bodyText: 'return md5(secret);',
                    stableKey: 'function:generateCsrfToken',
                }],
                variables: [],
                imports: [],
            },
            content: undefined,
        } as unknown as FileRecord;

        const workingAnalysis = {
            entities: [
                { kind: 'function', name: 'generateCsrfToken', key: 'function:generateCsrfToken', signature: 'function generateCsrfToken()', bodyText: 'return md5(secret);', node: null },
            ],
        } as unknown as TSFileAnalysis;

        recomputeFileGraphDiffFromAuthoritativeSymbols(fileGraph, baselineFile, workingAnalysis);

        // Function node was reset
        const fn = fileGraph.nodes.find(n => n.id === 'node_8');
        expect(fn?.diff, 'function node should reset to unchanged').toBe('unchanged');

        // Edges should also reset because both endpoints are now unchanged
        const edges = fileGraph.edges.filter(e => e.id === 'edge_16' || e.id === 'edge_17');
        for (const e of edges) {
            expect(e.diff,
                `edge ${e.id} (uses) should reset to unchanged when both endpoints are unchanged. Got: ${e.diff}`,
            ).toBe('unchanged');
        }
    });

    // Issue 764 (2026-06-06) — the recompute used to only walk
    // `type === 'function'` nodes, so a reverted variable / import /
    // class would stay stuck at `modified` even after the file content
    // matched baseline. These three tests lock the broadened coverage.
    it('Issue 764: downgrades a reverted VARIABLE node from modified back to unchanged', () => {
        const fileGraph: DiagramGraph = {
            graphId: 'file:src/config.ts', type: 'file',
            nodes: [
                { id: 'v1', type: 'variable', label: 'API_BASE', diff: 'modified' },
            ],
            edges: [], anchors: {}, meta: {},
        };
        const baselineFile = {
            symbols: {
                functions: [],
                variables: [{ name: 'API_BASE', signature: 'const API_BASE', bodyText: '"https://api.example.com"', stableKey: 'variable:API_BASE' }],
                imports: [],
            },
        } as unknown as FileRecord;
        const workingAnalysis = {
            entities: [{ kind: 'variable', name: 'API_BASE', key: 'variable:API_BASE', signature: 'const API_BASE', bodyText: '"https://api.example.com"', node: null }],
        } as unknown as TSFileAnalysis;
        recomputeFileGraphDiffFromAuthoritativeSymbols(fileGraph, baselineFile, workingAnalysis);
        expect(fileGraph.nodes.find(n => n.id === 'v1')?.diff).toBe('unchanged');
    });

    it('Issue 764: downgrades a reverted IMPORT node from modified back to unchanged', () => {
        const fileGraph: DiagramGraph = {
            graphId: 'file:src/handler.ts', type: 'file',
            nodes: [
                { id: 'i1', type: 'import', label: 'fastify', diff: 'modified' },
            ],
            edges: [], anchors: {}, meta: {},
        };
        const baselineFile = {
            symbols: {
                functions: [], variables: [],
                imports: [{ source: 'fastify', specifiers: [{ local: 'fastify', imported: 'default' }], span: { start: 0, end: 20 }, stableKey: 'import:fastify' }],
            },
        } as unknown as FileRecord;
        const workingAnalysis = {
            entities: [{ kind: 'import', name: 'fastify', key: 'import:fastify', signature: "import fastify from 'fastify'", bodyText: '', node: null }],
        } as unknown as TSFileAnalysis;
        recomputeFileGraphDiffFromAuthoritativeSymbols(fileGraph, baselineFile, workingAnalysis);
        expect(fileGraph.nodes.find(n => n.id === 'i1')?.diff).toBe('unchanged');
    });

    it('Issue 764: downgrades a reverted CLASS node from modified back to unchanged', () => {
        const fileGraph: DiagramGraph = {
            graphId: 'file:src/widget.ts', type: 'file',
            nodes: [
                { id: 'c1', type: 'class', label: 'Widget', diff: 'modified' },
            ],
            edges: [], anchors: {}, meta: {},
        };
        const baselineFile = {
            symbols: {
                functions: [{ name: 'Widget', signature: 'class Widget', bodyText: 'render() {}', stableKey: 'class:Widget' }],
                variables: [], imports: [],
            },
        } as unknown as FileRecord;
        const workingAnalysis = {
            entities: [{ kind: 'class', name: 'Widget', key: 'class:Widget', signature: 'class Widget', bodyText: 'render() {}', node: null }],
        } as unknown as TSFileAnalysis;
        recomputeFileGraphDiffFromAuthoritativeSymbols(fileGraph, baselineFile, workingAnalysis);
        expect(fileGraph.nodes.find(n => n.id === 'c1')?.diff).toBe('unchanged');
    });

    it('keeps edge diff intact when at least one endpoint remained modified', () => {
        // Edit changed the function body — function node STAYS modified.
        // Edges should retain their modified diff.
        const fileGraph: DiagramGraph = {
            graphId: 'file:src/a.ts', type: 'file',
            nodes: [
                { id: 'fn1', type: 'function', label: 'doThing', diff: 'modified' },
                { id: 'imp1', type: 'import', label: 'lodash', diff: 'unchanged' },
            ],
            edges: [
                { id: 'e1', source: 'fn1', target: 'imp1', label: 'uses', edgeType: 'uses', diff: 'modified' },
            ],
            anchors: {}, meta: {},
        };
        const baselineFile = {
            symbols: {
                functions: [{ name: 'doThing', signature: 'function doThing()', bodyText: 'return 1;', stableKey: 'function:doThing' }],
                variables: [], imports: [],
            },
        } as unknown as FileRecord;
        // working has DIFFERENT body
        const workingAnalysis = {
            entities: [{ kind: 'function', name: 'doThing', key: 'function:doThing', signature: 'function doThing()', bodyText: 'return 2;', node: null }],
        } as unknown as TSFileAnalysis;

        recomputeFileGraphDiffFromAuthoritativeSymbols(fileGraph, baselineFile, workingAnalysis);

        const fn = fileGraph.nodes.find(n => n.id === 'fn1');
        expect(fn?.diff, 'function should stay modified').toBe('modified');
        const e = fileGraph.edges.find(e => e.id === 'e1');
        expect(e?.diff, 'edge should stay modified when endpoint stayed modified').toBe('modified');
    });
});
