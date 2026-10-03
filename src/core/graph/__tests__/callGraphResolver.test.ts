import { describe, it, expect } from 'vitest';
import { buildCallGraph, WorkspaceCallGraph, getFunctionKeysForFiles, resolveNonJsModulePath } from '../callGraphResolver';
import type { Snapshot, FileRecord } from '../graphTypes';

function makeSnapshot(files: Record<string, { content: string; symbols?: any }>): Snapshot {
    const fileRecords: Record<string, FileRecord> = {};
    for (const [fp, data] of Object.entries(files)) {
        fileRecords[fp] = {
            content: data.content,
            symbols: data.symbols ?? { functions: [], vars: [], imports: [] },
            lastModified: 0,
        };
    }
    return {
        files: fileRecords,
        apiIndex: {},
        graphs: {},
    };
}

describe('WorkspaceCallGraph', () => {
    it('ensureNode creates a node with empty edges', () => {
        const graph = new WorkspaceCallGraph();
        const node = graph.ensureNode('a.ts', 'foo');
        expect(node.key).toBe('a.ts::foo');
        expect(node.filePath).toBe('a.ts');
        expect(node.functionName).toBe('foo');
        expect(node.calls).toEqual([]);
        expect(node.calledBy).toEqual([]);
    });

    it('addEdge connects caller and callee', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('a.ts', 'bar');
        graph.addEdge('a.ts::foo', 'a.ts::bar');

        expect(graph.getNode('a.ts::foo')?.calls).toContain('a.ts::bar');
        expect(graph.getNode('a.ts::bar')?.calledBy).toContain('a.ts::foo');
    });

    it('addEdge does not duplicate edges', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('a.ts', 'bar');
        graph.addEdge('a.ts::foo', 'a.ts::bar');
        graph.addEdge('a.ts::foo', 'a.ts::bar'); // duplicate
        expect(graph.getNode('a.ts::foo')?.calls).toHaveLength(1);
    });

    it('serialize / deserialize round-trip', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.addEdge('a.ts::foo', 'b.ts::bar');

        const serialized = graph.serialize();
        expect(serialized.version).toBe(2);
        expect(Object.keys(serialized.nodes)).toHaveLength(2);

        const restored = WorkspaceCallGraph.deserialize(serialized);
        expect(restored.getNode('a.ts::foo')?.calls).toContain('b.ts::bar');
        expect(restored.getNode('b.ts::bar')?.calledBy).toContain('a.ts::foo');
    });

    it('serialize produces a non-empty top-level edges array', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.addEdge('a.ts::foo', 'b.ts::bar', 0.85, 'calls');

        const serialized = graph.serialize();
        expect(Array.isArray(serialized.edges)).toBe(true);
        expect(serialized.edges.length).toBeGreaterThan(0);
    });

    it('serialize edges have correct shape (callerKey, calleeKey, confidence, kind)', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.addEdge('a.ts::foo', 'b.ts::bar', 0.75, 'imports');

        const serialized = graph.serialize();
        const edge = serialized.edges[0];
        expect(edge.callerKey).toBe('a.ts::foo');
        expect(edge.calleeKey).toBe('b.ts::bar');
        expect(edge.confidence).toBe(0.75);
        expect(edge.kind).toBe('imports');
    });

    it('serialize edges are consistent with per-node callEdges', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.ensureNode('b.ts', 'baz');
        graph.addEdge('a.ts::foo', 'b.ts::bar', 0.9, 'calls');
        graph.addEdge('a.ts::foo', 'b.ts::baz', 0.6, 'calls');

        const serialized = graph.serialize();
        // flat edges count should match sum of callEdges across all nodes
        const totalCallEdges = Object.values(serialized.nodes).reduce(
            (sum, n) => sum + (n.callEdges?.length ?? 0), 0
        );
        expect(serialized.edges.length).toBe(totalCallEdges);

        // Each flat edge should appear in the corresponding node's callEdges
        for (const flatEdge of serialized.edges) {
            const node = serialized.nodes[flatEdge.callerKey];
            expect(node).toBeDefined();
            const match = node?.callEdges?.find(
                (ce) => ce.key === flatEdge.calleeKey && ce.confidence === flatEdge.confidence
            );
            expect(match).toBeDefined();
        }
    });

    it('serialize produces empty edges array for a graph with no edges', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        const serialized = graph.serialize();
        expect(Array.isArray(serialized.edges)).toBe(true);
        expect(serialized.edges).toHaveLength(0);
    });

    it('getReachable returns transitively called nodes', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');
        graph.ensureNode('c.ts', 'c');
        graph.addEdge('a.ts::a', 'b.ts::b');
        graph.addEdge('b.ts::b', 'c.ts::c');

        const reachable = graph.getReachable('a.ts::a');
        const keys = reachable.map((r) => r.key);
        expect(keys).toContain('b.ts::b');
        expect(keys).toContain('c.ts::c');
    });

    it('getReachable respects maxDepth', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');
        graph.ensureNode('c.ts', 'c');
        graph.addEdge('a.ts::a', 'b.ts::b');
        graph.addEdge('b.ts::b', 'c.ts::c');

        const reachable = graph.getReachable('a.ts::a', 1);
        const keys = reachable.map((r) => r.key);
        expect(keys).toContain('b.ts::b');
        expect(keys).not.toContain('c.ts::c');
    });

    it('getImpacted returns reverse callers', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');
        graph.ensureNode('c.ts', 'c');
        graph.addEdge('a.ts::a', 'b.ts::b');
        graph.addEdge('b.ts::b', 'c.ts::c');

        // If c.ts::c changes, who is impacted?
        const impacted = graph.getImpacted(['c.ts::c']);
        const keys = impacted.map((r) => r.key);
        expect(keys).toContain('b.ts::b');
        expect(keys).toContain('a.ts::a');
    });

    it('getImpacted does not include the changed keys themselves', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');
        graph.addEdge('a.ts::a', 'b.ts::b');

        const impacted = graph.getImpacted(['b.ts::b']);
        expect(impacted.map((r) => r.key)).not.toContain('b.ts::b');
    });

    it('addEdge stores confidence and kind in edgeMeta', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.addEdge('a.ts::foo', 'b.ts::bar', 0.85, 'calls');
        const meta = graph.getEdgeMeta('a.ts::foo', 'b.ts::bar');
        expect(meta?.confidence).toBe(0.85);
        expect(meta?.kind).toBe('calls');
    });

    it('serialize populates callEdges with confidence and kind', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.addEdge('a.ts::foo', 'b.ts::bar', 0.75, 'imports');
        const serialized = graph.serialize();
        const node = serialized.nodes['a.ts::foo'];
        expect(node?.callEdges).toHaveLength(1);
        expect(node?.callEdges?.[0]?.confidence).toBe(0.75);
        expect(node?.callEdges?.[0]?.kind).toBe('imports');
    });

    it('deserialize restores edgeMeta from callEdges', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('b.ts', 'bar');
        graph.addEdge('a.ts::foo', 'b.ts::bar', 0.6, 'calls');
        const serialized = graph.serialize();
        const restored = WorkspaceCallGraph.deserialize(serialized);
        const meta = restored.getEdgeMeta('a.ts::foo', 'b.ts::bar');
        expect(meta?.confidence).toBe(0.6);
        expect(meta?.kind).toBe('calls');
    });

    it('getImpactedFiltered respects minConfidence threshold', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');   // high-confidence caller
        graph.ensureNode('c.ts', 'c');   // low-confidence caller
        graph.addEdge('b.ts::b', 'a.ts::a', 0.9, 'calls');
        graph.addEdge('c.ts::c', 'a.ts::a', 0.4, 'calls');

        const impacted = graph.getImpactedFiltered(['a.ts::a'], {
            maxDepth: 4,
            minConfidence: 0.8,
            kinds: ['calls'],
        });
        const keys = impacted.map((r) => r.key);
        expect(keys).toContain('b.ts::b');
        expect(keys).not.toContain('c.ts::c');
    });

    it('getImpactedFiltered respects relation kind filter', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');
        graph.ensureNode('c.ts', 'c');
        graph.addEdge('b.ts::b', 'a.ts::a', 0.9, 'calls');
        graph.addEdge('c.ts::c', 'a.ts::a', 0.9, 'imports');

        // Only follow 'calls' edges
        const callsOnly = graph.getImpactedFiltered(['a.ts::a'], {
            maxDepth: 4,
            minConfidence: 0,
            kinds: ['calls'],
        });
        expect(callsOnly.map((r) => r.key)).toContain('b.ts::b');
        expect(callsOnly.map((r) => r.key)).not.toContain('c.ts::c');

        // Only follow 'imports' edges
        const importsOnly = graph.getImpactedFiltered(['a.ts::a'], {
            maxDepth: 4,
            minConfidence: 0,
            kinds: ['imports'],
        });
        expect(importsOnly.map((r) => r.key)).toContain('c.ts::c');
        expect(importsOnly.map((r) => r.key)).not.toContain('b.ts::b');
    });

    it('getImpactedFiltered returns confidence on results', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'a');
        graph.ensureNode('b.ts', 'b');
        graph.addEdge('b.ts::b', 'a.ts::a', 0.75, 'calls');

        const impacted = graph.getImpactedFiltered(['a.ts::a'], {
            maxDepth: 4,
            minConfidence: 0,
            kinds: ['calls'],
        });
        expect(impacted[0]?.confidence).toBe(0.75);
    });
});

