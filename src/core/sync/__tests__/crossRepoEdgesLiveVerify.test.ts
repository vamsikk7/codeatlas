/**
 * crossRepoEdgesLiveVerify.test.ts — UX-65 (2026-06-10)
 *
 * Live-verifies the cross_repo_http_edges contract end-to-end:
 * registry → aggregator → cross-repo analyzer → edge surfaced in
 * `aggregator.listCrossRepoHttpEdges()`. The crossRepoHttpAnalyzer
 * unit tests (`__tests__/crossRepoHttpAnalyzer.test.ts`) cover matcher
 * logic in isolation; this test wires the analyzer through the SAME
 * aggregator + registry plumbing the production WorkspaceOrchestrator
 * uses, with summaries that mirror what `SyncOrchestrator.
 * produceSummary` would emit for a real alpha→beta wire (no full
 * SyncOrchestrator init — that path's late-bind requires need vsce
 * bundling to resolve).
 *
 * This is the live-verify the carry-over list flagged as missing
 * because the `js-serverless-examples` fixture (132 standalone demos)
 * has 0 cross-repo wires.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import { CrossRepoAnalyzerRegistry } from '../crossRepoAnalyzer';
import { crossRepoHttpAnalyzer } from '../../analysis/crossRepoHttpAnalyzer';
import { emptyRepoSummary } from '../repoSummary';
import type { RepoRow } from '../../storage/storeInterfaces';

const tmpDirs: string[] = [];

afterEach(() => {
    while (tmpDirs.length) {
        try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* */ }
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

describe('UX-65 — cross-repo HTTP edges live verification', () => {
    let workspaceRoot: string;

    function setup() {
        workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ux65-crossrepo-'));
        tmpDirs.push(workspaceRoot);
        const registry = new RepoStoreRegistry();
        const analyzerRegistry = new CrossRepoAnalyzerRegistry();
        analyzerRegistry.register(crossRepoHttpAnalyzer);
        const aggregator = new AggregatorStore(workspaceRoot, { inMemoryOnly: true });
        aggregator.setAnalyzerRegistry(analyzerRegistry);
        return { aggregator, registry };
    }

    it('alpha fetch→beta express route produces a cross_repo_http_edge end-to-end', async () => {
        const { aggregator } = setup();
        await aggregator.init();
        aggregator.upsertRepo(repoRow('svc-alpha'));
        aggregator.upsertRepo(repoRow('svc-beta'));

        // Producer: beta exposes GET /items/:id. The summary that
        // SyncOrchestrator.produceSummary would emit for a real Express
        // server with this route.
        aggregator.applySummary('svc-beta', {
            ...emptyRepoSummary('svc-beta'),
            apis: [{
                apiId: 'GET:/items/:id',
                method: 'GET',
                route: '/items/:id',
                filePath: 'src/server.js',
                handlerName: 'anonymous',
            }],
        });

        // Consumer: alpha fetches beta's route. The url shape mimics what
        // sdkDetector + httpClientPaths surface for a real fetch call.
        aggregator.applySummary('svc-alpha', {
            ...emptyRepoSummary('svc-alpha'),
            httpClientPaths: ['http://svc-beta:3001/items/${id}'],
        });

        // Edge should be flagged by crossRepoHttpAnalyzer + persisted.
        const edges = aggregator.listCrossRepoHttpEdges();
        expect(edges.length, `expected ≥1 cross-repo edge, got ${edges.length}`).toBeGreaterThan(0);
        const alphaToBeta = edges.find(e =>
            e.sourceRepo === 'svc-alpha' && e.targetRepo === 'svc-beta'
        );
        expect(alphaToBeta, `no alpha→beta edge in ${JSON.stringify(edges)}`).toBeTruthy();
        expect(alphaToBeta!.method).toBe('GET');
        expect(alphaToBeta!.route).toMatch(/items\/(:id|\$\{id\}|\{id\})/);

        aggregator.close();
    });

    it('reapply of alpha summary refreshes the edge set (Phase D second-pass contract)', async () => {
        // Reflects the production WorkspaceOrchestrator's cross-repo
        // second-pass at extension.ts:868 — every repo re-applies its
        // summary AFTER all repos finished init, so analyzers see the
        // full network and can re-decide. The first-pass edge set
        // includes beta but the second-pass adds gamma.
        const { aggregator } = setup();
        await aggregator.init();
        aggregator.upsertRepo(repoRow('svc-alpha'));
        aggregator.upsertRepo(repoRow('svc-beta'));
        aggregator.upsertRepo(repoRow('svc-gamma'));

        // First pass — alpha can only see beta because gamma hasn't applied.
        aggregator.applySummary('svc-beta', {
            ...emptyRepoSummary('svc-beta'),
            apis: [{ apiId: 'GET:/items/:id', method: 'GET', route: '/items/:id', filePath: 'src/x.js', handlerName: 'h' }],
        });
        aggregator.applySummary('svc-alpha', {
            ...emptyRepoSummary('svc-alpha'),
            httpClientPaths: [
                'http://svc-beta:3001/items/${id}',
                'http://svc-gamma:3002/users/${id}',
            ],
        });
        const firstPass = aggregator.listCrossRepoHttpEdges();
        expect(firstPass.length).toBe(1);
        expect(firstPass[0].targetRepo).toBe('svc-beta');

        // Second pass — gamma applies its API, then alpha re-applies and
        // both edges materialise.
        aggregator.applySummary('svc-gamma', {
            ...emptyRepoSummary('svc-gamma'),
            apis: [{ apiId: 'GET:/users/:id', method: 'GET', route: '/users/:id', filePath: 'src/y.js', handlerName: 'h' }],
        });
        aggregator.applySummary('svc-alpha', {
            ...emptyRepoSummary('svc-alpha'),
            httpClientPaths: [
                'http://svc-beta:3001/items/${id}',
                'http://svc-gamma:3002/users/${id}',
            ],
        });
        const secondPass = aggregator.listCrossRepoHttpEdges();
        expect(secondPass.length).toBe(2);
        const targets = secondPass.map(e => e.targetRepo).sort();
        expect(targets).toEqual(['svc-beta', 'svc-gamma']);

        aggregator.close();
    });
});
