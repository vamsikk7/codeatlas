import { describe, it, expect } from 'vitest';
import { detectCommunities, diffClusters, findClusterForFile, stabilizeClusters, detectSubClusters } from '../communityDetector';
import { WorkspaceCallGraph } from '../../graph/callGraphResolver';
import type { Snapshot, FileRecord, FeatureCluster } from '../../graph/graphTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnapshot(
    filePaths: string[],
    callEdges: Array<[string, string]> = [] // ["fileA::fnA", "fileB::fnB"]
): Snapshot {
    const files: Record<string, FileRecord> = {};
    for (const fp of filePaths) {
        files[fp] = {
            content: '',
            symbols: { functions: [], vars: [], imports: [] },
            lastModified: 0,
        };
    }
    return { files, apiIndex: {}, graphs: {} };
}

function makeCallGraph(nodes: string[], edges: Array<[string, string]>): WorkspaceCallGraph {
    const graph = new WorkspaceCallGraph();
    for (const key of nodes) {
        const [fp, fn] = key.split('::');
        if (fp && fn) graph.ensureNode(fp, fn);
    }
    for (const [caller, callee] of edges) {
        graph.addEdge(caller, callee);
    }
    return graph;
}

const dummySpan = { start: 0, end: 0 };

/**
 * Build a Snapshot where files carry explicit import declarations.
 * imports: { 'fileA.js': ['./fileB', './fileC'] }
 */
function makeSnapshotWithImports(
    imports: Record<string, string[]>
): Snapshot {
    const files: Record<string, FileRecord> = {};
    for (const [fp, srcs] of Object.entries(imports)) {
        files[fp] = {
            path: fp,
            hash: `hash:${fp}`,
            mtime: 0,
            content: '',
            symbols: {
                functions: [],
                variables: [],
                imports: srcs.map((source, i) => ({
                    source,
                    specifiers: [],
                    span: dummySpan,
                    stableKey: `${fp}:i${i}`,
                })),
            },
        } as unknown as FileRecord;
    }
    return { files, apiIndex: {}, graphs: {} };
}

// ---------------------------------------------------------------------------
// Test-drift-like fixture
//
// Mirrors the structure of a typical Express backend:
//   backend/features/auth/     – 4 source files
//   backend/features/todos/    – 5 source files
//   backend/middleware/        – 1 shared middleware
//   backend/utils/             – 2 shared utilities
//   backend/config/            – 1 config file
//   backend/index.js           – hub that imports BOTH auth and todos
//
// The hub + shared middleware are the tricky nodes — they connect both
// feature clusters equally, so a naive tie-break merges everything.
// ---------------------------------------------------------------------------

function makeTestDriftCallGraph(): WorkspaceCallGraph {
    const AUTH = 'backend/features/auth';
    const TODO = 'backend/features/todos';
    const nodes = [
        `${AUTH}/authController.js::handleAuth`,
        `${AUTH}/authRoutes.js::routes`,
        `${AUTH}/index.js::index`,
        `${AUTH}/userModel.js::UserModel`,
        `${TODO}/todoController.js::handleTodo`,
        `${TODO}/todoRoutes.js::routes`,
        `${TODO}/index.js::index`,
        `${TODO}/todoModel.js::TodoModel`,
        `${TODO}/todoService.js::createTodo`,
        'backend/middleware/authMiddleware.js::authenticate',
        'backend/utils/password.js::hashPassword',
        'backend/utils/token.js::signToken',
        'backend/config/db.js::connectDB',
        'backend/index.js::start',
    ];

    const edges: Array<[string, string]> = [
        // Auth internals
        [`${AUTH}/authRoutes.js::routes`,      `${AUTH}/authController.js::handleAuth`],
        [`${AUTH}/authController.js::handleAuth`, `${AUTH}/userModel.js::UserModel`],
        [`${AUTH}/authController.js::handleAuth`, 'backend/utils/password.js::hashPassword'],
        [`${AUTH}/authController.js::handleAuth`, 'backend/utils/token.js::signToken'],
        [`${AUTH}/index.js::index`,             `${AUTH}/authRoutes.js::routes`],
        // Auth uses shared middleware
        [`${AUTH}/authRoutes.js::routes`, 'backend/middleware/authMiddleware.js::authenticate'],
        // Todo internals
        [`${TODO}/todoRoutes.js::routes`,  `${TODO}/todoController.js::handleTodo`],
        [`${TODO}/todoController.js::handleTodo`, `${TODO}/todoService.js::createTodo`],
        [`${TODO}/todoService.js::createTodo`, `${TODO}/todoModel.js::TodoModel`],
        [`${TODO}/index.js::index`,         `${TODO}/todoRoutes.js::routes`],
        // Todo uses shared middleware
        [`${TODO}/todoRoutes.js::routes`, 'backend/middleware/authMiddleware.js::authenticate'],
        // Hub connects both
        ['backend/index.js::start', `${AUTH}/index.js::index`],
        ['backend/index.js::start', `${TODO}/index.js::index`],
        ['backend/index.js::start', 'backend/config/db.js::connectDB'],
        ['backend/index.js::start', 'backend/middleware/authMiddleware.js::authenticate'],
    ];

    return makeCallGraph(nodes, edges);
}

function makeTestDriftSnapshot(): Snapshot {
    return makeSnapshot([
        'backend/features/auth/authController.js',
        'backend/features/auth/authRoutes.js',
        'backend/features/auth/index.js',
        'backend/features/auth/userModel.js',
        'backend/features/todos/todoController.js',
        'backend/features/todos/todoRoutes.js',
        'backend/features/todos/index.js',
        'backend/features/todos/todoModel.js',
        'backend/features/todos/todoService.js',
        'backend/middleware/authMiddleware.js',
        'backend/utils/password.js',
        'backend/utils/token.js',
        'backend/config/db.js',
        'backend/index.js',
    ]);
}

// ---------------------------------------------------------------------------
// detectCommunities — basic behaviour
// ---------------------------------------------------------------------------

