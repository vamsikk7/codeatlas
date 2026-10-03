import { describe, it, expect } from 'vitest';
import { exportArchitectureDocs } from '../markdownExporter';
import type {
    Snapshot,
    FileRecord,
    ServiceRecord,
    FeatureCluster,
    ApiRecord,
    DiagramGraph,
    GraphNode,
    GraphEdge,
    HealthReport,
} from '../../graph/graphTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileRecord(fp: string, hash = `hash:${fp}`): FileRecord {
    return {
        path: fp,
        hash,
        mtime: 0,
        content: '',
        symbols: { functions: [], variables: [], imports: [] },
    } as unknown as FileRecord;
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
        files: {},
        apiIndex: {},
        graphs: {},
        ...overrides,
    };
}

function makeService(id: string, name: string, tech: ServiceRecord['technology'] = 'express', apiCount = 3): ServiceRecord {
    return {
        id,
        name,
        rootPath: name,
        technology: tech,
        exposedApiCount: apiCount,
        consumedUrls: [],
        consumedServices: [],
        diff: 'unchanged',
    };
}

function makeCluster(id: string, label: string, files: string[], apis: ApiRecord[] = []): FeatureCluster {
    return {
        id,
        label,
        name: label,
        files,
        entryPoints: [],
        apisInCluster: apis,
        internalCallCount: 8,
        externalCallCount: 2,
        modularity: 0.42,
        diff: 'unchanged',
    };
}

function makeApi(method: string, route: string, handler: string, filePath: string): ApiRecord {
    return {
        apiId: `${method}:${route}`,
        method,
        route,
        handlerName: handler,
        filePath,
        anchor: { filePath },
    };
}

function makeMicroserviceGraph(services: ServiceRecord[]): DiagramGraph {
    const nodes: GraphNode[] = services.map((svc, i) => ({
        id: `node_${i}`,
        type: 'service' as const,
        label: svc.name,
        subtitle: `\u00AB${svc.technology}\u00BB`,
        diff: svc.diff ?? 'unchanged',
        meta: {},
    }));
    const edges: GraphEdge[] = [];
    if (services.length >= 2) {
        edges.push({
            id: 'edge_1',
            source: 'node_0',
            target: 'node_1',
            label: 'calls \u00B7 3 APIs',
            edgeType: 'inter-service',
            diff: 'unchanged',
        });
    }
    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes,
        edges,
        anchors: {},
        meta: {},
    };
}

function makeFeatureGraph(clusters: FeatureCluster[]): DiagramGraph {
    const nodes: GraphNode[] = clusters.map((c, i) => ({
        id: `cluster_${i}`,
        type: 'cluster' as const,
        label: c.label,
        diff: c.diff ?? 'unchanged',
        meta: {
            files: c.files,
            apisInCluster: c.apisInCluster ?? [],
        },
    }));
    return {
        graphId: 'feature:workspace',
        type: 'feature',
        nodes,
        edges: [],
        anchors: {},
        meta: {},
    };
}

// ---------------------------------------------------------------------------
// Basic export — structure
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — structure', () => {
    it('produces valid Markdown with header and TOC', () => {
        const md = exportArchitectureDocs(makeSnapshot(), undefined, 'my-app');
        expect(md).toContain('# my-app \u2014 Architecture Documentation');
        expect(md).toContain('## Table of Contents');
        expect(md).toContain('## System Overview');
        expect(md).toContain('## Feature Clusters');
        expect(md).toContain('## API Catalog');
        expect(md).toContain('## Code Health');
    });

    it('includes Diff Summary section only when baseline provided', () => {
        const md1 = exportArchitectureDocs(makeSnapshot());
        expect(md1).not.toContain('## Diff Summary');

        const md2 = exportArchitectureDocs(makeSnapshot(), makeSnapshot());
        expect(md2).toContain('## Diff Summary');
    });

    it('includes generation date', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        const today = new Date().toISOString().split('T')[0];
        expect(md).toContain(today);
    });

    it('includes CodeAtlas attribution', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toContain('CodeAtlas');
    });
});

