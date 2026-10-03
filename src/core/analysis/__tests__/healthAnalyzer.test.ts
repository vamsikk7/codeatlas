import { describe, it, expect } from 'vitest';
import { analyzeHealth, isFrameworkEntryPoint, isUnresolvedDispatch } from '../healthAnalyzer';
import type { Snapshot, SerializedCallGraph, FeatureCluster, FileRecord, ApiRecord } from '../../graph/graphTypes';

describe('isFrameworkEntryPoint (BUG-POLAR-8 — exclude framework entry points from dead-code)', () => {
    it('excludes Next.js special-file exports', () => {
        expect(isFrameworkEntryPoint('RootLayout', 'app/(authenticated)/layout.tsx')).toBe(true);
        expect(isFrameworkEntryPoint('Page', 'app/home/page.tsx')).toBe(true);
        expect(isFrameworkEntryPoint('handler', 'app/api/webhook/route.ts')).toBe(true);
    });
    it('excludes React components (PascalCase in .tsx/.jsx) + hooks', () => {
        expect(isFrameworkEntryPoint('HomeContent', 'components/HomeContent.tsx')).toBe(true);
        expect(isFrameworkEntryPoint('Providers', 'app/providers.jsx')).toBe(true);
        expect(isFrameworkEntryPoint('useCheckout', 'hooks/useCheckout.ts')).toBe(true);
    });
    it('does NOT exclude genuinely-dead non-framework helpers', () => {
        expect(isFrameworkEntryPoint('computeTotal', 'lib/pricing.ts')).toBe(false);
        expect(isFrameworkEntryPoint('parseInput', 'server/polar/utils.py')).toBe(false);
        expect(isFrameworkEntryPoint('helper', 'components/Card.tsx')).toBe(false);
    });
});

describe('isUnresolvedDispatch (BUG-POLAR-8 rd2 — Python dispatch the call graph cannot resolve)', () => {
    it('suppresses Python dunder methods (language-invoked)', () => {
        expect(isUnresolvedDispatch('PowerLawDistribution.__init__', 'server/load_tests/common/distribution.py')).toBe(true);
        expect(isUnresolvedDispatch('__repr__', 'server/polar/models/user.py')).toBe(true);
    });
    it('suppresses Python class methods (instance dispatch not traced)', () => {
        expect(isUnresolvedDispatch('PowerLawDistribution.select', 'server/load_tests/common/distribution.py')).toBe(true);
        expect(isUnresolvedDispatch('CustomerService.list_payment_methods', 'server/polar/customer/service.py')).toBe(true);
    });
    it('suppresses Python class definitions (instantiation not traced)', () => {
        expect(isUnresolvedDispatch('LoadTestConfig', 'server/load_tests/config.py')).toBe(true);
    });
    it('suppresses Alembic-style framework free-function hooks', () => {
        expect(isUnresolvedDispatch('downgrade', 'server/migrations/versions/xyz.py')).toBe(true);
        expect(isUnresolvedDispatch('run_migrations_online', 'server/migrations/env.py')).toBe(true);
    });
    it('does NOT suppress Python module-level free functions (call graph resolves direct calls)', () => {
        expect(isUnresolvedDispatch('_parse_external_customer_ids', 'server/load_tests/config.py')).toBe(false);
        expect(isUnresolvedDispatch('generate_random_email', 'server/load_tests/common/test_data.py')).toBe(false);
    });
    it('is scoped to Python — JS/TS keep full dead-method detection', () => {
        expect(isUnresolvedDispatch('MyClass.deadMethod', 'src/service.ts')).toBe(false);
        expect(isUnresolvedDispatch('DeadClass', 'src/models.ts')).toBe(false);
        expect(isUnresolvedDispatch('__init__', 'src/weird.js')).toBe(false);
    });
});

