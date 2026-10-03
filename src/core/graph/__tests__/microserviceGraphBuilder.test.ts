import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    Snapshot,
    FileRecord,
    ServiceRecord,
    InfrastructureService,
    ApiRecord,
    DiffStatus,
    DiagramGraph,
    GraphNode,
    GraphEdge,
} from '../graphTypes';

/**
 * We mock the serviceDetector module so that buildMicroserviceGraph does not
 * hit the real filesystem (detectServices calls fs.existsSync / readdirSync).
 * Each test configures mock return values to control the graph builder output.
 */
vi.mock('../../analysis/serviceDetector', async (importActual) => ({
    // Keep real pure helpers (e.g. isInternalApiBaseEnv — BUG-EXP-4); mock only
    // the heavy detection functions so buildMicroserviceGraph stays isolated.
    ...(await importActual<typeof import('../../analysis/serviceDetector')>()),
    detectServices: vi.fn(() => ({})),
    diffServices: vi.fn((_base: any, working: any) => working),
    detectInfrastructureServices: vi.fn(() => []),
    diffInfrastructureServices: vi.fn((_baseInfra: any, workingInfra: any) => workingInfra),
    detectAllTechnologies: vi.fn(() => ['unknown']),
}));

import { buildMicroserviceGraph } from '../microserviceGraphBuilder';
import {
    detectServices,
    diffServices,
    detectInfrastructureServices,
    diffInfrastructureServices,
    detectAllTechnologies,
} from '../../analysis/serviceDetector';

// ---------- helpers ----------

function makeSnapshot(
    files: Record<string, { hash: string; content: string }> = {},
    apiIndex: Record<string, ApiRecord> = {}
): Snapshot {
    return {
        files: Object.fromEntries(
            Object.entries(files).map(([p, f]) => [
                p,
                {
                    path: p,
                    hash: f.hash,
                    mtime: 0,
                    content: f.content,
                    symbols: { functions: [], variables: [], imports: [] },
                } as FileRecord,
            ])
        ),
        apiIndex,
        graphs: {},
    };
}

function makeService(overrides: Partial<ServiceRecord> & { id: string; name: string }): ServiceRecord {
    return {
        rootPath: '',
        technology: 'unknown',
        category: 'backend',
        exposedApiCount: 0,
        consumedUrls: [],
        consumedServices: [],
        diff: 'unchanged',
        ...overrides,
    };
}

function makeInfra(overrides: Partial<InfrastructureService> & { id: string; name: string; kind: InfrastructureService['kind'] }): InfrastructureService {
    return {
        consumedBy: [],
        diff: 'unchanged',
        ...overrides,
    };
}

function makeApi(overrides: Partial<ApiRecord> & { apiId: string; method: string; route: string; filePath: string }): ApiRecord {
    return {
        handlerName: overrides.apiId,
        anchor: { filePath: overrides.filePath },
        ...overrides,
    };
}

function findNodeByLabel(graph: DiagramGraph, label: string): GraphNode | undefined {
    return graph.nodes.find(n => n.label === label);
}

function findNodesByType(graph: DiagramGraph, type: string): GraphNode[] {
    return graph.nodes.filter(n => n.type === type);
}

function findEdgeBySourceTarget(graph: DiagramGraph, sourceId: string, targetId: string): GraphEdge | undefined {
    return graph.edges.find(e => e.source === sourceId && e.target === targetId);
}

const WORKSPACE_ROOT = '/workspace/my-project';

// ---------- test suite ----------

