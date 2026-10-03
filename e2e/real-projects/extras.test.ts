/**
 * extras.test.ts
 *
 * Cross-cutting checks added in v3.2.2 for issues 282-288:
 *  - 282 Determinism: same repo, same code → byte-identical verify result
 *  - 283 Perf budget: per-repo init time bounded
 *  - 284 Anchor validity: graph-node anchors point inside file ranges
 *  - 286 Mobile-item assertions for mobile repos
 *  - 287 Path-traversal smoke (no FileRecord paths with `..` or absolute roots)
 *  - 288 Sub-cluster api-list content (graphs are populated)
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
const FAST_IDS = new Set(['js-express', 'ts-nestjs', 'py-django', 'go-gin', 'rust-axum']);
const manifest: Manifest = process.env.VERIFY_FAST === '1'
    ? { repos: fullManifest.repos.filter(r => FAST_IDS.has(r.id)) }
    : fullManifest;

const cache = new Map<string, Promise<VerifyResult>>();
function verifyCached(repoPath: string, spec: RepoSpec): Promise<VerifyResult> {
    const existing = cache.get(spec.id);
    if (existing) return existing;
    const p = runVerifyForRepo(repoPath, spec);
    cache.set(spec.id, p);
    return p;
}

const MOBILE_IDS = new Set(['ts-react-native', 'dart-flutter', 'kotlin-android', 'swift-ios']);

// Per-repo init-time budget (ms). These are CI-flake guards, not strict
// performance gates: hardware-load-dependent timings drift 2-3× run-to-run
// on shared CI runners and dev machines. Each budget = ~3× the worst
// observed time, sized to catch a real 5-10× regression while tolerating
// macOS Spotlight indexing, parallel test workers, browser tabs eating
// cores, etc. Retuned 2026-05-13 after 4.1.0 entry-point detection
// widened the per-file work.
function perfBudgetMs(spec: RepoSpec): number {
    if (spec.id === 'dart-flutter') return 12000;
    if (spec.id === 'kotlin-android' || spec.id === 'rust-rocket' || spec.id === 'go-fiber') return 8000;
    if (spec.id === 'kotlin-ktor') return 20000; // 8000 → 20000 (2026-05-13) — ktor cross-file router; load-dependent
    if (spec.id === 'java-spring-kafka') return 8000;
    if (spec.id === 'ts-apollo') return 35000; // 22000 → 35000 (2026-05-13) — Apollo monorepo; load-dependent
    return 6000;
}

describe('Real-world extras (issues 282-288)', () => {
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
            it('CallGraph round-trip (Issue 306): deserialize then re-serialize produces same edge count', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.callGraphEdgeCount === 0) return;
                expect(
                    r.callGraphRoundTripEdges,
                    `${spec.id}: original=${r.callGraphEdgeCount} round-trip=${r.callGraphRoundTripEdges}${r.callGraphRoundTripEdges < 0 ? ' (deserialize failed)' : ''}`,
                ).toBe(r.callGraphEdgeCount);
            });

            it('Flow graph upper bounds (Issue 305): no graph runs away (>250 nodes)', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.flowGraphMaxNodes,
                    `${spec.id}: a flow graph has ${r.flowGraphMaxNodes} nodes (cap 250) — extractor or consolidation regression`,
                ).toBeLessThanOrEqual(250);
            });

            it('Anchor validity (Issue 284): no node has an out-of-range span', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.anchorsInvalid,
                    `${spec.id}: ${r.anchorsInvalid}/${r.nodesWithAnchors} nodes have invalid spans (start<0 or end<start)`,
                ).toBe(0);
            });

            it('Perf (Issue 283): init within budget', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                const budget = perfBudgetMs(spec);
                expect(
                    r.durationMs,
                    `${spec.id}: init took ${r.durationMs}ms (budget ${budget}ms)`,
                ).toBeLessThanOrEqual(budget);
            });

            it('Security (Issue 287): no FileRecord paths escape workspace', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.suspectFilePaths,
                    `${spec.id}: ${r.suspectFilePaths} file paths contain '..' or are absolute`,
                ).toBe(0);
            });

            it('Cluster count smoke (Issue 308): repos with ≥30 files form ≥2 clusters', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.fileCount < 30) return;
                expect(
                    r.featureClusters,
                    `${spec.id}: ${r.fileCount} files collapsed into ${r.featureClusters} cluster(s) — Louvain regression risk (mega-cluster)`,
                ).toBeGreaterThanOrEqual(2);
            });

            it('Sub-cluster L2b (Issue 288/299): when ≥10 sub-clusters exist, ≥1 carries members', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.subClusterApiListGraphs < 10) return;
                // For repos with substantial sub-clustering, at least ONE sub-cluster
                // should contain APIs/screens/etc. — otherwise the sub-cluster builder
                // is degenerating into useless empty panels.
                expect(
                    r.subClusterApiListWithMembers,
                    `${spec.id}: ${r.subClusterApiListGraphs} sub-cluster api-list graphs but 0 contain members`,
                ).toBeGreaterThan(0);
            });

            if (MOBILE_IDS.has(spec.id)) {
                it('Mobile (Issue 286): clusters carry SCREEN/NAV_ROUTE/NETWORK items', { timeout: 120_000 }, async () => {
                    const r = await verifyCached(repoPath, spec);
                    const total = r.clusterScreensTotal + r.clusterNavRoutesTotal + r.clusterNetworkCallsTotal;
                    expect(
                        total,
                        `${spec.id}: mobile repo with 0 SCREEN/NAV_ROUTE/NETWORK items in any cluster — mobileDetector not firing`,
                    ).toBeGreaterThan(0);
                });

                it('Mobile content quality (Issue 315): distinct screen names emitted', { timeout: 120_000 }, async () => {
                    const r = await verifyCached(repoPath, spec);
                    if (r.clusterScreensTotal === 0) return;
                    expect(
                        r.distinctScreenNames,
                        `${spec.id}: ${r.clusterScreensTotal} screens detected but ${r.distinctScreenNames} distinct names — extractor dropping handlerNames`,
                    ).toBeGreaterThan(0);
                });

                it('Mobile (Issue 280): mobile items dominate the apiCount', { timeout: 120_000 }, async () => {
                    const r = await verifyCached(repoPath, spec);
                    // For a mobile repo, mobile items (SCREEN/NAV_ROUTE/NETWORK)
                    // should be >= the route APIs. Catches regressions where the
                    // mobile detector goes silent and the apiCount becomes 0.
                    expect(
                        r.mobileItemCount,
                        `${spec.id}: mobileItemCount=${r.mobileItemCount} routeApiCount=${r.routeApiCount}`,
                    ).toBeGreaterThanOrEqual(r.routeApiCount);
                });
            } else if (
                spec.language !== 'csharp' && spec.language !== 'swift' &&
                spec.framework !== 'rails' && spec.framework !== 'sinatra' &&
                spec.framework !== 'spring' && spec.framework !== 'apollo'
            ) {
                it('Backend (Issue 280): route APIs separable from mobile items', { timeout: 120_000 }, async () => {
                    const r = await verifyCached(repoPath, spec);
                    // For a backend repo with detected routes, the route count
                    // should be > 0. Mobile items can also be present (e.g. Next.js
                    // also has page screens), but routes shouldn't be zero.
                    if (r.apiCount === 0) return;
                    expect(
                        r.routeApiCount,
                        `${spec.id}: ${r.apiCount} APIs but 0 are real route APIs (all mobile items)`,
                    ).toBeGreaterThan(0);
                });
            }
        });
    }
});

// Issue 307 — Sequence-message content assertion. For a known repo (ts-nestjs
// realworld), the sequence graphs should contain at least one named handler
// message. This guards against the resolver producing only participant nodes
// even after Issue 263 fix.
describe('Sequence message content (Issue 307)', () => {
    const repo = manifest.repos.find(r => r.id === 'ts-nestjs');
    if (!repo) {
        it.skip('ts-nestjs not in manifest', () => { /* */ });
        return;
    }
    const repoPath = path.join(REAL_REPOS, repo.id);
    if (!fs.existsSync(repoPath)) {
        it.skip('ts-nestjs not cloned', () => { /* */ });
        return;
    }
    it('ts-nestjs sequence graphs collectively reference articleService or userService', { timeout: 120_000 }, async () => {
        const r = await runVerifyForRepo(repoPath, repo);
        expect(r.sequenceGraphs).toBeGreaterThan(0);
        // We don't have direct access to sequence graph contents in VerifyResult,
        // but `sequenceMessagesTotal > 0` is the proxy: at least one graph
        // produced a non-empty edge set against this real codebase.
        expect(r.sequenceMessagesTotal).toBeGreaterThan(0);
    });
});

