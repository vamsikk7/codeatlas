/**
 * ADR-034 Phase B — skeletalL1 builder tests (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)).
 *
 * Pure-function unit tests. No file system. No DB. No registry.
 */
import { describe, it, expect } from 'vitest';
import { buildSkeletalL1, buildCrossRepoEdges } from '../skeletalL1';
import type { RepoRow } from '../../storage/storeInterfaces';

function repo(overrides: Partial<RepoRow> = {}): RepoRow {
    return {
        repoId: 'r-default',
        name: 'default',
        rootPath: 'default',
        realpathHash: 'h-default',
        technology: null,
        status: 'ready',
        lastInitAt: 0,
        errorMessage: null,
        fallbackStatePath: null,
        stateDbSchemaVersion: 9,
        summarySchemaVersion: 1,
        diff: null,
        ...overrides,
    };
}

const WS = '/workspace';

describe('buildSkeletalL1', () => {
    it('empty repos list → empty nodes, valid graph shape', () => {
        const g = buildSkeletalL1([], WS);
        expect(g.graphId).toBe('microservice:workspace');
        expect(g.type).toBe('microservice');
        expect(g.nodes).toEqual([]);
        expect(g.edges).toEqual([]);
        expect(g.anchors).toEqual({});
        expect(g.meta.skeletal).toBe(true);
        expect(g.meta.repoCount).toBe(0);
    });

    it('N repos → N service nodes with repoId on each', () => {
        const repos = [
            repo({ repoId: 'a', name: 'svc-a', rootPath: 'svc-a' }),
            repo({ repoId: 'b', name: 'svc-b', rootPath: 'svc-b' }),
            repo({ repoId: 'c', name: 'svc-c', rootPath: 'svc-c' }),
        ];
        const g = buildSkeletalL1(repos, WS);
        expect(g.nodes).toHaveLength(3);
        expect(g.nodes.map((n) => n.id)).toEqual(['service:a', 'service:b', 'service:c']);
        for (const n of g.nodes) {
            expect(n.type).toBe('service');
            expect(n.meta!.skeletal).toBe(true);
            expect(typeof (n.meta as any).repoId).toBe('string');
        }
    });

    it('meta.skeletal=true on graph + every node — signals "still loading"', () => {
        const g = buildSkeletalL1([repo({ repoId: 'a', name: 'svc' })], WS);
        expect(g.meta.skeletal).toBe(true);
        expect(g.nodes[0].meta!.skeletal).toBe(true);
    });

    it('draws cross-repo HTTP edges between repo nodes (BUG-L1-CROSSREPO-EDGE)', () => {
        const repos = [repo({ repoId: 'clients', name: 'clients', rootPath: 'clients' }), repo({ repoId: 'server', name: 'server', rootPath: 'server' })];
        const g = buildSkeletalL1(repos, WS, [
            { sourceRepo: 'clients', targetRepo: 'server', method: 'GET', route: '/v1/orders', diff: null },
        ]);
        const edge = g.edges.find((e) => (e.meta as any)?.kind === 'cross-repo-http');
        expect(edge).toBeDefined();
        expect(edge!.source).toBe('service:clients');
        expect(edge!.target).toBe('service:server');
        expect(edge!.label).toBe('GET /v1/orders');
        // No edges when none are passed (skeletal-only default).
        expect(buildSkeletalL1(repos, WS).edges).toEqual([]);
    });

    it('buildCrossRepoEdges injects edges for a stored graph that has none (BUG-L1-CROSSREPO-EDGE serve-time inject)', () => {
        // The stored skeletal graph can be written BEFORE the cross-repo edge pass
        // populates the table (init-ordering), leaving edges:[]. The serve path
        // re-derives edges from the table via this helper.
        const nodes = [
            { id: 'service:clients', meta: { repoId: 'clients' } },
            { id: 'service:server', meta: { repoId: 'server' } },
        ] as any;
        const edges = buildCrossRepoEdges(nodes, [
            { sourceRepo: 'clients', targetRepo: 'server', method: 'GET', route: '/', diff: null },
        ] as any);
        expect(edges).toHaveLength(1);
        expect(edges[0].source).toBe('service:clients');
        expect(edges[0].target).toBe('service:server');
        expect(edges[0].label).toBe('GET /');
        expect((edges[0].meta as any).kind).toBe('cross-repo-http');
        // skips edges whose src/dst node is absent, and de-dupes by id
        expect(buildCrossRepoEdges(nodes, [
            { sourceRepo: 'clients', targetRepo: 'ghost', method: 'GET', route: '/', diff: null },
        ] as any)).toEqual([]);
        expect(buildCrossRepoEdges(nodes, [
            { sourceRepo: 'clients', targetRepo: 'server', method: 'GET', route: '/', diff: null },
            { sourceRepo: 'clients', targetRepo: 'server', method: 'GET', route: '/', diff: null },
        ] as any)).toHaveLength(1);
    });

    it('label falls back from name → rootPath → repoId', () => {
        const g = buildSkeletalL1(
            [
                repo({ repoId: 'no-name', name: '', rootPath: 'fallback-root' }),
                repo({ repoId: 'no-name-or-root', name: '', rootPath: '' }),
                repo({ repoId: 'normal', name: 'a-real-name', rootPath: 'wat' }),
            ],
            WS,
        );
        expect(g.nodes[0].label).toBe('fallback-root');
        expect(g.nodes[1].label).toBe('no-name-or-root');   // falls back to repoId
        expect(g.nodes[2].label).toBe('a-real-name');
    });

    it('propagates status + errorMessage for per-repo failure UX (Phase E)', () => {
        const g = buildSkeletalL1(
            [
                repo({ repoId: 'a', status: 'parsing' }),
                repo({ repoId: 'b', status: 'failed', errorMessage: 'parse blew up' }),
                repo({ repoId: 'c', status: 'ready' }),
            ],
            WS,
        );
        expect(g.nodes[0].meta!.status).toBe('parsing');
        expect(g.nodes[1].meta!.status).toBe('failed');
        expect((g.nodes[1].meta as any).errorMessage).toBe('parse blew up');
        expect(g.nodes[2].meta!.status).toBe('ready');
    });

    it('propagates technology hint when set', () => {
        const g = buildSkeletalL1(
            [
                repo({ repoId: 'a', technology: 'nodejs' }),
                repo({ repoId: 'b', technology: null }),
            ],
            WS,
        );
        expect((g.nodes[0].meta as any).technology).toBe('nodejs');
        expect((g.nodes[1].meta as any).technology).toBeNull();
    });

    it('graph.meta.workspaceRoot + repoCount + builtAt populated', () => {
        const before = Date.now();
        const g = buildSkeletalL1(
            [repo({ repoId: 'a' }), repo({ repoId: 'b' })],
            WS,
        );
        const after = Date.now();
        expect(g.meta.workspaceRoot).toBe(WS);
        expect(g.meta.repoCount).toBe(2);
        expect(g.meta.builtAt as number).toBeGreaterThanOrEqual(before);
        expect(g.meta.builtAt as number).toBeLessThanOrEqual(after);
    });

    it('node ids match the `service:<repoId>` drill-in convention', () => {
        const g = buildSkeletalL1([repo({ repoId: 'sha-abc123' })], WS);
        expect(g.nodes[0].id).toBe('service:sha-abc123');
    });

    it('UX-27: buckets by AWS service when repo count > 50', () => {
        const repos = [
            ...Array.from({ length: 20 }, (_, i) => repo({ repoId: `r${i}`, name: `apigateway-sqs-${i}`, rootPath: `apigateway-sqs-${i}` })),
            ...Array.from({ length: 15 }, (_, i) => repo({ repoId: `s${i}`, name: `lambda-dynamodb-${i}`, rootPath: `lambda-dynamodb-${i}` })),
            ...Array.from({ length: 12 }, (_, i) => repo({ repoId: `t${i}`, name: `eventbridge-pipes-${i}`, rootPath: `eventbridge-pipes-${i}` })),
            ...Array.from({ length: 8 }, (_, i) => repo({ repoId: `u${i}`, name: `sns-fanout-${i}`, rootPath: `sns-fanout-${i}` })),
        ];
        const g = buildSkeletalL1(repos as any, '/ws');
        expect((g.meta as any).bucketed).toBe(true);
        expect((g.meta as any).bucketReason).toBe('aws-services');
        expect((g.meta as any).repoCount).toBe(55);
        // 55 raw repos collapse to a small handful of AWS-service buckets.
        expect(g.nodes.length).toBeLessThan(10);
        const labels = g.nodes.map((n) => n.label);
        expect(labels).toEqual(expect.arrayContaining(['API Gateway', 'Lambda']));
    });

    it('UX-27: does NOT bucket when repo count at or below threshold', () => {
        const repos = Array.from({ length: 50 }, (_, i) => repo({ repoId: `r${i}`, name: `apigateway-${i}`, rootPath: `apigateway-${i}` }));
        const g = buildSkeletalL1(repos as any, '/ws');
        expect((g.meta as any).bucketed).not.toBe(true);
        expect(g.nodes.length).toBe(50);
    });
});
