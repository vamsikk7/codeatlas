/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — crossRepoHttpAnalyzer tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { CrossRepoAnalyzerRegistry } from '../../sync/crossRepoAnalyzer';
import { crossRepoHttpAnalyzer } from '../crossRepoHttpAnalyzer';
import { emptyRepoSummary, type RepoSummary, type SummaryApi } from '../../sync/repoSummary';
import type { RepoRow } from '../../storage/storeInterfaces';
import { filterMicroserviceGraphForRepo } from '../../graph/scopedMicroserviceGraphFilter';

const tmpDirs: string[] = [];

async function makeAggregator(): Promise<AggregatorStore> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crha-test-'));
    tmpDirs.push(dir);
    const agg = new AggregatorStore(dir, { inMemoryOnly: true });
    const reg = new CrossRepoAnalyzerRegistry();
    reg.register(crossRepoHttpAnalyzer);
    agg.setAnalyzerRegistry(reg);
    await agg.init();
    return agg;
}

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

function repoRow(repoId: string, rootPath: string = repoId): RepoRow {
    return {
        repoId, name: rootPath, rootPath, realpathHash: repoId,
        technology: null, status: 'ready', lastInitAt: 0, errorMessage: null,
        fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
        diff: null,
    };
}

function api(method: string, route: string): SummaryApi {
    return { apiId: `${method}:${route}`, method, route, filePath: 'src/x.js', handlerName: 'h' };
}

function summary(repoId: string, opts: { apis?: ReadonlyArray<SummaryApi>; httpClientPaths?: ReadonlyArray<string> } = {}): RepoSummary {
    return {
        ...emptyRepoSummary(repoId),
        apis: opts.apis ?? [],
        httpClientPaths: opts.httpClientPaths ?? [],
    };
}

describe('crossRepoHttpAnalyzer — exact path match', () => {
    it('alpha calls /api/svc-beta/items/:id; beta exposes it → edge emitted', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo(repoRow('svc-alpha'));
        agg.upsertRepo(repoRow('svc-beta'));

        // Setup: beta's apis live in the aggregator's repo_summaries first
        // so when alpha applies, the matcher can see them.
        agg.applySummary('svc-beta', summary('svc-beta', {
            apis: [api('GET', '/api/svc-beta/items/:id')],
        }));
        agg.applySummary('svc-alpha', summary('svc-alpha', {
            httpClientPaths: ['http://svc-beta:3001/api/svc-beta/items/${id}'],
        }));

        const edges = agg.listCrossRepoHttpEdges();
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
            sourceRepo: 'svc-alpha',
            targetRepo: 'svc-beta',
            method: 'GET',
            route: '/api/svc-beta/items/${id}',
        });
        agg.close();
    });

    it('no match → no edge emitted', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo(repoRow('svc-alpha'));
        agg.upsertRepo(repoRow('svc-beta'));
        agg.applySummary('svc-beta', summary('svc-beta', { apis: [api('GET', '/api/items')] }));
        agg.applySummary('svc-alpha', summary('svc-alpha', {
            httpClientPaths: ['http://svc-beta:3001/api/different/thing'],
        }));
        expect(agg.listCrossRepoHttpEdges()).toEqual([]);
        agg.close();
    });
});

describe('crossRepoHttpAnalyzer — path parameter normalisation', () => {
    it('Express :id matches ${id} matches {id}', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo(repoRow('svc-alpha'));
        agg.upsertRepo(repoRow('svc-beta'));
        agg.applySummary('svc-beta', summary('svc-beta', { apis: [api('GET', '/users/:id')] }));
        agg.applySummary('svc-alpha', summary('svc-alpha', {
            httpClientPaths: [
                'http://svc-beta/users/${userId}',
                'http://svc-beta/users/{userId}',
                'http://svc-beta/users/:userId',
            ],
        }));
        const edges = agg.listCrossRepoHttpEdges();
        // All three forms normalise to the same route → first match wins
        // per-source-URL, so 3 source URLs → 3 edges with the same target.
        expect(edges.length).toBeGreaterThanOrEqual(1);
        for (const e of edges) {
            expect(e.sourceRepo).toBe('svc-alpha');
            expect(e.targetRepo).toBe('svc-beta');
            expect(e.method).toBe('GET');
        }
        agg.close();
    });
});

describe('crossRepoHttpAnalyzer — multiple targets', () => {
    it('two repos expose the same route → two edges, one per target', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo(repoRow('caller'));
        agg.upsertRepo(repoRow('svc-a'));
        agg.upsertRepo(repoRow('svc-b'));
        agg.applySummary('svc-a', summary('svc-a', { apis: [api('GET', '/api/data')] }));
        agg.applySummary('svc-b', summary('svc-b', { apis: [api('GET', '/api/data')] }));
        agg.applySummary('caller', summary('caller', {
            httpClientPaths: ['http://anywhere/api/data'],
        }));
        const targets = agg.listCrossRepoHttpEdges().map((e) => e.targetRepo).sort();
        expect(targets).toEqual(['svc-a', 'svc-b']);
        agg.close();
    });
});

