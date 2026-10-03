/**
 * reviewPrCli.integration.test.ts — #850 (2026-06-11)
 *
 * Dry-run integration: REAL git repo (synthetic base/head commits), REAL
 * SnapshotStore + SyncOrchestrator pipeline, stubbed LLM (the review step
 * writes a finding through the real store API). Verifies the end-to-end
 * choreography the unit tests fake: base checkout → init → head checkout →
 * resync → finding lands on a commentable diff line → payload built → repo
 * restored to its original branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runReviewPr } from '../reviewPrCli';
import { PR_REVIEW_MARKER } from '../../core/review/prReviewPayload';

const BASE_SRC = `const express = require('express');
const app = express();

app.get('/api/user', function getUser(req, res) {
    res.json({ ok: true });
});

module.exports = app;
`;

// Head adds a token-logging line inside the handler (lines shift below it).
const HEAD_SRC = BASE_SRC.replace(
    "    res.json({ ok: true });",
    "    console.log('token', req.headers.authorization);\n    res.json({ ok: true });",
);

let repo: string;
let baseSha = '';

function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pr-int-'));
    git(['init', '--quiet', '-b', 'main']);
    git(['config', 'user.email', 'test@codeatlas.dev']);
    git(['config', 'user.name', 'CodeAtlas Test']);
    fs.writeFileSync(path.join(repo, 'app.js'), BASE_SRC);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'base']);
    baseSha = git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'app.js'), HEAD_SRC);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'head: log auth token']);
});

afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('review-pr integration dry-run (#850)', () => {
    it('real git + real pipeline: finding pins to the added diff line, branch restored', async () => {
        const logs: string[] = [];
        const out = await runReviewPr({
            repoPath: repo,
            baseRef: baseSha,
            log: (m) => logs.push(m),
            env: { OPENROUTER_API_KEY: 'stub-key' },
            // Stub ONLY the LLM step — write through the real store API so the
            // read-back path (listAiReviewFindings → toPrFinding) is exercised.
            review: async (deps) => {
                deps.snapshotStore.upsertAiReviewFinding({
                    entryPointId: 'GET:/api/user',
                    bindings: [],
                    severity: 'error',
                    category: 'security',
                    title: 'Auth token logged',
                    body: 'The Authorization header is written to stdout.',
                    anchor: {
                        filePath: 'app.js',
                        symbol: 'getUser',
                        snippet: "console.log('token', req.headers.authorization);",
                        lineStart: 5,
                        lineEnd: 5,
                    },
                    status: 'open',
                    model: 'stub',
                } as any);
                deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { reviewed: 1 } });
            },
        });

        expect(out.error).toBeUndefined();
        expect(out.ok).toBe(true);
        expect(out.posted).toBe(false);
        // The added console.log line is line 5 on the RIGHT side of the diff.
        expect(out.inlineCount).toBe(1);
        expect(out.inline![0]).toMatchObject({ path: 'app.js', line: 5, side: 'RIGHT' });
        expect(out.inline![0].body).toContain('Auth token logged');
        expect(out.summaryBody).toContain(PR_REVIEW_MARKER);
        expect(out.summaryBody).toContain('1 entry point reviewed');
        // #853 — the real store's working-vs-baseline diff drives the
        // regression-scope composer: the changed handler owns GET /api/user.
        expect(out.summaryBody).toContain('What to re-test');
        expect(out.summaryBody).toContain('/api/user');

        // Repo restored: back on main, head content intact, no .codeatlas dirs.
        expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
        expect(fs.readFileSync(path.join(repo, 'app.js'), 'utf-8')).toBe(HEAD_SRC);
        expect(fs.existsSync(path.join(repo, '.codeatlas'))).toBe(false);
        expect(fs.existsSync(path.join(repo, '.codeatlas-pr'))).toBe(false);
    }, 60_000);

    it('init at base really is the baseline: store diff sees only the PR change', async () => {
        let workingHash = '';
        let baselineHash = '';
        const out = await runReviewPr({
            repoPath: repo,
            baseRef: baseSha,
            log: () => {},
            env: { OPENROUTER_API_KEY: 'stub-key' },
            review: async (deps) => {
                const f = deps.snapshotStore.getWorking().files['app.js'];
                const b = deps.snapshotStore.getBaseline().files['app.js'];
                workingHash = f?.hash ?? '';
                baselineHash = b?.hash ?? '';
            },
        });
        expect(out.ok).toBe(true);
        expect(workingHash).not.toBe('');
        expect(baselineHash).not.toBe('');
        // baseline = base commit, working = head commit ⇒ hashes diverge.
        expect(workingHash).not.toBe(baselineHash);
    }, 60_000);
});
