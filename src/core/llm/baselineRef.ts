/**
 * baselineRef.ts (#534 — AI Review findings carry no commit / baseline reference)
 *
 * Compute a stable provenance ref for an AI review run. Two strategies:
 *
 *   - **git** — when the workspace is a git repo, use the 7-char short SHA of
 *     HEAD as the ref. Matches what users see in `git log --oneline`.
 *   - **snapshot** — when no git, fold the working snapshot's per-file content
 *     hashes into a deterministic 8-char hex digest. Two reviews against
 *     identical file contents will produce the same ref, which is what we
 *     want for caching / "stale finding" detection.
 *
 * The helper never throws — all I/O paths fall back to `snapshot`-kind so a
 * review is never blocked by a missing git binary or odd repo state.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SnapshotStore } from '../storage/snapshotStore';
import type { AiReviewBaselineRef, FileRecord } from '../graph/graphTypes';

export interface ComputeBaselineRefOpts {
    workspaceRoot: string;
    snapshotStore: SnapshotStore;
    /** Inject for testability — defaults to a real `git rev-parse --short=7 HEAD` invocation. */
    gitShaProbe?: (workspaceRoot: string) => string | null;
}

/**
 * Real git-sha probe. spawnSync (not execSync) so it doesn't inherit stdin
 * from the parent process — matches the same EBADF fix we made for
 * gitReader. Returns the short SHA or `null` when the workspace isn't a git
 * repo / git isn't installed.
 */
export function defaultGitShaProbe(workspaceRoot: string): string | null {
    try {
        if (!fs.existsSync(path.join(workspaceRoot, '.git'))) return null;
    } catch { return null; }
    try {
        const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], {
            cwd: workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5_000,
        });
        if (r.status !== 0) return null;
        const out = String(r.stdout ?? '').trim();
        return /^[0-9a-f]{7}$/.test(out) ? out : null;
    } catch {
        return null;
    }
}

export function computeBaselineRef(opts: ComputeBaselineRefOpts): AiReviewBaselineRef {
    const capturedAt = new Date().toISOString();
    const probe = opts.gitShaProbe ?? defaultGitShaProbe;
    const gitSha = probe(opts.workspaceRoot);
    if (gitSha) return { kind: 'git', ref: gitSha, capturedAt };

    // Non-git fallback: deterministic 8-char hex digest of the working
    // snapshot's per-file `${path}@${hash}` lines (sorted).
    let files: Record<string, FileRecord> | undefined;
    try { files = opts.snapshotStore.getWorking().files; } catch { files = undefined; }
    const lines: string[] = [];
    if (files) {
        for (const [p, f] of Object.entries(files)) {
            const hash = (f as any)?.hash ?? '';
            lines.push(`${p}@${hash}`);
        }
        lines.sort();
    }
    const digest = crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 8);
    return { kind: 'snapshot', ref: digest, capturedAt };
}
