/**
 * reviewPrCli.ts — #850 (2026-06-11).
 *
 * One-shot PR review orchestrator behind `codeatlas-mcp review-pr`. Designed
 * to run inside GitHub Actions on pull_request events — the Action IS the
 * webhook (CodeRabbit-style commenter, CI-driven v1).
 *
 * Flow: checkout PR base → initialize the normal CodeAtlas pipeline
 * (baseline = base) → checkout head → resync only the changed files (the
 * store's working-vs-baseline diff then IS the PR diff) → run the existing
 * evidence-gated review (`runFullReview` scope=changed) → map the persisted
 * findings onto GitHub's PR review shape (inline on exact diff lines, the
 * rest folded into a marker-tagged summary) → `--post` via the REST API or
 * dry-run print.
 *
 * INVARIANT: the repo is always restored to its original ref, even on
 * failure — CI checkouts are ephemeral but local dry-runs are not.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
// INVARIANT: this module must NEVER be imported (even dynamically) from
// mcp-server.ts — adding it to that bundle's graph reorders zod's module
// init and crashes the MCP SDK's schema construction on every invocation
// ("Class2 is not a constructor"). It is built as its own esbuild entry
// (`dist/review-pr-cli.js`) and loaded via runtime require; see ADR-044.
import { SnapshotStore } from '../core/storage/snapshotStore';
import { SyncOrchestrator } from '../core/sync/syncOrchestrator';
import { CommentStore } from '../core/storage/commentStore';
import type { AiReviewFinding } from '../core/graph/graphTypes';
import { createSettingsResolver } from './settings';
import { createSecretsStore } from './secrets';
import { runFullReview, type AiReviewDeps } from './aiReview';
import { selectProjectLevelFiles, selectUncoveredChangedFiles, SOURCE_EXT, fileTier } from '../core/llm/projectLevelReviewer';
import { filterReviewFindings } from '../core/llm/reviewFilters';
import {
    parseUnifiedDiff,
    mapFindingsToPrReview,
    buildPrSummaryBody,
    renderRegressionHint,
    type PrFindingLike,
    type PrInlineComment,
    type ReviewCoverage,
} from '../core/review/prReviewPayload';
import { computeRegressionScope } from '../core/analysis/regressionScope';
import { postReview, upsertSummaryComment, type GithubPrTarget } from '../core/review/githubPrClient';

export interface ReviewPrOptions {
    repoPath: string;
    /** PR base ref/sha (e.g. `origin/main`, `$GITHUB_BASE_SHA`). */
    baseRef: string;
    /** PR head ref/sha. Defaults to the current HEAD. */
    headRef?: string;
    /** "owner/repo" — required with `post`. */
    repoSlug?: string;
    /** PR number — required with `post`. */
    prNumber?: number;
    /** Post to GitHub. Default false → dry-run print to stdout. */
    post?: boolean;
    /** Defaults to env GITHUB_TOKEN. */
    githubToken?: string;
    /**
     * #853 — review guidelines applied to this run. The clone's state store
     * is fresh, so guidelines saved in the live workspace never reach it
     * unless forwarded here (watcher wirings) or via `--guidelines <path>`
     * (CI). Seeded into the pipeline store before the review runs.
     */
    guidelinesText?: string;
    log?: (msg: string) => void;
    /** Test seams — every external effect is injectable. */
    execGit?: (args: string[]) => string;
    fetchImpl?: (url: string, init?: any) => Promise<any>;
    createPipeline?: (repoPath: string) => Promise<PrReviewPipeline>;
    review?: (deps: AiReviewDeps) => Promise<void>;
    env?: Record<string, string | undefined>;
    /** #867 — free-bytes probe (test seam); defaults to fs.statfsSync on tmpdir + repo. */
    freeBytes?: () => number;
    /** #871 — skip the final restore checkout (it cold-fetches originalRef on partial clones). */
    noRestore?: boolean;
    /** #871 — skip the regression-scope blast-radius BFS (slow on big graphs; non-essential hint). */
    noRegression?: boolean;
}

