/**
 * prCloneRunner.ts — #851 (2026-06-12).
 *
 * Default `reviewPr` implementation for the PR watcher: runs the #850
 * review-pr flow (ADR-044) against a TEMPORARY CLONE of the workspace repo.
 *
 * INVARIANT: the watcher must NEVER check out branches in the user's live
 * working tree — `runReviewPr` does base/head checkouts, so it always gets
 * a disposable clone. The clone starts from the local repo (fast, no
 * network for existing history) and fetches the PR head + base refs from
 * GitHub with the token passed via an HTTP header (never embedded in the
 * URL, which would leak into process listings).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { PrSummary } from './prWatcher';

export interface PrCloneRunnerOpts {
    /** The user's live repo — used as the local clone source. */
    repoPath: string;
    log: (msg: string) => void;
    /**
     * LLM credentials/config for the review running inside the CLONE. The
     * clone has neither the host's secret store (VS Code secrets / the
     * workspace's `.codeatlas-sa/config.json` — both unversioned) nor its
     * settings, so the owning surface forwards them as the env-override
     * names the standalone resolvers honor (OPENROUTER_API_KEY,
     * CODEATLAS_LLM_PROVIDER / _MODEL / _ENDPOINT). Merged over
     * process.env; undefined values are dropped.
     */
    reviewEnv?: () => Promise<Record<string, string | undefined>>;
    /**
     * #853 — review guidelines from the LIVE workspace store (the clone's
     * store starts empty, so they must be forwarded). Resolved per run so
     * edits in the browser card apply to the next poll.
     */
    guidelinesText?: () => Promise<string | undefined>;
    /** Test seams. */
    execGit?: (args: string[], cwd: string) => string;
    runReview?: (opts: {
        repoPath: string; baseRef: string; headRef: string;
        repoSlug: string; prNumber: number; post: boolean;
        githubToken: string; log: (m: string) => void;
        env?: Record<string, string | undefined>;
        guidelinesText?: string;
    }) => Promise<{ ok: boolean; exitCode: number; error?: string }>;
    mkTmpDir?: () => string;
    rmDir?: (dir: string) => void;
}

const PR_HEAD_BRANCH = '__codeatlas_pr_head';
const PR_BASE_BRANCH = '__codeatlas_pr_base';

export async function reviewPrInClone(
    pr: PrSummary,
    ctx: { slug: string; token: string },
    opts: PrCloneRunnerOpts,
): Promise<{ ok: boolean; error?: string }> {
    const git = opts.execGit ?? ((args: string[], cwd: string) =>
        execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }));
    const mkTmp = opts.mkTmpDir ?? (() => fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-pr-watch-')));
    const rm = opts.rmDir ?? ((dir: string) => fs.rmSync(dir, { recursive: true, force: true }));

    const tmp = mkTmp();
    try {
        // Local clone — shares objects with the source repo, no network.
        git(['clone', '--quiet', '--no-checkout', opts.repoPath, tmp], path.dirname(tmp));
        // Token via header, not URL. `Buffer` base64 of "x-access-token:<t>"
        // is GitHub's documented basic-auth form for installation tokens.
        const auth = Buffer.from(`x-access-token:${ctx.token}`).toString('base64');
        const authedFetch = (refspecs: string[]) => git([
            '-c', `http.extraHeader=Authorization: Basic ${auth}`,
            'fetch', '--quiet', `https://github.com/${ctx.slug}.git`,
            ...refspecs,
        ], tmp);
        authedFetch([
            `+refs/pull/${pr.number}/head:refs/heads/${PR_HEAD_BRANCH}`,
            `+refs/heads/${pr.baseRef}:refs/heads/${PR_BASE_BRANCH}`,
        ]);
        git(['checkout', '--quiet', PR_HEAD_BRANCH], tmp);

        // Base = the PR's recorded base sha when the fetched base history
        // contains it (the normal case); otherwise the fetched base tip.
        let baseRef = PR_BASE_BRANCH;
        try {
            git(['cat-file', '-e', `${pr.baseSha}^{commit}`], tmp);
            baseRef = pr.baseSha;
        } catch { /* shallow/foreign base sha — fall back to branch tip */ }

        const runReview = opts.runReview ?? (async (o) => {
            // INVARIANT: reviewPrCli must NOT join this module's bundle graph
            // (ADR-044 — a static OR analyzable-dynamic import reorders zod
            // init and crashes the MCP SDK at load). Resolve the sibling
            // bundle first (dist/review-pr-cli.js, present in both the
            // extension and MCP dists); fall back to the source path for
            // un-bundled dev runs. The non-literal require is left as a
            // runtime require by esbuild.
            const sibling = path.join(__dirname, 'review-pr-cli.js');
            const modPath = fs.existsSync(sibling)
                ? sibling
                : path.join(__dirname, '..', '..', 'standalone', 'reviewPrCli');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { runReviewPr } = require(modPath) as typeof import('../../standalone/reviewPrCli');
            return runReviewPr(o);
        });
        let env: Record<string, string | undefined> | undefined;
        if (opts.reviewEnv) {
            const forwarded = await opts.reviewEnv();
            env = { ...process.env };
            for (const [k, v] of Object.entries(forwarded)) {
                if (v !== undefined && v !== '') env[k] = v;
            }
        }
        const out = await runReview({
            repoPath: tmp,
            baseRef,
            headRef: PR_HEAD_BRANCH,
            repoSlug: ctx.slug,
            prNumber: pr.number,
            post: true,
            githubToken: ctx.token,
            log: opts.log,
            env,
            guidelinesText: opts.guidelinesText ? await opts.guidelinesText() : undefined,
        });
        return out.ok ? { ok: true } : { ok: false, error: out.error ?? `exit ${out.exitCode}` };
    } catch (err: any) {
        return { ok: false, error: (err?.message ?? String(err)).slice(0, 300) };
    } finally {
        try { rm(tmp); } catch { /* tmpdir */ }
    }
}