// Issue 314 — Perf budget calibrated against multi-run p95.
// Runs `runVerifyForRepo` N times on a small repo and asserts the slowest run
// stays under a budget that's anchored to the median + headroom (3× median),
// rather than a single hand-picked number.
describe('Perf budget — p95 calibration (Issue 314)', () => {
    const repo = manifest.repos.find(r => r.id === 'js-express');
    if (!repo) {
        it.skip('js-express not in manifest', () => { /* */ });
        return;
    }
    const repoPath = path.join(REAL_REPOS, repo.id);
    if (!fs.existsSync(repoPath)) {
        it.skip('js-express not cloned', () => { /* */ });
        return;
    }
    it('5 consecutive runs: max ≤ 3× median', { timeout: 240_000 }, async () => {
        const durations: number[] = [];
        for (let i = 0; i < 5; i++) {
            const r = await runVerifyForRepo(repoPath, repo);
            durations.push(r.durationMs);
        }
        durations.sort((a, b) => a - b);
        const median = durations[Math.floor(durations.length / 2)];
        const max = durations[durations.length - 1];
        expect(
            max,
            `js-express durations ${durations.join('/')}: max ${max}ms vs median ${median}ms (3× cap ${median * 3}ms)`,
        ).toBeLessThanOrEqual(median * 3);
    });
});

// Issue 282 — Determinism. Run on a small fixed repo only (cost: 1 extra full
// init). We compare two consecutive runs on the same on-disk state and assert
// the metric tuple matches byte-for-byte.
describe('Determinism (Issue 282)', () => {
    const repo = manifest.repos.find(r => r.id === 'js-express');
    if (!repo) {
        it.skip('js-express not in manifest', () => { /* */ });
        return;
    }
    const repoPath = path.join(REAL_REPOS, repo.id);
    if (!fs.existsSync(repoPath)) {
        it.skip('js-express not cloned', () => { /* */ });
        return;
    }
    it('two consecutive verify runs produce identical metrics on the same repo state', { timeout: 240_000 }, async () => {
        const a = await runVerifyForRepo(repoPath, repo);
        const b = await runVerifyForRepo(repoPath, repo);
        // Compare every field except durationMs (timing varies).
        const stripDuration = ({ durationMs: _d, ...rest }: VerifyResult) => rest;
        expect(stripDuration(b)).toEqual(stripDuration(a));
    });
});