export interface PrReviewPipeline {
    store: Pick<SnapshotStore, 'listAiReviewFindings' | 'setReviewGuidelines' | 'getWorking' | 'getBaseline'>;
    initialize: () => Promise<unknown>;
    rebuildFile: (absPath: string, opts?: { deferCascade?: boolean }) => Promise<unknown>;
    handleFileDeleted: (absPath: string) => void;
    dispose: () => void;
}

export interface ReviewPrResult {
    ok: boolean;
    exitCode: number;
    findingsCount: number;
    inlineCount: number;
    outsideCount: number;
    summaryBody?: string;
    inline?: PrInlineComment[];
    /** #853 — findings folded into the summary (no commentable diff line). */
    outside?: PrFindingLike[];
    /** #849 — per-run LLM usage + timing for benchmark metering. */
    tokensUsed?: { prompt: number; completion: number; calls: number };
    model?: string;
    durationMs?: number;
    posted: boolean;
    error?: string;
    /** #916 — the review's coverage denominator (changed files reviewed vs reviewed-blind). */
    coverage?: ReviewCoverage;
}

/** Refs are passed to execFile (no shell), so the only injection surface is
 *  git treating a leading `-` as an option. Reject those outright. */
function assertSafeRef(ref: string, name: string): void {
    if (!ref || ref.startsWith('-') || /\s/.test(ref)) {
        throw new Error(`invalid ${name} ref: "${ref}"`);
    }
}

async function defaultCreatePipeline(repoPath: string): Promise<PrReviewPipeline> {
    // State lives in a tmpdir, NOT the repo working tree — we checkout
    // branches underneath it and don't want `.codeatlas/` churn in the diff.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-pr-'));
    const store = new SnapshotStore(stateDir);
    const sync = new SyncOrchestrator(repoPath, store, new CommentStore([]));
    return Promise.resolve({
        store,
        initialize: () => sync.initialize(),
        rebuildFile: (abs: string, opts?: { deferCascade?: boolean }) => sync.rebuildFile(abs, undefined, opts),
        handleFileDeleted: (abs: string) => sync.handleFileDeleted(abs),
        dispose: () => { try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* tmpdir */ } },
    });
}

/** Adapt a persisted AiReviewFinding (anchor carries line + snippet) to the
 *  payload mapper's finding shape (evidence object). */
export function toPrFinding(f: AiReviewFinding): PrFindingLike {
    return {
        id: f.id,
        severity: f.severity,
        title: f.title,
        body: f.body,
        anchor: f.anchor ? { filePath: f.anchor.filePath, symbol: f.anchor.symbol } : undefined,
        evidence: f.anchor
            ? { filePath: f.anchor.filePath, lineStart: f.anchor.lineStart, lineEnd: f.anchor.lineEnd, snippet: f.anchor.snippet }
            : undefined,
        evidenceConfidence: (f.anchor as any)?.evidenceConfidence,
    };
}

/** #867 — free bytes on the volume holding `p`; Infinity if unknowable. */
function freeBytesAt(p: string): number {
    try {
        const s = (fs as any).statfsSync(p);
        return s.bavail * s.bsize;
    } catch {
        return Infinity;
    }
}

/** Default minimum free disk for a review-pr run (base checkout + state.db). */
export const MIN_FREE_BYTES = 2 * 1024 ** 3; // 2 GB

/**
 * #867 — pure disk-space precondition. Pulled out for testing. Returns a
 * human-readable message when the volume is too full to safely check out the
 * base tree + write snapshot state (which would otherwise ENOSPC mid-write and
 * corrupt the store / results file).
 */
export function checkDiskSpace(freeBytes: number, minBytes: number): { ok: boolean; message?: string } {
    if (freeBytes >= minBytes) return { ok: true };
    const gb = (n: number) => (n / 1024 ** 3).toFixed(2);
    return {
        ok: false,
        message: `only ${gb(freeBytes)} GB free — review-pr needs ≥ ${gb(minBytes)} GB for the base checkout + snapshot state. Free disk space and retry.`,
    };
}