describe('buildCallGraph', () => {
    it('builds intra-file call edges from parsed content', () => {
        const snapshot = makeSnapshot({
            'src/a.ts': {
                content: `
                    function foo() { bar(); }
                    function bar() {}
                `,
                symbols: {
                    functions: [{ name: 'foo' }, { name: 'bar' }],
                    vars: [],
                    imports: [],
                },
            },
        });

        const graph = buildCallGraph(snapshot);
        const fooNode = graph.getNode('src/a.ts::foo');
        expect(fooNode).toBeDefined();
        expect(fooNode?.calls).toContain('src/a.ts::bar');
    });

    it('returns empty graph for empty snapshot', () => {
        const snapshot = makeSnapshot({});
        const graph = buildCallGraph(snapshot);
        expect(graph.getAllNodes()).toHaveLength(0);
    });

    it('skips files without content', () => {
        const snapshot: Snapshot = {
            files: {
                'a.ts': { content: undefined as any, symbols: { functions: [{ name: 'foo' }], vars: [], imports: [] }, lastModified: 0 },
            },
            apiIndex: {},
            graphs: {},
        };
        const graph = buildCallGraph(snapshot);
        // Node is registered from symbols phase but no edges from parse phase
        expect(graph.getNode('a.ts::foo')).toBeDefined();
        expect(graph.getNode('a.ts::foo')?.calls).toHaveLength(0);
    });

    // #775 (2026-06-06) — `FileRecord.content` is dropped after each
    // save (lazy-content optimisation #354/#355). On cascade rebuilds
    // the in-memory snapshot's content is `undefined`, so the existing
    // `if (!content) continue` branch skipped every file → ZERO
    // cross-file edges → every cluster reported `internalCallCount=0`.
    // The fix: accept an optional `getFileContent` callback that
    // re-hydrates content from the snapshot store.
    describe('#775 lazy-content fallback', () => {
        it('uses getFileContent when fileRecord.content is undefined', () => {
            const snapshot: Snapshot = {
                files: {
                    'a.ts': {
                        content: undefined as any,
                        symbols: { functions: [{ name: 'foo' }, { name: 'bar' }], variables: [], imports: [] },
                        lastModified: 0,
                    } as any,
                },
                apiIndex: {},
                graphs: {},
            };
            const getContent = (filePath: string) => {
                if (filePath === 'a.ts') {
                    return 'function foo() { bar(); }\nfunction bar() {}';
                }
                return undefined;
            };
            const graph = buildCallGraph(snapshot, undefined, getContent);
            // Edge between foo and bar should now be detected via the callback.
            expect(graph.getNode('a.ts::foo')?.calls).toContain('a.ts::bar');
        });

        it('resolves cross-file imports through getFileContent', () => {
            const snapshot: Snapshot = {
                files: {
                    'src/controller.ts': {
                        content: undefined as any,
                        symbols: {
                            functions: [{ name: 'handler' }],
                            variables: [],
                            imports: [],
                        },
                        lastModified: 0,
                    } as any,
                    'src/service.ts': {
                        content: undefined as any,
                        symbols: {
                            functions: [{ name: 'login' }],
                            variables: [],
                            imports: [],
                        },
                        lastModified: 0,
                    } as any,
                },
                apiIndex: {},
                graphs: {},
            };
            const sources: Record<string, string> = {
                'src/controller.ts': "import { login } from './service';\nexport function handler() { return login(); }",
                'src/service.ts': "export function login() { return true; }",
            };
            const getContent = (filePath: string) => sources[filePath];
            const graph = buildCallGraph(snapshot, undefined, getContent);
            expect(graph.getNode('src/controller.ts::handler')?.calls).toContain('src/service.ts::login');
        });

        it('prefers fileRecord.content over the callback when both are present', () => {
            const snapshot: Snapshot = {
                files: {
                    'a.ts': {
                        content: 'function foo() { bar(); }\nfunction bar() {}',
                        symbols: { functions: [{ name: 'foo' }, { name: 'bar' }], variables: [], imports: [] },
                        lastModified: 0,
                    } as any,
                },
                apiIndex: {},
                graphs: {},
            };
            let callbackInvoked = false;
            const getContent = () => { callbackInvoked = true; return 'function foo() {}'; };
            const graph = buildCallGraph(snapshot, undefined, getContent);
            // Edge present because the inline content has the call.
            expect(graph.getNode('a.ts::foo')?.calls).toContain('a.ts::bar');
            expect(callbackInvoked).toBe(false);
        });

        it('still skips files when getFileContent returns undefined', () => {
            const snapshot: Snapshot = {
                files: {
                    'a.ts': {
                        content: undefined as any,
                        symbols: { functions: [{ name: 'foo' }], variables: [], imports: [] },
                        lastModified: 0,
                    } as any,
                },
                apiIndex: {},
                graphs: {},
            };
            const getContent = () => undefined;
            const graph = buildCallGraph(snapshot, undefined, getContent);
            expect(graph.getNode('a.ts::foo')?.calls).toHaveLength(0);
        });
    });

    /**
     * #444-A-cohesion: every C# (and other non-JS) cluster was showing 0%
     * cohesion because `buildCallGraph` Phase 2 re-parses content via the
     * JS-only `collectTopLevelEntities`, which throws on non-JS source and is
     * swallowed by the catch block. Result: zero intra-file edges for C#,
     * Java, Python, Go, Rust, Kotlin, PHP, Ruby, Swift, Dart files. Cluster
     * cohesion is then `0 / externalCallCount = 0%` for any cluster that
     * holds non-JS files. The fix: for non-JS files, use the pre-extracted
     * `fileRecord.symbols.functions[].calls` (already populated by the tree-
     * sitter extractor's `extractCalls`).
     */
    it('builds intra-file edges for non-JS files using stored symbols.calls (#444-A-cohesion)', () => {
        const snapshot = makeSnapshot({
            'src/Create.cs': {
                content: `public class Create { public class Handler { public Task Handle() { GenerateSlug(); SaveChanges(); } public void GenerateSlug() {} public void SaveChanges() {} } }`,
                symbols: {
                    functions: [
                        { name: 'Create.Handler.Handle', kind: 'function', calls: ['GenerateSlug', 'SaveChanges'] },
                        { name: 'Create.Handler.GenerateSlug', kind: 'function', calls: [] },
                        { name: 'Create.Handler.SaveChanges', kind: 'function', calls: [] },
                    ],
                    vars: [],
                    imports: [],
                },
            },
        });

        const graph = buildCallGraph(snapshot);
        const handleNode = graph.getNode('src/Create.cs::Create.Handler.Handle');
        expect(handleNode, 'Handle node should be registered').toBeDefined();
        // Both intra-file callees should produce edges.
        expect(handleNode?.calls, 'Handle should call GenerateSlug').toContain('src/Create.cs::Create.Handler.GenerateSlug');
        expect(handleNode?.calls, 'Handle should call SaveChanges').toContain('src/Create.cs::Create.Handler.SaveChanges');
    });

    // MCP-EVAL-1/2: non-JS (Python etc.) files got INTRA-file edges only, so a
    // Python endpoint that calls an imported free function or a service method in
    // ANOTHER file had ZERO downstream edges — `get_function_dependencies` and
    // `trace_call_path` returned empty. The fix resolves calls to IMPORTED names
    // across the workspace (import-gated to avoid false links).
    describe('non-JS cross-file edges (MCP-EVAL-1/2 — Python import-gated resolution)', () => {
        it('resolves a free-function call to its imported definition in another file', () => {
            const snapshot = makeSnapshot({
                'polar/customer_portal/endpoints/customer.py': {
                    content: '',
                    symbols: {
                        functions: [{ name: 'add_payment_method', kind: 'function', calls: ['get_customer', 'get_audit_context'] }],
                        vars: [],
                        imports: [{ source: '.utils', specifiers: [
                            { local: 'get_customer', imported: 'get_customer' },
                            { local: 'get_audit_context', imported: 'get_audit_context' },
                        ], span: { start: 0, end: 1 }, stableKey: 'imp1' }],
                    },
                },
                'polar/customer_portal/utils.py': {
                    content: '',
                    symbols: {
                        functions: [{ name: 'get_customer', kind: 'function', calls: [] }, { name: 'get_audit_context', kind: 'function', calls: [] }],
                        vars: [], imports: [],
                    },
                },
            });
            const graph = buildCallGraph(snapshot);
            const node = graph.getNode('polar/customer_portal/endpoints/customer.py::add_payment_method');
            expect(node?.calls).toContain('polar/customer_portal/utils.py::get_customer');
            expect(node?.calls).toContain('polar/customer_portal/utils.py::get_audit_context');
        });

        it('resolves a member call (obj.method) to the method in the imported class file, not a self-edge', () => {
            const snapshot = makeSnapshot({
                'polar/customer_portal/endpoints/customer.py': {
                    content: '',
                    symbols: {
                        functions: [{ name: 'add_payment_method', kind: 'function', calls: [], memberCalls: { customer_service: ['add_payment_method'] } }],
                        vars: [],
                        imports: [{ source: '.service', specifiers: [{ local: 'customer_service', imported: 'customer_service' }], span: { start: 0, end: 1 }, stableKey: 'imp2' }],
                    },
                },
                'polar/customer/service.py': {
                    content: '',
                    symbols: {
                        functions: [{ name: 'CustomerService.add_payment_method', kind: 'function', calls: [] }],
                        vars: [], imports: [],
                    },
                },
            });
            const graph = buildCallGraph(snapshot);
            const node = graph.getNode('polar/customer_portal/endpoints/customer.py::add_payment_method');
            // Cross-file edge to the service method; NOT a self-edge on the endpoint's own name.
            expect(node?.calls).toContain('polar/customer/service.py::CustomerService.add_payment_method');
            expect(node?.calls).not.toContain('polar/customer_portal/endpoints/customer.py::add_payment_method');
        });

        it('PERF: skips cross-file resolution for an over-common name (>20 definitions) to avoid O(n²)', () => {
            // `get` defined in 30 files → too ambiguous; resolving + filtering that
            // candidate list per call site is quadratic on large repos and blocked
            // the event loop for minutes. It must be skipped (no edges added).
            const files: Record<string, { content: string; symbols?: any }> = {
                'a/caller.py': {
                    content: '',
                    symbols: {
                        functions: [{ name: 'handler', kind: 'function', calls: [], memberCalls: { svc: ['get'] } }],
                        vars: [],
                        imports: [{ source: '.services', specifiers: [{ local: 'svc', imported: 'svc' }], span: { start: 0, end: 1 }, stableKey: 'i' }],
                    },
                },
            };
            for (let i = 0; i < 30; i++) {
                files[`svc/s${i}.py`] = { content: '', symbols: { functions: [{ name: `S${i}.get`, kind: 'function', calls: [] }], vars: [], imports: [] } };
            }
            const graph = buildCallGraph(makeSnapshot(files));
            const node = graph.getNode('a/caller.py::handler');
            // No cross-file edge added — the name was too common to resolve.
            expect((node?.calls ?? []).some(k => /svc\/s\d+\.py::/.test(k))).toBe(false);
        });

        it('does NOT invent a cross-file edge for a call name the file does not import', () => {
            const snapshot = makeSnapshot({
                'a/foo.py': {
                    content: '',
                    symbols: { functions: [{ name: 'foo', kind: 'function', calls: ['helper'] }], vars: [], imports: [] },
                },
                'b/other.py': {
                    content: '',
                    symbols: { functions: [{ name: 'helper', kind: 'function', calls: [] }], vars: [], imports: [] },
                },
            });
            const graph = buildCallGraph(snapshot);
            const node = graph.getNode('a/foo.py::foo');
            expect(node?.calls ?? []).not.toContain('b/other.py::helper');
        });
    });

    it('non-JS intra-file edges: callee name matched by suffix (#444-A-cohesion)', () => {
        // The C# extractor stores function names as `Outer.Inner.Method` but
        // `extractCalls` records the raw call name `Method` (no class prefix).
        // The resolver needs to map raw call names to their fully-qualified
        // counterparts within the same file.
        const snapshot = makeSnapshot({
            'src/Articles.cs': {
                content: `public class ArticlesController { public void Get() { _mediator.Send(new GetCommand()); } public void Send() {} }`,
                symbols: {
                    functions: [
                        { name: 'ArticlesController.Get', kind: 'function', calls: ['Send'] },
                        { name: 'ArticlesController.Send', kind: 'function', calls: [] },
                    ],
                    vars: [],
                    imports: [],
                },
            },
        });

        const graph = buildCallGraph(snapshot);
        const getNode = graph.getNode('src/Articles.cs::ArticlesController.Get');
        expect(getNode?.calls).toContain('src/Articles.cs::ArticlesController.Send');
    });
});

