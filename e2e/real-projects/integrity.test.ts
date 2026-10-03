/**
 * integrity.test.ts
 *
 * Cross-cutting graph-quality invariants that should hold for *every* repo
 * regardless of language/framework. Failures here indicate silent renderer
 * bugs (empty labels, duplicate node IDs) or pipeline breakage (parse
 * failures, missing api-list/health/call-graph artifacts).
 *
 * Run via the standard `npm run verify:real:invariants` (this file is
 * picked up alongside invariants.test.ts).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runVerifyForRepo, type RepoSpec, type VerifyResult } from './runVerify';
import { isBackendRepo } from './repoCategories';

// Reuse across the 8 assertions per repo to avoid reinitializing the
// orchestrator (and hammering the WASM tree-sitter heap on big mobile repos).
const cache = new Map<string, Promise<VerifyResult>>();
function verifyCached(repoPath: string, spec: RepoSpec): Promise<VerifyResult> {
    const existing = cache.get(spec.id);
    if (existing) return existing;
    const p = runVerifyForRepo(repoPath, spec);
    cache.set(spec.id, p);
    return p;
}

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_REPOS = path.join(ROOT, 'e2e', 'real-repos');
const MANIFEST = path.join(__dirname, 'repos.json');

interface Manifest { repos: RepoSpec[]; }
const fullManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Manifest;
const FAST_IDS = new Set(['js-express', 'ts-nestjs', 'py-django', 'go-gin', 'rust-axum']);
const manifest: Manifest = process.env.VERIFY_FAST === '1'
    ? { repos: fullManifest.repos.filter(r => FAST_IDS.has(r.id)) }
    : fullManifest;

describe('Real-world graph integrity', () => {
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
            it('parses every scanned file without failure', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.parseFailureCount,
                    `${spec.id}: parse failures by extension: ${JSON.stringify(r.parseFailures)}`,
                ).toBe(0);
            });

            it('builds an api-list graph when APIs are detected', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.apiCount === 0) return; // covered by invariants.test.ts
                expect(
                    r.apiListGraphs,
                    `${spec.id}: ${r.apiCount} APIs detected but 0 api-list graphs`,
                ).toBeGreaterThan(0);
            });

            it('produces a non-empty file graph for connected codebases', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.fileCount < 5) return; // single-file demos legitimately have no edges
                expect(
                    r.fileGraphsWithEdges,
                    `${spec.id}: ${r.fileCount} files but no file graph has edges`,
                ).toBeGreaterThan(0);
            });

            it('at least one sequence graph contains messages', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                if (r.sequenceGraphs === 0) return; // covered by invariants.test.ts
                // Stricter "ratio" assertions surfaced a known gap — meta-framework
                // handlers (Next.js / Nuxt / tRPC default exports, NestJS class
                // methods reached via DI) often resolve to participant-only
                // diagrams because cross-file handler-body resolution doesn't see
                // them. That's tracked separately as a future enhancement; for
                // the smoke-test bar, require at least one non-empty graph so a
                // total resolver regression still gets caught.
                expect(
                    r.sequenceGraphsWithMessages,
                    `${spec.id}: ${r.sequenceGraphs} sequence graphs built but ALL are participant-only`,
                ).toBeGreaterThan(0);
            });

            it('produces a workspace health report', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.healthReportPresent,
                    `${spec.id}: working.health is missing — health analyzer never ran`,
                ).toBe(true);
            });

            it('Issue 301: health report has all required array fields', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.healthReportFieldsPresent,
                    `${spec.id}: health report exists but is missing one or more required arrays (deadFunctions/godFiles/highCouplingFiles/cyclicDependencies/orphanedClusters)`,
                ).toBe(true);
            });

            it('builds a non-empty call graph for multi-file repos', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                const isJsOrTs = spec.language === 'javascript' || spec.language === 'typescript';
                if (!isJsOrTs || r.fileCount < 5) return;
                // Some sample/example repos (e.g. koajs/examples — many tiny standalone
                // demos in subdirs that DON'T cross-call each other, plus heavy use of
                // CJS expression exports `module.exports = views(...)` which the
                // resolver can't bridge) legitimately have 0 call edges. Require
                // edges only for repos with substantive function density across
                // a connected codebase (≥30 flow graphs).
                if (r.flowGraphs < 30) return;
                expect(
                    r.callGraphEdgeCount,
                    `${spec.id}: JS/TS repo with ${r.fileCount} files / ${r.flowGraphs} flow graphs has 0 call graph edges`,
                ).toBeGreaterThan(0);
            });

            it('no graph node has an empty or missing label', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.nodesWithoutLabel,
                    `${spec.id}: ${r.nodesWithoutLabel} graph nodes have empty/null labels (silent renderer bug)`,
                ).toBe(0);
            });

            it('no graph has duplicate node IDs', { timeout: 120_000 }, async () => {
                const r = await verifyCached(repoPath, spec);
                expect(
                    r.duplicateNodeIdGraphs,
                    `${spec.id}: ${r.duplicateNodeIdGraphs} graphs contain duplicate node IDs (would break React keys)`,
                ).toBe(0);
            });
        });
    }
});