/**
 * #896 — pick which rebuild gets the single non-deferred final cascade. Returns
 * the LAST loop index whose file still exists (deletes and any trailing removed
 * files don't count). Index-based, NOT abs-path `findIndex` — so O(n) instead of
 * O(n²), and duplicate / path-normalization-collision entries can't all match the
 * first occurrence and leave the genuine last file deferred (which would skip the
 * one cascade that re-annotates every live graph). Returns -1 when nothing exists
 * (all deletes) — then no rebuild runs and no non-deferred cascade is needed.
 */
export function lastExistingRebuildIndex(items: { abs: string }[], exists: (abs: string) => boolean): number {
    let last = -1;
    for (let i = 0; i < items.length; i++) {
        if (exists(items[i].abs)) last = i;
    }
    return last;
}

export async function runReviewPr(opts: ReviewPrOptions): Promise<ReviewPrResult> {
    const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
    const env = opts.env ?? process.env;
    const repoPath = path.resolve(opts.repoPath);
    const tStart = Date.now();
    const git = opts.execGit ?? ((args: string[]) =>
        execFileSync('git', args, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }));

    const fail = (exitCode: number, error: string): ReviewPrResult => {
        log(`[review-pr] ERROR: ${error}`);
        return { ok: false, exitCode, findingsCount: 0, inlineCount: 0, outsideCount: 0, posted: false, error };
    };

    try { assertSafeRef(opts.baseRef, 'base'); if (opts.headRef) assertSafeRef(opts.headRef, 'head'); } catch (e: any) {
        return fail(2, e.message);
    }
    if (opts.post && (!opts.repoSlug || !opts.prNumber)) {
        return fail(2, '--post requires --repo <owner/repo> and --pr <number>');
    }
    const token = opts.githubToken ?? env.GITHUB_TOKEN ?? '';
    if (opts.post && !token) {
        return fail(2, '--post requires a GitHub token (GITHUB_TOKEN env or --token)');
    }

    // Fail fast on a missing LLM key BEFORE the (slow) base-checkout + init —
    // runFullReview only toasts on this, which a CI log would bury.
    const settings = createSettingsResolver({ workspaceRoot: repoPath, env: env as Record<string, string | undefined> });
    const secrets = createSecretsStore({ env: env as Record<string, string | undefined>, log });
    const provider = settings.get<string>('codeatlas.llmProvider') || 'openrouter';
    const keyOptional = provider === 'ollama' || provider === 'custom';
    if (!keyOptional && !(await secrets.get('codeatlas.openRouterApiKey'))) {
        return fail(2, `no LLM API key for provider "${provider}" — set OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY, or configure provider ollama/custom`);
    }

    let baseSha: string, headSha: string, originalRef: string;
    try {
        if (git(['status', '--porcelain']).trim() !== '') {
            return fail(2, 'working tree is dirty — review-pr checks out base/head and refuses to clobber local changes');
        }
        baseSha = git(['rev-parse', opts.baseRef]).trim();
        headSha = git(['rev-parse', opts.headRef ?? 'HEAD']).trim();
        // #941 — review the PR's OWN changes (3-dot / merge-base), not everything
        // the base branch lacks. A resolved GitHub base SHA is the base BRANCH tip,
        // which typically advanced past the PR's fork point; a 2-dot `base..head`
        // diff then sweeps in every intervening commit's files (measured: 64 files
        // vs the PR's real 10 on keycloak#36880; 82 vs 4 on #40940), flooding the
        // review with unrelated code that drowns the actual bugs. Resolving base to
        // merge-base(base,head) makes the baseline snapshot AND the changed-file
        // diff align to the PR fork point — i.e. exactly the GitHub PR `.diff`.
        // Fall back to the raw base if the merge-base can't be computed (unrelated
        // histories / shallow clone) — never worse than the prior 2-dot behavior.
        try {
            const mb = git(['merge-base', baseSha, headSha]).trim();
            if (mb) baseSha = mb;
        } catch { /* keep raw base */ }
        const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
        originalRef = branch === 'HEAD' ? git(['rev-parse', 'HEAD']).trim() : branch;
    } catch (e: any) {
        return fail(2, `git ref resolution failed: ${e.message}`);
    }
    log(`[review-pr] base=${baseSha.slice(0, 7)} head=${headSha.slice(0, 7)}`);

    // #867 — pre-init disk guard. The base checkout + state.db write are the
    // disk-heavy steps; on a near-full volume they ENOSPC mid-write and corrupt
    // the store / results. Abort cleanly BEFORE writing anything.
    const minFree = Number(env.CODEATLAS_MIN_FREE_BYTES) || MIN_FREE_BYTES;
    const free = opts.freeBytes ? opts.freeBytes() : Math.min(freeBytesAt(os.tmpdir()), freeBytesAt(repoPath));
    const disk = checkDiskSpace(free, minFree);
    if (!disk.ok) return fail(2, disk.message!);

    let pipeline: PrReviewPipeline | undefined;
    const messages: any[] = [];
    try {
        // 1. Baseline = PR base.
        // #869 — time the checkout (blob:none materialization, the network-bound
        // part) vs the init (scan/parse/build) so the wall-clock is transparent
        // and it's clear no LLM/timeout wait is involved in a dry run.
        const tCheckout = Date.now();
        git(['checkout', '--quiet', baseSha]);
        const checkoutMs = Date.now() - tCheckout;
        pipeline = await (opts.createPipeline ?? defaultCreatePipeline)(repoPath);
        const initStats = (await pipeline.initialize()) as { fileCount?: number; apiCount?: number; truncated?: boolean; totalFound?: number; parseFailures?: Record<string, number>; durations?: { scan_ms?: number; parse_ms?: number; build_ms?: number; total_ms?: number; build_phases?: { callgraph_ms?: number; services_ms?: number; communities_ms?: number; feature_ms?: number; graphs_ms?: number } } } | undefined;
        // #849 — truncation must be visible: a capped scan can miss changed
        // entry points on monorepo-scale fixtures, which skews benchmarks.
        log(`[review-pr] baseline initialized at base commit (${initStats?.fileCount ?? '?'} files, ${initStats?.apiCount ?? '?'} entry points${initStats?.truncated ? ` — TRUNCATED of ${initStats?.totalFound}; raise codeatlas.maxFiles` : ''})`);
        const d = initStats?.durations;
        const bp = d?.build_phases;
        const s = (ms?: number) => ((ms ?? 0) / 1000).toFixed(1);
        log(`[review-pr] timings: git-checkout=${s(checkoutMs)}s · init=${s(d?.total_ms)}s (scan=${s(d?.scan_ms)}s parse=${s(d?.parse_ms)}s build=${s(d?.build_ms)}s) — no LLM/timeout wait`);
        // #874 — attribute the build wall-clock to its phases so a slow init is
        // diagnosable (callgraph resolution vs Louvain clustering vs graph build)
        // instead of one opaque number.
        if (bp) log(`[review-pr] build phases: callgraph=${s(bp.callgraph_ms)}s services=${s(bp.services_ms)}s communities=${s(bp.communities_ms)}s feature=${s(bp.feature_ms)}s graphs=${s(bp.graphs_ms)}s`);
        // #875 — surface parse failures from the baseline init. A language whose
        // files all fail to parse (e.g. a missing grammar) silently yields zero
        // entry points; making the failures visible turns that into a signal.
        const pf = initStats?.parseFailures ?? {};
        const pfEntries = Object.entries(pf).filter(([, n]) => n > 0);
        if (pfEntries.length > 0) {
            log(`[review-pr] ⚠ baseline parse failures: ${pfEntries.map(([ext, n]) => `${ext}=${n}`).join(', ')} — these files contribute no entry points`);
        }

        // #853 — apply forwarded guidelines (the tmp store starts empty).
        if (opts.guidelinesText && opts.guidelinesText.trim()) {
            pipeline.store.setReviewGuidelines(opts.guidelinesText);
            log('[review-pr] applied forwarded review guidelines');
        }

        // 2. Working = PR head: resync exactly the changed files.
        git(['checkout', '--quiet', headSha]);
        const changed = git(['diff', '--name-only', `${baseSha}..${headSha}`])
            .split('\n').map((s) => s.trim()).filter(Boolean);
        log(`[review-pr] ${changed.length} changed file${changed.length === 1 ? '' : 's'}`);
        // #871 — defer the whole-workspace cascade on every file but the LAST,
        // so the expensive recompute (callgraph/clusters/L2a/L1/sequence) runs
        // ONCE instead of per-file (~12× → 1× on a multi-file PR). The final
        // non-deferred rebuild re-annotates all live graphs, so diffs stay correct.
        const rebuildable = changed.map((rel) => ({ rel, abs: path.join(repoPath, rel) }));
        // #896 — the FINAL non-deferred rebuild must land on the genuinely last
        // EXISTING changed file (by loop position), so the one full cascade
        // re-annotates every live graph. The old `existing.findIndex(e=>e.abs===abs)`
        // was O(n²) AND, on duplicate / path-normalization collisions, returned the
        // FIRST occurrence for every dupe — so the real last file got deferred and the
        // final cascade never ran (graphs left stale). Track the last existing position
        // once, by index, and compare loop index against it.
        const lastExistingPos = lastExistingRebuildIndex(rebuildable, (abs) => fs.existsSync(abs));
        for (let i = 0; i < rebuildable.length; i++) {
            const { abs } = rebuildable[i];
            if (fs.existsSync(abs)) await pipeline.rebuildFile(abs, { deferCascade: i !== lastExistingPos });
            else pipeline.handleFileDeleted(abs);
        }

        // #936 — style/template files (.scss/.css/.erb) and other non-parsed source
        // (.sh/.sql) aren't ingested by initialize() (it gates non-JS on a parser
        // language), so the BASELINE snapshot holds no content for them. Their WORKING
        // content lands via rebuildFile above, but with no baseline the diff window
        // renders them as an all-`+` NEW FILE — which hides VALUE-change bugs (a SCSS
        // color-lightness inversion is only detectable with the old value side-by-side;
        // discourse #7). Backfill the BASELINE content from the base commit (SQLite-only,
        // no in-memory FileRecord → graph builders unaffected) for exactly the changed
        // files the diff window can't otherwise resolve, so it shows `-`/`+`.
        const backfillStore = pipeline.store as SnapshotStore;
        if (typeof backfillStore.setBaselineFileContent === 'function') {
            let backfilled = 0;
            for (const rel of changed) {
                if (!SOURCE_EXT.test(rel)) continue;
                const hasBaseline = backfillStore.getFileContent?.('baseline', rel)
                    ?? (backfillStore.getBaseline?.()?.files as Record<string, { content?: string }> | undefined)?.[rel]?.content;
                if (hasBaseline) continue; // diff window already resolves a baseline → leave it
                let baseContent: string;
                try { baseContent = git(['show', `${baseSha}:${rel}`]); } catch { continue; } // absent in base = genuinely new
                backfillStore.setBaselineFileContent(rel, baseContent);
                backfilled += 1;
            }
            if (backfilled > 0) log(`[review-pr] #936 backfilled baseline content for ${backfilled} non-parsed changed file${backfilled === 1 ? '' : 's'} (style/template/script) so their diff shows -/+`);
        }

        // #875 — extraction sanity: how many entry points did the resynced
        // working snapshot actually find inside the changed files? A PR that
        // touches source files but surfaces 0 entry points is either a genuine
        // no-route change OR a silent extraction gap (missing grammar, a
        // framework/receiver pattern the detector doesn't match — e.g. the
        // observed Go = 0 case). Logging it makes "0 reviewed" diagnosable
        // instead of indistinguishable from "nothing to review".
        const changedSet = new Set(changed);
        const changedSource = changed.filter((p) => SOURCE_EXT.test(p) && fs.existsSync(path.join(repoPath, p)));
        const apiIndex = (pipeline.store as SnapshotStore).getWorking().apiIndex ?? {};
        const entryPointsInChanged = Object.values(apiIndex).filter((a) => a.filePath && changedSet.has(a.filePath)).length;
        log(`[review-pr] extraction: ${entryPointsInChanged} entry point${entryPointsInChanged === 1 ? '' : 's'} in changed files (${changedSource.length}/${changed.length} changed file${changed.length === 1 ? '' : 's'} are source)`);
        if (changedSource.length > 0 && entryPointsInChanged === 0) {
            log(`[review-pr] ⚠ 0 entry points extracted from ${changedSource.length} changed source file(s) — this PR may legitimately touch no routes, OR a parser/framework-detection gap is hiding them (check the baseline parse-failure line above)`);
        }

        // #882 — context COVERAGE: which changed source files' actual CODE reaches
        // the reviewer. Two code channels: (a) a changed file that OWNS a changed
        // entry point → its diff-windowed handler source rides a per-entry pack;
        // (b) a changed file the project pass picks (the ≤6 cross-cutting
        // auth/middleware/config infra files). A changed file in NEITHER is
        // reviewed BLIND — its code is never shown, so any bug there is unreachable
        // for the per-entry + project passes (downstream participants contribute
        // names, not source — #865). This is the completeness signal beyond the
        // entry-point count.
        const PROJECT_PASS_MAX = 6;
        const CHANGED_FILE_CAP = Number(process.env.CODEATLAS_REVIEW_CHANGED_FILE_CAP) || 150; // #921
        const entryFiles = new Set(
            Object.values(apiIndex).filter((a) => a.filePath && changedSet.has(a.filePath)).map((a) => a.filePath as string)
        );
        const infraFiles = new Set(
            selectProjectLevelFiles(pipeline.store as SnapshotStore).slice(0, PROJECT_PASS_MAX).filter((fp) => changedSet.has(fp))
        );
        // #883 — the diff-aware pass reviews uncovered changed files (windowed) up
        // to the cap, so they now reach the model too.
        const changedPassFiles = new Set(selectUncoveredChangedFiles(pipeline.store as SnapshotStore).slice(0, CHANGED_FILE_CAP));
        const inContext = (fp: string): boolean => entryFiles.has(fp) || infraFiles.has(fp) || changedPassFiles.has(fp);
        const covered = changedSource.filter(inContext);
        const uncovered = changedSource.filter((fp) => !inContext(fp));
        // #884 — split the blind tail by tier so the metric is honest: with
        // production-first ordering, the blind tail is mostly tests/UI, not logic.
        const blindProd = uncovered.filter((fp) => fileTier(fp) === 0).length;
        const blindRest = uncovered.length - blindProd;
        const uncoveredList = uncovered.length ? `: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? ` +${uncovered.length - 8} more` : ''}` : '';
        log(`[review-pr] coverage: ${covered.length}/${changedSource.length} changed source files in review context (${entryFiles.size} entry-anchored, ${changedPassFiles.size} changed-pass, ${infraFiles.size} infra) · ${uncovered.length} reviewed-blind (${blindProd} prod, ${blindRest} test/ui)${uncoveredList}`);

        // 3. Evidence-gated review over the changed scope. Quiet collector
        //    bridge — we read clientToast errors back out for CI visibility.
        const wsBridge = {
            broadcast: (m: any) => { messages.push(m); },
            sendTo: (_id: string, m: any) => { messages.push(m); },
            hasClients: () => false,
        } as unknown as AiReviewDeps['wsBridge'];
        const deps: AiReviewDeps = { snapshotStore: pipeline.store as SnapshotStore, wsBridge, settings, secrets, log, workspaceRoot: repoPath };
        await (opts.review ?? ((d: AiReviewDeps) => runFullReview(d, { kind: 'changed' })))(deps);

        const toastError = messages.find((m) => m?.type === 'clientToast' && m.level === 'error');
        if (toastError) return fail(3, `review failed: ${toastError.text}`);
        // Per-entry failures don't toast — they're captured per-entry. If
        // EVERY entry failed AND nothing else produced findings, the
        // "review" never happened; exiting 0 here would post a false "no
        // issues found" to the PR (bad key, provider down). But the
        // project-level pass can still land findings when per-entry calls
        // time out (slow local models) — those must be posted, with the
        // coverage-is-partial warning, not discarded.
        const reviewSummary = messages.find((m) => m?.type === 'aiReviewComplete')?.summary;
        // #948–#953 — deterministic FP backstop: drop findings anchored OFF the PR
        // diff (#949 — reviewing context code, the largest mechanically-removable FP
        // class), low-severity test-file nits (#951), and exact duplicates (#953),
        // before mapping to PR comments. Off-diff gate is a no-op if `changedSet` is
        // empty. Complements the prompt-level precision gates (#948/#950/#952).
        const rawOpen = pipeline.store.listAiReviewFindings({ status: 'open' } as any) as AiReviewFinding[];
        const { kept, dropped } = filterReviewFindings(rawOpen, changedSet);
        if (dropped.length) {
            const byReason = dropped.reduce<Record<string, number>>((m, d) => { m[d.reason] = (m[d.reason] ?? 0) + 1; return m; }, {});
            log(`[review-pr] #948–#953 FP filter dropped ${dropped.length} finding${dropped.length === 1 ? '' : 's'} (${Object.entries(byReason).map(([k, v]) => `${v} ${k}`).join(', ')})`);
        }
        const findings = kept.map(toPrFinding);
        if (reviewSummary && reviewSummary.totalEntryPoints > 0 && reviewSummary.reviewed === 0 && reviewSummary.failed > 0
            && findings.length === 0) {
            return fail(3, `review produced no results — all ${reviewSummary.failed} entry-point reviews failed (check the LLM key / provider / network)`);
        }

        // 4. Map findings → GitHub review payload.
        const diffText = git(['diff', `${baseSha}..${headSha}`]);
        const commentable = parseUnifiedDiff(diffText);
        const { inline, outside } = mapFindingsToPrReview(findings, commentable);
        // #853 — "What to re-test": the tmp store's working-vs-baseline IS the
        // PR diff, so the regression-scope composer runs on it directly.
        let regressionHint: string | undefined;
        // #871 — the regression-scope blast-radius BFS is slow on big graphs;
        // skip it for fast/benchmark runs (it's a non-essential "what to re-test" hint).
        if (opts.noRegression || env.CODEATLAS_REVIEW_NO_REGRESSION === '1') {
            log('[review-pr] regression-scope hint skipped (CODEATLAS_REVIEW_NO_REGRESSION)');
        } else try {
            const tRegr = Date.now();
            const scope = computeRegressionScope({
                working: pipeline.store.getWorking(),
                baseline: pipeline.store.getBaseline(),
            });
            regressionHint = renderRegressionHint(scope);
            log(`[review-pr] regression-scope computed in ${((Date.now() - tRegr) / 1000).toFixed(1)}s`);
        } catch (err: any) {
            log(`[review-pr] regression-scope hint skipped: ${err?.message ?? err}`);
        }

        // #916 — capture the coverage denominator (computed above for logging)
        // into the result so the PR summary, the CLI/MCP result, and the panel
        // all state how much of the change was actually reviewed.
        const coverage = {
            changedSourceTotal: changedSource.length,
            reviewed: covered.length,
            reviewedBlind: uncovered.length,
            blindFiles: uncovered.slice(0, 12),
        };
        const summaryBody = buildPrSummaryBody({
            inline, outside, allFindings: findings,
            meta: { headSha, entryPointsReviewed: reviewSummary?.reviewed, failedEntryPoints: reviewSummary?.failed || undefined, regressionHint, coverage },
        });

        // 5. Post or print.
        let posted = false;
        if (opts.post) {
            const target: GithubPrTarget = { repoSlug: opts.repoSlug!, prNumber: opts.prNumber!, token };
            const rev = await postReview(target, { body: summaryBody, comments: inline, commitSha: headSha }, opts.fetchImpl as any);
            if (!rev.ok) return fail(4, `GitHub review post failed (${rev.status}): ${rev.error}`);
            if (rev.droppedInline) log('[review-pr] inline anchors rejected by GitHub — posted summary-only review');
            const up = await upsertSummaryComment(target, summaryBody, opts.fetchImpl as any);
            if (!up.ok) log(`[review-pr] WARN: summary comment upsert failed (${up.status}): ${up.error}`);
            posted = true;
            log(`[review-pr] posted review with ${rev.droppedInline ? 0 : inline.length} inline comment${inline.length === 1 ? '' : 's'}`);
        } else {
            // #923 — write the result fully + synchronously to fd 1 before
            // mcp-server's process.exit() fires. A plain process.stdout.write is
            // async and gets truncated by the immediate exit; a single fs.writeSync
            // on a NON-BLOCKING pipe (Node sets piped stdout non-blocking) does ONE
            // write syscall that returns a PARTIAL count (~8 KB pipe buffer) — so we
            // must LOOP until every byte is flushed (handling partial writes +
            // EAGAIN). Only bites on large real-finding output; empty-finding
            // dry-runs fit one write and always passed.
            const payload = Buffer.from(JSON.stringify({
                summaryBody, inline, outside,
                outsideCount: outside.length, findingsCount: findings.length,
                tokensUsed: reviewSummary?.tokensUsed, model: reviewSummary?.model,
                durationMs: Date.now() - tStart,
            }, null, 2) + '\n', 'utf8');
            let wrote = 0;
            while (wrote < payload.length) {
                try { wrote += fs.writeSync(1, payload, wrote, payload.length - wrote); }
                catch (werr: any) { if (werr?.code === 'EAGAIN') continue; throw werr; }
            }
        }

        return { ok: true, exitCode: 0, findingsCount: findings.length, inlineCount: inline.length, outsideCount: outside.length, summaryBody, inline, outside, tokensUsed: reviewSummary?.tokensUsed, model: reviewSummary?.model, durationMs: Date.now() - tStart, posted, coverage };
    } catch (e: any) {
        return fail(1, e?.message ?? String(e));
    } finally {
        // #871 — the restore checkout cold-fetches `originalRef`'s tree on a
        // blob:none partial clone (~200s/PR silent hang). Skip it when the caller
        // doesn't need the repo restored (benchmark resets before each PR anyway).
        const skipRestore = opts.noRestore || env.CODEATLAS_REVIEW_NO_RESTORE === '1';
        if (!skipRestore) {
            try { git(['checkout', '--quiet', originalRef]); } catch (e: any) {
                log(`[review-pr] WARN: failed to restore ref "${originalRef}": ${e?.message ?? e}`);
            }
        }
        pipeline?.dispose();
    }
}