describe('analyzeHealth — dead functions: test files excluded (BUG-POLAR-22)', () => {
    it('does not report functions defined in test/spec files', () => {
        const cg = makeCallGraph({
            'clients/apps/app/auth/refreshMiddleware.test.ts::buildTokenResponse': { calls: [], calledBy: [] },
            'server/tests/test_customer.py::make_fixture': { calls: [], calledBy: [] },
            'src/util/__tests__/helper.spec.ts::renderForm': { calls: [], calledBy: [] },
            'src/util/pricing.ts::genuinelyDead': { calls: [], calledBy: [] },
        });
        const snap = makeSnapshot({
            files: {
                'clients/apps/app/auth/refreshMiddleware.test.ts': makeFileRecord([{ name: 'buildTokenResponse' }]),
                'server/tests/test_customer.py': makeFileRecord([{ name: 'make_fixture' }]),
                'src/util/__tests__/helper.spec.ts': makeFileRecord([{ name: 'renderForm' }]),
                'src/util/pricing.ts': makeFileRecord([{ name: 'genuinelyDead' }]),
            },
            callGraph: cg,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('clients/apps/app/auth/refreshMiddleware.test.ts::buildTokenResponse');
        expect(report.deadFunctions).not.toContain('server/tests/test_customer.py::make_fixture');
        expect(report.deadFunctions).not.toContain('src/util/__tests__/helper.spec.ts::renderForm');
        // a genuinely dead non-test function is still reported
        expect(report.deadFunctions).toContain('src/util/pricing.ts::genuinelyDead');
    });
});

describe('analyzeHealth — dead functions: framework-reachability (MCP-EVAL-4)', () => {
    it('does not flag framework-decorated functions (Celery task, pytest fixture) or Depends providers as dead', () => {
        const cg = makeCallGraph({
            'server/polar/tasks.py::auth_delete_expired': { calls: [], calledBy: [] },   // @shared_task
            'server/polar/deps.py::get_db_session': { calls: [], calledBy: [] },           // Depends provider
            'server/polar/util.py::genuinely_dead': { calls: [], calledBy: [] },           // real dead code
            'server/polar/util.py::memoized': { calls: [], calledBy: [] },                 // @lru_cache only → still dead
        });
        const snap = makeSnapshot({
            files: {
                'server/polar/tasks.py': { content: '', symbols: {
                    functions: [{ name: 'auth_delete_expired', decorators: ['@shared_task'] }],
                    variables: [], imports: [],
                } } as any,
                'server/polar/deps.py': { content: '', symbols: {
                    functions: [{ name: 'get_db_session' }], variables: [], imports: [],
                } } as any,
                'server/polar/endpoints.py': { content: '', symbols: {
                    functions: [{ name: 'handler' }], variables: [], imports: [],
                    frameworkRefs: ['get_db_session'],   // Depends(get_db_session) somewhere in this file
                } } as any,
                'server/polar/util.py': { content: '', symbols: {
                    functions: [
                        { name: 'genuinely_dead' },
                        { name: 'memoized', decorators: ['@lru_cache'] },
                    ],
                    variables: [], imports: [],
                } } as any,
            },
            callGraph: cg,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('server/polar/tasks.py::auth_delete_expired');
        expect(report.deadFunctions).not.toContain('server/polar/deps.py::get_db_session');
        // Real dead code + a util-only-decorated function are still reported.
        expect(report.deadFunctions).toContain('server/polar/util.py::genuinely_dead');
        expect(report.deadFunctions).toContain('server/polar/util.py::memoized');
    });
});

describe('analyzeHealth — dead functions: Python dispatch suppression (BUG-POLAR-8 rd2)', () => {
    it('does not report Python methods/classes/dunders, but still reports a dead free function', () => {
        const cg = makeCallGraph({
            'server/polar/service.py::CustomerService.list_payment_methods': { calls: [], calledBy: [] },
            'server/polar/service.py::CustomerService.__init__': { calls: [], calledBy: [] },
            'server/polar/config.py::LoadTestConfig': { calls: [], calledBy: [] },
            'server/polar/util.py::truly_dead_helper': { calls: [], calledBy: [] },
        });
        const snap = makeSnapshot({
            files: {
                'server/polar/service.py': makeFileRecord([{ name: 'CustomerService.list_payment_methods' }, { name: 'CustomerService.__init__' }]),
                'server/polar/config.py': makeFileRecord([{ name: 'LoadTestConfig' }]),
                'server/polar/util.py': makeFileRecord([{ name: 'truly_dead_helper' }]),
            },
            callGraph: cg,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('server/polar/service.py::CustomerService.list_payment_methods');
        expect(report.deadFunctions).not.toContain('server/polar/service.py::CustomerService.__init__');
        expect(report.deadFunctions).not.toContain('server/polar/config.py::LoadTestConfig');
        expect(report.deadFunctions).toContain('server/polar/util.py::truly_dead_helper');
    });
});

describe('analyzeHealth — dead functions: decorated route handlers + lifecycle (BUG-HEALTH-DEADCODE)', () => {
    it('does not flag FastAPI @router / NestJS @Controller handlers, lifespan, TypeORM hooks, or class-qualified constructors as dead', () => {
        const cg = makeCallGraph({
            // NestJS controller handler: node is class-qualified, apiIndex handlerName is bare
            'src/article/article.controller.ts::ArticleController.findAll': { calls: [], calledBy: [] },
            'src/article/article.controller.ts::ArticleController.constructor': { calls: [], calledBy: [] },
            'src/article/article.entity.ts::ArticleEntity.updateTimestamp': { calls: [], calledBy: [] }, // @BeforeUpdate
            // FastAPI @router handler: node filePath missing the `server/` prefix apiIndex has
            'polar/backoffice/customers/endpoints.py::restore_customer': { calls: [], calledBy: [] },
            'server/polar/app.py::lifespan': { calls: [], calledBy: [] },       // FastAPI lifespan
            'src/util/pricing.ts::genuinelyDead': { calls: [], calledBy: [] },   // real dead code
        });
        const snap = makeSnapshot({
            apiIndex: {
                a1: { filePath: 'src/article/article.controller.ts', handlerName: 'findAll', method: 'GET', route: '/', stableKey: 'a1' } as any,
                a2: { filePath: 'server/polar/backoffice/customers/endpoints.py', handlerName: 'restore_customer', method: 'POST', route: '/restore', stableKey: 'a2' } as any,
            },
            files: {
                'src/article/article.entity.ts': { content: '', symbols: {
                    functions: [{ name: 'ArticleEntity.updateTimestamp', decorators: ['@BeforeUpdate()'] }], variables: [], imports: [],
                } } as any,
                'src/util/pricing.ts': { content: '', symbols: { functions: [{ name: 'genuinelyDead' }], variables: [], imports: [] } } as any,
            },
            callGraph: cg,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('src/article/article.controller.ts::ArticleController.findAll');
        expect(report.deadFunctions).not.toContain('src/article/article.controller.ts::ArticleController.constructor');
        expect(report.deadFunctions).not.toContain('src/article/article.entity.ts::ArticleEntity.updateTimestamp');
        expect(report.deadFunctions).not.toContain('polar/backoffice/customers/endpoints.py::restore_customer');
        expect(report.deadFunctions).not.toContain('server/polar/app.py::lifespan');
        // real dead code is still reported
        expect(report.deadFunctions).toContain('src/util/pricing.ts::genuinelyDead');
    });
});

function makeSnapshot(overrides?: Partial<Snapshot>): Snapshot {
    return {
        files: {},
        apiIndex: {},
        graphs: {},
        ...overrides,
    };
}

function makeFileRecord(
    functions: Array<{ name: string; exported?: boolean }>,
    variables: Array<{ name: string; exported?: boolean }> = [],
    imports: Array<{ source: string }> = [],
): FileRecord {
    return {
        content: '',
        symbols: {
            functions: functions.map((f) => ({
                name: f.name,
                kind: 'function' as const,
                span: { start: 0, end: 0 },
                bodyText: '',
                exported: f.exported,
            })),
            variables: variables.map((v) => ({
                name: v.name,
                kind: 'variable' as const,
                exported: v.exported,
            })),
            imports: imports.map((i) => ({
                source: i.source,
                specifiers: [],
                span: { start: 0, end: 0 },
                stableKey: i.source,
            })),
        },
        lastModified: 0,
    } as FileRecord;
}

function makeCallGraph(
    nodes: Record<string, { calls: string[]; calledBy: string[] }>,
    edges?: Array<{ callerKey: string; calleeKey: string; confidence?: number; kind?: string }>,
): SerializedCallGraph {
    const cgNodes: Record<string, any> = {};
    for (const [key, val] of Object.entries(nodes)) {
        const [filePath, functionName] = key.split('::');
        cgNodes[key] = {
            key,
            filePath,
            functionName,
            calls: val.calls,
            calledBy: val.calledBy,
        };
    }
    const flatEdges = edges ?? [];
    // If no explicit edges provided, derive from node data
    if (flatEdges.length === 0) {
        for (const [key, val] of Object.entries(nodes)) {
            for (const callee of val.calls) {
                flatEdges.push({ callerKey: key, calleeKey: callee, confidence: 0.9, kind: 'calls' });
            }
        }
    }
    return {
        nodes: cgNodes,
        edges: flatEdges.map((e) => ({
            callerKey: e.callerKey,
            calleeKey: e.calleeKey,
            confidence: e.confidence ?? 0.9,
            kind: (e.kind ?? 'calls') as any,
        })),
        version: 2,
    };
}

// ─── Dead Code ─────────────────────────────────────────────────────────────

describe('analyzeHealth — dead functions', () => {
    it('flags a function with no callers as dead', () => {
        const cg = makeCallGraph({
            'src/helper.ts::unused': { calls: [], calledBy: [] },
            'src/main.ts::main': { calls: ['src/helper.ts::unused'], calledBy: [] },
        });
        // 'main' is an entry point name → excluded, but 'unused' is called by main → not dead
        // Let's test a truly dead function
        const cg2 = makeCallGraph({
            'src/helper.ts::deadHelper': { calls: [], calledBy: [] },
            'src/main.ts::main': { calls: [], calledBy: [] },
        });
        const snap = makeSnapshot({
            files: {
                'src/helper.ts': makeFileRecord([{ name: 'deadHelper' }]),
                'src/main.ts': makeFileRecord([{ name: 'main' }]),
            },
            callGraph: cg2,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).toContain('src/helper.ts::deadHelper');
        // 'main' is an entry point — should NOT be flagged
        expect(report.deadFunctions).not.toContain('src/main.ts::main');
    });

    it('does not flag a function that has callers', () => {
        const cg = makeCallGraph({
            'src/a.ts::fn': { calls: ['src/b.ts::helper'], calledBy: [] },
            'src/b.ts::helper': { calls: [], calledBy: ['src/a.ts::fn'] },
        });
        const snap = makeSnapshot({
            files: {
                'src/a.ts': makeFileRecord([{ name: 'fn' }]),
                'src/b.ts': makeFileRecord([{ name: 'helper' }]),
            },
            callGraph: cg,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('src/b.ts::helper');
    });

    it('does not flag an API handler as dead', () => {
        const cg = makeCallGraph({
            'src/routes.ts::getUsers': { calls: [], calledBy: [] },
        });
        const snap = makeSnapshot({
            files: { 'src/routes.ts': makeFileRecord([{ name: 'getUsers' }]) },
            callGraph: cg,
            apiIndex: {
                'api1': { apiId: 'api1', method: 'GET', route: '/users', filePath: 'src/routes.ts', handlerName: 'getUsers' } as ApiRecord,
            },
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('src/routes.ts::getUsers');
    });

    it('does not flag functions that are called by other functions', () => {
        const cg = makeCallGraph({
            'src/lib.ts::usedFn': { calls: [], calledBy: ['src/app.ts::main'] },
            'src/app.ts::main': { calls: ['src/lib.ts::usedFn'], calledBy: [] },
        });
        const snap = makeSnapshot({
            files: {
                'src/lib.ts': makeFileRecord([{ name: 'usedFn' }]),
                'src/app.ts': makeFileRecord([{ name: 'main' }]),
            },
            callGraph: cg,
        });
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).not.toContain('src/lib.ts::usedFn');
    });

    it('returns empty when deadCodeEnabled is false', () => {
        const cg = makeCallGraph({
            'src/a.ts::dead': { calls: [], calledBy: [] },
        });
        const snap = makeSnapshot({
            files: { 'src/a.ts': makeFileRecord([{ name: 'dead' }]) },
            callGraph: cg,
        });
        const report = analyzeHealth(snap, { deadCodeEnabled: false });
        expect(report.deadFunctions).toEqual([]);
    });

    it('does not crash on empty snapshot', () => {
        const snap = makeSnapshot();
        const report = analyzeHealth(snap);
        expect(report.deadFunctions).toEqual([]);
        expect(report.godFiles).toEqual([]);
        expect(report.cyclicDependencies).toEqual([]);
    });
});

// ─── God Files ─────────────────────────────────────────────────────────────

describe('analyzeHealth — god files', () => {
    it('flags a file with symbols above threshold', () => {
        const fns = Array.from({ length: 20 }, (_, i) => ({ name: `fn${i}` }));
        const snap = makeSnapshot({
            files: { 'src/godFile.ts': makeFileRecord(fns) },
        });
        const report = analyzeHealth(snap, { godFileThreshold: 15 });
        expect(report.godFiles).toContain('src/godFile.ts');
    });

    it('does not flag a file below threshold', () => {
        const fns = Array.from({ length: 14 }, (_, i) => ({ name: `fn${i}` }));
        const snap = makeSnapshot({
            files: { 'src/small.ts': makeFileRecord(fns) },
        });
        const report = analyzeHealth(snap, { godFileThreshold: 15 });
        expect(report.godFiles).not.toContain('src/small.ts');
    });

    it('counts functions + variables together', () => {
        const fns = Array.from({ length: 10 }, (_, i) => ({ name: `fn${i}` }));
        const vars = Array.from({ length: 8 }, (_, i) => ({ name: `var${i}` }));
        const snap = makeSnapshot({
            files: { 'src/mixed.ts': makeFileRecord(fns, vars) },
        });
        const report = analyzeHealth(snap, { godFileThreshold: 15 });
        expect(report.godFiles).toContain('src/mixed.ts');
    });
});

// ─── High Coupling ─────────────────────────────────────────────────────────

describe('analyzeHealth — high coupling', () => {
    it('flags a file with many outgoing cross-file edges', () => {
        const nodes: Record<string, { calls: string[]; calledBy: string[] }> = {};
        const callees: string[] = [];
        for (let i = 0; i < 12; i++) {
            const key = `src/dep${i}.ts::fn`;
            nodes[key] = { calls: [], calledBy: ['src/hub.ts::main'] };
            callees.push(key);
        }
        nodes['src/hub.ts::main'] = { calls: callees, calledBy: [] };

        const snap = makeSnapshot({
            files: {
                'src/hub.ts': makeFileRecord([{ name: 'main' }]),
                ...Object.fromEntries(
                    Array.from({ length: 12 }, (_, i) => [`src/dep${i}.ts`, makeFileRecord([{ name: 'fn' }])]),
                ),
            },
            callGraph: makeCallGraph(nodes),
        });
        const report = analyzeHealth(snap, { highCouplingThreshold: 10 });
        expect(report.highCouplingFiles).toContain('src/hub.ts');
    });

    it('does not flag intra-file edges', () => {
        const cg = makeCallGraph({
            'src/a.ts::fn1': { calls: ['src/a.ts::fn2', 'src/a.ts::fn3'], calledBy: [] },
            'src/a.ts::fn2': { calls: [], calledBy: ['src/a.ts::fn1'] },
            'src/a.ts::fn3': { calls: [], calledBy: ['src/a.ts::fn1'] },
        });
        const snap = makeSnapshot({
            files: { 'src/a.ts': makeFileRecord([{ name: 'fn1' }, { name: 'fn2' }, { name: 'fn3' }]) },
            callGraph: cg,
        });
        const report = analyzeHealth(snap, { highCouplingThreshold: 1 });
        expect(report.highCouplingFiles).not.toContain('src/a.ts');
    });
});

// ─── Cyclic Dependencies ───────────────────────────────────────────────────

describe('analyzeHealth — cyclic dependencies', () => {
    it('detects A → B → C → A import cycle', () => {
        const snap = makeSnapshot({
            files: {
                'src/a.ts': makeFileRecord([], [], [{ source: './b' }]),
                'src/b.ts': makeFileRecord([], [], [{ source: './c' }]),
                'src/c.ts': makeFileRecord([], [], [{ source: './a' }]),
            },
        });
        const report = analyzeHealth(snap);
        expect(report.cyclicDependencies.length).toBeGreaterThanOrEqual(1);
        // The cycle should contain all three files
        const cycleFiles = new Set(report.cyclicDependencies[0]);
        expect(cycleFiles.has('src/a.ts')).toBe(true);
        expect(cycleFiles.has('src/b.ts')).toBe(true);
        expect(cycleFiles.has('src/c.ts')).toBe(true);
    });

    it('does not report false positive for A → B (no back-edge)', () => {
        const snap = makeSnapshot({
            files: {
                'src/a.ts': makeFileRecord([], [], [{ source: './b' }]),
                'src/b.ts': makeFileRecord([], [], []),
            },
        });
        const report = analyzeHealth(snap);
        expect(report.cyclicDependencies).toEqual([]);
    });

    it('ignores package imports (non-relative)', () => {
        const snap = makeSnapshot({
            files: {
                'src/a.ts': makeFileRecord([], [], [{ source: 'lodash' }, { source: './b' }]),
                'src/b.ts': makeFileRecord([], [], [{ source: 'express' }]),
            },
        });
        const report = analyzeHealth(snap);
        expect(report.cyclicDependencies).toEqual([]);
    });
});

// ─── Orphaned Clusters ─────────────────────────────────────────────────────

describe('analyzeHealth — orphaned clusters', () => {
    it('flags a cluster with no cross-cluster call edges', () => {
        const clusters: Record<string, FeatureCluster> = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth', files: ['src/auth.ts'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
            'cluster:todos': {
                id: 'cluster:todos', label: 'todos', files: ['src/todos.ts'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
        };
        // Only intra-cluster edges
        const cg = makeCallGraph({
            'src/auth.ts::login': { calls: [], calledBy: [] },
            'src/todos.ts::list': { calls: [], calledBy: [] },
        });
        const snap = makeSnapshot({ clusters, callGraph: cg });
        const report = analyzeHealth(snap);
        expect(report.orphanedClusters).toContain('cluster:auth');
        expect(report.orphanedClusters).toContain('cluster:todos');
    });

    it('does not flag clusters with cross-cluster edges', () => {
        const clusters: Record<string, FeatureCluster> = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth', files: ['src/auth.ts'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
            'cluster:todos': {
                id: 'cluster:todos', label: 'todos', files: ['src/todos.ts'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
        };
        const cg = makeCallGraph({
            'src/auth.ts::getUser': { calls: [], calledBy: ['src/todos.ts::list'] },
            'src/todos.ts::list': { calls: ['src/auth.ts::getUser'], calledBy: [] },
        });
        const snap = makeSnapshot({ clusters, callGraph: cg });
        const report = analyzeHealth(snap);
        expect(report.orphanedClusters).toEqual([]);
    });
});