describe('buildMicroserviceGraph', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default mocks: empty workspace
        vi.mocked(detectServices).mockReturnValue({});
        vi.mocked(diffServices).mockImplementation((_base, working) => working);
        vi.mocked(detectInfrastructureServices).mockReturnValue([]);
        vi.mocked(diffInfrastructureServices).mockImplementation((_baseInfra, workingInfra) => workingInfra);
        vi.mocked(detectAllTechnologies).mockReturnValue(['unknown']);
    });

    // ---------------------------------------------------------------
    // 1. Empty workspace
    // ---------------------------------------------------------------
    describe('empty workspace', () => {
        it('returns an empty graph without crashing', () => {
            const snapshot = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, snapshot);
            expect(graph.nodes).toHaveLength(0);
            expect(graph.edges).toHaveLength(0);
        });

        it('has correct graphId and type', () => {
            const snapshot = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, snapshot);
            expect(graph.graphId).toBe('microservice:workspace');
            expect(graph.type).toBe('microservice');
        });
    });

    // ---------------------------------------------------------------
    // UX-27 (2026-06-05) — AWS service bucketing at scale
    // ---------------------------------------------------------------
    describe('UX-27: AWS service bucketing for serverless-patterns-style monorepos', () => {
        function makeAwsPatternServices(): Record<string, ServiceRecord> {
            const services: Record<string, ServiceRecord> = {};
            // Issue #790 #8 — threshold lifted from 50 → 300 to let
            // 132-sub-repo monorepos (serverless/examples) render per
            // sub-project. The bucket-collapse fixture now mirrors the
            // serverless-patterns scale where bucketing is genuinely
            // useful: 320 services across known + unrecognised tokens.
            const patterns = [
                ...Array.from({ length: 100 }, (_, i) => `apigateway-sqs-${i}`),
                ...Array.from({ length: 80 }, (_, i) => `lambda-dynamodb-${i}`),
                ...Array.from({ length: 70 }, (_, i) => `eventbridge-pipes-${i}`),
                ...Array.from({ length: 50 }, (_, i) => `sns-sqs-fanout-${i}`),
                ...Array.from({ length: 20 }, (_, i) => `unrecognized-thing-${i}`),
            ];
            for (let i = 0; i < patterns.length; i++) {
                const name = patterns[i];
                services[`service:${name}`] = makeService({
                    id: `service:${name}`,
                    name,
                    rootPath: name,
                    technology: 'unknown',
                    exposedApiCount: 1,
                });
            }
            return services;
        }

        it('renders one bucket per AWS service when service count > 300', () => {
            vi.mocked(detectServices).mockReturnValue(makeAwsPatternServices());
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // 320 raw services should collapse to a small set of buckets.
            expect(graph.nodes.length).toBeLessThan(15);
            expect(graph.nodes.length).toBeGreaterThan(0);
            expect((graph.meta as any).bucketed).toBe(true);
            expect((graph.meta as any).bucketReason).toBe('aws-services');
            expect((graph.meta as any).originalServiceCount).toBe(320);
        });

        it('the API Gateway bucket carries every apigateway-* member', () => {
            vi.mocked(detectServices).mockReturnValue(makeAwsPatternServices());
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const apigw = graph.nodes.find((n) => n.label === 'API Gateway');
            expect(apigw).toBeDefined();
            expect((apigw?.meta as any).patternCount).toBe(100);
            expect(apigw?.subtitle).toContain('100 patterns');
        });

        it('uncategorized services land in the Other bucket', () => {
            vi.mocked(detectServices).mockReturnValue(makeAwsPatternServices());
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const other = graph.nodes.find((n) => n.label === 'Other');
            expect(other).toBeDefined();
            expect((other?.meta as any).patternCount).toBe(20);
        });

        it('does NOT bucket when service count is at or below the threshold', () => {
            // 132 services — well under the new 300 cap; should render
            // per-service so monorepos like serverless/examples retain
            // their individual sub-project nodes.
            const services: Record<string, ServiceRecord> = {};
            for (let i = 0; i < 132; i++) {
                const name = `lambda-svc-${i}`;
                services[`service:${name}`] = makeService({
                    id: `service:${name}`, name, rootPath: name, technology: 'unknown', exposedApiCount: 0,
                });
            }
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect((graph.meta as any).bucketed).not.toBe(true);
            expect(graph.nodes.length).toBe(132);
        });
    });

    // ---------------------------------------------------------------
    // 2. Single service with no infra
    // ---------------------------------------------------------------
    describe('single service with no infrastructure', () => {
        beforeEach(() => {
            const services: Record<string, ServiceRecord> = {
                'service:backend': makeService({
                    id: 'service:backend',
                    name: 'backend',
                    rootPath: 'backend',
                    technology: 'express',
                    exposedApiCount: 5,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
        });

        it('creates a single service node', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes).toHaveLength(1);
            expect(graph.nodes[0].label).toBe('backend');
        });

        it('service node has type "service"', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].type).toBe('service');
        });

        it('service node has correct diff status (unchanged by default)', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].diff).toBe('unchanged');
        });

        it('service node subtitle contains technology label', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].subtitle).toContain('Express');
        });

        it('service node subtitle contains HTTP route count (#142)', () => {
            // #142: relabeled from "N APIs" to "N HTTP routes" to differentiate
            // from the homepage's apiCount which includes non-HTTP entry
            // points (screens, jobs, middleware). `exposedApiCount` is
            // HTTP-only per #171.
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].subtitle).toContain('5 HTTP routes');
        });

        it('service node body contains the rootPath', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].body).toBe('backend');
        });

        it('service node meta contains serviceId, rootPath, technology', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const meta = graph.nodes[0].meta!;
            expect(meta.serviceId).toBe('service:backend');
            expect(meta.rootPath).toBe('backend');
            expect(meta.technology).toBe('express');
        });

        it('creates no edges when only one service exists', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges).toHaveLength(0);
        });

        it('graph has correct graphId', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.graphId).toBe('microservice:workspace');
            expect(graph.type).toBe('microservice');
        });
    });

    // ---------------------------------------------------------------
    // 3. Single service with database infra
    // ---------------------------------------------------------------
    describe('single service with database infrastructure', () => {
        beforeEach(() => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    rootPath: 'api',
                    technology: 'fastify',
                    exposedApiCount: 3,
                }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({
                    id: 'infra:postgresql',
                    name: 'PostgreSQL',
                    kind: 'database',
                    consumedBy: ['service:api'],
                }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
        });

        it('creates both a service node and an infra node', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes).toHaveLength(2);
            const labels = graph.nodes.map(n => n.label);
            expect(labels).toContain('api');
            expect(labels).toContain('PostgreSQL');
        });

        it('infra node has subtitle with kind label', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const infraNode = findNodeByLabel(graph, 'PostgreSQL')!;
            expect(infraNode.subtitle).toBe('«database»');
        });

        it('infra node meta marks it as infra', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const infraNode = findNodeByLabel(graph, 'PostgreSQL')!;
            expect(infraNode.meta?.infra).toBe(true);
            expect(infraNode.meta?.kind).toBe('database');
        });

        it('creates an edge from service to infra with label "stores"', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges).toHaveLength(1);
            expect(graph.edges[0].label).toBe('stores');
            expect(graph.edges[0].edgeType).toBe('inter-service');
        });
    });

    // ---------------------------------------------------------------
    // 4. Multi-service monorepo
    // ---------------------------------------------------------------
    describe('multi-service monorepo', () => {
        beforeEach(() => {
            const services: Record<string, ServiceRecord> = {
                'service:backend': makeService({
                    id: 'service:backend',
                    name: 'backend',
                    rootPath: 'backend',
                    technology: 'express',
                    exposedApiCount: 10,
                }),
                'service:frontend': makeService({
                    id: 'service:frontend',
                    name: 'frontend',
                    rootPath: 'frontend',
                    technology: 'nextjs',
                    exposedApiCount: 0,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
        });

        it('creates a node for each service', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes).toHaveLength(2);
            const labels = graph.nodes.map(n => n.label);
            expect(labels).toContain('backend');
            expect(labels).toContain('frontend');
        });

        it('each service node has the correct technology in subtitle', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const backend = findNodeByLabel(graph, 'backend')!;
            const frontend = findNodeByLabel(graph, 'frontend')!;
            expect(backend.subtitle).toContain('Express');
            // BUG-EXP-5 — nextjs now has a TECH_ICONS label; renders «Next.js», not «Service».
            expect(frontend.subtitle).toContain('Next.js');
        });
    });

    // ---------------------------------------------------------------
    // 5. Inter-service edges
    // ---------------------------------------------------------------
    describe('inter-service edges', () => {
        it('creates an edge when frontend consumes backend', () => {
            const services: Record<string, ServiceRecord> = {
                'service:backend': makeService({
                    id: 'service:backend',
                    name: 'backend',
                    rootPath: 'backend',
                    technology: 'express',
                    exposedApiCount: 5,
                }),
                'service:frontend': makeService({
                    id: 'service:frontend',
                    name: 'frontend',
                    rootPath: 'frontend',
                    technology: 'nextjs',
                    exposedApiCount: 0,
                    consumedServices: ['service:backend'],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges).toHaveLength(1);
            expect(graph.edges[0].edgeType).toBe('inter-service');
            expect(graph.edges[0].label).toContain('calls');
        });

        it('does not duplicate edges between the same pair of services', () => {
            const services: Record<string, ServiceRecord> = {
                'service:a': makeService({
                    id: 'service:a',
                    name: 'a',
                    consumedServices: ['service:b', 'service:b'], // duplicate
                }),
                'service:b': makeService({
                    id: 'service:b',
                    name: 'b',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // Only one edge should be created despite duplicate consumedServices
            const abEdges = graph.edges.filter(e => {
                const srcNode = graph.nodes.find(n => n.id === e.source);
                const tgtNode = graph.nodes.find(n => n.id === e.target);
                return srcNode?.label === 'a' && tgtNode?.label === 'b';
            });
            expect(abEdges).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------
    // 6. Multiple infra types (database + cache + queue)
    // ---------------------------------------------------------------
    describe('multiple infrastructure types', () => {
        beforeEach(() => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    rootPath: '',
                    technology: 'express',
                }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:postgresql', name: 'PostgreSQL', kind: 'database', consumedBy: ['service:api'] }),
                makeInfra({ id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:api'] }),
                makeInfra({ id: 'infra:rabbitmq', name: 'RabbitMQ', kind: 'queue', consumedBy: ['service:api'] }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
        });

        it('creates an infra node for each infrastructure service', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // 1 service + 3 infra = 4 nodes
            expect(graph.nodes).toHaveLength(4);
            expect(findNodeByLabel(graph, 'PostgreSQL')).toBeDefined();
            expect(findNodeByLabel(graph, 'Redis')).toBeDefined();
            expect(findNodeByLabel(graph, 'RabbitMQ')).toBeDefined();
        });

        it('creates edges with correct labels per infra kind', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges).toHaveLength(3);
            const labels = graph.edges.map(e => e.label);
            expect(labels).toContain('stores');   // database
            expect(labels).toContain('caches');   // cache
            expect(labels).toContain('publishes'); // queue
        });

        it('infra nodes have correct subtitle per kind', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(findNodeByLabel(graph, 'PostgreSQL')!.subtitle).toBe('«database»');
            expect(findNodeByLabel(graph, 'Redis')!.subtitle).toBe('«cache»');
            expect(findNodeByLabel(graph, 'RabbitMQ')!.subtitle).toBe('«message queue»');
        });
    });

    // ---------------------------------------------------------------
    // 7. External services (consumed URLs)
    // ---------------------------------------------------------------
    describe('external service nodes', () => {
        it('creates an external node for consumed URLs that are not known services', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    rootPath: '',
                    technology: 'express',
                    consumedUrls: ['https://stripe.com/v1/charges'],
                    consumedServices: [],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // 1 service + 1 external
            expect(graph.nodes).toHaveLength(2);
            const extNode = graph.nodes.find(n => n.meta?.external === true)!;
            expect(extNode).toBeDefined();
            expect(extNode.label).toBe('stripe.com');
            expect(extNode.subtitle).toBe('«external»');
        });

        it('creates an edge from the service to the external node', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    rootPath: '',
                    consumedUrls: ['https://api.github.com/repos'],
                    consumedServices: [],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges).toHaveLength(1);
            expect(graph.edges[0].label).toBe('calls');
            expect(graph.edges[0].edgeType).toBe('inter-service');
        });

        it('deduplicates external nodes with the same hostname', () => {
            const services: Record<string, ServiceRecord> = {
                'service:a': makeService({
                    id: 'service:a',
                    name: 'a',
                    consumedUrls: ['https://api.example.com/v1'],
                    consumedServices: [],
                }),
                'service:b': makeService({
                    id: 'service:b',
                    name: 'b',
                    consumedUrls: ['https://api.example.com/v2'],
                    consumedServices: [],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const extNodes = graph.nodes.filter(n => n.meta?.external === true);
            expect(extNodes).toHaveLength(1);
            expect(extNodes[0].label).toBe('api.example.com');
        });

        it('skips relative-api:same-origin URLs', () => {
            const services: Record<string, ServiceRecord> = {
                'service:frontend': makeService({
                    id: 'service:frontend',
                    name: 'frontend',
                    consumedUrls: ['relative-api:same-origin'],
                    consumedServices: [],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // Only the service node, no external node for same-origin
            expect(graph.nodes).toHaveLength(1);
            expect(graph.edges).toHaveLength(0);
        });

        it('handles env: URL patterns gracefully', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    consumedUrls: ['env:PAYMENT_SERVICE_URL'],
                    consumedServices: [],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const extNode = graph.nodes.find(n => n.meta?.external === true);
            expect(extNode).toBeDefined();
            // env:PAYMENT_SERVICE_URL → "payment-service" (lowered, _url stripped, _ → -)
            expect(extNode!.label).toBe('payment-service');
        });
    });

    // ---------------------------------------------------------------
    // 8. Diff propagation: added service
    // ---------------------------------------------------------------
    describe('diff propagation — added service', () => {
        it('marks a new service as "added" when baseline lacks it', () => {
            const workingServices: Record<string, ServiceRecord> = {
                'service:existing': makeService({ id: 'service:existing', name: 'existing', diff: 'unchanged' }),
                'service:newone': makeService({ id: 'service:newone', name: 'newone', diff: 'added' }),
            };
            const baselineServices: Record<string, ServiceRecord> = {
                'service:existing': makeService({ id: 'service:existing', name: 'existing' }),
            };
            vi.mocked(detectServices)
                .mockReturnValueOnce(workingServices)   // working call
                .mockReturnValueOnce(baselineServices);  // baseline call
            vi.mocked(diffServices).mockReturnValue(workingServices);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);

            const addedNode = findNodeByLabel(graph, 'newone');
            expect(addedNode).toBeDefined();
            expect(addedNode!.diff).toBe('added');
        });
    });

    // ---------------------------------------------------------------
    // 9. Diff propagation: modified service
    // ---------------------------------------------------------------
    describe('diff propagation — modified service', () => {
        it('marks a service as "modified" when its API count changed', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    exposedApiCount: 8,
                    diff: 'modified',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(diffServices).mockReturnValue(services);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);

            expect(graph.nodes[0].diff).toBe('modified');
        });
    });

    // ---------------------------------------------------------------
    // 10. Diff propagation: deleted service
    // ---------------------------------------------------------------
    describe('diff propagation — deleted service', () => {
        it('marks a removed service as "deleted" with label suffix', () => {
            const services: Record<string, ServiceRecord> = {
                'service:old__deleted': makeService({
                    id: 'service:old__deleted',
                    name: 'old',
                    diff: 'deleted',
                }),
            };
            vi.mocked(detectServices).mockReturnValue({});
            vi.mocked(diffServices).mockReturnValue(services);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);

            const deletedNode = graph.nodes.find(n => n.label.includes('old'));
            expect(deletedNode).toBeDefined();
            expect(deletedNode!.diff).toBe('deleted');
            expect(deletedNode!.label).toContain('(deleted)');
        });
    });

    // ---------------------------------------------------------------
    // 11. Diff propagation: unchanged
    // ---------------------------------------------------------------
    describe('diff propagation — unchanged', () => {
        it('marks all nodes as "unchanged" for identical snapshots', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    diff: 'unchanged',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(diffServices).mockReturnValue(services);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);

            for (const node of graph.nodes) {
                expect(node.diff).toBe('unchanged');
            }
        });
    });

    // ---------------------------------------------------------------
    // 12. Diff on infra nodes
    // ---------------------------------------------------------------
    describe('diff on infrastructure nodes', () => {
        it('marks a new database infra node as "added"', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api' }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:mongo', name: 'MongoDB', kind: 'database', consumedBy: ['service:api'], diff: 'added' }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffServices).mockReturnValue(services);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);

            const mongoNode = findNodeByLabel(graph, 'MongoDB')!;
            expect(mongoNode).toBeDefined();
            expect(mongoNode.diff).toBe('added');
        });

        it('marks a deleted infra node with "(removed)" label suffix', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api' }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:api'], diff: 'deleted' }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffServices).mockReturnValue(services);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);

            const redisNode = graph.nodes.find(n => n.label.includes('Redis'))!;
            expect(redisNode.diff).toBe('deleted');
            expect(redisNode.label).toContain('(removed)');
        });
    });

    // ---------------------------------------------------------------
    // 13. Graph metadata
    // ---------------------------------------------------------------
    describe('graph metadata', () => {
        it('meta contains repoName derived from workspace root basename', () => {
            vi.mocked(detectServices).mockReturnValue({});
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.meta.repoName).toBe('my-project');
        });

        it('meta contains serviceCount', () => {
            const services: Record<string, ServiceRecord> = {
                'service:a': makeService({ id: 'service:a', name: 'a' }),
                'service:b': makeService({ id: 'service:b', name: 'b' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.meta.serviceCount).toBe(2);
        });

        it('meta contains infraCount', () => {
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: [] }),
            ];
            vi.mocked(detectServices).mockReturnValue({});
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.meta.infraCount).toBe(1);
        });

        it('meta.hasChanges is false when all nodes are unchanged', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api', diff: 'unchanged' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.meta.hasChanges).toBe(false);
        });

        it('meta.hasChanges is true when any node has a non-unchanged diff', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api', diff: 'modified' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(diffServices).mockReturnValue(services);

            const working = makeSnapshot();
            const baseline = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, working, baseline);
            expect(graph.meta.hasChanges).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 14. Node types
    // ---------------------------------------------------------------
    describe('node types', () => {
        it('all service nodes have type "service"', () => {
            const services: Record<string, ServiceRecord> = {
                'service:a': makeService({ id: 'service:a', name: 'a' }),
                'service:b': makeService({ id: 'service:b', name: 'b' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            for (const node of graph.nodes) {
                expect(node.type).toBe('service');
            }
        });

        it('infra nodes have type "service" (rendered as special service)', () => {
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: [] }),
            ];
            vi.mocked(detectServices).mockReturnValue({});
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].type).toBe('service');
            expect(graph.nodes[0].meta?.infra).toBe(true);
        });

        it('external nodes have type "service" with meta.external=true', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    consumedUrls: ['https://ext.example.com/api'],
                    consumedServices: [],
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const extNode = graph.nodes.find(n => n.meta?.external === true);
            expect(extNode).toBeDefined();
            expect(extNode!.type).toBe('service');
        });
    });

    // ---------------------------------------------------------------
    // 15. Edge types
    // ---------------------------------------------------------------
    describe('edge types', () => {
        it('inter-service edges have edgeType "inter-service"', () => {
            const services: Record<string, ServiceRecord> = {
                'service:a': makeService({ id: 'service:a', name: 'a', consumedServices: ['service:b'] }),
                'service:b': makeService({ id: 'service:b', name: 'b' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges[0].edgeType).toBe('inter-service');
        });

        it('service→infra edges have edgeType "inter-service"', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api' }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:api'] }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.edges[0].edgeType).toBe('inter-service');
        });
    });

    // ---------------------------------------------------------------
    // 16. Service technology detection (polyglot display)
    // ---------------------------------------------------------------
    describe('service technology detection', () => {
        it('displays primary technology in subtitle', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    technology: 'django',
                    exposedApiCount: 2,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].subtitle).toContain('Django');
        });

        it('displays secondary technologies when detected', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    technology: 'django',
                    exposedApiCount: 1,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectAllTechnologies).mockReturnValue(['django', 'fastapi', 'express']);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // Secondary techs appended: "«Django + FastAPI, Express» 1 API"
            expect(graph.nodes[0].subtitle).toContain('Django');
            expect(graph.nodes[0].subtitle).toContain('FastAPI');
            expect(graph.nodes[0].subtitle).toContain('Express');
        });

        it('does not repeat primary technology in secondary list', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    technology: 'express',
                    exposedApiCount: 0,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectAllTechnologies).mockReturnValue(['express', 'nestjs']);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // Should be "«Express + NestJS»", not "«Express + Express, NestJS»"
            const subtitle = graph.nodes[0].subtitle!;
            // Count occurrences of "Express"
            const expressCount = (subtitle.match(/Express/g) || []).length;
            expect(expressCount).toBe(1);
            expect(subtitle).toContain('NestJS');
        });
    });

    // ---------------------------------------------------------------
    // 17. API count in inter-service edge labels
    // ---------------------------------------------------------------
    describe('API count in edge labels', () => {
        it('includes target API count in inter-service edge label', () => {
            const apiIndex: Record<string, ApiRecord> = {
                'api1': makeApi({ apiId: 'api1', method: 'GET', route: '/users', filePath: 'backend/users.ts' }),
                'api2': makeApi({ apiId: 'api2', method: 'POST', route: '/users', filePath: 'backend/users.ts' }),
            };
            const services: Record<string, ServiceRecord> = {
                'service:frontend': makeService({
                    id: 'service:frontend',
                    name: 'frontend',
                    rootPath: 'frontend',
                    consumedServices: ['service:backend'],
                }),
                'service:backend': makeService({
                    id: 'service:backend',
                    name: 'backend',
                    rootPath: 'backend',
                    exposedApiCount: 2,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const snapshot = makeSnapshot({}, apiIndex);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, snapshot);
            expect(graph.edges[0].label).toContain('2 APIs');
        });
    });

    // ---------------------------------------------------------------
    // 18. Anchors
    // ---------------------------------------------------------------
    describe('anchors', () => {
        it('populates anchors map for service nodes', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api', rootPath: 'api' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const nodeId = graph.nodes[0].id;
            expect(graph.anchors[nodeId]).toBeDefined();
            expect(graph.anchors[nodeId].filePath).toBe('api');
        });

        it('populates anchors map for infra nodes', () => {
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: [] }),
            ];
            vi.mocked(detectServices).mockReturnValue({});
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const nodeId = graph.nodes[0].id;
            expect(graph.anchors[nodeId]).toBeDefined();
            expect(graph.anchors[nodeId].filePath).toBe('');
        });
    });

    // ---------------------------------------------------------------
    // 19. Diff propagation on inter-service edges
    // ---------------------------------------------------------------
    describe('diff propagation on edges', () => {
        it('marks edge as "added" when source service is added', () => {
            const services: Record<string, ServiceRecord> = {
                'service:new': makeService({
                    id: 'service:new',
                    name: 'new',
                    diff: 'added',
                    consumedServices: ['service:existing'],
                }),
                'service:existing': makeService({
                    id: 'service:existing',
                    name: 'existing',
                    diff: 'unchanged',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(diffServices).mockReturnValue(services);

            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot(), makeSnapshot());
            expect(graph.edges[0].diff).toBe('added');
        });

        it('marks edge as "deleted" when target service is deleted', () => {
            const services: Record<string, ServiceRecord> = {
                'service:caller': makeService({
                    id: 'service:caller',
                    name: 'caller',
                    diff: 'unchanged',
                    consumedServices: ['service:removed'],
                }),
                'service:removed': makeService({
                    id: 'service:removed',
                    name: 'removed',
                    diff: 'deleted',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(diffServices).mockReturnValue(services);

            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot(), makeSnapshot());
            expect(graph.edges[0].diff).toBe('deleted');
        });
    });

    // ---------------------------------------------------------------
    // 20. Infra edge diff propagation
    // ---------------------------------------------------------------
    describe('infra edge diff propagation', () => {
        it('propagates service "added" diff to the service→infra edge', () => {
            const services: Record<string, ServiceRecord> = {
                'service:new-api': makeService({
                    id: 'service:new-api',
                    name: 'new-api',
                    diff: 'added',
                }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: ['service:new-api'], diff: 'unchanged' }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffServices).mockReturnValue(services);

            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot(), makeSnapshot());
            expect(graph.edges[0].diff).toBe('added');
        });

        it('uses infra diff when service is unchanged', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    diff: 'unchanged',
                }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: ['service:api'], diff: 'modified' }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffInfrastructureServices).mockReturnValue(infra);
            vi.mocked(diffServices).mockReturnValue(services);

            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot(), makeSnapshot());
            expect(graph.edges[0].diff).toBe('modified');
        });
    });

    // ---------------------------------------------------------------
    // 21. Service with zero exposed APIs shows tech-only subtitle
    // ---------------------------------------------------------------
    describe('subtitle formatting', () => {
        it('shows only technology when exposedApiCount is 0', () => {
            const services: Record<string, ServiceRecord> = {
                'service:worker': makeService({
                    id: 'service:worker',
                    name: 'worker',
                    technology: 'express',
                    exposedApiCount: 0,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectAllTechnologies).mockReturnValue(['express']);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].subtitle).toBe('«Express»');
        });

        it('uses singular "API" when count is 1', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    technology: 'express',
                    exposedApiCount: 1,
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // #142: relabeled to "HTTP route" — singular case must not pluralise.
            expect(graph.nodes[0].subtitle).toContain('1 HTTP route');
            expect(graph.nodes[0].subtitle).not.toContain('1 HTTP routes');
        });
    });

    // ---------------------------------------------------------------
    // 22. Node IDs are unique
    // ---------------------------------------------------------------
    describe('node ID uniqueness', () => {
        it('generates unique IDs across all nodes', () => {
            const services: Record<string, ServiceRecord> = {
                'service:a': makeService({ id: 'service:a', name: 'a', consumedUrls: ['https://ext.io/api'], consumedServices: [] }),
                'service:b': makeService({ id: 'service:b', name: 'b' }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: ['service:a'] }),
                makeInfra({ id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:b'] }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const ids = graph.nodes.map(n => n.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    // ---------------------------------------------------------------
    // 23. Service with rootPath '' uses '.' as body
    // ---------------------------------------------------------------
    describe('root-level service', () => {
        it('uses "." as body when rootPath is empty', () => {
            const services: Record<string, ServiceRecord> = {
                'service:main': makeService({
                    id: 'service:main',
                    name: 'main',
                    rootPath: '',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes[0].body).toBe('.');
        });
    });

    // ---------------------------------------------------------------
    // 24. Complex scenario: multiple services, infra, and externals
    // ---------------------------------------------------------------
    describe('complex multi-service scenario', () => {
        it('builds a complete graph with services, infra, and externals', () => {
            const services: Record<string, ServiceRecord> = {
                'service:backend': makeService({
                    id: 'service:backend',
                    name: 'backend',
                    rootPath: 'backend',
                    technology: 'express',
                    exposedApiCount: 10,
                    consumedUrls: ['https://stripe.com/v1/charges'],
                    consumedServices: [],
                }),
                'service:frontend': makeService({
                    id: 'service:frontend',
                    name: 'frontend',
                    rootPath: 'frontend',
                    technology: 'nextjs',
                    exposedApiCount: 0,
                    consumedServices: ['service:backend'],
                }),
                'service:worker': makeService({
                    id: 'service:worker',
                    name: 'worker',
                    rootPath: 'worker',
                    technology: 'express',
                    exposedApiCount: 0,
                    consumedServices: ['service:backend'],
                }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:pg', name: 'PostgreSQL', kind: 'database', consumedBy: ['service:backend'] }),
                makeInfra({ id: 'infra:redis', name: 'Redis', kind: 'cache', consumedBy: ['service:backend', 'service:worker'] }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);

            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());

            // 3 services + 2 infra + 1 external (stripe.com)
            expect(graph.nodes.length).toBeGreaterThanOrEqual(6);

            // Edges: frontend→backend, worker→backend, backend→pg, backend→redis, worker→redis, backend→stripe
            expect(graph.edges.length).toBeGreaterThanOrEqual(5);

            // Verify graph metadata
            expect(graph.meta.serviceCount).toBe(3);
            expect(graph.meta.infraCount).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // Tier 1 (Issue 364 — Same TS file parsed up to 5× per save) — Worker nodes for JOB / MQ_CONSUMER records
    // ---------------------------------------------------------------
    describe('Tier 1 worker nodes', () => {
        it('emits a Worker node when the snapshot has JOB records and links it to the service', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({
                    id: 'service:api',
                    name: 'api',
                    rootPath: '',
                    technology: 'spring',
                }),
            };
            vi.mocked(detectServices).mockReturnValue(services);

            const apiIndex: Record<string, ApiRecord> = {
                'job:report': makeApi({
                    apiId: 'job:report', method: 'JOB',
                    route: '/cron:0 0 * * * *', filePath: 'src/jobs/Report.java',
                    handlerName: 'generateReport',
                }),
            };
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot({}, apiIndex));

            const worker = graph.nodes.find(n => n.meta?.worker === true);
            expect(worker).toBeDefined();
            expect(worker?.label).toBe('Workers · api');
            expect(worker?.subtitle).toMatch(/«worker» 1 job/);
            expect(graph.meta.workerCount).toBe(1);

            // Service "runs" the worker
            const serviceNode = graph.nodes.find(n => n.label === 'api');
            const runsEdge = graph.edges.find(e =>
                e.source === serviceNode?.id && e.target === worker?.id && e.label === 'runs'
            );
            expect(runsEdge).toBeDefined();
        });

        it('emits a "consumes" edge from the Worker to the matching broker infra (Kafka)', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api', rootPath: '', technology: 'spring' }),
            };
            const infra: InfrastructureService[] = [
                makeInfra({ id: 'infra:kafka', name: 'Kafka', kind: 'queue', consumedBy: ['service:api'] }),
            ];
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);

            const apiIndex: Record<string, ApiRecord> = {
                'mq:orders': makeApi({
                    apiId: 'mq:orders', method: 'MQ_CONSUMER',
                    route: '/kafka:orders', filePath: 'src/consumers/OrderConsumer.java',
                    handlerName: 'onOrder',
                }),
            };
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot({}, apiIndex));

            const worker = graph.nodes.find(n => n.meta?.worker === true);
            const kafka = graph.nodes.find(n => n.label === 'Kafka');
            expect(worker).toBeDefined();
            expect(kafka).toBeDefined();
            const consumesEdge = graph.edges.find(e =>
                e.source === worker?.id && e.target === kafka?.id && e.label === 'consumes'
            );
            expect(consumesEdge).toBeDefined();
        });

        it('does not emit a Worker node when there are no JOB or MQ_CONSUMER records', () => {
            const services: Record<string, ServiceRecord> = {
                'service:api': makeService({ id: 'service:api', name: 'api', rootPath: '', technology: 'spring' }),
            };
            vi.mocked(detectServices).mockReturnValue(services);

            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(graph.nodes.some(n => n.meta?.worker === true)).toBe(false);
            expect(graph.meta.workerCount).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Issue 367 — Worker node + edge diff propagation
    // ---------------------------------------------------------------
    describe('Tier 1 worker diff propagation', () => {
        const services: Record<string, ServiceRecord> = {
            'service:api': makeService({ id: 'service:api', name: 'api', rootPath: '', technology: 'spring' }),
        };
        const infra: InfrastructureService[] = [
            makeInfra({ id: 'infra:kafka', name: 'Kafka', kind: 'queue', consumedBy: ['service:api'] }),
        ];

        beforeEach(() => {
            vi.mocked(detectServices).mockReturnValue(services);
            vi.mocked(detectInfrastructureServices).mockReturnValue(infra);
        });

        const baselineSnap = makeSnapshot({}, {
            'mq:orders': makeApi({
                apiId: 'mq:orders', method: 'MQ_CONSUMER',
                route: '/kafka:orders', filePath: 'src/consumers/Order.java',
                handlerName: 'onOrder',
            }),
        });

        it('Worker node and runs edge mark as `added` when first job appears', () => {
            // Baseline has no JOB/MQ_CONSUMER records; working has one.
            const workingSnap = makeSnapshot({}, {
                'mq:orders': makeApi({
                    apiId: 'mq:orders', method: 'MQ_CONSUMER',
                    route: '/kafka:orders', filePath: 'src/consumers/Order.java',
                    handlerName: 'onOrder',
                }),
            });
            const baselineEmpty = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, workingSnap, baselineEmpty);
            const worker = graph.nodes.find(n => n.meta?.worker === true);
            expect(worker?.diff).toBe('added');
            const runsEdge = graph.edges.find(e => e.label === 'runs' && e.target === worker?.id);
            expect(runsEdge?.diff).toBe('added');
            const consumesEdge = graph.edges.find(e => e.label === 'consumes' && e.source === worker?.id);
            expect(consumesEdge?.diff).toBe('added');
        });

        it('Worker node marks as `deleted` when the last job is removed', () => {
            const workingEmpty = makeSnapshot();
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, workingEmpty, baselineSnap);
            const worker = graph.nodes.find(n => n.meta?.worker === true);
            expect(worker).toBeDefined();
            expect(worker?.diff).toBe('deleted');
            expect(worker?.label).toContain('(removed)');
            const runsEdge = graph.edges.find(e => e.label === 'runs' && e.target === worker?.id);
            expect(runsEdge?.diff).toBe('deleted');
        });

        it('Worker node marks as `modified` when the consumer route set changes', () => {
            const workingChanged = makeSnapshot({}, {
                'mq:orders': makeApi({
                    apiId: 'mq:orders', method: 'MQ_CONSUMER',
                    route: '/kafka:orders.v2', filePath: 'src/consumers/Order.java',
                    handlerName: 'onOrder',
                }),
            });
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, workingChanged, baselineSnap);
            const worker = graph.nodes.find(n => n.meta?.worker === true);
            expect(worker?.diff).toBe('modified');
        });

        it('Worker stays `unchanged` when route set is identical between baseline and working', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, baselineSnap, baselineSnap);
            const worker = graph.nodes.find(n => n.meta?.worker === true);
            expect(worker?.diff).toBe('unchanged');
            const runsEdge = graph.edges.find(e => e.label === 'runs' && e.target === worker?.id);
            expect(runsEdge?.diff).toBe('unchanged');
        });
    });

    // v2 phase 2 PR-C — SDK nodes at L1 for FE/mobile services.
    //
    // Locks the rendering contract: each `kind: 'sdk'` infra entry
    // produces ONE node with `meta.kind === 'sdk'` + `meta.sdkId`, the
    // subtitle reads `«sdk · <category>»`, and the consumer→SDK edge
    // carries the literal label `imports` (distinct from `stores` /
    // `caches` / `publishes` / `uses` used by other infra kinds).
    //
    // Failure modes the test catches:
    //   - A renderer change that swallows `meta.sdkId` / `meta.sdkCategory`
    //     so the icon mapping in the React side breaks.
    //   - An edge-label regression that uses `'uses'` for SDK consumers,
    //     making L1 read as "fe-app uses Stripe" instead of imports.
    //   - Mixing SDK nodes with same-name DB nodes (a `Stripe` infra
    //     node with `kind: 'database'` would collapse in the name-merge
    //     pass).
    describe('SDK nodes at L1 (v2 phase 2 #482)', () => {
        beforeEach(() => {
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web',
                    rootPath: 'apps/web',
                    technology: 'nextjs',
                    category: 'frontend',
                    exposedApiCount: 5,
                }),
            });
            vi.mocked(detectInfrastructureServices).mockReturnValue([
                makeInfra({
                    id: 'sdk:stripe', name: 'Stripe', kind: 'sdk',
                    consumedBy: ['service:web'],
                    sdkId: 'stripe', sdkCategory: 'payments',
                }),
                makeInfra({
                    id: 'sdk:sentry', name: 'Sentry', kind: 'sdk',
                    consumedBy: ['service:web'],
                    sdkId: 'sentry', sdkCategory: 'observability',
                }),
            ]);
            vi.mocked(diffInfrastructureServices).mockImplementation((_base, working) => working);
        });

        it('emits one node per SDK with sdkId + sdkCategory in meta and «sdk · <cat>» subtitle', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const stripeNode = findNodeByLabel(graph, 'Stripe');
            const sentryNode = findNodeByLabel(graph, 'Sentry');
            expect(stripeNode).toBeDefined();
            expect(sentryNode).toBeDefined();
            expect(stripeNode!.meta?.kind).toBe('sdk');
            expect(stripeNode!.meta?.sdkId).toBe('stripe');
            expect(stripeNode!.meta?.sdkCategory).toBe('payments');
            expect(stripeNode!.subtitle).toBe('«sdk · payments»');
            expect(sentryNode!.meta?.kind).toBe('sdk');
            expect(sentryNode!.meta?.sdkId).toBe('sentry');
            expect(sentryNode!.subtitle).toBe('«sdk · observability»');
        });

        it('consumer→SDK edge carries the `imports` label, not `uses`/`stores`/`caches`/`publishes`', () => {
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const webNode = findNodeByLabel(graph, 'web')!;
            const stripeNode = findNodeByLabel(graph, 'Stripe')!;
            const edge = findEdgeBySourceTarget(graph, webNode.id, stripeNode.id);
            expect(edge).toBeDefined();
            expect(edge!.label).toBe('imports');
        });

        it('SDK subtitle falls back to «sdk» when sdkCategory is missing', () => {
            vi.mocked(detectInfrastructureServices).mockReturnValue([
                makeInfra({
                    id: 'sdk:bare', name: 'Bare', kind: 'sdk',
                    consumedBy: ['service:web'],
                    sdkId: 'bare',
                    // sdkCategory intentionally omitted
                }),
            ]);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const bareNode = findNodeByLabel(graph, 'Bare')!;
            expect(bareNode.subtitle).toBe('«sdk»');
        });
    });

    // v2 phase 2 PR-E — External-API node fallback for FE-only repos.
    //
    // What this suite locks:
    //   1. An FE-only repo (no backend service in workspace) with an
    //      absolute outbound URL to a third party (e.g. `https://api.
    //      stripe.com/v1/charges`) emits ONE external L1 node for the
    //      provider host. The hostname extraction works for FE-only
    //      repos exactly as it does for backend repos.
    //   2. SDK + external coexistence: when the SAME FE service both
    //      imports `@stripe/stripe-js` (SDK detection) AND calls
    //      `https://api.stripe.com/...` (URL detection), the L1 graph
    //      emits BOTH node types — they have different roles (SDK is a
    //      library dependency; external is a network endpoint). The
    //      legacy "name-similarity" merge MUST NOT collapse them.
    //   3. FE→backend + external mix: a single service with one
    //      `path:` match to a workspace backend AND one absolute URL
    //      to a third-party emits the correct edges to both, with
    //      the legacy fallback suppressed (the precise path match
    //      claimed the backend already).
    //   4. SDK added in working / removed in baseline produces the
    //      correct diff annotation on the SDK node.
    describe('External-API node fallback + SDK coexistence (v2 phase 2 #483)', () => {
        beforeEach(() => {
            // Default: a single FE-only service with no backend siblings.
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web',
                    rootPath: 'apps/web',
                    technology: 'nextjs',
                    category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: [],
                    consumedServices: [],
                }),
            });
            vi.mocked(detectInfrastructureServices).mockReturnValue([]);
            vi.mocked(diffInfrastructureServices).mockImplementation((_base, working) => working);
        });

        it('FE-only repo with https://api.stripe.com URL emits one external node for stripe.com', () => {
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: ['https://api.stripe.com/v1/charges'],
                    consumedServices: [],
                }),
            });
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const externalNode = findNodeByLabel(graph, 'api.stripe.com');
            expect(externalNode).toBeDefined();
            expect(externalNode!.subtitle).toBe('«external»');
            expect(externalNode!.meta?.external).toBe(true);
        });

        it('SDK and external nodes coexist for the same provider without merging', () => {
            // Service imports @stripe/stripe-js AND calls https://api.stripe.com.
            // SDK detection (via detectInfrastructureServices) emits an
            // `sdk:stripe` node; the external-URL fallback emits an
            // `external:api.stripe.com` node. Both must appear.
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: ['https://api.stripe.com/v1/charges'],
                    consumedServices: [],
                }),
            });
            vi.mocked(detectInfrastructureServices).mockReturnValue([
                makeInfra({
                    id: 'sdk:stripe', name: 'Stripe', kind: 'sdk',
                    consumedBy: ['service:web'],
                    sdkId: 'stripe', sdkCategory: 'payments',
                }),
            ]);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const sdkNode = findNodeByLabel(graph, 'Stripe');
            const extNode = findNodeByLabel(graph, 'api.stripe.com');
            expect(sdkNode).toBeDefined();
            expect(sdkNode!.subtitle).toBe('«sdk · payments»');
            expect(extNode).toBeDefined();
            expect(extNode!.subtitle).toBe('«external»');
            // Two distinct nodes.
            expect(sdkNode!.id).not.toBe(extNode!.id);
        });

        it('FE→backend (path match) + FE→external (third-party URL) emit both edges', () => {
            // v2 follow-up #715 — hostname suppression now uses EXACT
            // hostname equality (not substring), so `service:api` no
            // longer drops `https://api.stripe.com` external nodes.
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: ['path:/api/articles', 'https://api.stripe.com/v1/charges'],
                    consumedServices: ['service:api'],
                }),
                'service:api': makeService({
                    id: 'service:api', name: 'api', rootPath: 'apps/api',
                    technology: 'express', category: 'backend',
                    exposedApiCount: 1,
                    consumedUrls: [], consumedServices: [],
                }),
            });
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const web = findNodeByLabel(graph, 'web')!;
            const backend = findNodeByLabel(graph, 'api')!;
            const stripe = findNodeByLabel(graph, 'api.stripe.com')!;
            expect(backend).toBeDefined();
            expect(stripe, 'external Stripe node must survive — hostname `api.stripe.com` ≠ service `api`').toBeDefined();
            // Edge web→backend (inter-service via consumedServices).
            expect(findEdgeBySourceTarget(graph, web.id, backend.id)).toBeDefined();
            // Edge web→external (URL hostname).
            expect(findEdgeBySourceTarget(graph, web.id, stripe.id)).toBeDefined();
        });

        it('#715: workspace service named `web` does NOT suppress external `web.archive.org`', () => {
            // The old substring match would silently drop the external
            // node because `web` is a substring of `web.archive.org`.
            // Exact-hostname comparison preserves the third-party edge.
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    consumedUrls: ['https://web.archive.org/snapshot'],
                    consumedServices: ['service:web'],  // self-ref (no-op)
                }),
            });
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            expect(findNodeByLabel(graph, 'web.archive.org')).toBeDefined();
        });

        it('#715: hostname EQUALS a service name → external node IS suppressed (the legitimate case)', () => {
            // When a service is literally named after its public
            // hostname (rare but happens for vanity-named subdomains
            // pointing at workspace services), the suppression still
            // fires — that's the original intent. We've only tightened
            // it to exact equality.
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    consumedUrls: ['https://api/v1/users'],
                    consumedServices: ['service:api'],
                }),
                'service:api': makeService({
                    id: 'service:api', name: 'api', rootPath: 'apps/api',
                    technology: 'express', category: 'backend',
                    exposedApiCount: 1,
                }),
            });
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // External `api` (hostname-only) would collide with
            // `service:api`. Exact equality on hostname `api`
            // suppresses correctly — no duplicate external node.
            const allApiNodes = graph.nodes.filter((n) => n.label === 'api');
            // Exactly one node labelled 'api' (the workspace service).
            expect(allApiNodes.length).toBe(1);
            expect(allApiNodes[0].meta?.external).toBeUndefined();
        });

        it('SDK added in working (not in baseline) carries diff=added', () => {
            // Baseline: no SDK. Working: Stripe SDK.
            const baselineSnap = makeSnapshot();
            const workingSnap = makeSnapshot();
            vi.mocked(detectInfrastructureServices)
                .mockImplementationOnce(() => [
                    // Working call — fires FIRST per buildMicroserviceGraph order.
                    makeInfra({
                        id: 'sdk:stripe', name: 'Stripe', kind: 'sdk',
                        consumedBy: ['service:web'],
                        sdkId: 'stripe', sdkCategory: 'payments',
                    }),
                ])
                .mockImplementationOnce(() => []);  // Baseline call — empty.
            // diffInfrastructureServices: working has stripe, baseline doesn't → diff=added.
            vi.mocked(diffInfrastructureServices).mockImplementation((_base, working) =>
                working.map((w) => ({ ...w, diff: 'added' as DiffStatus })),
            );
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, workingSnap, baselineSnap);
            const stripe = findNodeByLabel(graph, 'Stripe')!;
            expect(stripe).toBeDefined();
            expect(stripe.diff).toBe('added');
        });

        it('SDK removed in working (was in baseline) carries diff=deleted', () => {
            const baselineSnap = makeSnapshot();
            const workingSnap = makeSnapshot();
            vi.mocked(detectInfrastructureServices)
                .mockImplementationOnce(() => [])  // Working: empty.
                .mockImplementationOnce(() => [    // Baseline: had Stripe.
                    makeInfra({
                        id: 'sdk:stripe', name: 'Stripe', kind: 'sdk',
                        consumedBy: ['service:web'],
                        sdkId: 'stripe', sdkCategory: 'payments',
                    }),
                ]);
            vi.mocked(diffInfrastructureServices).mockImplementation((base, _working) =>
                base.map((b) => ({ ...b, diff: 'deleted' as DiffStatus })),
            );
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, workingSnap, baselineSnap);
            // Removed SDK retains node, labelled "(removed)" by the builder.
            const removedNode = graph.nodes.find((n) => n.label === 'Stripe (removed)');
            expect(removedNode).toBeDefined();
            expect(removedNode!.diff).toBe('deleted');
        });

        it('multiple FE services importing the same SDK produce ONE shared L1 node with consumedBy listing both', () => {
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: [], consumedServices: [],
                }),
                'service:admin': makeService({
                    id: 'service:admin', name: 'admin', rootPath: 'apps/admin',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: [], consumedServices: [],
                }),
            });
            vi.mocked(detectInfrastructureServices).mockReturnValue([
                makeInfra({
                    id: 'sdk:sentry', name: 'Sentry', kind: 'sdk',
                    consumedBy: ['service:web', 'service:admin'],
                    sdkId: 'sentry', sdkCategory: 'observability',
                }),
            ]);
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            // Exactly one Sentry node.
            const sentryNodes = graph.nodes.filter((n) => n.label === 'Sentry');
            expect(sentryNodes.length).toBe(1);
            // Both web → Sentry and admin → Sentry edges exist.
            const web = findNodeByLabel(graph, 'web')!;
            const admin = findNodeByLabel(graph, 'admin')!;
            const sentry = sentryNodes[0];
            expect(findEdgeBySourceTarget(graph, web.id, sentry.id)).toBeDefined();
            expect(findEdgeBySourceTarget(graph, admin.id, sentry.id)).toBeDefined();
        });

        it('localhost / 127.0.0.1 URLs from FE service emit external nodes', () => {
            // Edge case: dev-mode FE pointed at `http://localhost:4000`.
            // Should produce an external L1 node for `localhost`, NOT
            // get silently dropped or merged with workspace services.
            vi.mocked(detectServices).mockReturnValue({
                'service:web': makeService({
                    id: 'service:web', name: 'web', rootPath: 'apps/web',
                    technology: 'nextjs', category: 'frontend',
                    exposedApiCount: 0,
                    consumedUrls: ['http://localhost:4000/api/foo'],
                    consumedServices: [],
                }),
            });
            const graph = buildMicroserviceGraph(WORKSPACE_ROOT, makeSnapshot());
            const localhost = findNodeByLabel(graph, 'localhost');
            expect(localhost).toBeDefined();
            expect(localhost!.subtitle).toBe('«external»');
        });
    });
});
