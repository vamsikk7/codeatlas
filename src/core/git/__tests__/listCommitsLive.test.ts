/**
 * Live sanity check — exercises the real `listCommits` against the test repo
 * fixture to confirm spawnSync doesn't EBADF in normal test contexts.
 * The earlier EBADF we saw came from running the bundle as a child of a Node
 * probe; this test runs in the unit-test parent which is more representative
 * of a user shell.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { listCommits, listBranches } from '../gitReader';

// Point this at any local git checkout to run the live check:
//   CODEATLAS_LIVE_GIT_REPO=/path/to/repo npx vitest run listCommitsLive
// Skipped when unset or missing, so it is a no-op in CI and on a fresh clone.
const REPO = process.env.CODEATLAS_LIVE_GIT_REPO ?? '';
const REPO_AVAILABLE = REPO !== '' && fs.existsSync(REPO + '/.git');

describe.skipIf(!REPO_AVAILABLE)('listCommits / listBranches against the test repo', () => {
    it('returns commits', () => {
        const commits = listCommits(REPO, 5);
        expect(commits.length).toBeGreaterThan(0);
        expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    });

    it('returns branches', () => {
        const branches = listBranches(REPO);
        expect(branches.length).toBeGreaterThan(0);
        expect(branches.some((b) => b.isCurrent)).toBe(true);
    });
});
