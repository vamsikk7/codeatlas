/**
 * mapGraphBuilder.test.ts — Issue #700 Knowledge Map builder tests.
 *
 * Exercises the per-layer node + edge emission against synthetic Snapshot
 * fixtures, and the diff behavior (added/deleted tombstones) when a
 * baseline snapshot is provided.
 */

import { describe, it, expect } from 'vitest';
import { buildMapGraph, MAP_GRAPH_ID } from '../mapGraphBuilder';
import type {
    Snapshot,
    ServiceRecord,
    FeatureCluster,
    ApiRecord,
} from '../graphTypes';

function emptySnapshot(): Snapshot {
    return { files: {}, apiIndex: {}, graphs: {} };
}

function service(id: string, name: string, overrides: Partial<ServiceRecord> = {}): ServiceRecord {
    return {
        id,
        name,
        rootPath: `/${name}`,
        technology: 'express',
        category: 'backend',
        exposedApiCount: 0,
        consumedUrls: [],
        consumedServices: [],
        ...overrides,
    };
}

function cluster(id: string, label: string, overrides: Partial<FeatureCluster> = {}): FeatureCluster {
    return {
        id,
        label,
        name: label,
        files: [],
        entryPoints: [],
        ...overrides,
    };
}

function api(id: string, route: string, filePath: string, overrides: Partial<ApiRecord> = {}): ApiRecord {
    return {
        apiId: id,
        method: 'GET',
        route,
        handlerName: 'handler',
        filePath,
        anchor: { filePath, span: { start: 0, end: 1 } },
        ...overrides,
    };
}

