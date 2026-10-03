/**
 * summary.test.ts
 *
 * Per-framework breakdown printed alongside the layered assertions. For each
 * cloned repo we emit one line with:
 *   - test status (✓/✗ — the per-test framework probe verifies basic counts)
 *   - APIs (route APIs only, mobile items in parens)
 *   - Functions
 *   - Classes
 *   - Features (feature clusters)
 *   - avg classes/file and functions/file
 *
 * Output goes through `console.log` so it appears in vitest stdout regardless
 * of test pass/fail. Failures are still raised as assertion errors so the
 * status column reflects reality.
 */

import { describe, it, expect } from 'vitest';
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

function pad(s: string | number, w: number): string {
    const v = String(s);
    return v.length >= w ? v.slice(0, w) : v + ' '.repeat(w - v.length);
}

describe('Per-framework summary', () => {
    // Print the header once before the per-repo tests run.
    it('header', () => {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════════════════════════════');
        console.log('  PER-FRAMEWORK SUMMARY (verify:real:invariants)');
        console.log('═══════════════════════════════════════════════════════════════════════════════════════');
        console.log(
            '  ' +
            pad('repo', 22) +
            pad('lang/fw', 22) +
            pad('files', 6) +
            pad('apis', 9) +
            pad('funcs', 7) +
            pad('class', 6) +
            pad('feat', 5) +
            pad('cls/f', 6) +
            pad('fn/f', 6),
        );
        console.log('  ' + '─'.repeat(85));
    });

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

        it(`[${spec.id}] (${spec.language}/${spec.framework})`, { timeout: 120_000 }, async () => {
            const r = await verifyCached(repoPath, spec);
            // Smoke invariants — these are the headline numbers we just printed,
            // so the table reflects the actual test status:
            expect(r.initialized, `${spec.id}: initialize() failed: ${r.error}`).toBe(true);
            expect(r.fileCount, `${spec.id}: 0 files scanned`).toBeGreaterThan(0);
            expect(r.featureClusters, `${spec.id}: 0 feature clusters`).toBeGreaterThan(0);

            const apiSummary = `${r.routeApiCount}+${r.mobileItemCount}m`;
            console.log(
                '  ' +
                pad(spec.id, 22) +
                pad(`${spec.language}/${spec.framework}`, 22) +
                pad(r.fileCount, 6) +
                pad(apiSummary, 9) +
                pad(r.functionCount, 7) +
                pad(r.classCount, 6) +
                pad(r.featureClusters, 5) +
                pad(r.avgClassesPerFile.toFixed(2), 6) +
                pad(r.avgFunctionsPerFile.toFixed(2), 6),
            );
        });
    }
});
