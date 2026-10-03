/**
 * gitRefProvider.ts
 *
 * Resolves the current git HEAD SHA so persisted state can be tagged with
 * the code revision it corresponds to. Returns the `PRE_GIT_REF` sentinel
 * for workspaces that aren't a git repo or have no commits yet — that
 * sentinel is a real value (not null) so storage rows always have a
 * non-null `git_ref` and the FK invariant holds from day one.
 *
 * Result is cached briefly so a debounced save burst doesn't re-spawn
 * `git rev-parse` hundreds of times. Call `invalidate()` (or wire the
 * VS Code FS watcher to `.git/HEAD` + `.git/refs/heads/*`) when a branch
 * switch or commit happens so the next save picks up the new SHA.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const PRE_GIT_REF = 'pre-git';

const HEX_40 = /^[0-9a-fA-F]{40}$/;

export class GitRefProvider {
    private readonly workspaceRoot: string;
    private readonly cacheTtlMs: number;
    private cached: { value: string; capturedAt: number } | null = null;
    private log: (msg: string) => void = () => { /* noop */ };

    constructor(workspaceRoot: string, cacheTtlMs: number = 2000) {
        this.workspaceRoot = workspaceRoot;
        this.cacheTtlMs = cacheTtlMs;
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    /** Current HEAD SHA, or `PRE_GIT_REF` for non-repo / no-commits workspaces. */
    current(): string {
        const now = Date.now();
        if (this.cached && now - this.cached.capturedAt < this.cacheTtlMs) {
            return this.cached.value;
        }
        const value = this.computeRef();
        this.cached = { value, capturedAt: now };
        return value;
    }

    /** Force the next `current()` call to re-resolve. Wire to .git/HEAD watcher. */
    invalidate(): void {
        this.cached = null;
    }

    private computeRef(): string {
        const gitDir = path.join(this.workspaceRoot, '.git');
        if (!fs.existsSync(gitDir)) return PRE_GIT_REF;
        try {
            const out = execSync('git rev-parse HEAD', {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 5000,
            }).trim();
            if (HEX_40.test(out)) return out;
            this.log(`[GitRefProvider] rev-parse returned non-SHA "${out.slice(0, 16)}"; using ${PRE_GIT_REF}`);
            return PRE_GIT_REF;
        } catch {
            // Fresh clone with no commits, detached state, or git missing.
            return PRE_GIT_REF;
        }
    }
}