describe('buildMapGraph', () => {
    it('returns the well-known graphId and type', () => {
        const g = buildMapGraph(emptySnapshot());
        expect(g.graphId).toBe(MAP_GRAPH_ID);
        expect(g.type).toBe('map');
    });

    it('returns an empty graph for an empty snapshot', () => {
        const g = buildMapGraph(emptySnapshot());
        expect(g.nodes).toEqual([]);
        expect(g.edges).toEqual([]);
        expect(g.meta.serviceCount).toBe(0);
        expect(g.meta.apiCount).toBe(0);
    });

    it('emits service nodes carrying drill-down to the L2a feature view', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth'),
                'service:billing': service('service:billing', 'billing'),
            },
        };
        const g = buildMapGraph(snapshot);
        const serviceNodes = g.nodes.filter(n => n.meta?.layer === 'service');
        expect(serviceNodes).toHaveLength(2);
        // Sorted by name
        expect(serviceNodes[0].label).toBe('auth');
        expect(serviceNodes[1].label).toBe('billing');
        expect(serviceNodes[0].meta?.drillDownGraphId).toBe('feature:service:auth');
    });

    it('shows the category label (not «unknown») for FE/mobile services with tech=unknown (BUG-MAP-CATEGORY)', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:app': service('service:app', 'app', { technology: 'unknown', category: 'mobile', exposedApiCount: 0 }),
            },
        };
        const g = buildMapGraph(snapshot);
        const node = g.nodes.find(n => n.meta?.layer === 'service')!;
        expect(node.subtitle).not.toContain('unknown');
        expect(node.subtitle).toContain('mobile');
        expect(node.meta?.category).toBe('mobile');
    });

    it('emits cluster nodes connected to their owning service', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth'),
            },
            clusters: {
                'cluster:login': cluster('cluster:login', 'login', {
                    serviceId: 'service:auth',
                    files: ['src/auth/login.ts'],
                }),
            },
        };
        const g = buildMapGraph(snapshot);
        const clusterNode = g.nodes.find(n => n.meta?.layer === 'cluster')!;
        const serviceNode = g.nodes.find(n => n.meta?.layer === 'service')!;
        expect(clusterNode.meta?.drillDownGraphId).toBe('api-list:cluster:login');
        const containEdge = g.edges.find(e => e.source === serviceNode.id && e.target === clusterNode.id);
        expect(containEdge).toBeDefined();
        expect(containEdge?.edgeType).toBe('contains');
    });

    it('emits API nodes connected to their owning cluster', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth'),
            },
            clusters: {
                'cluster:login': cluster('cluster:login', 'login', {
                    serviceId: 'service:auth',
                    files: ['src/auth/login.ts'],
                }),
            },
            apiIndex: {
                'api:1': api('api:1', '/login', 'src/auth/login.ts'),
            },
        };
        const g = buildMapGraph(snapshot);
        const apiNode = g.nodes.find(n => n.meta?.layer === 'api');
        expect(apiNode).toBeDefined();
        expect(apiNode!.label).toBe('GET /login');
        expect(apiNode!.meta?.drillDownGraphId).toBe('sequence:src/auth/login.ts:handler');
        // API anchor surfaces on the graph's anchors map.
        expect(g.anchors[apiNode!.id]).toBeDefined();
    });

    it('skips APIs whose file is not in any cluster', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            apiIndex: {
                'api:1': api('api:1', '/orphan', 'src/orphan.ts'),
            },
        };
        const g = buildMapGraph(snapshot);
        const apiNodes = g.nodes.filter(n => n.meta?.layer === 'api');
        expect(apiNodes).toHaveLength(0);
    });

    it('emits inter-service edges from `consumedServices`', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth', {
                    consumedServices: ['service:billing'],
                }),
                'service:billing': service('service:billing', 'billing'),
            },
        };
        const g = buildMapGraph(snapshot);
        const interSvc = g.edges.find(e => e.edgeType === 'inter-service');
        expect(interSvc).toBeDefined();
        expect(interSvc?.label).toBe('calls');
    });

    it('marks newly-added services with diff="added" when missing from baseline', () => {
        const baseline = emptySnapshot();
        const working: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth'),
            },
        };
        const g = buildMapGraph(working, baseline);
        const svc = g.nodes.find(n => n.meta?.layer === 'service')!;
        expect(svc.diff).toBe('added');
    });

    it('emits tombstone nodes for services / clusters / APIs deleted from baseline', () => {
        const baseline: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:gone': service('service:gone', 'gone'),
            },
            clusters: {
                'cluster:removed': cluster('cluster:removed', 'removed'),
            },
            apiIndex: {
                'api:removed': api('api:removed', '/removed', 'src/old.ts'),
            },
        };
        const working = emptySnapshot();
        const g = buildMapGraph(working, baseline);
        const deletedSvc = g.nodes.find(n => n.meta?.deleted && n.meta?.layer === 'service');
        const deletedCluster = g.nodes.find(n => n.meta?.deleted && n.meta?.layer === 'cluster');
        const deletedApi = g.nodes.find(n => n.meta?.deleted && n.meta?.layer === 'api');
        expect(deletedSvc?.diff).toBe('deleted');
        expect(deletedCluster?.diff).toBe('deleted');
        expect(deletedApi?.diff).toBe('deleted');
    });

    it('preserves explicit diff on service/cluster records when present', () => {
        const working: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth', { diff: 'modified' }),
            },
        };
        const baseline: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:auth': service('service:auth', 'auth'),
            },
        };
        const g = buildMapGraph(working, baseline);
        expect(g.nodes.find(n => n.meta?.layer === 'service')?.diff).toBe('modified');
    });

    it('meta.overlayLayers drives renderer toggle ordering', () => {
        const g = buildMapGraph(emptySnapshot());
        expect(g.meta.overlayLayers).toEqual(['service', 'cluster', 'api', 'infrastructure']);
    });

    it('produces deterministic node order across rebuilds', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            services: {
                'service:z': service('service:z', 'z'),
                'service:a': service('service:a', 'a'),
            },
            clusters: {
                'cluster:z': cluster('cluster:z', 'z'),
                'cluster:a': cluster('cluster:a', 'a'),
            },
        };
        const g1 = buildMapGraph(snapshot);
        const g2 = buildMapGraph(snapshot);
        expect(g1.nodes.map(n => n.label)).toEqual(g2.nodes.map(n => n.label));
        // Services sorted by name (a before z); clusters sorted by id (a before z).
        const labels = g1.nodes.map(n => n.label);
        expect(labels.indexOf('a')).toBeLessThan(labels.indexOf('z'));
    });

    it('handler name falls back to file graph drill-down when missing', () => {
        const snapshot: Snapshot = {
            ...emptySnapshot(),
            clusters: {
                'cluster:c': cluster('cluster:c', 'c', { files: ['src/anon.ts'] }),
            },
            apiIndex: {
                'api:anon': api('api:anon', '/x', 'src/anon.ts', { handlerName: '' }),
            },
        };
        const g = buildMapGraph(snapshot);
        const apiNode = g.nodes.find(n => n.meta?.layer === 'api');
        expect(apiNode?.meta?.drillDownGraphId).toBe('file:src/anon.ts');
    });

    describe('Issue #739 — cascade modified state propagation', () => {
        it('API node reads modified from cascade-updated api-list meta.apis', () => {
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                clusters: {
                    'cluster:auth': cluster('cluster:auth', 'auth', { files: ['src/auth.ts'] }),
                },
                apiIndex: {
                    'api:1': api('api:1', '/login', 'src/auth.ts'),
                },
                graphs: {
                    'api-list:cluster:auth': {
                        graphId: 'api-list:cluster:auth',
                        type: 'api-list',
                        nodes: [],
                        edges: [],
                        anchors: {},
                        meta: {
                            apis: [{ apiId: 'api:1', method: 'GET', route: '/login', diff: 'modified' }],
                        },
                    } as any,
                },
            };
            // Baseline carries the same api id, so absence-based 'added' is OFF.
            const baseline: Snapshot = { ...emptySnapshot(), apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') } };
            const g = buildMapGraph(snapshot, baseline);
            const apiNode = g.nodes.find(n => n.meta?.layer === 'api')!;
            expect(apiNode.diff).toBe('modified');
        });

        it('Cluster node bubbles modified when ≥1 child API is modified', () => {
            // Cluster + API are in BOTH baseline and working so neither
            // gets the absence-based 'added' annotation. The only signal
            // is the modified-route in the api-list meta — that should
            // bubble through the API leaf to the cluster.
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                clusters: {
                    'cluster:auth': cluster('cluster:auth', 'auth', { files: ['src/auth.ts'] }),
                },
                apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') },
                graphs: {
                    'api-list:cluster:auth': {
                        graphId: 'api-list:cluster:auth', type: 'api-list', nodes: [], edges: [], anchors: {},
                        meta: { apis: [{ apiId: 'api:1', method: 'GET', route: '/login', diff: 'modified' }] },
                    } as any,
                },
            };
            const baseline: Snapshot = {
                ...emptySnapshot(),
                clusters: {
                    'cluster:auth': cluster('cluster:auth', 'auth', { files: ['src/auth.ts'] }),
                },
                apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') },
            };
            const g = buildMapGraph(snapshot, baseline);
            const clusterNode = g.nodes.find(n => n.meta?.layer === 'cluster')!;
            expect(clusterNode.diff).toBe('modified');
        });

        it('Service node bubbles modified when ≥1 child cluster is modified', () => {
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                services: { 'service:auth': service('service:auth', 'auth') },
                clusters: {
                    'cluster:auth': cluster('cluster:auth', 'auth', { serviceId: 'service:auth', files: ['src/auth.ts'] }),
                },
                apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') },
                graphs: {
                    'api-list:cluster:auth': {
                        graphId: 'api-list:cluster:auth', type: 'api-list', nodes: [], edges: [], anchors: {},
                        meta: { apis: [{ apiId: 'api:1', method: 'GET', route: '/login', diff: 'modified' }] },
                    } as any,
                },
            };
            // Baseline matches working for service + cluster + api so
            // none get the absence-based 'added' annotation. The only
            // signal is the modified-route in api-list meta.
            const baseline: Snapshot = {
                ...emptySnapshot(),
                services: { 'service:auth': service('service:auth', 'auth') },
                clusters: {
                    'cluster:auth': cluster('cluster:auth', 'auth', { serviceId: 'service:auth', files: ['src/auth.ts'] }),
                },
                apiIndex: { 'api:1': api('api:1', '/login', 'src/auth.ts') },
            };
            const g = buildMapGraph(snapshot, baseline);
            const serviceNode = g.nodes.find(n => n.meta?.layer === 'service' && n.label === 'auth')!;
            expect(serviceNode.diff).toBe('modified');
        });

        it('does NOT downgrade an explicit `added` on a container', () => {
            // Service is in working but not in baseline → 'added'. Even if
            // its cluster child carries `modified`, the 'added' on the
            // service must stick (added is the stronger signal).
            const snapshot: Snapshot = {
                ...emptySnapshot(),
                services: { 'service:new': service('service:new', 'new') },
                clusters: {
                    'cluster:c': cluster('cluster:c', 'c', { serviceId: 'service:new', files: ['src/c.ts'] }),
                },
                apiIndex: { 'api:c': api('api:c', '/c', 'src/c.ts') },
                graphs: {
                    'api-list:cluster:c': {
                        graphId: 'api-list:cluster:c', type: 'api-list', nodes: [], edges: [], anchors: {},
                        meta: { apis: [{ apiId: 'api:c', method: 'GET', route: '/c', diff: 'modified' }] },
                    } as any,
                },
            };
            const g = buildMapGraph(snapshot, emptySnapshot());
            const serviceNode = g.nodes.find(n => n.meta?.layer === 'service')!;
            expect(serviceNode.diff).toBe('added');
        });
    });
});