/** Parse `codeatlas-mcp review-pr <repoPath> --base <ref> [--head <ref>]
 *  [--repo owner/name --pr N --post] [--token t]` argv (post-subcommand). */
export function parseReviewPrArgs(argv: string[]): ReviewPrOptions | { error: string } {
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--post' || a === '--dry-run') { flags[a.slice(2)] = true; continue; }
        if (a.startsWith('--')) {
            const v = argv[i + 1];
            if (v == null || v.startsWith('--')) return { error: `flag ${a} needs a value` };
            flags[a.slice(2)] = v; i++; continue;
        }
        positional.push(a);
    }
    const repoPath = positional[0] ?? process.cwd();
    if (!flags.base || typeof flags.base !== 'string') return { error: 'required: --base <ref> (the PR base, e.g. origin/main)' };
    const prNumber = flags.pr != null ? parseInt(String(flags.pr), 10) : undefined;
    if (flags.pr != null && !Number.isFinite(prNumber)) return { error: `--pr must be a number, got "${flags.pr}"` };
    // #853 — `--guidelines <path>`: review guidelines file for CI runs.
    let guidelinesText: string | undefined;
    if (typeof flags.guidelines === 'string') {
        try { guidelinesText = fs.readFileSync(flags.guidelines, 'utf-8'); } catch {
            return { error: `--guidelines file not readable: ${flags.guidelines}` };
        }
    }
    return {
        repoPath,
        baseRef: String(flags.base),
        headRef: typeof flags.head === 'string' ? flags.head : undefined,
        repoSlug: typeof flags.repo === 'string' ? flags.repo : undefined,
        prNumber,
        post: flags.post === true,
        githubToken: typeof flags.token === 'string' ? flags.token : undefined,
        guidelinesText,
    };
}