describe('getFunctionKeysForFiles', () => {
    it('returns all function keys for given file paths', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        graph.ensureNode('a.ts', 'bar');
        graph.ensureNode('b.ts', 'baz');

        const keys = getFunctionKeysForFiles(['a.ts'], graph);
        expect(keys).toContain('a.ts::foo');
        expect(keys).toContain('a.ts::bar');
        expect(keys).not.toContain('b.ts::baz');
    });

    it('returns empty array for unknown file', () => {
        const graph = new WorkspaceCallGraph();
        graph.ensureNode('a.ts', 'foo');
        const keys = getFunctionKeysForFiles(['nonexistent.ts'], graph);
        expect(keys).toHaveLength(0);
    });
});

describe('resolveNonJsModulePath (BUG-L5-WRONGFILE)', () => {
    // polar-style layout: MANY same-basename service.py files.
    const polarFiles = [
        'server/polar/account/service.py',   // does NOT define get_accessible_org_ids
        'server/polar/authz/service.py',     // DOES define get_accessible_org_ids
        'server/polar/customer/service.py',
        'server/polar/order/service.py',
        'server/polar/customer_portal/endpoints/member.py', // the caller
    ];

    it('resolves a dotted Python import to the module named by its FULL path, not the first same-basename file', () => {
        // `from polar.authz.service import get_accessible_org_ids`
        const resolved = resolveNonJsModulePath(
            'polar.authz.service',
            'server/polar/customer_portal/endpoints/member.py',
            polarFiles,
        );
        expect(resolved).toBe('server/polar/authz/service.py');
        // Regression guard: must NOT collide onto account/service.py (first basename match).
        expect(resolved).not.toBe('server/polar/account/service.py');
    });

    it('disambiguates each colliding service.py by its package path', () => {
        expect(resolveNonJsModulePath('polar.account.service', undefined, polarFiles))
            .toBe('server/polar/account/service.py');
        expect(resolveNonJsModulePath('polar.customer.service', undefined, polarFiles))
            .toBe('server/polar/customer/service.py');
    });

    it('resolves a leading-package-dropped path via progressive tail shortening', () => {
        // Import path omits the `server/` root that exists in the file layout.
        expect(resolveNonJsModulePath('authz.service', undefined, polarFiles))
            .toBe('server/polar/authz/service.py');
    });

    it('resolves a relative Python import against the importing file directory', () => {
        const files = [
            'server/polar/authz/service.py',
            'server/polar/authz/scope.py',
            'server/polar/customer/service.py',
        ];
        // `from .service import x` inside server/polar/authz/scope.py
        expect(resolveNonJsModulePath('.service', 'server/polar/authz/scope.py', files))
            .toBe('server/polar/authz/service.py');
    });

    it('resolves a slash-style package path (Go/PHP)', () => {
        const files = ['internal/auth/handler.go', 'internal/order/handler.go'];
        expect(resolveNonJsModulePath('internal/auth/handler', undefined, files))
            .toBe('internal/auth/handler.go');
    });

    it('falls back to bare basename for a single-segment import when unambiguous', () => {
        const files = ['app/helpers/mailer.rb', 'app/models/user.rb'];
        expect(resolveNonJsModulePath('mailer', undefined, files))
            .toBe('app/helpers/mailer.rb');
    });

    it('returns undefined when nothing matches', () => {
        expect(resolveNonJsModulePath('nonexistent.module', undefined, polarFiles))
            .toBeUndefined();
    });
});
