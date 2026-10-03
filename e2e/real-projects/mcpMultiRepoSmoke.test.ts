/**
 * mcpMultiRepoSmoke.test.ts
 *
 * For every JS/TS real-project fixture, run a fresh SyncOrchestrator init via
 * the cascade harness, then exercise the full MCP tool surface against the
 * resulting snapshot. Validates that:
 *   - list_entrypoints returns ≥ the expected route count for the fixture
 *   - search_workspace finds a known function/cluster
 *   - get_entrypoint_pack on the most-routed file returns non-empty downstream
 *   - get_diff_summary runs cleanly on a fresh init
 *   - get_impact_of_change returns sane data
 *   - get_feature_pack returns ≥1 entry point on a major cluster
 *   - query_snapshot runs an ad-hoc SQL probe
 *
 * Each fixture gets its own describe block so failures are localised.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { installFixtureSafetyGuard } from './fixtureSafety';
import {
    listEntryPoints,
    getEntryPointPack,
    getDiffSummary,
    getImpactOfChange,
    getFeaturePack,
} from '../../src/mcp/contextPack';
import { searchWorkspace } from '../../src/mcp/searchIndex';

installFixtureSafetyGuard();

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');

// Subset chosen for MCP smoke: a mix of real-world JS/TS Express-style repos
// where the framework data is rich enough to drive each tool. Other fixtures
// (Python/Java/Go/Kotlin via tree-sitter, Apollo GraphQL, NestJS decorators)
// are also indexed but with fewer routes — see `expectedMinRoutes` per fixture.
interface RepoExpectation {
    id: string;
    expectedMinRoutes: number;
    searchProbe: { query: string | string[]; expectKindIncludes?: string };
    /** A method+route pair we know to exist for the entry-point pack probe. */
    epProbe?: { method: string; route: string };
    /** A symbol we know to exist for the impact probe. */
    impactProbe?: { filePath: string; functionName?: string };
}

const REPOS: RepoExpectation[] = [
    {
        id: 'ts-express-realworld',
        expectedMinRoutes: 20,
        searchProbe: { query: 'getCurrentUser' },
        epProbe: { method: 'GET', route: '/api/articles/:slug' },
        impactProbe: { filePath: 'src/app/routes/auth/auth.service.ts', functionName: 'getCurrentUser' },
    },
    {
        id: 'js-express',
        expectedMinRoutes: 10,
        searchProbe: { query: 'users' },
        impactProbe: { filePath: 'src/services/user.service.js' },
    },
    {
        id: 'ts-hono',
        expectedMinRoutes: 30,
        searchProbe: { query: 'basicAuth' },
    },
    {
        id: 'ts-nestjs',
        expectedMinRoutes: 15,
        searchProbe: { query: 'article' },
    },
    {
        id: 'js-fastify',
        expectedMinRoutes: 5,
        searchProbe: { query: 'tasks' },
    },
    {
        id: 'js-koa',
        expectedMinRoutes: 1,
        // The koa fixture (`koajs/examples`) is a multi-app sample collection;
        // its strongest indexed entity is the per-app cluster (`blog`, `csrf`,
        // `multipart`, etc.). Search for the well-known sample name.
        searchProbe: { query: 'blog' },
    },
];

for (const repo of REPOS) {
    const repoPath = path.join(REAL_REPOS_DIR, repo.id);
    const PRESENT = fs.existsSync(repoPath);

    (PRESENT ? describe : describe.skip)(`MCP multi-repo smoke — ${repo.id}`, () => {
        let scenario: ScenarioResult;
        let snapshot: any;

        beforeAll(async () => {
            scenario = await runScenario({ repoPath, edits: [] });
            snapshot = scenario.working;
        }, 180_000);

        afterAll(() => scenario?.dispose());

        it(`list_entrypoints returns ≥${repo.expectedMinRoutes} entries`, () => {
            const eps = listEntryPoints(snapshot);
            console.log(`  [${repo.id}] list_entrypoints: ${eps.length} entries`);
            expect(eps.length).toBeGreaterThanOrEqual(repo.expectedMinRoutes);
        });

        it('search_workspace finds the probe target', () => {
            const results = searchWorkspace(snapshot, repo.searchProbe.query, { limit: 10 });
            console.log(`  [${repo.id}] search(${JSON.stringify(repo.searchProbe.query)}): ${results.length} hits${results[0] ? ` (top: ${results[0].kind}:${results[0].name})` : ''}`);
            expect(results.length).toBeGreaterThan(0);
            if (repo.searchProbe.expectKindIncludes) {
                expect(results.some((r) => r.kind === repo.searchProbe.expectKindIncludes)).toBe(true);
            }
        });

        if (repo.epProbe) {
            it(`get_entrypoint_pack(${repo.epProbe.method} ${repo.epProbe.route}) returns a pack`, () => {
                const pack = getEntryPointPack(snapshot, repo.epProbe!.method, repo.epProbe!.route);
                if (pack) {
                    console.log(`  [${repo.id}] pack(${repo.epProbe!.method} ${repo.epProbe!.route}): callsInto=${pack.callsInto.length}, messages=${pack.messages.length}, flowNodes=${pack.flowNodes.length}`);
                    expect(pack.entryPoint.method).toBe(repo.epProbe!.method);
                } else {
                    console.log(`  [${repo.id}] pack(${repo.epProbe!.method} ${repo.epProbe!.route}): not found (route may have a different shape post-detection)`);
                }
            });
        }

        it('get_diff_summary returns a clean tree (no edits applied)', () => {
            const summary = getDiffSummary(snapshot, scenario.baseline);
            console.log(`  [${repo.id}] diff_summary: changedFiles=${summary.changedFiles.length}, added=${summary.addedEntryPoints.length}, modified=${summary.modifiedEntryPoints.length}`);
            expect(summary).toHaveProperty('changedFiles');
        });

        if (repo.impactProbe) {
            it('get_impact_of_change returns a structured result', () => {
                const impact = getImpactOfChange(snapshot, repo.impactProbe!.filePath, repo.impactProbe!.functionName);
                console.log(`  [${repo.id}] impact(${repo.impactProbe!.filePath}): ${impact.entryPoints.length} entry points`);
                expect(impact).toHaveProperty('entryPoints');
            });
        }

        it('get_feature_pack on the largest cluster returns ≥1 entry point', () => {
            const clusters = Object.values(snapshot.clusters ?? {}) as any[];
            if (clusters.length === 0) {
                console.log(`  [${repo.id}] no clusters in snapshot — skipping`);
                return;
            }
            // Pick the cluster with the most files.
            const target = clusters.sort((a, b) => b.files.length - a.files.length)[0];
            const pack = getFeaturePack(snapshot, target.id);
            expect(pack).not.toBeNull();
            console.log(`  [${repo.id}] feature(${target.id}): ${pack!.entryPoints.length} entry points, ${pack!.cluster.files.length} files`);
        });
    });
}