describe('detectCommunities', () => {
    it('returns empty clusters for empty snapshot', () => {
        const snapshot = makeSnapshot([]);
        const clusters = detectCommunities(snapshot);
        expect(Object.keys(clusters)).toHaveLength(0);
    });

    it('keeps migration files carrying DB_MIGRATION APIs clusterable so they surface in L2a (BUG-MIGRATION-SURFACE)', () => {
        const snapshot: Snapshot = {
            files: {
                'server/migrations/versions/0001_init.py': { content: '', symbols: { functions: [{ name: 'upgrade', kind: 'function', span: dummySpan, bodyText: '' }], vars: [], imports: [] }, lastModified: 0 } as any,
                'server/app/service.py': { content: '', symbols: { functions: [{ name: 'do', kind: 'function', span: dummySpan, bodyText: '' }], vars: [], imports: [] }, lastModified: 0 } as any,
            },
            apiIndex: {
                m1: { method: 'DB_MIGRATION', route: 'migration:0001_init', handlerName: 'upgrade', filePath: 'server/migrations/versions/0001_init.py', stableKey: 'm1' } as any,
                s1: { method: 'GET', route: '/x', handlerName: 'do', filePath: 'server/app/service.py', stableKey: 's1' } as any,
            },
            graphs: {},
        };
        const clusters = detectCommunities(snapshot);
        const allApis = Object.values(clusters).flatMap((c) => c.apisInCluster ?? []);
        expect(allApis.some((a) => a.method === 'DB_MIGRATION')).toBe(true);
    });

    it('creates at least one cluster for a single file', () => {
        const snapshot = makeSnapshot(['src/auth/login.ts']);
        const clusters = detectCommunities(snapshot);
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(1);
    });

    it('groups connected files into fewer clusters than isolated files', () => {
        const snapshot = makeSnapshot(['auth/a.ts', 'auth/b.ts', 'auth/c.ts']);
        const callGraph = makeCallGraph(
            ['auth/a.ts::fn', 'auth/b.ts::fn', 'auth/c.ts::fn'],
            [
                ['auth/a.ts::fn', 'auth/b.ts::fn'],
                ['auth/b.ts::fn', 'auth/c.ts::fn'],
            ]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const allFiles = Object.values(clusters).flatMap((c) => c.files);
        expect(allFiles).toContain('auth/a.ts');
        expect(allFiles).toContain('auth/b.ts');
        expect(allFiles).toContain('auth/c.ts');
        expect(Object.keys(clusters).length).toBeLessThanOrEqual(2);
    });

    it('each cluster has required fields', () => {
        const snapshot = makeSnapshot(['src/payments/pay.ts', 'src/payments/invoice.ts']);
        const callGraph = makeCallGraph(
            ['src/payments/pay.ts::pay', 'src/payments/invoice.ts::invoice'],
            [['src/payments/pay.ts::pay', 'src/payments/invoice.ts::invoice']]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        for (const cluster of Object.values(clusters)) {
            expect(cluster.id).toBeTruthy();
            expect(cluster.label).toBeTruthy();
            expect(cluster.name).toBe(cluster.label);
            expect(Array.isArray(cluster.files)).toBe(true);
            expect(Array.isArray(cluster.entryPoints)).toBe(true);
            expect(typeof cluster.internalCallCount).toBe('number');
            expect(typeof cluster.externalCallCount).toBe('number');
        }
    });

    // Issue #775: clusters should record internal vs external call counts
    // so the L2a cohesion ratio (= internal / (internal + external)) is
    // a real percentage, not always 0%. The persisted cluster JSON
    // round-trips both fields.
    it('#775 records non-zero internalCallCount when members call each other', () => {
        const snapshot = makeSnapshot([
            'src/auth/login.ts', 'src/auth/logout.ts', 'src/auth/session.ts',
        ]);
        // Dense intra-cluster graph: every file calls every other.
        const callGraph = makeCallGraph(
            [
                'src/auth/login.ts::loginFn',
                'src/auth/logout.ts::logoutFn',
                'src/auth/session.ts::sessionFn',
            ],
            [
                ['src/auth/login.ts::loginFn', 'src/auth/logout.ts::logoutFn'],
                ['src/auth/login.ts::loginFn', 'src/auth/session.ts::sessionFn'],
                ['src/auth/logout.ts::logoutFn', 'src/auth/session.ts::sessionFn'],
                ['src/auth/session.ts::sessionFn', 'src/auth/login.ts::loginFn'],
            ]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const totalInternal = Object.values(clusters)
            .reduce((acc, c) => acc + c.internalCallCount, 0);
        expect(totalInternal).toBeGreaterThan(0);
    });

    it('#775 records non-zero externalCallCount when cluster members call out', () => {
        // Force two distinct clusters: A1/A2 dense intra, B1/B2 dense
        // intra, single weak cross-cluster call A1 → B1. Louvain
        // prefers the dense intra-edges so A's stay together and B's
        // stay together; the cross call becomes external for A.
        const snapshot = makeSnapshot([
            'src/auth/a1.ts', 'src/auth/a2.ts',
            'src/billing/b1.ts', 'src/billing/b2.ts',
        ]);
        const callGraph = makeCallGraph(
            ['src/auth/a1.ts::fn', 'src/auth/a2.ts::fn',
             'src/billing/b1.ts::fn', 'src/billing/b2.ts::fn'],
            [
                // A1 ↔ A2 (dense intra)
                ['src/auth/a1.ts::fn', 'src/auth/a2.ts::fn'],
                ['src/auth/a2.ts::fn', 'src/auth/a1.ts::fn'],
                // B1 ↔ B2 (dense intra)
                ['src/billing/b1.ts::fn', 'src/billing/b2.ts::fn'],
                ['src/billing/b2.ts::fn', 'src/billing/b1.ts::fn'],
                // Single cross-cluster edge.
                ['src/auth/a1.ts::fn', 'src/billing/b1.ts::fn'],
            ]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const totalExternal = Object.values(clusters)
            .reduce((acc, c) => acc + c.externalCallCount, 0);
        expect(totalExternal).toBeGreaterThan(0);
    });

    it('#775 cluster JSON round-trip preserves both call counts', () => {
        const snapshot = makeSnapshot([
            'src/orders/list.ts', 'src/orders/detail.ts',
        ]);
        const callGraph = makeCallGraph(
            ['src/orders/list.ts::list', 'src/orders/detail.ts::detail'],
            [['src/orders/list.ts::list', 'src/orders/detail.ts::detail']]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        for (const cluster of Object.values(clusters)) {
            const round = JSON.parse(JSON.stringify(cluster));
            expect(round.internalCallCount).toBe(cluster.internalCallCount);
            expect(round.externalCallCount).toBe(cluster.externalCallCount);
        }
    });

    it('infers cluster label from directory name', () => {
        const snapshot = makeSnapshot(['payments/pay.ts', 'payments/invoice.ts']);
        const callGraph = makeCallGraph(
            ['payments/pay.ts::pay', 'payments/invoice.ts::invoice'],
            [['payments/pay.ts::pay', 'payments/invoice.ts::invoice']]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);
        expect(labels).toContain('payments');
    });

    it('uses import edges to cluster files when call graph is empty', () => {
        const snapshot: Snapshot = {
            files: {
                'src/features/todos/todoRoutes.ts': {
                    path: 'src/features/todos/todoRoutes.ts',
                    hash: 'h1',
                    mtime: 0,
                    content: '',
                    symbols: {
                        functions: [],
                        variables: [],
                        imports: [{ source: './todoController', specifiers: [], span: dummySpan, stableKey: 'i1' }],
                    },
                },
                'src/features/todos/todoController.ts': {
                    path: 'src/features/todos/todoController.ts',
                    hash: 'h2',
                    mtime: 0,
                    content: '',
                    symbols: {
                        functions: [],
                        variables: [],
                        imports: [{ source: './todoModel', specifiers: [], span: dummySpan, stableKey: 'i2' }],
                    },
                },
                'src/features/todos/todoModel.ts': {
                    path: 'src/features/todos/todoModel.ts',
                    hash: 'h3',
                    mtime: 0,
                    content: '',
                    symbols: { functions: [], variables: [], imports: [] },
                },
            },
            apiIndex: {},
            graphs: {},
        };
        const emptyGraph = makeCallGraph([], []);
        const clusters = detectCommunities(snapshot, emptyGraph);
        expect(Object.keys(clusters).length).toBeLessThan(3);
        const allFiles = Object.values(clusters).flatMap((c) => c.files);
        expect(allFiles).toContain('src/features/todos/todoRoutes.ts');
        expect(allFiles).toContain('src/features/todos/todoController.ts');
        expect(allFiles).toContain('src/features/todos/todoModel.ts');
    });

    it('skips "features" directory segment when inferring cluster label', () => {
        const snapshot = makeSnapshot([
            'src/features/todos/todoRoutes.ts',
            'src/features/todos/todoController.ts',
        ]);
        const callGraph = makeCallGraph(
            ['src/features/todos/todoRoutes.ts::fn', 'src/features/todos/todoController.ts::fn'],
            [['src/features/todos/todoRoutes.ts::fn', 'src/features/todos/todoController.ts::fn']]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);
        expect(labels.some((l) => l === 'todos')).toBe(true);
        expect(labels.every((l) => l !== 'features')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test-drift fixture tests — hub stability
// ---------------------------------------------------------------------------

describe('detectCommunities — test-drift mock (auth + todos)', () => {
    it('produces separate auth and todos clusters despite shared hub node', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);

        // Both feature names must appear as separate clusters
        expect(labels).toContain('auth');
        expect(labels).toContain('todos');
    });

    it('auth cluster contains all core auth feature files', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        const authCluster = Object.values(clusters).find((c) => c.label === 'auth');
        expect(authCluster).toBeDefined();
        // Core auth files must be in the auth cluster
        expect(authCluster!.files).toContain('backend/features/auth/authController.js');
        expect(authCluster!.files).toContain('backend/features/auth/userModel.js');
    });

    it('todos cluster contains all core todo feature files', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        const todosCluster = Object.values(clusters).find((c) => c.label === 'todos');
        expect(todosCluster).toBeDefined();
        // Core todos files must be in the todos cluster
        expect(todosCluster!.files).toContain('backend/features/todos/todoController.js');
        expect(todosCluster!.files).toContain('backend/features/todos/todoModel.js');
        expect(todosCluster!.files).toContain('backend/features/todos/todoService.js');
    });

    it('auth and todos clusters are disjoint (no file appears in both)', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        const authCluster = Object.values(clusters).find((c) => c.label === 'auth');
        const todosCluster = Object.values(clusters).find((c) => c.label === 'todos');

        if (!authCluster || !todosCluster) return; // skip if not produced
        const authSet = new Set(authCluster.files);
        const overlap = todosCluster.files.filter((f) => authSet.has(f));
        expect(overlap).toHaveLength(0);
    });

    it('hub node (backend/index.js) does not collapse auth and todos into one cluster', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        // We must have at least 2 distinct clusters covering auth and todos
        const authExists = Object.values(clusters).some((c) => c.label === 'auth');
        const todosExists = Object.values(clusters).some((c) => c.label === 'todos');
        expect(authExists).toBe(true);
        expect(todosExists).toBe(true);
    });

    it('every clusterable backend file is assigned to exactly one cluster', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        const assignedFiles = Object.values(clusters).flatMap((c) => c.files);
        const assignedSet = new Set(assignedFiles);

        // Root-level entry points (backend/index.js) are excluded from clustering
        const EXCLUDED = new Set(['backend/index.js']);
        for (const fp of Object.keys(snapshot.files)) {
            if (EXCLUDED.has(fp)) continue;
            expect(assignedSet.has(fp)).toBe(true);
        }
        // No file should be double-assigned
        expect(assignedFiles.length).toBe(new Set(assignedFiles).size);
    });
});

// ---------------------------------------------------------------------------
// Hub-node stability: equal connections to two clusters must not merge them
// ---------------------------------------------------------------------------

describe('detectCommunities — no duplicate cluster labels', () => {
    it('each cluster label appears exactly once even when multiple propagation groups infer the same name', () => {
        // auth/middleware.ts and app/middleware.ts both infer label "app" (middleware is SKIP)
        // They should be merged into one cluster, not two "app" clusters
        const callGraph = makeCallGraph(
            [
                'auth/handler.ts::fn',
                'auth/model.ts::fn',
                'app/middleware.ts::fn',
                'app/index.ts::fn',
            ],
            [
                ['auth/handler.ts::fn', 'auth/model.ts::fn'],
                ['app/index.ts::fn',    'auth/handler.ts::fn'],
                ['app/index.ts::fn',    'app/middleware.ts::fn'],
            ]
        );
        const snapshot = makeSnapshot([
            'auth/handler.ts',
            'auth/model.ts',
            'app/middleware.ts',
            'app/index.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);

        // No label should appear more than once
        const labelCounts = new Map<string, number>();
        for (const l of labels) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
        for (const [label, count] of labelCounts) {
            expect(count, `label "${label}" appears ${count} times`).toBe(1);
        }
    });

    it('test-drift: no cluster label appears more than once', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);

        const seen = new Set<string>();
        for (const label of labels) {
            expect(seen.has(label), `duplicate cluster label: "${label}"`).toBe(false);
            seen.add(label);
        }
    });

    it('test-drift: cluster IDs are stable (cluster:label format, no numeric suffix)', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        for (const [id, cluster] of Object.entries(clusters)) {
            expect(id).toBe(`cluster:${cluster.label}`);
        }
    });

    it('test-drift: cluster.name equals cluster.label for all clusters', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);

        for (const cluster of Object.values(clusters)) {
            expect(cluster.name).toBe(cluster.label);
        }
    });
});

