/**
 * gitRefProvider.test.ts
 *
 * Covers: non-repo → 'pre-git', no-commits repo → 'pre-git', repo with one
 * commit → 40-char SHA, caching across rapid calls, manual invalidation,
 * branch switch picked up after invalidate().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRefProvider, PRE_GIT_REF } from '../gitRefProvider';

function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-gitref-'));
}

function git(cwd: string, cmd: string): string {
    return execSync(`git ${cmd}`, {
        cwd,
        encoding: 'utf-8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'CodeAtlas Test',
            GIT_AUTHOR_EMAIL: 'test@codeatlas.dev',
            GIT_COMMITTER_NAME: 'CodeAtlas Test',
            GIT_COMMITTER_EMAIL: 'test@codeatlas.dev',
        },
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}

function initRepo(cwd: string): void {
    git(cwd, 'init -b main');
    git(cwd, 'config commit.gpgsign false');
}

describe('GitRefProvider', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = tmp();
    });

    afterEach(() => {
        try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('returns PRE_GIT_REF when workspace is not a git repo', () => {
        const provider = new GitRefProvider(workspaceRoot);
        expect(provider.current()).toBe(PRE_GIT_REF);
    });

    it('returns PRE_GIT_REF for a fresh repo with no commits yet', () => {
        initRepo(workspaceRoot);
        const provider = new GitRefProvider(workspaceRoot);
        expect(provider.current()).toBe(PRE_GIT_REF);
    });

    it('returns the 40-char HEAD SHA after a commit', () => {
        initRepo(workspaceRoot);
        fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# hello\n');
        git(workspaceRoot, 'add README.md');
        git(workspaceRoot, 'commit -m initial');
        const provider = new GitRefProvider(workspaceRoot);
        const sha = provider.current();
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('caches the result across rapid back-to-back calls', () => {
        initRepo(workspaceRoot);
        fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a');
        git(workspaceRoot, 'add a.txt');
        git(workspaceRoot, 'commit -m a');
        const provider = new GitRefProvider(workspaceRoot, 60_000); // long TTL
        const first = provider.current();
        // Make a new commit underneath the cache.
        fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'b');
        git(workspaceRoot, 'add b.txt');
        git(workspaceRoot, 'commit -m b');
        // Without invalidate(), cached value sticks.
        expect(provider.current()).toBe(first);
    });

    it('picks up branch switch after invalidate()', () => {
        initRepo(workspaceRoot);
        fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a');
        git(workspaceRoot, 'add a.txt');
        git(workspaceRoot, 'commit -m a');
        const provider = new GitRefProvider(workspaceRoot, 60_000);
        const onMain = provider.current();
        git(workspaceRoot, 'checkout -b feature');
        fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'b');
        git(workspaceRoot, 'add b.txt');
        git(workspaceRoot, 'commit -m b');
        // Cache still stale → returns onMain.
        expect(provider.current()).toBe(onMain);
        provider.invalidate();
        const onFeature = provider.current();
        expect(onFeature).toMatch(/^[0-9a-f]{40}$/);
        expect(onFeature).not.toBe(onMain);
    });

    it('respects the cache TTL and re-resolves after expiry', () => {
        initRepo(workspaceRoot);
        fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'a');
        git(workspaceRoot, 'add a.txt');
        git(workspaceRoot, 'commit -m a');
        // Effectively zero TTL → every call re-resolves.
        const provider = new GitRefProvider(workspaceRoot, 0);
        const first = provider.current();
        fs.writeFileSync(path.join(workspaceRoot, 'b.txt'), 'b');
        git(workspaceRoot, 'add b.txt');
        git(workspaceRoot, 'commit -m b');
        const second = provider.current();
        expect(second).toMatch(/^[0-9a-f]{40}$/);
        expect(second).not.toBe(first);
    });
});
