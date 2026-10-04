/**
 * verify.test.ts
 *
 * Pre-publish verification: runs the full CodeAtlas pipeline against each
 * real-world repo listed in repos.json (cloned via `npm run fetch:real-projects`)
 * and asserts that the analysis still produces meaningful output.
 *
 * Modes:
 *   - default       — assert against expectations.json (baseline). Fails on regression.
 *   - UPDATE_EXPECTATIONS=1 — write back to expectations.json (use to refresh after
 *                              an intentional pipeline change).
 *
 * Repos that are not yet cloned are skipped with a friendly message — `verify:real`
 * does not require all repos to be present, but a CI gate would.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runVerifyForRepo, type RepoSpec, type VerifyResult } from './runVerify';
import { isBackendRepo } from './repoCategories';
import { execFileSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_REPOS = path.join(ROOT, 'e2e', 'real-repos');
const MANIFEST = path.join(__dirname, 'repos.json');
const EXPECTATIONS = path.join(__dirname, 'expectations.json');

interface Manifest { repos: RepoSpec[]; }
interface Expectation {
    minFileCount: number;
    minApiCount: number;
    minGraphCount: number;
    minFileGraphs: number;
    minFlowGraphs: number;
    minSequenceGraphs: number;
    minFeatureClusters: number;
    minMicroservices: number;
    minFlowGraphsWithDecision: number;
    // anonymous handler resolution rate (resolved / handlers); 0..1
    minAnonymousResolutionRate: number;
    // Issue 300: route APIs vs mobile UI items split (added v3.2.2).
    minRouteApiCount?: number;
    minMobileItemCount?: number;
    notes?: string;
}
type Expectations = Record<string, Expectation>;

const UPDATE_MODE = process.env.UPDATE_EXPECTATIONS === '1';

function loadManifest(): Manifest {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
}

function loadExpectations(): Expectations {
    if (!fs.existsSync(EXPECTATIONS)) return {};
    return JSON.parse(fs.readFileSync(EXPECTATIONS, 'utf8')) as Expectations;
}

function deriveExpectation(r: VerifyResult): Expectation {
    // Strict baseline (3.3.2): expectations match the observed pipeline
    // output exactly. Any regression by even one route / sequence / file
    // graph fails the test. The previous 10% buffer was removed once the
    // detection pipeline was tuned to match hand-counts (see CHANGELOG 3.3.2).
    // Floor to 2 decimals so rounding never overshoots the actual ratio
    // (e.g. 29/30 ≈ 0.9667 stored as 0.96, not 0.97 — keeps the strict
    // floor strictly below the observed value).
    const rate = r.anonymousHandlers === 0
        ? 0
        : Math.floor((r.anonymousResolved / r.anonymousHandlers) * 100) / 100;
    return {
        minFileCount: r.fileCount,
        minApiCount: r.apiCount,
        minGraphCount: r.graphCount,
        minFileGraphs: r.fileGraphs,
        minFlowGraphs: r.flowGraphs,
        minSequenceGraphs: r.sequenceGraphs,
        minFeatureClusters: r.featureClusters,
        minMicroservices: r.microservices,
        minFlowGraphsWithDecision: r.flowGraphsWithDecision,
        minAnonymousResolutionRate: rate,
        minRouteApiCount: r.routeApiCount,
        minMobileItemCount: r.mobileItemCount,
    };
}

const manifest = loadManifest();
const expectations = loadExpectations();
const updates: Expectations = {};

describe('Real-world repo verification', () => {
    for (const spec of manifest.repos) {
        const repoPath = path.join(REAL_REPOS, spec.id);
        const cloned = fs.existsSync(repoPath);

        // Per-repo budget — Spring/Next.js can be slow to scan.
        // 2026-06-11: 120s became marginal for the largest fixture
        // (ts-nextjs-pages, ~1.2k graphs) and started flaking once the scan
        // grew the per-function bodySrc capture (#837). This is a
        // correctness gate, not a latency gate — give the big repos headroom.
        const TEST_TIMEOUT = 240_000;

        // v2 Phase 8 (#487-fixtures): the isBackendRepo gate is gone —
        // FE/mobile fixtures now run end-to-end against the Phase
        // 1-6 detection pipeline. Per-category invariants (screens,
        // L2b sections) come from `expectations.json` via the same
        // baseline mechanism backend repos use. Mark this branch
        // for clarity even though the gate is removed.
        void isBackendRepo; // intentionally unused — kept for back-compat with any tools that import it.

        if (!cloned) {
            it.skip(`[${spec.id}] not cloned — run \`npm run fetch:real-projects\``, () => { /* skipped */ });
            continue;
        }

        it(`[${spec.id}] (${spec.language}/${spec.framework}) full pipeline`, async () => {
            const result = await runVerifyForRepo(repoPath, spec);

            // Corpus precondition. The baseline is only meaningful against the
            // commit it was recorded from, so verify that first and fail with a
            // message that names the real problem.
            //
            // Without this, a stale corpus reports "apiCount regressed" — which
            // reads as a product defect and sends you looking at parsers. That
            // is exactly what happened: the corpus drifted five months from the
            // baseline and the suite reported 20 detection regressions that did
            // not exist. A failure here means fix the corpus, not the code.
            if (spec.sha) {
                let head = '';
                try {
                    head = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
                } catch { /* not a git checkout (symlinked localPath) — skip the check */ }
                if (head) {
                    expect(
                        head,
                        `[${spec.id}] corpus is at ${head.slice(0, 10)} but repos.json pins ${spec.sha.slice(0, 10)}. ` +
                        `The baseline does not describe this tree. Run \`npm run fetch:real-projects\` to re-sync ` +
                        `(it re-fetches any repo whose HEAD does not match the pin). Do NOT update expectations to ` +
                        `make this pass — that hides whatever moved.`,
                    ).toBe(spec.sha);
                }
            }

            // Hard invariants — pipeline must not crash on real code, regardless of expectations.
            expect(result.initialized, `initialize() failed: ${result.error}`).toBe(true);
            expect(result.fileCount).toBeGreaterThan(0);
            expect(result.graphCount).toBeGreaterThan(0);

            if (UPDATE_MODE) {
                updates[spec.id] = { ...deriveExpectation(result), notes: `auto-generated from ${new Date().toISOString().slice(0, 10)} run` };
                console.log(`[${spec.id}] observed: files=${result.fileCount} apis=${result.apiCount} graphs=${result.graphCount} ` +
                    `file=${result.fileGraphs} flow=${result.flowGraphs} seq=${result.sequenceGraphs} ` +
                    `clusters=${result.featureClusters} svcs=${result.microservices} ` +
                    `anon=${result.anonymousResolved}/${result.anonymousHandlers} ` +
                    `(${result.durationMs}ms)`);
                return;
            }

            const exp = expectations[spec.id];
            if (!exp) {
                throw new Error(`No expectations for ${spec.id}. Run \`UPDATE_EXPECTATIONS=1 npm run verify:real\` to baseline.`);
            }

            // Greater-than-or-equal regressions: a real-repo update can ADD APIs but
            // not remove them; if the observed counts drop below baseline, something
            // in our pipeline regressed.
            expect(result.fileCount, 'fileCount regressed').toBeGreaterThanOrEqual(exp.minFileCount);
            expect(result.apiCount, 'apiCount regressed').toBeGreaterThanOrEqual(exp.minApiCount);
            expect(result.graphCount, 'graphCount regressed').toBeGreaterThanOrEqual(exp.minGraphCount);
            expect(result.fileGraphs, 'fileGraphs regressed').toBeGreaterThanOrEqual(exp.minFileGraphs);
            expect(result.flowGraphs, 'flowGraphs regressed').toBeGreaterThanOrEqual(exp.minFlowGraphs);
            expect(result.sequenceGraphs, 'sequenceGraphs regressed').toBeGreaterThanOrEqual(exp.minSequenceGraphs);
            expect(result.featureClusters, 'featureClusters regressed').toBeGreaterThanOrEqual(exp.minFeatureClusters);
            expect(result.microservices, 'microservices regressed').toBeGreaterThanOrEqual(exp.minMicroservices);
            expect(result.flowGraphsWithDecision, 'flowGraphsWithDecision regressed').toBeGreaterThanOrEqual(exp.minFlowGraphsWithDecision);

            if (exp.minRouteApiCount !== undefined) {
                expect(result.routeApiCount, 'routeApiCount regressed').toBeGreaterThanOrEqual(exp.minRouteApiCount);
            }
            if (exp.minMobileItemCount !== undefined) {
                expect(result.mobileItemCount, 'mobileItemCount regressed').toBeGreaterThanOrEqual(exp.minMobileItemCount);
            }
            if (exp.minAnonymousResolutionRate > 0 && result.anonymousHandlers > 0) {
                const rate = result.anonymousResolved / result.anonymousHandlers;
                expect(rate, `anonymous handler resolution dropped (${result.anonymousResolved}/${result.anonymousHandlers})`)
                    .toBeGreaterThanOrEqual(exp.minAnonymousResolutionRate);
            }
        }, TEST_TIMEOUT);
    }

    // After all per-repo tests run, write back updated expectations if requested.
    // Vitest does not provide a guaranteed afterAll-after-all-its hook for top-level
    // describe with parallel its, so we hook the persistence into a final test.
    if (UPDATE_MODE) {
        it('persist updated expectations.json', () => {
            const merged = { ...expectations, ...updates };
            // Issue 304: byte-stable output. Both the top-level repo keys AND each
            // expectation's field order are sorted alphabetically so that two runs
            // on the same input produce byte-identical JSON regardless of Node
            // version or insertion order.
            const sortedKeys = Object.keys(merged).sort();
            const sorted: Expectations = {};
            for (const k of sortedKeys) {
                const exp = merged[k];
                const sortedExp: any = {};
                for (const f of Object.keys(exp).sort()) sortedExp[f] = (exp as any)[f];
                sorted[k] = sortedExp;
            }
            fs.writeFileSync(EXPECTATIONS, JSON.stringify(sorted, null, 2) + '\n');
            console.log(`Wrote ${Object.keys(updates).length} updated expectation(s) to ${EXPECTATIONS}`);
        });
    }
});