// ---------------------------------------------------------------------------
// L1 System Overview
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — System Overview', () => {
    it('shows service count and repo name', () => {
        const snapshot = makeSnapshot({
            services: {
                'service:backend': makeService('service:backend', 'backend'),
                'service:frontend': makeService('service:frontend', 'frontend', 'unknown', 0),
            },
        });
        const md = exportArchitectureDocs(snapshot, undefined, 'test-drift');
        expect(md).toContain('**test-drift**');
        expect(md).toContain('2 services');
    });

    it('renders Mermaid graph TB when microservice graph exists', () => {
        const services = {
            'service:backend': makeService('service:backend', 'backend'),
        };
        const snapshot = makeSnapshot({
            services,
            graphs: {
                'microservice:workspace': makeMicroserviceGraph(Object.values(services)),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('```mermaid');
        expect(md).toContain('graph TB');
        expect(md).toContain('```');
    });

    it('renders service table with technology and API count', () => {
        const snapshot = makeSnapshot({
            services: {
                'service:backend': makeService('service:backend', 'backend', 'express', 11),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('| backend | express | 11 |');
    });

    it('shows placeholder when no services detected', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toContain('No services detected');
    });

    it('includes infra nodes in Mermaid when present', () => {
        const nodes: GraphNode[] = [
            { id: 'svc_1', type: 'service', label: 'backend', diff: 'unchanged', meta: {} },
            { id: 'infra_1', type: 'service', label: 'MongoDB', diff: 'unchanged', meta: { infra: true, kind: 'database' } },
        ];
        const edges: GraphEdge[] = [
            { id: 'e1', source: 'svc_1', target: 'infra_1', edgeType: 'inter-service', diff: 'unchanged' },
        ];
        const snapshot = makeSnapshot({
            services: { 'service:backend': makeService('service:backend', 'backend') },
            graphs: {
                'microservice:workspace': {
                    graphId: 'microservice:workspace', type: 'microservice',
                    nodes, edges, anchors: {}, meta: {},
                },
            },
        });
        const md = exportArchitectureDocs(snapshot);
        // Infra nodes use cylinder syntax for databases
        expect(md).toContain('MongoDB');
        expect(md).toContain('-->');
    });

    it('applies diff styling classes on service nodes', () => {
        const nodes: GraphNode[] = [
            { id: 'svc_1', type: 'service', label: 'backend', diff: 'modified', meta: {} },
        ];
        const snapshot = makeSnapshot({
            services: { 'service:backend': makeService('service:backend', 'backend') },
            graphs: {
                'microservice:workspace': {
                    graphId: 'microservice:workspace', type: 'microservice',
                    nodes, edges: [], anchors: {}, meta: {},
                },
            },
        });
        const md = exportArchitectureDocs(snapshot);
        // Issue 233: mermaidId now appends hash suffix for collision prevention
        expect(md).toContain('class svc_1_1tds modified');
    });
});

// ---------------------------------------------------------------------------
// L2a Feature Clusters
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — Feature Clusters', () => {
    it('lists all clusters with file count, API count, cohesion', () => {
        const apis = [makeApi('GET', '/todos', 'listTodos', 'todos/routes.ts')];
        const snapshot = makeSnapshot({
            clusters: {
                'cluster:todos': makeCluster('cluster:todos', 'todos', ['todos/routes.ts', 'todos/service.ts'], apis),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('### todos');
        expect(md).toContain('**Files:** 2');
        expect(md).toContain('**APIs:** 1');
        expect(md).toContain('**Cohesion:**');
        expect(md).toContain('**Modularity Q:**');
    });

    it('renders Mermaid diagram when feature graph exists', () => {
        const clusters = {
            'cluster:auth': makeCluster('cluster:auth', 'auth', ['auth/a.ts', 'auth/b.ts']),
        };
        const snapshot = makeSnapshot({
            clusters,
            graphs: {
                'feature:workspace': makeFeatureGraph(Object.values(clusters)),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('```mermaid');
        expect(md).toContain('graph TB');
    });

    it('includes member files in collapsible details', () => {
        const snapshot = makeSnapshot({
            clusters: {
                'cluster:auth': makeCluster('cluster:auth', 'auth', ['auth/login.ts', 'auth/register.ts']),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('<details>');
        expect(md).toContain('`auth/login.ts`');
        expect(md).toContain('`auth/register.ts`');
    });

    it('includes API table per cluster when APIs present', () => {
        const apis = [
            makeApi('GET', '/auth/me', 'getCurrentUser', 'auth/routes.ts'),
            makeApi('POST', '/auth/login', 'login', 'auth/routes.ts'),
        ];
        const snapshot = makeSnapshot({
            clusters: {
                'cluster:auth': makeCluster('cluster:auth', 'auth', ['auth/routes.ts'], apis),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('| GET | /auth/me | getCurrentUser |');
        expect(md).toContain('| POST | /auth/login | login |');
    });

    it('shows placeholder when no clusters detected', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toContain('No feature clusters detected');
    });

    it('shows diff icon on modified clusters', () => {
        const snapshot = makeSnapshot({
            clusters: {
                'cluster:auth': { ...makeCluster('cluster:auth', 'auth', ['a.ts']), diff: 'added' },
            },
        });
        const md = exportArchitectureDocs(snapshot);
        // Green circle emoji for added
        expect(md).toContain('\u{1F7E2}');
    });
});

// ---------------------------------------------------------------------------
// L2b API Catalog
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — API Catalog', () => {
    it('lists all APIs in a table sorted by file path', () => {
        const snapshot = makeSnapshot({
            apiIndex: {
                'GET:/todos': makeApi('GET', '/todos', 'listTodos', 'todos/routes.ts'),
                'POST:/auth/login': makeApi('POST', '/auth/login', 'login', 'auth/routes.ts'),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('2 endpoints detected');
        expect(md).toContain('| Method | Route | Handler | File | Status |');
        // auth comes before todos alphabetically
        expect(md.indexOf('auth/routes.ts')).toBeLessThan(md.indexOf('todos/routes.ts'));
    });

    it('shows placeholder when no APIs detected', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toContain('No APIs detected');
    });

    it('shows diff icon on changed APIs', () => {
        const snapshot = makeSnapshot({
            apiIndex: {
                'DELETE:/todos/:id': { ...makeApi('DELETE', '/todos/:id', 'removeTodo', 'todos.ts'), diff: 'deleted' },
            },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('\u{1F534}');
    });
});

// ---------------------------------------------------------------------------
// Code Health
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — Code Health', () => {
    it('shows health metrics table', () => {
        const health: HealthReport = {
            deadFunctions: ['a.ts::unusedFn'],
            godFiles: ['big.ts'],
            highCouplingFiles: ['hub.ts'],
            cyclicDependencies: [['a.ts', 'b.ts', 'a.ts']],
            orphanedClusters: [],
        };
        const snapshot = makeSnapshot({ health });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('| Dead functions (no callers) | 1 |');
        expect(md).toContain('| God files (>15 symbols) | 1 |');
        expect(md).toContain('| Cyclic dependencies | 1 |');
    });

    it('lists god files when present', () => {
        const health: HealthReport = {
            deadFunctions: [],
            godFiles: ['massive.ts', 'enormous.ts'],
            highCouplingFiles: [],
            cyclicDependencies: [],
            orphanedClusters: [],
        };
        const snapshot = makeSnapshot({ health });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('**God files:**');
        expect(md).toContain('`massive.ts`');
        expect(md).toContain('`enormous.ts`');
    });

    it('lists cyclic dependencies as arrow chains', () => {
        const health: HealthReport = {
            deadFunctions: [],
            godFiles: [],
            highCouplingFiles: [],
            cyclicDependencies: [['a.ts', 'b.ts', 'c.ts']],
            orphanedClusters: [],
        };
        const snapshot = makeSnapshot({ health });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('`a.ts` \u2192 `b.ts` \u2192 `c.ts`');
    });

    it('shows placeholder when no health data', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toContain('No health analysis available');
    });
});

// ---------------------------------------------------------------------------
// Diff Summary
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — Diff Summary', () => {
    it('shows file/API/cluster change counts', () => {
        const baseline = makeSnapshot({
            files: {
                'a.ts': makeFileRecord('a.ts', 'old'),
                'removed.ts': makeFileRecord('removed.ts'),
            },
            apiIndex: {
                'GET:/old': makeApi('GET', '/old', 'old', 'a.ts'),
            },
        });
        const working = makeSnapshot({
            files: {
                'a.ts': makeFileRecord('a.ts', 'new'),
                'added.ts': makeFileRecord('added.ts'),
            },
            apiIndex: {
                'POST:/new': makeApi('POST', '/new', 'newHandler', 'added.ts'),
            },
        });
        const md = exportArchitectureDocs(working, baseline);
        expect(md).toContain('## Diff Summary');
        // Files: 1 added, 1 deleted, 1 modified
        expect(md).toContain('| Files | 1 | 1 | 1 |');
        // APIs: 1 added, 1 deleted
        expect(md).toContain('| APIs | 1 | 1 |');
    });

    it('shows no-changes message when snapshots are identical', () => {
        const snapshot = makeSnapshot({
            files: { 'a.ts': makeFileRecord('a.ts') },
        });
        const md = exportArchitectureDocs(snapshot, snapshot);
        expect(md).toContain('No changes detected');
    });
});

// ---------------------------------------------------------------------------
// Negative / edge cases
// ---------------------------------------------------------------------------

describe('exportArchitectureDocs — edge cases', () => {
    it('empty snapshot produces valid Markdown without crash', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toBeTruthy();
        expect(md).toContain('# Workspace');
        expect(md).toContain('No services detected');
        expect(md).toContain('No feature clusters detected');
        expect(md).toContain('No APIs detected');
    });

    it('special characters in service names are escaped in Mermaid', () => {
        const nodes: GraphNode[] = [
            { id: 'svc_1', type: 'service', label: 'my<service>', diff: 'unchanged', meta: {} },
        ];
        const snapshot = makeSnapshot({
            services: { 'service:test': makeService('service:test', 'test') },
            graphs: {
                'microservice:workspace': {
                    graphId: 'microservice:workspace', type: 'microservice',
                    nodes, edges: [], anchors: {}, meta: {},
                },
            },
        });
        const md = exportArchitectureDocs(snapshot);
        // < and > should be escaped
        expect(md).not.toContain('<service>');
        expect(md).toContain('my_service_');
    });

    it('service with no APIs shows 0 in table', () => {
        const snapshot = makeSnapshot({
            services: { 'service:frontend': makeService('service:frontend', 'frontend', 'unknown', 0) },
        });
        const md = exportArchitectureDocs(snapshot);
        expect(md).toContain('| frontend | unknown | 0 |');
    });

    it('health section does not list empty subsections', () => {
        const health: HealthReport = {
            deadFunctions: [],
            godFiles: [],
            highCouplingFiles: [],
            cyclicDependencies: [],
            orphanedClusters: [],
        };
        const snapshot = makeSnapshot({ health });
        const md = exportArchitectureDocs(snapshot);
        expect(md).not.toContain('**God files:**');
        expect(md).not.toContain('**Cyclic dependencies:**');
    });

    it('Mermaid code blocks are properly fenced', () => {
        const services = { 'service:a': makeService('service:a', 'a') };
        const snapshot = makeSnapshot({
            services,
            graphs: {
                'microservice:workspace': makeMicroserviceGraph(Object.values(services)),
            },
        });
        const md = exportArchitectureDocs(snapshot);
        const mermaidBlocks = md.match(/```mermaid[\s\S]*?```/g) ?? [];
        expect(mermaidBlocks.length).toBeGreaterThanOrEqual(1);
        for (const block of mermaidBlocks) {
            expect(block).toMatch(/^```mermaid\n/);
            expect(block).toMatch(/\n```$/);
        }
    });

    it('default repo name is Workspace', () => {
        const md = exportArchitectureDocs(makeSnapshot());
        expect(md).toContain('# Workspace');
    });
});