describe('crossRepoHttpAnalyzer — reapply cleans prior edges', () => {
    it('source removes a httpClientPath → its prior edges are dropped', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo(repoRow('alpha'));
        agg.upsertRepo(repoRow('beta'));
        agg.applySummary('beta', summary('beta', {
            apis: [api('GET', '/a'), api('GET', '/b')],
        }));
        agg.applySummary('alpha', summary('alpha', {
            httpClientPaths: ['http://beta/a', 'http://beta/b'],
        }));
        expect(agg.listCrossRepoHttpEdges()).toHaveLength(2);
        // alpha re-applies with only one path
        agg.applySummary('alpha', summary('alpha', { httpClientPaths: ['http://beta/a'] }));
        const edges = agg.listCrossRepoHttpEdges();
        expect(edges).toHaveLength(1);
        expect(edges[0].route).toBe('/a');
        agg.close();
    });
});

describe('crossRepoHttpAnalyzer — sandbox case (alpha → beta)', () => {
    it('exact sandbox scenario: svc-alpha fetches svc-beta/items/:id → one edge', async () => {
        const agg = await makeAggregator();
        agg.upsertRepo(repoRow('svc-alpha'));
        agg.upsertRepo(repoRow('svc-beta'));
        agg.upsertRepo(repoRow('svc-gamma'));
        agg.applySummary('svc-beta', summary('svc-beta', {
            apis: [
                api('GET', '/api/svc-beta/health'),
                api('GET', '/api/svc-beta/items/:id'),
                api('POST', '/api/svc-beta/items'),
            ],
        }));
        agg.applySummary('svc-gamma', summary('svc-gamma', {
            apis: [api('GET', '/api/svc-gamma/items/:id')],
        }));
        agg.applySummary('svc-alpha', summary('svc-alpha', {
            httpClientPaths: ['http://svc-beta:3001/api/svc-beta/items/${id}'],
        }));
        const edges = agg.listCrossRepoHttpEdges();
        expect(edges).toHaveLength(1);
        expect(edges[0].sourceRepo).toBe('svc-alpha');
        expect(edges[0].targetRepo).toBe('svc-beta');
        expect(edges[0].method).toBe('GET');
        agg.close();
    });
});

// 2026-06-09 — UX-65 end-to-end fixture. The 132-repo serverless-examples
// workspace produces `cross_repo_http_edges = 0` because sibling sub-repos
// don't consume each other — that left the SPA's cross-repo hop ("click a
// `meta.crossRepoTarget` neighbour to re-scope") unverifiable. This case
// drives the full chain: applySummary on two repos that call each other,
// confirm the edges land, then run `filterMicroserviceGraphForRepo` on a
// synthetic L1 to confirm the cross-repo neighbour gets stamped.
describe('crossRepoHttpAnalyzer — UX-65 cross-repo edge + scoped filter wiring', () => {
    it('produces cross_repo_http_edges and the scope filter stamps meta.crossRepoTarget', async () => {
        const agg = await makeAggregator();
        // Two-repo workspace: api-svc exposes /orders/:id; web-svc fetches it.
        agg.upsertRepo(repoRow('api-svc', 'apps/api-svc'));
        agg.upsertRepo(repoRow('web-svc', 'apps/web-svc'));
        agg.applySummary('api-svc', summary('api-svc', {
            apis: [api('GET', '/orders/:id'), api('POST', '/orders')],
        }));
        agg.applySummary('web-svc', summary('web-svc', {
            httpClientPaths: ['http://api-svc:3000/orders/${id}'],
        }));

        // 1) cross_repo_http_edges populated → no more "0 edges" gap.
        const edges = agg.listCrossRepoHttpEdges();
        expect(edges, 'cross-repo HTTP edges must land').toHaveLength(1);
        expect(edges[0]).toMatchObject({ sourceRepo: 'web-svc', targetRepo: 'api-svc', method: 'GET' });

        // 2) Build a synthetic L1 microservice graph carrying the two sub-repos
        //    + a "calls" edge mirroring the cross-repo HTTP edge, then run the
        //    scope filter and confirm the cross-repo neighbour is stamped.
        const l1 = {
            nodes: [
                { id: 'svc-api', type: 'service', meta: { rootPath: 'apps/api-svc', repoId: 'api-svc' } },
                { id: 'svc-web', type: 'service', meta: { rootPath: 'apps/web-svc', repoId: 'web-svc' } },
            ],
            edges: [
                { id: 'e1', source: 'svc-web', target: 'svc-api', label: 'calls', meta: { crossRepoHttp: true } },
            ],
            meta: {},
        };
        const scoped = filterMicroserviceGraphForRepo(l1, 'apps/web-svc');
        expect(scoped, 'scope filter must return a graph').not.toBeNull();
        expect(scoped!.crossRepoCount).toBe(1);
        const apiNeighbour = scoped!.nodes!.find((n: any) => n.id === 'svc-api');
        expect(apiNeighbour, 'cross-repo neighbour kept').toBeTruthy();
        expect(apiNeighbour!.meta?.crossRepoTarget, 'crossRepoTarget pointing at the other repo').toBe('apps/api-svc');

        agg.close();
    });
});