describe('detectCommunities — hub node stability', () => {
    it('a hub connecting two feature dirs equally does not merge them', () => {
        // hub.js imports both payment/service.ts and shipping/service.ts
        const callGraph = makeCallGraph(
            [
                'payments/service.ts::payFn',
                'payments/repo.ts::repoFn',
                'shipping/service.ts::shipFn',
                'shipping/repo.ts::repoFn',
                'app/hub.ts::main',
            ],
            [
                ['payments/service.ts::payFn',  'payments/repo.ts::repoFn'],
                ['shipping/service.ts::shipFn', 'shipping/repo.ts::repoFn'],
                // hub calls both
                ['app/hub.ts::main', 'payments/service.ts::payFn'],
                ['app/hub.ts::main', 'shipping/service.ts::shipFn'],
            ]
        );
        const snapshot = makeSnapshot([
            'payments/service.ts',
            'payments/repo.ts',
            'shipping/service.ts',
            'shipping/repo.ts',
            'app/hub.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);

        expect(labels).toContain('payments');
        expect(labels).toContain('shipping');
    });

    it('shared utility called by both clusters stays independent or merges without collapsing clusters', () => {
        // shared.ts is called by both auth and todos; should not merge the two
        const callGraph = makeCallGraph(
            [
                'auth/controller.ts::authFn',
                'auth/model.ts::AuthModel',
                'todos/controller.ts::todoFn',
                'todos/model.ts::TodoModel',
                'shared/utils.ts::util',
            ],
            [
                ['auth/controller.ts::authFn',  'auth/model.ts::AuthModel'],
                ['auth/controller.ts::authFn',  'shared/utils.ts::util'],
                ['todos/controller.ts::todoFn', 'todos/model.ts::TodoModel'],
                ['todos/controller.ts::todoFn', 'shared/utils.ts::util'],
            ]
        );
        const snapshot = makeSnapshot([
            'auth/controller.ts',
            'auth/model.ts',
            'todos/controller.ts',
            'todos/model.ts',
            'shared/utils.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);

        expect(labels).toContain('auth');
        expect(labels).toContain('todos');
    });
});

// ---------------------------------------------------------------------------
// Cluster label inference — propagation label takes priority
// ---------------------------------------------------------------------------

describe('detectCommunities — cluster label inference', () => {
    it('uses deepest non-generic directory segment as cluster name', () => {
        // All files are deeply nested; cluster name should be the feature name
        const snapshot = makeSnapshot([
            'app/modules/payments/paymentService.ts',
            'app/modules/payments/paymentRepo.ts',
            'app/modules/payments/paymentModel.ts',
        ]);
        const callGraph = makeCallGraph(
            [
                'app/modules/payments/paymentService.ts::fn',
                'app/modules/payments/paymentRepo.ts::fn',
                'app/modules/payments/paymentModel.ts::fn',
            ],
            [
                ['app/modules/payments/paymentService.ts::fn', 'app/modules/payments/paymentRepo.ts::fn'],
                ['app/modules/payments/paymentRepo.ts::fn',    'app/modules/payments/paymentModel.ts::fn'],
            ]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);
        // Should use 'payments', not 'modules' or 'app'
        expect(labels).toContain('payments');
        expect(labels.every((l) => l !== 'modules')).toBe(true);
        expect(labels.every((l) => l !== 'app')).toBe(true);
    });

    it('skips generic segments: src, lib, modules, components, services', () => {
        const genericPrefixes = ['src', 'lib', 'modules', 'components', 'services'];
        for (const prefix of genericPrefixes) {
            const snapshot = makeSnapshot([
                `${prefix}/auth/login.ts`,
                `${prefix}/auth/register.ts`,
            ]);
            const callGraph = makeCallGraph(
                [`${prefix}/auth/login.ts::fn`, `${prefix}/auth/register.ts::fn`],
                [[`${prefix}/auth/login.ts::fn`, `${prefix}/auth/register.ts::fn`]]
            );
            const clusters = detectCommunities(snapshot, callGraph);
            const labels = Object.values(clusters).map((c) => c.label);
            expect(labels).toContain('auth');
            expect(labels.every((l) => l !== prefix)).toBe(true);
        }
    });

    it('does not label cluster after generic root when feature name is present', () => {
        // "features" is in SKIP, so cluster should be named "billing" not "features"
        const snapshot = makeSnapshot([
            'src/features/billing/invoice.ts',
            'src/features/billing/payment.ts',
        ]);
        const callGraph = makeCallGraph(
            ['src/features/billing/invoice.ts::fn', 'src/features/billing/payment.ts::fn'],
            [['src/features/billing/invoice.ts::fn', 'src/features/billing/payment.ts::fn']]
        );
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map((c) => c.label);
        expect(labels).toContain('billing');
        expect(labels.every((l) => l !== 'features')).toBe(true);
        expect(labels.every((l) => l !== 'src')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// diffClusters
// ---------------------------------------------------------------------------

describe('diffClusters', () => {
    const baselineCluster: FeatureCluster = {
        id: 'cluster:auth',
        label: 'auth',
        files: ['auth/login.ts', 'auth/logout.ts'],
        entryPoints: [],
        internalCallCount: 5,
        externalCallCount: 1,
    };

    it('marks unchanged clusters as unchanged', () => {
        const working = { 'cluster:auth': { ...baselineCluster } };
        const baseline = { 'cluster:auth': { ...baselineCluster } };
        const result = diffClusters(baseline, working);
        expect(result['cluster:auth']?.diff).toBe('unchanged');
    });

    it('marks new clusters as added', () => {
        const working = { 'cluster:payments': { id: 'cluster:payments', label: 'payments', files: ['p.ts'], entryPoints: [], internalCallCount: 0, externalCallCount: 0 } };
        const baseline = {};
        const result = diffClusters(baseline, working);
        expect(result['cluster:payments']?.diff).toBe('added');
    });

    it('marks clusters with changed files as modified', () => {
        const working = {
            'cluster:auth': { ...baselineCluster, files: ['auth/login.ts', 'auth/register.ts'] },
        };
        const baseline = { 'cluster:auth': baselineCluster };
        const result = diffClusters(baseline, working);
        expect(result['cluster:auth']?.diff).toBe('modified');
    });

    it('marks baseline-only clusters as deleted', () => {
        const working = {};
        const baseline = { 'cluster:auth': baselineCluster };
        const result = diffClusters(baseline, working);
        const deletedEntry = Object.values(result).find((c) => c.label === 'auth' && c.diff === 'deleted');
        expect(deletedEntry).toBeDefined();
    });

    it('marks cluster as modified when a member file content hash changes', () => {
        const working = { 'cluster:auth': { ...baselineCluster } };
        const baseline = { 'cluster:auth': { ...baselineCluster } };
        const baselineFiles = {
            'auth/login.ts': { hash: 'abc123' },
            'auth/logout.ts': { hash: 'def456' },
        };
        const workingFiles = {
            'auth/login.ts': { hash: 'abc123_changed' },
            'auth/logout.ts': { hash: 'def456' },
        };
        const result = diffClusters(baseline, working, baselineFiles, workingFiles);
        expect(result['cluster:auth']?.diff).toBe('modified');
    });

    it('leaves cluster unchanged when file hashes are identical', () => {
        const working = { 'cluster:auth': { ...baselineCluster } };
        const baseline = { 'cluster:auth': { ...baselineCluster } };
        const fileRecords = {
            'auth/login.ts': { hash: 'abc123' },
            'auth/logout.ts': { hash: 'def456' },
        };
        const result = diffClusters(baseline, working, fileRecords, fileRecords);
        expect(result['cluster:auth']?.diff).toBe('unchanged');
    });

    // Issue 373: pure membership shifts from clustering jitter must not mark
    // clusters as modified. If a file migrates between clusters between two
    // snapshots but its content hash is unchanged AND it still exists in the
    // workspace, the cluster's diff should stay `unchanged`.
    it('does NOT mark clusters as modified when a file merely migrates between clusters (#373)', () => {
        // Baseline: user.model.ts is in `auth`, profile has 2 files
        const baseline = {
            'cluster:auth': {
                id: 'cluster:auth',
                label: 'auth',
                files: ['auth/login.ts', 'auth/user.model.ts'],
                entryPoints: [],
                internalCallCount: 5,
                externalCallCount: 1,
            },
            'cluster:article': {
                id: 'cluster:article',
                label: 'article',
                files: ['article/article.controller.ts'],
                entryPoints: [],
                internalCallCount: 3,
                externalCallCount: 0,
            },
        };
        // Working: clustering jitter moved user.model.ts from auth to article.
        // Auth lost it, article gained it. NO file content changed.
        const working = {
            'cluster:auth': {
                id: 'cluster:auth',
                label: 'auth',
                files: ['auth/login.ts'],
                entryPoints: [],
                internalCallCount: 5,
                externalCallCount: 1,
            },
            'cluster:article': {
                id: 'cluster:article',
                label: 'article',
                files: ['article/article.controller.ts', 'auth/user.model.ts'],
                entryPoints: [],
                internalCallCount: 3,
                externalCallCount: 0,
            },
        };
        // Identical file hashes across both snapshots — no content changed.
        const fileRecords = {
            'auth/login.ts': { hash: 'h1' },
            'auth/user.model.ts': { hash: 'h2' },
            'article/article.controller.ts': { hash: 'h3' },
        };
        const result = diffClusters(baseline, working, fileRecords, fileRecords);
        expect(result['cluster:auth']?.diff).toBe('unchanged');
        expect(result['cluster:article']?.diff).toBe('unchanged');
    });

    // Companion: an actual content change must still propagate — verify the
    // #373 fix didn't over-correct.
    it('still marks a cluster modified when one of its files has a content hash change after a membership shift (#373 companion)', () => {
        const baseline = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts', 'auth/user.model.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
            'cluster:article': {
                id: 'cluster:article', label: 'article',
                files: ['article/article.controller.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
        };
        const working = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
            'cluster:article': {
                id: 'cluster:article', label: 'article',
                files: ['article/article.controller.ts', 'auth/user.model.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
        };
        const baselineFiles = {
            'auth/login.ts': { hash: 'h1' },
            'auth/user.model.ts': { hash: 'h2' },
            'article/article.controller.ts': { hash: 'h3' },
        };
        const workingFiles = {
            'auth/login.ts': { hash: 'h1' },
            'auth/user.model.ts': { hash: 'h2' },
            'article/article.controller.ts': { hash: 'h3_changed' }, // real edit
        };
        const result = diffClusters(baseline, working, baselineFiles, workingFiles);
        // auth shouldn't be modified — it only lost a file, no member files changed
        expect(result['cluster:auth']?.diff).toBe('unchanged');
        // article must be modified — its existing member file's content changed
        expect(result['cluster:article']?.diff).toBe('modified');
    });

    // A real deletion from the codebase (file gone from workingFiles) must mark
    // the cluster modified — the baseline-only file represents a removed file.
    it('marks cluster modified when a baseline member file is deleted from the codebase (#373)', () => {
        const baseline = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts', 'auth/legacy.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
        };
        const working = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
        };
        // legacy.ts is in baselineFiles but NOT in workingFiles — real delete.
        const baselineFiles = { 'auth/login.ts': { hash: 'h1' }, 'auth/legacy.ts': { hash: 'h2' } };
        const workingFiles = { 'auth/login.ts': { hash: 'h1' } };
        const result = diffClusters(baseline, working, baselineFiles, workingFiles);
        expect(result['cluster:auth']?.diff).toBe('modified');
    });

    // A genuinely-new file added to the codebase must mark the cluster modified.
    it('marks cluster modified when a working file is new to the codebase (#373)', () => {
        const baseline = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
        };
        const working = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts', 'auth/2fa.ts'],
                entryPoints: [], internalCallCount: 1, externalCallCount: 0,
            },
        };
        // 2fa.ts didn't exist in baseline at all.
        const baselineFiles = { 'auth/login.ts': { hash: 'h1' } };
        const workingFiles = { 'auth/login.ts': { hash: 'h1' }, 'auth/2fa.ts': { hash: 'h2' } };
        const result = diffClusters(baseline, working, baselineFiles, workingFiles);
        expect(result['cluster:auth']?.diff).toBe('modified');
    });

    // Issue #423 Mechanism A2 — Louvain's non-determinism on rebuild can SPLIT
    // one baseline cluster into multiple working clusters even when no file
    // content has changed (e.g., Next.js's `cluster:[page]` splits into
    // `[page]` + `[handle]` + `[collection]` on revert). Pre-fix: the
    // "new" cluster IDs (whose files were ALL already in some baseline
    // cluster) get marked `added` by diffClusters. That propagates up through
    // L2a feature graph → L1 microservice service node gets re-marked
    // `modified` post-revert → user sees orange L1 service for what was
    // logically a no-op edit. Lock the post-fix behaviour: if every file in
    // a "new" working cluster already existed in some baseline cluster AND
    // none of those files had a content-hash change, the cluster is a SPLIT
    // (clustering jitter), not a real addition — diff should be `unchanged`.
    it('does NOT mark Louvain-split clusters as added when their files all pre-existed in baseline (#423-A2)', () => {
        // Baseline: one big cluster grouping 4 files
        const baseline = {
            'cluster:[page]': {
                id: 'cluster:[page]',
                label: '[page]',
                files: [
                    'app/[page]/layout.tsx',
                    'app/[page]/page.tsx',
                    'app/product/[handle]/page.tsx',
                    'app/search/[collection]/page.tsx',
                ],
                entryPoints: [],
                internalCallCount: 5,
                externalCallCount: 1,
            },
        };
        // Working: Louvain SPLIT it into 3 clusters. All 4 files still exist
        // in the codebase, no content changes.
        const working = {
            'cluster:[page]': {
                id: 'cluster:[page]', label: '[page]',
                files: ['app/[page]/layout.tsx', 'app/[page]/page.tsx'],
                entryPoints: [], internalCallCount: 2, externalCallCount: 0,
            },
            'cluster:[handle]': {
                id: 'cluster:[handle]', label: '[handle]',
                files: ['app/product/[handle]/page.tsx'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
            'cluster:[collection]': {
                id: 'cluster:[collection]', label: '[collection]',
                files: ['app/search/[collection]/page.tsx'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
        };
        const sameFiles = {
            'app/[page]/layout.tsx': { hash: 'h1' },
            'app/[page]/page.tsx': { hash: 'h2' },
            'app/product/[handle]/page.tsx': { hash: 'h3' },
            'app/search/[collection]/page.tsx': { hash: 'h4' },
        };
        const result = diffClusters(baseline, working, sameFiles, sameFiles);
        // The matched cluster keeps its existing baseline ID → unchanged.
        expect(result['cluster:[page]']?.diff).toBe('unchanged');
        // The two split-off clusters should NOT be marked `added` — every
        // file already existed in some baseline cluster + no content changes.
        expect(result['cluster:[handle]']?.diff,
            `[handle] cluster files all existed in baseline; should not be 'added'. Got: ${result['cluster:[handle]']?.diff}`,
        ).toBe('unchanged');
        expect(result['cluster:[collection]']?.diff,
            `[collection] cluster files all existed in baseline; should not be 'added'. Got: ${result['cluster:[collection]']?.diff}`,
        ).toBe('unchanged');
    });

    it('STILL marks truly new clusters as added when at least one file is new (#423-A2 companion)', () => {
        const baseline = {
            'cluster:auth': {
                id: 'cluster:auth', label: 'auth',
                files: ['auth/login.ts'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
        };
        // working has cluster:payments with a file payments/charge.ts that
        // NEVER existed in baseline.
        const working = {
            'cluster:auth': baseline['cluster:auth'],
            'cluster:payments': {
                id: 'cluster:payments', label: 'payments',
                files: ['payments/charge.ts'],
                entryPoints: [], internalCallCount: 0, externalCallCount: 0,
            },
        };
        const baselineFiles = { 'auth/login.ts': { hash: 'h1' } };
        const workingFiles = { 'auth/login.ts': { hash: 'h1' }, 'payments/charge.ts': { hash: 'h2' } };
        const result = diffClusters(baseline, working, baselineFiles, workingFiles);
        expect(result['cluster:payments']?.diff).toBe('added');
    });
});

// ---------------------------------------------------------------------------
// findClusterForFile
// ---------------------------------------------------------------------------

describe('findClusterForFile', () => {
    it('returns the cluster containing the file', () => {
        const clusters: Record<string, FeatureCluster> = {
            'cluster:auth': {
                id: 'cluster:auth',
                label: 'auth',
                files: ['auth/login.ts'],
                entryPoints: [],
                internalCallCount: 0,
                externalCallCount: 0,
            },
        };
        const result = findClusterForFile('auth/login.ts', clusters);
        expect(result?.id).toBe('cluster:auth');
    });

    it('returns undefined for unknown file', () => {
        const result = findClusterForFile('unknown.ts', {});
        expect(result).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Louvain algorithm — positive flows
// ---------------------------------------------------------------------------

describe('detectCommunities — Louvain quality', () => {
    it('3 disconnected components produce 3 clusters', () => {
        const callGraph = makeCallGraph(
            [
                'auth/a.ts::fn', 'auth/b.ts::fn',
                'todos/a.ts::fn', 'todos/b.ts::fn',
                'billing/a.ts::fn', 'billing/b.ts::fn',
            ],
            [
                ['auth/a.ts::fn', 'auth/b.ts::fn'],
                ['todos/a.ts::fn', 'todos/b.ts::fn'],
                ['billing/a.ts::fn', 'billing/b.ts::fn'],
            ]
        );
        const snapshot = makeSnapshot([
            'auth/a.ts', 'auth/b.ts',
            'todos/a.ts', 'todos/b.ts',
            'billing/a.ts', 'billing/b.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);
        expect(Object.keys(clusters).length).toBe(3);
        const labels = new Set(Object.values(clusters).map(c => c.label));
        expect(labels.has('auth')).toBe(true);
        expect(labels.has('todos')).toBe(true);
        expect(labels.has('billing')).toBe(true);
    });

    it('star graph: auth files are grouped together despite hub connecting multiple modules', () => {
        // hub.ts calls auth 3 times, todos 1 time
        // auth internal edges bind auth files tightly
        const callGraph = makeCallGraph(
            [
                'app/hub.ts::main',
                'auth/a.ts::fn', 'auth/b.ts::fn', 'auth/c.ts::fn',
                'todos/a.ts::fn', 'todos/b.ts::fn',
            ],
            [
                ['app/hub.ts::main', 'auth/a.ts::fn'],
                ['app/hub.ts::main', 'auth/b.ts::fn'],
                ['app/hub.ts::main', 'auth/c.ts::fn'],
                ['app/hub.ts::main', 'todos/a.ts::fn'],
                // auth internal (tight cluster)
                ['auth/a.ts::fn', 'auth/b.ts::fn'],
                ['auth/b.ts::fn', 'auth/c.ts::fn'],
                ['auth/a.ts::fn', 'auth/c.ts::fn'],
                // todos internal
                ['todos/a.ts::fn', 'todos/b.ts::fn'],
            ]
        );
        const snapshot = makeSnapshot([
            'app/hub.ts', 'auth/a.ts', 'auth/b.ts', 'auth/c.ts', 'todos/a.ts', 'todos/b.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);
        // All auth files must be in the same cluster
        const authCluster = Object.values(clusters).find(c => c.files.includes('auth/a.ts'));
        expect(authCluster).toBeDefined();
        expect(authCluster!.files).toContain('auth/b.ts');
        expect(authCluster!.files).toContain('auth/c.ts');
    });

    it('flat directory with clear groups in subdirs produces ≥2 clusters', () => {
        // Two groups in separate dirs but with one cross-group edge
        const callGraph = makeCallGraph(
            [
                'group1/a.ts::fn', 'group1/b.ts::fn', 'group1/c.ts::fn',
                'group2/d.ts::fn', 'group2/e.ts::fn', 'group2/f.ts::fn',
            ],
            [
                // Group 1 internal (tight)
                ['group1/a.ts::fn', 'group1/b.ts::fn'],
                ['group1/b.ts::fn', 'group1/c.ts::fn'],
                ['group1/a.ts::fn', 'group1/c.ts::fn'],
                // Group 2 internal (tight)
                ['group2/d.ts::fn', 'group2/e.ts::fn'],
                ['group2/e.ts::fn', 'group2/f.ts::fn'],
                ['group2/d.ts::fn', 'group2/f.ts::fn'],
                // One weak cross-group edge
                ['group1/c.ts::fn', 'group2/d.ts::fn'],
            ]
        );
        const snapshot = makeSnapshot([
            'group1/a.ts', 'group1/b.ts', 'group1/c.ts',
            'group2/d.ts', 'group2/e.ts', 'group2/f.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(2);
        // a,b,c should be in one cluster; d,e,f in another
        const clusterA = Object.values(clusters).find(c => c.files.includes('group1/a.ts'));
        const clusterD = Object.values(clusters).find(c => c.files.includes('group2/d.ts'));
        expect(clusterA).toBeDefined();
        expect(clusterD).toBeDefined();
        expect(clusterA!.id).not.toBe(clusterD!.id);
    });

    it('modularity Q is a number between -0.5 and 1.0', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);
        for (const cluster of Object.values(clusters)) {
            expect(cluster.modularity).toBeDefined();
            expect(typeof cluster.modularity).toBe('number');
            expect(cluster.modularity!).toBeGreaterThanOrEqual(-0.5);
            expect(cluster.modularity!).toBeLessThanOrEqual(1.0);
        }
    });

    it('Louvain clusters match or exceed label propagation for test-drift', () => {
        // This test verifies that Louvain produces auth and todos as separate clusters
        // (same quality as label propagation but using modularity optimization)
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);
        const labels = Object.values(clusters).map(c => c.label);
        expect(labels).toContain('auth');
        expect(labels).toContain('todos');
    });

    it('real-world pattern: microservice with 3 feature domains', () => {
        // Simulates an Express backend with users, orders, and products
        const nodes = [
            'src/users/userController.ts::handleUser',
            'src/users/userService.ts::createUser',
            'src/users/userModel.ts::User',
            'src/orders/orderController.ts::handleOrder',
            'src/orders/orderService.ts::createOrder',
            'src/orders/orderModel.ts::Order',
            'src/products/productController.ts::handleProduct',
            'src/products/productService.ts::getProduct',
            'src/products/productModel.ts::Product',
            'src/shared/db.ts::connect',
            'src/shared/auth.ts::verify',
            'src/index.ts::main',
        ];
        const edges: Array<[string, string]> = [
            // Users internal
            ['src/users/userController.ts::handleUser', 'src/users/userService.ts::createUser'],
            ['src/users/userService.ts::createUser', 'src/users/userModel.ts::User'],
            // Orders internal
            ['src/orders/orderController.ts::handleOrder', 'src/orders/orderService.ts::createOrder'],
            ['src/orders/orderService.ts::createOrder', 'src/orders/orderModel.ts::Order'],
            // Products internal
            ['src/products/productController.ts::handleProduct', 'src/products/productService.ts::getProduct'],
            ['src/products/productService.ts::getProduct', 'src/products/productModel.ts::Product'],
            // Cross-domain: orders use users
            ['src/orders/orderService.ts::createOrder', 'src/users/userService.ts::createUser'],
            // Shared deps
            ['src/users/userService.ts::createUser', 'src/shared/db.ts::connect'],
            ['src/orders/orderService.ts::createOrder', 'src/shared/db.ts::connect'],
            ['src/products/productService.ts::getProduct', 'src/shared/db.ts::connect'],
            // Index hub
            ['src/index.ts::main', 'src/users/userController.ts::handleUser'],
            ['src/index.ts::main', 'src/orders/orderController.ts::handleOrder'],
            ['src/index.ts::main', 'src/products/productController.ts::handleProduct'],
        ];
        const callGraph = makeCallGraph(nodes, edges);
        const snapshot = makeSnapshot([
            'src/users/userController.ts', 'src/users/userService.ts', 'src/users/userModel.ts',
            'src/orders/orderController.ts', 'src/orders/orderService.ts', 'src/orders/orderModel.ts',
            'src/products/productController.ts', 'src/products/productService.ts', 'src/products/productModel.ts',
            'src/shared/db.ts', 'src/shared/auth.ts', 'src/index.ts',
        ]);
        const clusters = detectCommunities(snapshot, callGraph);

        // Should produce at least 2 distinct feature clusters
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(2);

        // All clusterable files assigned (src/index.ts is excluded as a root entry point)
        const assignedFiles = Object.values(clusters).flatMap(c => c.files);
        expect(new Set(assignedFiles).size).toBe(assignedFiles.length);
        expect(assignedFiles.length).toBe(11); // 12 files - 1 excluded (src/index.ts)

        // Users and products should NOT be in the same cluster (no direct connection)
        const usersCluster = Object.values(clusters).find(c => c.files.includes('src/users/userController.ts'));
        const productsCluster = Object.values(clusters).find(c => c.files.includes('src/products/productController.ts'));
        if (usersCluster && productsCluster) {
            expect(usersCluster.id).not.toBe(productsCluster.id);
        }
    });
});

// ---------------------------------------------------------------------------
// Louvain algorithm — negative flows
// ---------------------------------------------------------------------------

describe('detectCommunities — Louvain negative flows', () => {
    it('empty graph returns empty clusters without crash', () => {
        const snapshot = makeSnapshot([]);
        const clusters = detectCommunities(snapshot);
        expect(Object.keys(clusters)).toHaveLength(0);
    });

    it('single-file graph returns one cluster', () => {
        const snapshot = makeSnapshot(['src/solo.ts']);
        const clusters = detectCommunities(snapshot);
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(1);
        const allFiles = Object.values(clusters).flatMap(c => c.files);
        expect(allFiles).toContain('src/solo.ts');
    });

    it('graph with no edges: each file becomes singleton (merged by post-processing)', () => {
        const callGraph = makeCallGraph(
            ['a.ts::fn', 'b.ts::fn', 'c.ts::fn'],
            [], // no edges
        );
        const snapshot = makeSnapshot(['a.ts', 'b.ts', 'c.ts']);
        const clusters = detectCommunities(snapshot, callGraph);
        // All files must be assigned somewhere
        const allFiles = Object.values(clusters).flatMap(c => c.files);
        expect(allFiles).toContain('a.ts');
        expect(allFiles).toContain('b.ts');
        expect(allFiles).toContain('c.ts');
    });

    it('fully connected graph (all files call each other): produces at least 1 cluster', () => {
        const callGraph = makeCallGraph(
            ['a.ts::fn', 'b.ts::fn', 'c.ts::fn'],
            [
                ['a.ts::fn', 'b.ts::fn'],
                ['b.ts::fn', 'c.ts::fn'],
                ['a.ts::fn', 'c.ts::fn'],
                ['b.ts::fn', 'a.ts::fn'],
                ['c.ts::fn', 'b.ts::fn'],
                ['c.ts::fn', 'a.ts::fn'],
            ],
        );
        const snapshot = makeSnapshot(['a.ts', 'b.ts', 'c.ts']);
        const clusters = detectCommunities(snapshot, callGraph);
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(1);
        const allFiles = Object.values(clusters).flatMap(c => c.files);
        expect(new Set(allFiles).size).toBe(allFiles.length); // no dupes
    });

    it('no file is assigned to multiple clusters', () => {
        const snapshot = makeTestDriftSnapshot();
        const callGraph = makeTestDriftCallGraph();
        const clusters = detectCommunities(snapshot, callGraph);
        const allFiles = Object.values(clusters).flatMap(c => c.files);
        expect(new Set(allFiles).size).toBe(allFiles.length);
    });

    it('Louvain converges within 100 iterations (no infinite loop)', () => {
        // Large adversarial graph: ring structure
        const n = 50;
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];
        for (let i = 0; i < n; i++) {
            nodes.push(`file${i}.ts::fn`);
            edges.push([`file${i}.ts::fn`, `file${(i + 1) % n}.ts::fn`]);
        }
        const callGraph = makeCallGraph(nodes, edges);
        const snapshot = makeSnapshot(nodes.map(n => n.split('::')[0]));
        // Should not hang — just run and check it completes
        const clusters = detectCommunities(snapshot, callGraph);
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(1);
    });

    it('falls back to label propagation when Louvain produces 1 community', () => {
        // Very small fully-connected graph → Louvain merges everything
        // Label propagation should still produce meaningful clustering based on directories
        const callGraph = makeCallGraph(
            ['auth/a.ts::fn', 'todos/b.ts::fn'],
            [
                ['auth/a.ts::fn', 'todos/b.ts::fn'],
                ['todos/b.ts::fn', 'auth/a.ts::fn'],
            ],
        );
        const snapshot = makeSnapshot(['auth/a.ts', 'todos/b.ts']);
        const clusters = detectCommunities(snapshot, callGraph);
        // Should produce clusters based on directory structure (label propagation fallback)
        const allFiles = Object.values(clusters).flatMap(c => c.files);
        expect(allFiles).toContain('auth/a.ts');
        expect(allFiles).toContain('todos/b.ts');
    });

    it('import-only edges (no call graph) still produce meaningful clusters', () => {
        const snapshot = makeSnapshotWithImports({
            'auth/login.ts': ['./register'],
            'auth/register.ts': ['./login'],
            'todos/list.ts': ['./create'],
            'todos/create.ts': ['./list'],
        });
        const emptyGraph = makeCallGraph([], []);
        const clusters = detectCommunities(snapshot, emptyGraph);
        // Should cluster auth files together and todo files together
        const allFiles = Object.values(clusters).flatMap(c => c.files);
        expect(allFiles).toContain('auth/login.ts');
        expect(allFiles).toContain('todos/list.ts');
    });
});

// ---------------------------------------------------------------------------
// Sub-clustering — multi-level recursive clustering (Issue 24 — Multi-level recursive clustering (sub-clusters within clusters))
// ---------------------------------------------------------------------------

describe('detectSubClusters', () => {
    it('cluster with 20 files and 2 clear call groups produces 2 sub-clusters', () => {
        // Build a cluster with 20 files: 10 in group A, 10 in group B, weakly connected
        const groupAFiles: string[] = [];
        const groupBFiles: string[] = [];
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];

        for (let i = 0; i < 10; i++) {
            const fp = `domain/groupA/file${i}.ts`;
            groupAFiles.push(fp);
            nodes.push(`${fp}::fn`);
        }
        for (let i = 0; i < 10; i++) {
            const fp = `domain/groupB/file${i}.ts`;
            groupBFiles.push(fp);
            nodes.push(`${fp}::fn`);
        }

        // Group A: fully connected internally
        for (let i = 0; i < 9; i++) {
            edges.push([`domain/groupA/file${i}.ts::fn`, `domain/groupA/file${i + 1}.ts::fn`]);
        }
        // Group B: fully connected internally
        for (let i = 0; i < 9; i++) {
            edges.push([`domain/groupB/file${i}.ts::fn`, `domain/groupB/file${i + 1}.ts::fn`]);
        }
        // One weak cross-group edge
        edges.push([`domain/groupA/file0.ts::fn`, `domain/groupB/file0.ts::fn`]);

        const callGraph = makeCallGraph(nodes, edges);
        const cluster: FeatureCluster = {
            id: 'cluster:domain',
            label: 'domain',
            files: [...groupAFiles, ...groupBFiles],
            entryPoints: [],
            internalCallCount: 18,
            externalCallCount: 1,
        };

        const subClusters = detectSubClusters(cluster, callGraph);
        expect(subClusters).not.toBeNull();
        expect(Object.keys(subClusters!).length).toBeGreaterThanOrEqual(2);
    });

    it('sub-cluster IDs follow cluster:parent/child format', () => {
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];
        const files: string[] = [];

        for (let i = 0; i < 10; i++) {
            files.push(`feature/auth/file${i}.ts`);
            nodes.push(`feature/auth/file${i}.ts::fn`);
        }
        for (let i = 0; i < 10; i++) {
            files.push(`feature/users/file${i}.ts`);
            nodes.push(`feature/users/file${i}.ts::fn`);
        }

        for (let i = 0; i < 9; i++) {
            edges.push([`feature/auth/file${i}.ts::fn`, `feature/auth/file${i + 1}.ts::fn`]);
        }
        for (let i = 0; i < 9; i++) {
            edges.push([`feature/users/file${i}.ts::fn`, `feature/users/file${i + 1}.ts::fn`]);
        }
        edges.push([`feature/auth/file0.ts::fn`, `feature/users/file0.ts::fn`]);

        const callGraph = makeCallGraph(nodes, edges);
        const cluster: FeatureCluster = {
            id: 'cluster:feature',
            label: 'feature',
            files,
            entryPoints: [],
            internalCallCount: 18,
            externalCallCount: 1,
        };

        const subClusters = detectSubClusters(cluster, callGraph);
        if (subClusters) {
            for (const id of Object.keys(subClusters)) {
                expect(id).toMatch(/^cluster:feature\//);
            }
        }
    });

    it('sub-cluster files are a subset of parent cluster files', () => {
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];
        const files: string[] = [];

        for (let i = 0; i < 10; i++) {
            files.push(`mod/alpha/f${i}.ts`);
            nodes.push(`mod/alpha/f${i}.ts::fn`);
        }
        for (let i = 0; i < 8; i++) {
            files.push(`mod/beta/f${i}.ts`);
            nodes.push(`mod/beta/f${i}.ts::fn`);
        }

        for (let i = 0; i < 9; i++) {
            edges.push([`mod/alpha/f${i}.ts::fn`, `mod/alpha/f${Math.min(i + 1, 9)}.ts::fn`]);
        }
        for (let i = 0; i < 7; i++) {
            edges.push([`mod/beta/f${i}.ts::fn`, `mod/beta/f${i + 1}.ts::fn`]);
        }
        edges.push([`mod/alpha/f0.ts::fn`, `mod/beta/f0.ts::fn`]);

        const callGraph = makeCallGraph(nodes, edges);
        const parentFiles = new Set(files);
        const cluster: FeatureCluster = {
            id: 'cluster:mod',
            label: 'mod',
            files,
            entryPoints: [],
            internalCallCount: 16,
            externalCallCount: 1,
        };

        const subClusters = detectSubClusters(cluster, callGraph);
        if (subClusters) {
            for (const sc of Object.values(subClusters)) {
                for (const f of sc.files) {
                    expect(parentFiles.has(f)).toBe(true);
                }
            }
        }
    });

    it('cluster with 5 files returns null (below threshold)', () => {
        const callGraph = makeCallGraph(
            ['a/f1.ts::fn', 'a/f2.ts::fn', 'b/f3.ts::fn', 'b/f4.ts::fn', 'b/f5.ts::fn'],
            [['a/f1.ts::fn', 'a/f2.ts::fn'], ['b/f3.ts::fn', 'b/f4.ts::fn']],
        );
        const cluster: FeatureCluster = {
            id: 'cluster:small',
            label: 'small',
            files: ['a/f1.ts', 'a/f2.ts', 'b/f3.ts', 'b/f4.ts', 'b/f5.ts'],
            entryPoints: [],
            internalCallCount: 2,
            externalCallCount: 0,
        };
        const result = detectSubClusters(cluster, callGraph);
        expect(result).toBeNull();
    });

    it('cluster with 20 fully connected files stays as single cluster (no sub-groups)', () => {
        const files: string[] = [];
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];

        for (let i = 0; i < 20; i++) {
            files.push(`flat/f${i}.ts`);
            nodes.push(`flat/f${i}.ts::fn`);
        }
        // Fully connected: each file calls every other
        for (let i = 0; i < 20; i++) {
            for (let j = i + 1; j < 20; j++) {
                edges.push([`flat/f${i}.ts::fn`, `flat/f${j}.ts::fn`]);
            }
        }

        const callGraph = makeCallGraph(nodes, edges);
        const cluster: FeatureCluster = {
            id: 'cluster:flat',
            label: 'flat',
            files,
            entryPoints: [],
            internalCallCount: 190,
            externalCallCount: 0,
        };

        const result = detectSubClusters(cluster, callGraph);
        // Fully connected graph: Louvain may produce 1 community → returns null
        // Or may produce sub-communities, but they won't be meaningful (≥2 check)
        // Either way is acceptable — the key is no crash
        if (result !== null) {
            expect(Object.keys(result).length).toBeGreaterThanOrEqual(2);
        }
    });

    it('cluster with 0 internal edges does not crash', () => {
        const files: string[] = [];
        const nodes: string[] = [];

        for (let i = 0; i < 20; i++) {
            files.push(`isolated/f${i}.ts`);
            nodes.push(`isolated/f${i}.ts::fn`);
        }

        const callGraph = makeCallGraph(nodes, []);
        const cluster: FeatureCluster = {
            id: 'cluster:isolated',
            label: 'isolated',
            files,
            entryPoints: [],
            internalCallCount: 0,
            externalCallCount: 0,
        };

        // Should not throw
        const result = detectSubClusters(cluster, callGraph);
        // With no edges, Louvain assigns each file its own community
        // but they won't form 2 meaningful groups, so null is expected
        expect(result === null || typeof result === 'object').toBe(true);
    });

    it('sub-clusters do NOT recursively sub-cluster (depth limited to 1)', () => {
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];
        const files: string[] = [];

        for (let i = 0; i < 10; i++) {
            files.push(`big/a/f${i}.ts`);
            nodes.push(`big/a/f${i}.ts::fn`);
        }
        for (let i = 0; i < 10; i++) {
            files.push(`big/b/f${i}.ts`);
            nodes.push(`big/b/f${i}.ts::fn`);
        }

        for (let i = 0; i < 9; i++) {
            edges.push([`big/a/f${i}.ts::fn`, `big/a/f${i + 1}.ts::fn`]);
        }
        for (let i = 0; i < 9; i++) {
            edges.push([`big/b/f${i}.ts::fn`, `big/b/f${i + 1}.ts::fn`]);
        }
        edges.push([`big/a/f0.ts::fn`, `big/b/f0.ts::fn`]);

        const callGraph = makeCallGraph(nodes, edges);
        const cluster: FeatureCluster = {
            id: 'cluster:big',
            label: 'big',
            files,
            entryPoints: [],
            internalCallCount: 18,
            externalCallCount: 1,
        };

        const subClusters = detectSubClusters(cluster, callGraph);
        if (subClusters) {
            // Sub-clusters should NOT have their own subClusters
            for (const sc of Object.values(subClusters)) {
                expect(sc.subClusters).toBeUndefined();
            }
        }
    });
});

describe('detectCommunities — auto sub-clustering integration', () => {
    it('large cluster (>15 files) gets subClusters auto-populated', () => {
        const nodes: string[] = [];
        const edges: Array<[string, string]> = [];
        const files: string[] = [];

        for (let i = 0; i < 10; i++) {
            const fp = `svc/auth/f${i}.ts`;
            files.push(fp);
            nodes.push(`${fp}::fn`);
        }
        for (let i = 0; i < 10; i++) {
            const fp = `svc/users/f${i}.ts`;
            files.push(fp);
            nodes.push(`${fp}::fn`);
        }

        for (let i = 0; i < 9; i++) {
            edges.push([`svc/auth/f${i}.ts::fn`, `svc/auth/f${i + 1}.ts::fn`]);
        }
        for (let i = 0; i < 9; i++) {
            edges.push([`svc/users/f${i}.ts::fn`, `svc/users/f${i + 1}.ts::fn`]);
        }
        edges.push([`svc/auth/f0.ts::fn`, `svc/users/f0.ts::fn`]);

        const callGraph = makeCallGraph(nodes, edges);
        const snapshot = makeSnapshot(files);
        const clusters = detectCommunities(snapshot, callGraph);

        // Find a cluster that has all 20 files (likely merged into one since all in "svc/")
        // If Louvain correctly separates them, they'd be in separate clusters and each has <16 files
        // So subClusters may or may not be populated depending on whether they got merged
        const allClusters = Object.values(clusters);
        const largeClusters = allClusters.filter(c => c.files.length > 15);

        for (const lc of largeClusters) {
            // Large clusters should have subClusters
            expect(lc.subClusters).toBeDefined();
            expect(Object.keys(lc.subClusters!).length).toBeGreaterThanOrEqual(2);
        }
    });

    it('small cluster (<= 15 files) does NOT get subClusters', () => {
        const callGraph = makeCallGraph(
            ['auth/a.ts::fn', 'auth/b.ts::fn', 'auth/c.ts::fn'],
            [['auth/a.ts::fn', 'auth/b.ts::fn'], ['auth/b.ts::fn', 'auth/c.ts::fn']],
        );
        const snapshot = makeSnapshot(['auth/a.ts', 'auth/b.ts', 'auth/c.ts']);
        const clusters = detectCommunities(snapshot, callGraph);

        for (const cluster of Object.values(clusters)) {
            expect(cluster.subClusters).toBeUndefined();
        }
    });
});

// ---------------------------------------------------------------------------
// Issue 135: Louvain clustering assigns all APIs to a single cluster
// ---------------------------------------------------------------------------

describe('detectCommunities — API-to-cluster split by directory (Issue 135)', () => {
    /**
     * Mimics node-express-realworld-example-app where controllers from different
     * feature directories all import shared auth middleware, causing Louvain to
     * group them into one mega-cluster.
     */
    function makeRealWorldSnapshot(): { snapshot: Snapshot; callGraph: WorkspaceCallGraph } {
        const imports: Record<string, string[]> = {
            'src/routes/article/article.controller.ts': ['./article.service', '../auth/auth.middleware', '../routes'],
            'src/routes/article/article.service.ts': ['../../prisma'],
            'src/routes/article/article.model.ts': [],
            'src/routes/auth/auth.controller.ts': ['./auth.service', './auth.middleware', '../routes'],
            'src/routes/auth/auth.service.ts': ['../../prisma'],
            'src/routes/auth/auth.middleware.ts': ['./token.utils'],
            'src/routes/auth/token.utils.ts': [],
            'src/routes/profile/profile.controller.ts': ['../auth/auth.middleware', '../routes'],
            'src/routes/profile/profile.service.ts': ['../../prisma'],
            'src/routes/tag/tag.controller.ts': ['../auth/auth.middleware', '../routes'],
            'src/routes/tag/tag.service.ts': ['../../prisma'],
            'src/routes/routes.ts': ['./article/article.controller', './auth/auth.controller', './profile/profile.controller', './tag/tag.controller'],
        };
        const snapshot = makeSnapshotWithImports(imports);

        // Add API records for each controller
        snapshot.apiIndex = {
            'GET:/articles': { apiId: 'GET:/articles', method: 'GET', route: '/articles', filePath: 'src/routes/article/article.controller.ts', handlerName: 'getArticles' },
            'POST:/articles': { apiId: 'POST:/articles', method: 'POST', route: '/articles', filePath: 'src/routes/article/article.controller.ts', handlerName: 'createArticle' },
            'POST:/users': { apiId: 'POST:/users', method: 'POST', route: '/users', filePath: 'src/routes/auth/auth.controller.ts', handlerName: 'register' },
            'POST:/users/login': { apiId: 'POST:/users/login', method: 'POST', route: '/users/login', filePath: 'src/routes/auth/auth.controller.ts', handlerName: 'login' },
            'GET:/profiles/:username': { apiId: 'GET:/profiles/:username', method: 'GET', route: '/profiles/:username', filePath: 'src/routes/profile/profile.controller.ts', handlerName: 'getProfile' },
            'GET:/tags': { apiId: 'GET:/tags', method: 'GET', route: '/tags', filePath: 'src/routes/tag/tag.controller.ts', handlerName: 'getTags' },
        } as any;

        const callGraph = makeCallGraph(
            Object.keys(imports).map(fp => `${fp}::handler`),
            [
                // All controllers call auth middleware (creates cross-cluster edges)
                ['src/routes/article/article.controller.ts::handler', 'src/routes/auth/auth.middleware.ts::handler'],
                ['src/routes/profile/profile.controller.ts::handler', 'src/routes/auth/auth.middleware.ts::handler'],
                ['src/routes/tag/tag.controller.ts::handler', 'src/routes/auth/auth.middleware.ts::handler'],
                // Controllers call their services
                ['src/routes/article/article.controller.ts::handler', 'src/routes/article/article.service.ts::handler'],
                ['src/routes/auth/auth.controller.ts::handler', 'src/routes/auth/auth.service.ts::handler'],
                ['src/routes/profile/profile.controller.ts::handler', 'src/routes/profile/profile.service.ts::handler'],
                ['src/routes/tag/tag.controller.ts::handler', 'src/routes/tag/tag.service.ts::handler'],
                // Router imports all controllers
                ['src/routes/routes.ts::handler', 'src/routes/article/article.controller.ts::handler'],
                ['src/routes/routes.ts::handler', 'src/routes/auth/auth.controller.ts::handler'],
                ['src/routes/routes.ts::handler', 'src/routes/profile/profile.controller.ts::handler'],
                ['src/routes/routes.ts::handler', 'src/routes/tag/tag.controller.ts::handler'],
            ],
        );

        return { snapshot, callGraph };
    }

    it('splits controllers from different directories into separate clusters', () => {
        const { snapshot, callGraph } = makeRealWorldSnapshot();
        const clusters = detectCommunities(snapshot, callGraph);

        // Article APIs should be in the article cluster, not in auth
        const articleCluster = Object.values(clusters).find(c =>
            c.apisInCluster?.some(a => a.route === '/articles')
        );
        const authCluster = Object.values(clusters).find(c =>
            c.apisInCluster?.some(a => a.route === '/users')
        );

        expect(articleCluster).toBeDefined();
        expect(authCluster).toBeDefined();
        // They should be different clusters
        expect(articleCluster!.id).not.toBe(authCluster!.id);

        // Article cluster should have article APIs only
        for (const api of articleCluster!.apisInCluster ?? []) {
            expect(api.filePath).toContain('article');
        }

        // Auth cluster should have auth APIs only
        for (const api of authCluster!.apisInCluster ?? []) {
            expect(api.filePath).toContain('auth');
        }
    });

    it('each cluster has correct API count — no APIs in wrong cluster', () => {
        const { snapshot, callGraph } = makeRealWorldSnapshot();
        const clusters = detectCommunities(snapshot, callGraph);

        // Every API should appear in exactly one cluster
        const allApis = Object.values(clusters).flatMap(c => c.apisInCluster ?? []);
        const apiIds = allApis.map(a => a.apiId);
        expect(apiIds.length).toBe(6); // 6 total APIs in the snapshot
        expect(new Set(apiIds).size).toBe(6); // no duplicates
    });

    it('does not split when all API files are in the same directory', () => {
        const imports: Record<string, string[]> = {
            'src/controllers/userController.ts': ['./authService'],
            'src/controllers/adminController.ts': ['./authService'],
            'src/controllers/authService.ts': [],
        };
        const snapshot = makeSnapshotWithImports(imports);
        snapshot.apiIndex = {
            'GET:/users': { apiId: 'GET:/users', method: 'GET', route: '/users', filePath: 'src/controllers/userController.ts', handlerName: 'getUsers' },
            'GET:/admin': { apiId: 'GET:/admin', method: 'GET', route: '/admin', filePath: 'src/controllers/adminController.ts', handlerName: 'getAdmin' },
        } as any;

        const callGraph = makeCallGraph(
            ['src/controllers/userController.ts::fn', 'src/controllers/adminController.ts::fn', 'src/controllers/authService.ts::fn'],
            [
                ['src/controllers/userController.ts::fn', 'src/controllers/authService.ts::fn'],
                ['src/controllers/adminController.ts::fn', 'src/controllers/authService.ts::fn'],
            ],
        );

        const clusters = detectCommunities(snapshot, callGraph);
        // Both APIs should be in the same cluster (same directory)
        const clusterWithApis = Object.values(clusters).filter(c => (c.apisInCluster?.length ?? 0) > 0);
        expect(clusterWithApis.length).toBe(1);
        expect(clusterWithApis[0].apisInCluster!.length).toBe(2);
    });

    it('small project with one directory does not over-split', () => {
        const imports: Record<string, string[]> = {
            'src/api/server.ts': ['./handler'],
            'src/api/handler.ts': [],
        };
        const snapshot = makeSnapshotWithImports(imports);
        snapshot.apiIndex = {
            'GET:/health': { apiId: 'GET:/health', method: 'GET', route: '/health', filePath: 'src/api/server.ts', handlerName: 'healthCheck' },
        } as any;

        const callGraph = makeCallGraph(
            ['src/api/server.ts::handler', 'src/api/handler.ts::helper'],
            [['src/api/server.ts::handler', 'src/api/handler.ts::helper']],
        );
        const clusters = detectCommunities(snapshot, callGraph);

        // Should produce at least 1 cluster, no crash
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(1);
        // The API should be in some cluster
        const allApis = Object.values(clusters).flatMap(c => c.apisInCluster ?? []);
        expect(allApis.length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// #874 — directory-affinity cap (init-perf guard).
//
// The same-directory affinity bonus is an O(d²) clique per directory. On
// monorepo-scale repos a single catch-all directory (hundreds–thousands of
// files) makes that clique the dominant init cost. We skip affinity above
// MAX_AFFINITY_DIR_SIZE (default 200, env-overridable). These lock in that
// the cap is (a) output-neutral for any directory under it and (b) lossless
// for directories over it (every file still clustered, no throw).
// ---------------------------------------------------------------------------
describe('#874 — directory-affinity cap', () => {
    const ENV = 'CODEATLAS_MAX_AFFINITY_DIR';
    function filesInDir(dir: string, n: number): string[] {
        return Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`);
    }
    function withEnv(val: string | undefined, fn: () => void): void {
        const prev = process.env[ENV];
        if (val === undefined) delete process.env[ENV]; else process.env[ENV] = val;
        try { fn(); } finally {
            if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev;
        }
    }

    it('is output-neutral for directories under the cap (default == affinity-disabled)', () => {
        // Largest directory = 199 files, just under the default 200 cap, so
        // affinity applies identically in BOTH runs → byte-identical clusters.
        // This is the no-regression guarantee for every normal-sized repo.
        const snap = makeSnapshot([
            ...filesInDir('src/feature-a', 199),
            ...filesInDir('src/feature-b', 40),
        ]);
        let resultDefault = '';
        let resultDisabled = '';
        withEnv(undefined, () => { resultDefault = JSON.stringify(detectCommunities(snap)); });
        withEnv('999999', () => { resultDisabled = JSON.stringify(detectCommunities(snap)); });
        expect(resultDefault).toBe(resultDisabled);
    });

    it('skips affinity for an over-cap directory without dropping files or throwing', () => {
        // 300 files in ONE directory (> default 200): the O(d²) clique never
        // forms, but every file must still land in a cluster (directory label
        // grouping carries them) — no silent data loss from the skip branch.
        const files = filesInDir('src/generated', 300);
        const snap = makeSnapshot(files);
        let clusters: Record<string, FeatureCluster> = {};
        withEnv(undefined, () => { clusters = detectCommunities(snap); });
        expect(Object.keys(clusters).length).toBeGreaterThanOrEqual(1);
        const clustered = new Set(Object.values(clusters).flatMap(c => c.files));
        for (const f of files) expect(clustered.has(f)).toBe(true);
    });

    it('honors the CODEATLAS_MAX_AFFINITY_DIR override', () => {
        // cap=10 turns a 20-file directory into an over-cap (skip) directory;
        // still lossless.
        const files = filesInDir('src/big', 20);
        const snap = makeSnapshot(files);
        let clusters: Record<string, FeatureCluster> = {};
        withEnv('10', () => { clusters = detectCommunities(snap); });
        const clustered = new Set(Object.values(clusters).flatMap(c => c.files));
        for (const f of files) expect(clustered.has(f)).toBe(true);
    });
});
