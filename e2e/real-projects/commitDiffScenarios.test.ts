/**
 * commitDiffScenarios.test.ts
 *
 * Issue #401: synthetic-git-history T3 coverage for the commit/branch/PR
 * diff path (`commitDiffer.buildCommitDiffGraphs`). Until now, only the
 * working-diff path had a T3 scenario; commit-diff was covered indirectly
 * (the helper functions it composes are exercised by working-diff via
 * `buildWorkingDiffBundle`) but never end-to-end through the git-shell-out
 * code in `buildCommitDiffGraphs` itself.
 *
 * Approach: create a fresh tmpdir, copy the ts-express-realworld fixture
 * into it, then build a synthetic 2-commit history:
 *   commit A — initial state (full fixture)
 *   commit B — single-line edit to getCurrentUser
 * Feed both hashes to `buildCommitDiffGraphs` and assert the diff bundle:
 *   - L4 `file:auth.service.ts` has getCurrentUser modified
 *   - sibling functions stay unchanged
 *   - L1 microservice graph + L2a feature graph are present
 *   - apiIndex carries all the routes from BOTH snapshots
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { initGitHistory, applyEditOp } from './cascadeHarness';
import { PRESENT_FIXTURES, probeLinesFor } from './cascadeFixtures';
import { installFixtureSafetyGuard } from './fixtureSafety';
import { buildCommitDiffGraphs } from '../../src/core/git/commitDiffer';
import { expectGraph } from './graphMatchers';

installFixtureSafetyGuard();

const TS_EXPRESS = PRESENT_FIXTURES.find(f => f.id === 'ts-express-realworld');
const d = TS_EXPRESS ? describe : describe.skip;

// Helper: copy fixture into a tmp dir for the commit-diff suite.
function copyTreeSync(src: string, dest: string, exclude: Set<string>): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (exclude.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyTreeSync(s, d, exclude);
        else if (entry.isFile()) fs.copyFileSync(s, d);
    }
}

d('commit diff scenarios — buildCommitDiffGraphs against synthetic 2-commit history', () => {
    const REL = TS_EXPRESS!.canonical.relativePath;
    const FN = TS_EXPRESS!.canonical.fnName;
    let workspaceDir: string;
    let baseHash: string;
    let headHash: string;
    let result: Awaited<ReturnType<typeof buildCommitDiffGraphs>>;

    beforeAll(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitdiff-'));
        copyTreeSync(TS_EXPRESS!.repoPath, workspaceDir, new Set(['.git', 'node_modules', '.codeatlas']));

        // Commit A: initial state (no edits — just record the fixture as-is).
        // Commit B: one body edit on getCurrentUser.
        const hashes = await initGitHistory(workspaceDir, [
            { message: 'initial', edits: [] },
            {
                message: `feat: probe ${FN}`,
                edits: [
                    {
                        filePath: REL,
                        op: { op: 'addLinesToFunction', fnName: FN, lines: probeLinesFor(TS_EXPRESS!) },
                    },
                ],
            },
        ]);
        baseHash = hashes[0];
        headHash = hashes[1];

        result = await buildCommitDiffGraphs(workspaceDir, baseHash, headHash);
    }, 90_000);

    afterAll(() => {
        if (workspaceDir) {
            try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('produces non-empty base + head snapshots with matching file counts (single-file edit)', () => {
        expect(Object.keys(result.baseSnapshot.files).length).toBeGreaterThan(0);
        expect(Object.keys(result.headSnapshot.files).length).toBeGreaterThan(0);
        // The edit is body-only — base and head should have the same file set.
        const baseSet = new Set(Object.keys(result.baseSnapshot.files));
        const headSet = new Set(Object.keys(result.headSnapshot.files));
        expect(baseSet.size).toBe(headSet.size);
        for (const k of baseSet) expect(headSet.has(k)).toBe(true);
    });

    it('apiIndex carries routes from both snapshots', () => {
        expect(Object.keys(result.apiIndex).length).toBeGreaterThan(0);
        // ts-express-realworld has at least these auth routes.
        const routes = Object.values(result.apiIndex).map(a => `${a.method} ${a.route}`);
        expect(routes).toContain('GET /user');
        expect(routes).toContain('POST /users');
    });

    it('L4 file:graph for the edited file exists and marks ONLY the edited function modified', () => {
        const l4 = result.diffedGraphs[`file:${REL}`];
        expectGraph(l4, `commit-diff L4`)
            .hasModifiedFunctions([FN]);
    });

    it('L4 file root + Functions section are both modified', () => {
        const l4 = result.diffedGraphs[`file:${REL}`];
        expectGraph(l4, 'commit-diff L4').hasFileRootDiff('modified');
        const section = l4.nodes.find(n => n.type === 'section' && typeof n.label === 'string' && /^Functions/.test(n.label));
        expect(section?.diff).toBe('modified');
    });

    it('sibling L3 sequences (POST /users, PUT /user) stay unchanged in the diff bundle', () => {
        for (const sibling of TS_EXPRESS!.canonical.expectedModified.siblingSequenceIds ?? []) {
            const g = result.diffedGraphs[sibling];
            if (!g) continue;
            const mods = g.nodes.filter(n => n.diff && n.diff !== 'unchanged');
            expect(mods, `sibling ${sibling} must not have modifications`).toEqual([]);
        }
    });

    it('L1 microservice:workspace graph is present in the diff bundle', () => {
        expect(result.diffedGraphs['microservice:workspace'], 'expected microservice:workspace').toBeDefined();
    });

    it('feature graph exists (workspace OR per-service)', () => {
        const featureGraphs = Object.keys(result.diffedGraphs).filter(g => g.startsWith('feature:'));
        expect(featureGraphs.length, 'expected at least one feature: graph').toBeGreaterThan(0);
    });

    it('L5 flow:graph for the edited function is present in the diff bundle', () => {
        const flowId = `flow:${REL}:${FN}`;
        const l5 = result.diffedGraphs[flowId];
        expect(l5, `expected ${flowId} present`).toBeDefined();
    });
});

d('commit diff scenarios — head identical to base (no-op commit)', () => {
    let workspaceDir: string;
    let result: Awaited<ReturnType<typeof buildCommitDiffGraphs>>;

    beforeAll(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitdiff-noop-'));
        copyTreeSync(TS_EXPRESS!.repoPath, workspaceDir, new Set(['.git', 'node_modules', '.codeatlas']));
        const hashes = await initGitHistory(workspaceDir, [
            { message: 'initial', edits: [] },
            { message: 'empty', edits: [] },
        ]);
        result = await buildCommitDiffGraphs(workspaceDir, hashes[0], hashes[1]);
    }, 90_000);

    afterAll(() => {
        if (workspaceDir) {
            try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });

    it('no L4 file:graph has any modified entity nodes', () => {
        for (const [gid, graph] of Object.entries(result.diffedGraphs)) {
            if (!gid.startsWith('file:')) continue;
            const mods = (graph as any).nodes.filter(
                (n: any) => n.type !== 'file' && n.type !== 'section' && n.diff && n.diff !== 'unchanged',
            );
            expect(mods, `${gid} should be clean for no-op commit`).toEqual([]);
        }
    });
});
