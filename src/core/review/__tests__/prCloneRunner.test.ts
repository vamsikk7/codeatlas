/**
 * prCloneRunner.test.ts — #851 (2026-06-12)
 *
 * Clone-based watcher review runner: clones to tmp (never the live tree),
 * fetches PR refs with header auth (no token in URL), prefers the recorded
 * base sha, always cleans up the tmpdir.
 */
import { describe, it, expect, vi } from 'vitest';
import { reviewPrInClone } from '../prCloneRunner';
import type { PrSummary } from '../prWatcher';

const PR: PrSummary = { number: 9, title: 'Fix', headSha: 'h9', baseSha: 'b9', baseRef: 'main' };

function harness(over: { catFileFails?: boolean; reviewOk?: boolean } = {}) {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const execGit = (args: string[], cwd: string): string => {
        calls.push({ args, cwd });
        if (args[0] === 'cat-file' && over.catFileFails) throw new Error('missing object');
        return '';
    };
    const reviewCalls: any[] = [];
    const runReview = vi.fn(async (o: any) => {
        reviewCalls.push(o);
        return over.reviewOk === false
            ? { ok: false, exitCode: 3, error: 'llm down' }
            : { ok: true, exitCode: 0 };
    });
    let removed: string | null = null;
    return {
        calls, reviewCalls, removedRef: () => removed,
        opts: {
            repoPath: '/repo/live',
            log: () => {},
            execGit,
            runReview,
            mkTmpDir: () => '/tmp/clone-x',
            rmDir: (d: string) => { removed = d; },
        },
    };
}

describe('reviewPrInClone (#851)', () => {
    it('clones to tmp, fetches PR refs with header auth, reviews at base sha, cleans up', async () => {
        const h = harness();
        const out = await reviewPrInClone(PR, { slug: 'acme/widgets', token: 'sekret' }, h.opts);
        expect(out.ok).toBe(true);

        const clone = h.calls.find((c) => c.args[0] === 'clone')!;
        expect(clone.args).toContain('/repo/live');
        expect(clone.args).toContain('/tmp/clone-x');

        const fetch = h.calls.find((c) => c.args.includes('fetch'))!;
        const joined = fetch.args.join(' ');
        expect(joined).toContain('refs/pull/9/head');
        expect(joined).toContain('refs/heads/main');
        expect(joined).toContain('https://github.com/acme/widgets.git');
        // Token travels in the Authorization header, never the URL.
        expect(joined).not.toContain('sekret');
        expect(joined).toContain('http.extraHeader=Authorization: Basic');
        expect(fetch.cwd).toBe('/tmp/clone-x');

        expect(h.reviewCalls[0]).toMatchObject({
            repoPath: '/tmp/clone-x', baseRef: 'b9', prNumber: 9,
            repoSlug: 'acme/widgets', post: true, githubToken: 'sekret',
        });
        expect(h.removedRef()).toBe('/tmp/clone-x');
    });

    it('forwards reviewEnv (LLM key/config) into the clone review, dropping empties', async () => {
        const h = harness();
        (h.opts as any).reviewEnv = async () => ({
            OPENROUTER_API_KEY: 'llm-key',
            CODEATLAS_LLM_PROVIDER: 'openrouter',
            CODEATLAS_LLM_MODEL: undefined,   // unset — must not land
            CODEATLAS_LLM_ENDPOINT: '',       // empty — must not land
        });
        await reviewPrInClone(PR, { slug: 'a/b', token: 't' }, h.opts);
        const env = h.reviewCalls[0].env;
        expect(env.OPENROUTER_API_KEY).toBe('llm-key');
        expect(env.CODEATLAS_LLM_PROVIDER).toBe('openrouter');
        expect('CODEATLAS_LLM_MODEL' in env ? env.CODEATLAS_LLM_MODEL : undefined).toBeUndefined();
        expect(env.CODEATLAS_LLM_ENDPOINT).toBeUndefined();
        // process.env still present underneath (e.g. PATH for git/node).
        expect(env.PATH).toBe(process.env.PATH);
    });

    it('forwards live-workspace guidelines into the clone review (#853)', async () => {
        const h = harness();
        (h.opts as any).guidelinesText = async () => 'No console.log of tokens.';
        await reviewPrInClone(PR, { slug: 'a/b', token: 't' }, h.opts);
        expect(h.reviewCalls[0].guidelinesText).toBe('No console.log of tokens.');
    });

    it('without reviewEnv the review gets no env override (process.env default)', async () => {
        const h = harness();
        await reviewPrInClone(PR, { slug: 'a/b', token: 't' }, h.opts);
        expect(h.reviewCalls[0].env).toBeUndefined();
    });

    it('falls back to the fetched base branch when the base sha is unreachable', async () => {
        const h = harness({ catFileFails: true });
        await reviewPrInClone(PR, { slug: 'a/b', token: 't' }, h.opts);
        expect(h.reviewCalls[0].baseRef).toBe('__codeatlas_pr_base');
    });

    it('review failure propagates as ok:false with the error, tmpdir still removed', async () => {
        const h = harness({ reviewOk: false });
        const out = await reviewPrInClone(PR, { slug: 'a/b', token: 't' }, h.opts);
        expect(out.ok).toBe(false);
        expect(out.error).toContain('llm down');
        expect(h.removedRef()).toBe('/tmp/clone-x');
    });

    it('git failure (clone/fetch) is caught, tmpdir removed', async () => {
        const h = harness();
        h.opts.execGit = () => { throw new Error('network down'); };
        const out = await reviewPrInClone(PR, { slug: 'a/b', token: 't' }, h.opts);
        expect(out.ok).toBe(false);
        expect(out.error).toContain('network down');
        expect(h.removedRef()).toBe('/tmp/clone-x');
    });
});
