/**
 * layers.test.ts
 *
 * Per-layer integrity assertions across all real-world repos. Each layer
 * (L1 microservice, L2a feature, L2b api-list, L3 sequence) gets its own
 * test family so a regression hits a focused, named failure rather than
 * a generic "graphCount dropped" message.
 *
 * Also asserts diff-mode sanity: on a fresh init, baseline and working
 * snapshots should hold the same graph count (no spurious diffs).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runVerifyForRepo, type RepoSpec, type VerifyResult } from './runVerify';
import { isBackendRepo } from './repoCategories';

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_REPOS = path.join(ROOT, 'e2e', 'real-repos');
const MANIFEST = path.join(__dirname, 'repos.json');

interface Manifest { repos: RepoSpec[]; }
const fullManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
// VERIFY_FAST=1 trims to a 5-repo set that exercises every code path:
// Express/JS, NestJS/TS-classes, Python/Django, Go/Gin, Rust/Axum.
const FAST_IDS = new Set(['js-express', 'ts-nestjs', 'py-django', 'go-gin', 'rust-axum']);
const manifest: Manifest = process.env.VERIFY_FAST === '1'
    ? { repos: fullManifest.repos.filter(r => FAST_IDS.has(r.id)) }
    : fullManifest;

// Cache the verify result per repo: each describe block has 12+ assertions
// against the same data, so we run the heavy `initialize()` once per repo
// and feed all assertions from the cached snapshot. Without this, the
// WASM tree-sitter runtime hits memory pressure on the largest repos
// (ruby-sinatra: 147 files × 12 inits = 1700+ parses).
const cache = new Map<string, Promise<VerifyResult>>();
function verifyCached(repoPath: string, spec: RepoSpec): Promise<VerifyResult> {
    const existing = cache.get(spec.id);
    if (existing) return existing;
    const p = runVerifyForRepo(repoPath, spec);
    cache.set(spec.id, p);
    return p;
}

describe('Layered diagram coverage', () => {
    for (const spec of manifest.repos) {
        const repoPath = path.join(REAL_REPOS, spec.id);
        if (!isBackendRepo(spec.id)) {
            it.skip(`[${spec.id}] frontend/mobile — currently de-prioritized (see repoCategories.ts)`, () => { /* skipped */ });
            continue;
        }
        if (!fs.existsSync(repoPath)) {
            it.skip(`[${spec.id}] not cloned`, () => { /* skipped */ });
            continue;
        }

        describe(`[${spec.id}] (${spec.language}/${spec.framework})`, () => {
            it('L1: builds exactly one microservice diagram', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(r.microserviceGraphs, `${spec.id}: expected 1 microservice graph`).toBe(1);
            });

            it('L2a: builds at least one feature diagram', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                // Single-service apps: one workspace-wide feature graph.
                // Multi-service apps: one per service. Either way, > 0.
                expect(r.featureGraphs, `${spec.id}: no feature graphs built`).toBeGreaterThan(0);
            });

            it('L2b: every api-list graph has populated meta', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.apiListGraphs === 0) return; // no APIs ⇒ no api-list expected
                // Issue 349: pure-frontend repos (e.g. ts-sveltekit) have
                // clusters but no API definitions. The orchestrator still
                // creates api-list shells for each cluster — those legitimately
                // have 0 members. Skip when the repo has no APIs at all.
                if (r.apiCount === 0) return;
                // Every api-list should at minimum include a non-empty member set
                // (apis / screens / navRoutes / networkCalls). A graph with all
                // four arrays empty would render as a blank panel in the UI.
                expect(
                    r.apiListWithMembers,
                    `${spec.id}: ${r.apiListGraphs} api-list graphs but only ${r.apiListWithMembers} contain members`,
                ).toBeGreaterThan(0);
            });

            it('L2b: api-list meta.apis count matches detected route APIs (within tolerance)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.apiListGraphs === 0) return;
                if (r.apiCount === 0) return;
                // The detected-API count is dominated by mobile items (SCREEN/NAV_ROUTE/
                // NETWORK) for some repos. meta.apis only carries true route APIs. We
                // assert the L2b meta has *some* APIs whenever any cluster has detected
                // route handlers.
                if (r.sequenceGraphs > 0) {
                    expect(
                        r.apiListMetaApisCount,
                        `${spec.id}: ${r.sequenceGraphs} sequence graphs (route APIs) but api-list meta carries 0 APIs`,
                    ).toBeGreaterThan(0);
                }
            });

            it('L3: every sequence graph carries at least one participant', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.sequenceGraphs === 0) return;
                // Each handler resolved into a sequence graph should have at least
                // one participant (the API client + the handler module). Average
                // ≥1 participant/graph is a low floor.
                const ratio = r.sequenceParticipantsTotal / r.sequenceGraphs;
                expect(
                    ratio,
                    `${spec.id}: average ${ratio.toFixed(2)} participants/graph (expected >= 1)`,
                ).toBeGreaterThanOrEqual(1);
            });

            it('L3: at least one sequence graph carries messages (smoke)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.sequenceGraphs === 0) return;
                expect(
                    r.sequenceMessagesTotal,
                    `${spec.id}: ${r.sequenceGraphs} sequence graphs but 0 total messages — handler resolution is broken`,
                ).toBeGreaterThan(0);
            });

            it('L4: nearly every parsed file has a corresponding file graph', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                // Allow up to 1% gap to absorb parse failures on exotic syntax in
                // big monorepos (Flutter samples have a couple of files that
                // Dart tree-sitter can't parse). A larger gap is a real bug.
                const ratio = r.fileGraphs / r.fileCount;
                expect(
                    ratio,
                    `${spec.id}: ${r.fileGraphs}/${r.fileCount} file graphs (ratio ${ratio.toFixed(3)} — expected ≥0.99)`,
                ).toBeGreaterThanOrEqual(0.99);
            });

            it('L4: file graphs surface imports for repos that use modules', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.fileGraphs < 5) return; // tiny demos may have few imports
                expect(
                    r.fileGraphsWithImports,
                    `${spec.id}: 0 of ${r.fileGraphs} file graphs contain import nodes`,
                ).toBeGreaterThan(0);
            });

            it('L4: file graphs surface functions for connected codebases', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.flowGraphs < 5) return; // few functions ⇒ few function nodes expected
                expect(
                    r.fileGraphsWithFunctions,
                    `${spec.id}: ${r.flowGraphs} flow graphs (callable functions) but 0 file graphs surface function nodes`,
                ).toBeGreaterThan(0);
            });

            it('L4: file graphs are not all empty (avg ≥ 1 node/graph)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.fileGraphs === 0) return;
                const avg = r.fileGraphNodesTotal / r.fileGraphs;
                expect(
                    avg,
                    `${spec.id}: average ${avg.toFixed(2)} nodes per file graph (expected ≥ 1)`,
                ).toBeGreaterThanOrEqual(1);
            });

            it('L5: every flow graph has Start and End terminals', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.flowGraphs === 0) return;
                expect(
                    r.flowGraphsWithStartEnd,
                    `${spec.id}: only ${r.flowGraphsWithStartEnd}/${r.flowGraphs} flow graphs have Start+End terminal pair`,
                ).toBe(r.flowGraphs);
            });

            it('L5: most flow graphs have body content (not just Start+End)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.flowGraphs < 10) return; // skip tiny repos
                // "Trivial" = exactly Start+End with no body. If >30% of flow graphs
                // are trivial, the body-extraction path is silently dropping
                // statements for that language.
                const trivialRatio = r.flowGraphsTrivial / r.flowGraphs;
                expect(
                    trivialRatio,
                    `${spec.id}: ${r.flowGraphsTrivial}/${r.flowGraphs} flow graphs are empty (Start+End only) — ratio ${trivialRatio.toFixed(2)}`,
                ).toBeLessThanOrEqual(0.3);
            });

            it('L5: extracted statement density (issues 276-278) — meta.statements reflects raw stmts', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.flowGraphs < 30) return; // small demos legitimately have one-line functions
                // Average extracted body statements per non-trivial flow graph.
                // Idiomatic functions average ≥1.5 statements. Lower means the
                // extractor isn't capturing per-statement granularity (the
                // consolidation pass compresses for *display* but `meta.statements`
                // preserves the original count).
                expect(
                    r.flowGraphAvgBodyNodes,
                    `${spec.id}: avg ${r.flowGraphAvgBodyNodes.toFixed(2)} extracted body statements per non-trivial flow graph (expected ≥1.5)`,
                ).toBeGreaterThanOrEqual(1.5);
            });

            it('L5: at least one flow graph has a decision node (control flow)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.flowGraphs < 30) return; // small demos may legitimately have no branches
                expect(
                    r.flowGraphsWithDecision,
                    `${spec.id}: ${r.flowGraphs} flow graphs but 0 contain decision nodes — control-flow extractor not firing`,
                ).toBeGreaterThan(0);
            });

            it('L5: flow graphs have edges connecting their nodes', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.flowGraphs === 0) return;
                expect(
                    r.flowGraphAvgEdges,
                    `${spec.id}: avg ${r.flowGraphAvgEdges.toFixed(2)} edges per flow graph (expected ≥ 1)`,
                ).toBeGreaterThanOrEqual(1);
            });

            it('Diff: fresh init produces baseline == working graph count', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                // initialize() seeds both baseline and working from the same scan.
                // A divergence here means the baseline-write path is dropping or
                // duplicating graphs vs. the working-write path.
                expect(
                    r.baselineGraphCount,
                    `${spec.id}: baseline=${r.baselineGraphCount} working=${r.workingGraphCount} (drift on init)`,
                ).toBe(r.workingGraphCount);
            });
        });
    }
});
