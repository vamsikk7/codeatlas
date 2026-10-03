/**
 * reviewPrCli.test.ts — #850 (2026-06-11)
 *
 * PR review orchestrator: git choreography (base checkout → init → head
 * checkout → resync changed files → restore), findings → GitHub payload
 * mapping, post vs dry-run, and every fail-fast guard. All external effects
 * (git, pipeline, review, fetch) injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runReviewPr, parseReviewPrArgs, toPrFinding, checkDiskSpace, MIN_FREE_BYTES, lastExistingRebuildIndex, type PrReviewPipeline } from '../reviewPrCli';
import { PR_REVIEW_MARKER } from '../../core/review/prReviewPayload';

const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
 const a = 1;
+log(token);
 const b = 2;
`;

function finding(over: any = {}) {
    return {
        id: 'f1', entryPointId: 'GET:/api/user', bindings: [], severity: 'error',
        category: 'security', title: 'Token logged', body: 'Session token written to logs.',
        anchor: { filePath: 'src/auth.ts', symbol: 'login', lineStart: 2, lineEnd: 2, snippet: 'log(token);' },
        status: 'open', model: 'm', createdAt: 'now', updatedAt: 'now',
        ...over,
    };
}

/** Scripted git: records calls, answers by command shape. */
function makeGit(over: { dirty?: boolean; diff?: string; changed?: string[]; changedRaw?: string[]; mergeBase?: string; mergeBaseThrows?: boolean; showContent?: Record<string, string> } = {}) {
    const calls: string[][] = [];
    // #941 — review-pr resolves base to merge-base(base,head) (3-dot semantics).
    // Default mergeBase to BASE so pre-#941 tests (base already at the fork point)
    // are unaffected; set `mergeBase` to a distinct SHA to model an advanced base.
    const effBase = over.mergeBase ?? BASE;
    const git = (args: string[]): string => {
        calls.push(args);
        const key = args.join(' ');
        if (key === 'status --porcelain') return over.dirty ? ' M src/auth.ts' : '';
        if (key.startsWith('rev-parse --abbrev-ref')) return 'feature-branch';
        if (args[0] === 'rev-parse') return args[1] === 'origin/main' ? BASE : HEAD;
        if (args[0] === 'merge-base') { if (over.mergeBaseThrows) throw new Error('unrelated histories'); return effBase; }
        // Diff against the effective (merge-)base = the PR's own changes; against
        // the raw BASE = the polluted 2-dot set (intervening commits' files).
        if (key === `diff --name-only ${effBase}..${HEAD}`) return (over.changed ?? ['src/auth.ts']).join('\n');
        if (key === `diff --name-only ${BASE}..${HEAD}`) return (over.changedRaw ?? over.changed ?? ['src/auth.ts']).join('\n');
        if (key === `diff ${effBase}..${HEAD}`) return over.diff ?? DIFF;
        if (key === `diff ${BASE}..${HEAD}`) return over.diff ?? DIFF;
        if (args[0] === 'checkout') return '';
        // #936 — `git show <base>:<path>` backfill of non-parsed baseline content.
        if (args[0] === 'show') {
            const v = (over.showContent ?? {})[args[1]];
            if (v !== undefined) return v;
            throw new Error(`unscripted git show: ${args[1]}`);
        }
        throw new Error(`unscripted git: ${key}`);
    };
    return { git, calls };
}

function makePipeline(findings: any[] = [finding()]) {
    const events: string[] = [];
    const pipeline: PrReviewPipeline & { rebuilt: string[]; deleted: string[]; disposed: boolean; events: string[] } = {
        rebuilt: [], deleted: [], disposed: false, events,
        store: {
            listAiReviewFindings: vi.fn(() => findings),
            setReviewGuidelines: vi.fn((text: string) => { events.push(`guidelines:${text.slice(0, 20)}`); return { text, hash: 'h', updatedAt: 0 }; }),
            getWorking: vi.fn(() => ({ files: {}, apiIndex: {}, clusters: {}, graphs: {} })),
            getBaseline: vi.fn(() => ({ files: {}, apiIndex: {}, clusters: {}, graphs: {} })),
        } as any,
        initialize: vi.fn(async () => { events.push('init'); }),
        rebuildFile: vi.fn(async (abs: string) => { pipeline.rebuilt.push(abs); }),
        handleFileDeleted: vi.fn((abs: string) => { pipeline.deleted.push(abs); }),
        dispose: () => { pipeline.disposed = true; },
    };
    return pipeline;
}

let repoPath: string;
beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'review-pr-cli-'));
    fs.mkdirSync(path.join(repoPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, 'src/auth.ts'), 'const a = 1;\nlog(token);\nconst b = 2;\n');
});
afterEach(() => { fs.rmSync(repoPath, { recursive: true, force: true }); });

const ENV = { OPENROUTER_API_KEY: 'test-key' };

function baseOpts(over: any = {}) {
    const { git, calls } = makeGit(over.gitOver ?? {});
    const pipeline = makePipeline(over.findings);
    return {
        calls, pipeline,
        opts: {
            repoPath, baseRef: 'origin/main', log: () => {}, env: ENV,
            // #867 — inject ample free disk so tests don't depend on the host's
            // real free space (the production probe is fs.statfsSync).
            freeBytes: over.freeBytes ?? (() => 100 * 1024 ** 3),
            execGit: over.execGit ?? git,
            createPipeline: async () => pipeline,
            review: over.review ?? (async (deps: any) => {
                deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { reviewed: 3 } });
            }),
            ...over.opts,
        },
    };
}

describe('#941 — review-pr diffs the merge-base (3-dot), not the raw base (2-dot)', () => {
    const MB = 'm'.repeat(40);

    it('resolves base to merge-base(base,head) so an advanced base does not flood the changed-file set', async () => {
        const { opts, calls, pipeline } = baseOpts({
            gitOver: {
                mergeBase: MB,
                changed: ['src/auth.ts'],                          // 3-dot: the PR's own change
                changedRaw: ['unrelated/other.ts', 'src/auth.ts'], // 2-dot would also sweep in an intervening-commit file
            },
        });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        const keys = calls.map((c) => c.join(' '));
        // base resolved via merge-base, and the changed-file diff used it
        expect(keys).toContain(`merge-base ${BASE} ${HEAD}`);
        expect(keys).toContain(`diff --name-only ${MB}..${HEAD}`);
        // the raw 2-dot diff (which would pull in unrelated/other.ts) was NOT used
        expect(keys).not.toContain(`diff --name-only ${BASE}..${HEAD}`);
        // baseline snapshot was checked out at the merge-base, not the raw base
        expect(keys).toContain(`checkout --quiet ${MB}`);
        // only the PR's own file entered the rebuild set
        expect(pipeline.rebuilt.some((p: string) => p.endsWith('other.ts'))).toBe(false);
    });

    it('falls back to the raw base when merge-base cannot be computed (unrelated histories / shallow clone)', async () => {
        const { opts, calls } = baseOpts({ gitOver: { mergeBaseThrows: true, changed: ['src/auth.ts'] } });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        // still computed a changed-file diff against the raw base — never worse than the old 2-dot behavior
        expect(calls.map((c) => c.join(' '))).toContain(`diff --name-only ${BASE}..${HEAD}`);
    });
});

describe('#936 — backfill baseline content for non-parsed changed files', () => {
    function pipelineWithBackfill(baselineFiles: Record<string, { content: string }> = {}) {
        const calls: Array<[string, string]> = [];
        const sqliteBaseline: Record<string, string> = {};
        const p = makePipeline();
        (p.store as any).getFileContent = vi.fn((kind: string, fp: string) => (kind === 'baseline' ? sqliteBaseline[fp] : `working-${fp}`));
        (p.store as any).getBaseline = vi.fn(() => ({ files: baselineFiles, apiIndex: {}, graphs: {} }));
        (p.store as any).setBaselineFileContent = vi.fn((fp: string, content: string) => { sqliteBaseline[fp] = content; calls.push([fp, content]); });
        return { p, calls };
    }

    it('git-shows the base content of a changed .scss and backfills it (diff is not all-+ NEW FILE)', async () => {
        // src/auth.ts is a PARSED file whose in-memory baseline content is present → skipped.
        const { p, calls } = pipelineWithBackfill({ 'src/auth.ts': { content: 'const a = 1;' } });
        const { opts } = baseOpts({
            gitOver: {
                changed: ['app/styles/header.scss', 'src/auth.ts'],
                showContent: { [`${BASE}:app/styles/header.scss`]: '.x { color: scale-color($p, 30%); }' },
            },
        });
        opts.createPipeline = async () => p;
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        // ONLY the non-parsed, baseline-less .scss is backfilled (the .ts is skipped via its in-memory baseline).
        expect(calls).toEqual([['app/styles/header.scss', '.x { color: scale-color($p, 30%); }']]);
    });

    it('skips a changed style file that already has baseline content', async () => {
        const { p, calls } = pipelineWithBackfill({ 'app/a.scss': { content: 'already-here' } });
        const { opts } = baseOpts({ gitOver: { changed: ['app/a.scss'], showContent: {} } });
        opts.createPipeline = async () => p;
        await runReviewPr(opts);
        expect(calls).toEqual([]); // baseline already resolvable → no git show, no backfill
    });

    it('skips a non-source changed file (e.g. .png) — no backfill attempt', async () => {
        const { p, calls } = pipelineWithBackfill();
        const { opts } = baseOpts({ gitOver: { changed: ['assets/logo.png'], showContent: {} } });
        opts.createPipeline = async () => p;
        await runReviewPr(opts);
        expect(calls).toEqual([]); // not SOURCE_EXT → never considered
    });
});

describe('runReviewPr (#850)', () => {
    it('dry-run: base checkout → init → head checkout → resync → payload, ref restored', async () => {
        const { opts, calls, pipeline } = baseOpts();
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        expect(out.posted).toBe(false);
        expect(out.inlineCount).toBe(1);
        expect(out.inline![0]).toMatchObject({ path: 'src/auth.ts', line: 2, side: 'RIGHT' });
        expect(out.summaryBody).toContain(PR_REVIEW_MARKER);
        expect(out.summaryBody).toContain('3 entry points reviewed');
        // ordering: checkout base happens before init-driven rebuilds; head checkout before resync
        const checkouts = calls.filter((c) => c[0] === 'checkout').map((c) => c[2]);
        expect(checkouts).toEqual([BASE, HEAD, 'feature-branch']);
        expect(pipeline.initialize).toHaveBeenCalledTimes(1);
        expect(pipeline.rebuilt).toEqual([path.join(repoPath, 'src/auth.ts')]);
        expect(pipeline.disposed).toBe(true);
    });

    it('deleted files route to handleFileDeleted, not rebuildFile', async () => {
        const { opts, pipeline } = baseOpts({ gitOver: { changed: ['src/auth.ts', 'src/gone.ts'] } });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        expect(pipeline.rebuilt).toEqual([path.join(repoPath, 'src/auth.ts')]);
        expect(pipeline.deleted).toEqual([path.join(repoPath, 'src/gone.ts')]);
    });

    it('--post sends one review + upserts the marker summary comment', async () => {
        const fetchCalls: any[] = [];
        const fetchImpl = vi.fn(async (url: string, init: any) => {
            fetchCalls.push({ url, init });
            if (url.includes('/issues/') && (!init || init.method == null)) return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
            return { ok: true, status: 201, json: async () => ({}), text: async () => '{}' };
        });
        const { opts } = baseOpts({ opts: { post: true, repoSlug: 'acme/widgets', prNumber: 7, githubToken: 'tok', fetchImpl } });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        expect(out.posted).toBe(true);
        const reviewCall = fetchCalls.find((c) => c.url.includes('/pulls/7/reviews'));
        expect(reviewCall).toBeDefined();
        const sent = JSON.parse(reviewCall.init.body);
        expect(sent.commit_id).toBe(HEAD);
        expect(sent.comments).toHaveLength(1);
        expect(sent.body).toContain(PR_REVIEW_MARKER);
        expect(fetchCalls.some((c) => c.url.includes('/issues/7/comments'))).toBe(true);
    });

    it('fails fast (exit 2) on dirty working tree without touching refs', async () => {
        const { opts, calls } = baseOpts({ gitOver: { dirty: true } });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(false);
        expect(out.exitCode).toBe(2);
        expect(out.error).toContain('dirty');
        expect(calls.some((c) => c[0] === 'checkout' && c[2] !== 'feature-branch')).toBe(false);
    });

    it('fails fast (exit 2) when no LLM key is available', async () => {
        const { opts } = baseOpts({ opts: { env: {} } });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(false);
        expect(out.exitCode).toBe(2);
        expect(out.error).toContain('API key');
    });

    it('fails (exit 2) when --post lacks repo/pr/token', async () => {
        const a = await runReviewPr(baseOpts({ opts: { post: true } }).opts);
        expect(a.exitCode).toBe(2);
        const b = await runReviewPr(baseOpts({ opts: { post: true, repoSlug: 'a/b', prNumber: 1, env: { ...ENV } } }).opts);
        expect(b.exitCode).toBe(2);
        expect(b.error).toContain('token');
    });

    it('exits 3 when every entry-point review failed AND no findings exist — never a false "no issues"', async () => {
        const { opts } = baseOpts({
            findings: [],
            review: async (deps: any) => {
                deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { totalEntryPoints: 4, reviewed: 0, failed: 4, findingsCount: 0 } });
            },
        });
        const out = await runReviewPr(opts);
        expect(out.exitCode).toBe(3);
        expect(out.error).toContain('all 4 entry-point reviews failed');
    });

    it('all entries failed but project-level findings exist → posts them with the partial-coverage flag', async () => {
        // Slow local models time out per-entry while the project pass still
        // lands findings — those must not be discarded (live ollama repro).
        const { opts } = baseOpts({
            review: async (deps: any) => {
                deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { totalEntryPoints: 2, reviewed: 0, failed: 2, findingsCount: 1 } });
            },
        });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        expect(out.findingsCount).toBe(1);
        expect(out.summaryBody).toContain('2 entry points could not be reviewed');
    });

    it('partial failures stay non-fatal but are flagged in the summary body', async () => {
        const { opts } = baseOpts({
            review: async (deps: any) => {
                deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { totalEntryPoints: 4, reviewed: 3, failed: 1, findingsCount: 1 } });
            },
        });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        expect(out.summaryBody).toContain('1 entry point could not be reviewed');
        expect(out.summaryBody).toContain('coverage is partial');
    });

    it('surfaces review-level toast errors as exit 3 and still restores the ref', async () => {
        const { opts, calls } = baseOpts({
            review: async (deps: any) => { deps.wsBridge.broadcast({ type: 'clientToast', level: 'error', text: 'Full review failed: boom' }); },
        });
        const out = await runReviewPr(opts);
        expect(out.exitCode).toBe(3);
        expect(out.error).toContain('boom');
        const checkouts = calls.filter((c) => c[0] === 'checkout').map((c) => c[2]);
        expect(checkouts[checkouts.length - 1]).toBe('feature-branch');
    });

    it('GitHub post failure is exit 4 with status + body, ref restored', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => '{"message":"forbidden"}' }));
        const { opts, calls } = baseOpts({ opts: { post: true, repoSlug: 'a/b', prNumber: 1, githubToken: 't', fetchImpl } });
        const out = await runReviewPr(opts);
        expect(out.exitCode).toBe(4);
        expect(out.error).toContain('403');
        const checkouts = calls.filter((c) => c[0] === 'checkout').map((c) => c[2]);
        expect(checkouts[checkouts.length - 1]).toBe('feature-branch');
    });

    it('forwarded guidelines are seeded into the pipeline store before the review runs (#853)', async () => {
        const { opts, pipeline } = baseOpts({
            opts: { guidelinesText: 'Focus on auth and secrets handling.' },
            review: async (deps: any) => {
                (pipeline as any).events.push('review');
                deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { reviewed: 1 } });
            },
        });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        const ev = (pipeline as any).events;
        expect(ev.find((e: string) => e.startsWith('guidelines:'))).toContain('Focus on auth');
        expect(ev.indexOf(ev.find((e: string) => e.startsWith('guidelines:')))).toBeLessThan(ev.indexOf('review'));
        expect(pipeline.store.setReviewGuidelines).toHaveBeenCalledTimes(1);
    });

    it('no guidelines → store untouched; empty regression scope → no re-test section', async () => {
        const { opts, pipeline } = baseOpts();
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(true);
        expect(pipeline.store.setReviewGuidelines).not.toHaveBeenCalled();
        expect(out.summaryBody).not.toContain('What to re-test');
    });

    it('rejects refs that look like git options', async () => {
        const { opts } = baseOpts({ opts: { baseRef: '--upload-pack=evil' } });
        const out = await runReviewPr(opts);
        expect(out.exitCode).toBe(2);
        expect(out.error).toContain('invalid base ref');
    });
});

describe('#875 — extraction + parse-failure transparency', () => {
    function withLog(over: any = {}) {
        const lines: string[] = [];
        const b = baseOpts(over);
        b.opts.log = (m: string) => lines.push(m);
        return { ...b, lines };
    }

    it('logs an extraction summary for the resynced changed files', async () => {
        const { opts, lines } = withLog();
        await runReviewPr(opts);
        expect(lines.some((l) => /\[review-pr\] extraction: \d+ entry point/.test(l))).toBe(true);
    });

    it('warns when changed source files yield 0 entry points (the silent Go=0 signal)', async () => {
        // Default mock: empty apiIndex + one changed `.ts` → 0 entry points.
        const { opts, lines } = withLog();
        await runReviewPr(opts);
        expect(lines.some((l) => l.includes('⚠') && l.includes('0 entry points extracted from'))).toBe(true);
    });

    it('does NOT warn when a changed source file carries an entry point', async () => {
        const { opts, pipeline, lines } = withLog();
        (pipeline.store.getWorking as any).mockReturnValue({
            files: {}, clusters: {}, graphs: {},
            apiIndex: { a1: { method: 'GET', route: '/x', handlerName: 'h', filePath: 'src/auth.ts' } },
        });
        await runReviewPr(opts);
        expect(lines.some((l) => l.includes('1 entry point in changed files'))).toBe(true);
        expect(lines.some((l) => l.includes('0 entry points extracted from'))).toBe(false);
    });

    it('surfaces baseline parse failures + per-phase build timings from init (#874/#875)', async () => {
        const { opts, pipeline, lines } = withLog();
        (pipeline.initialize as any).mockImplementation(async () => ({
            fileCount: 200, apiCount: 5, truncated: false, totalFound: 200,
            parseFailures: { go: 12, rb: 4 },
            durations: {
                total_ms: 9000, scan_ms: 1000, parse_ms: 3000, build_ms: 5000,
                build_phases: { callgraph_ms: 1000, services_ms: 500, communities_ms: 3000, feature_ms: 300, graphs_ms: 200 },
            },
        }));
        await runReviewPr(opts);
        expect(lines.some((l) => l.includes('baseline parse failures') && l.includes('go=12'))).toBe(true);
        expect(lines.some((l) => l.includes('build phases:') && l.includes('communities=3.0s'))).toBe(true);
    });
});

describe('toPrFinding (#850)', () => {
    it('maps anchor line/snippet into the evidence the payload mapper reads', () => {
        const f = toPrFinding(finding() as any);
        expect(f.evidence).toMatchObject({ filePath: 'src/auth.ts', lineStart: 2, snippet: 'log(token);' });
        expect(f.anchor).toMatchObject({ filePath: 'src/auth.ts', symbol: 'login' });
    });
    it('tolerates findings without an anchor', () => {
        const f = toPrFinding(finding({ anchor: undefined }) as any);
        expect(f.evidence).toBeUndefined();
    });
});

describe('parseReviewPrArgs (#850)', () => {
    it('parses the full flag set', () => {
        const out = parseReviewPrArgs(['/repo', '--base', 'origin/main', '--head', 'abc', '--repo', 'a/b', '--pr', '12', '--post', '--token', 't']) as any;
        expect(out).toMatchObject({ repoPath: '/repo', baseRef: 'origin/main', headRef: 'abc', repoSlug: 'a/b', prNumber: 12, post: true, githubToken: 't' });
    });
    it('requires --base', () => {
        expect((parseReviewPrArgs(['/repo']) as any).error).toContain('--base');
    });
    it('--guidelines reads the file or errors clearly (#853)', () => {
        const f = path.join(os.tmpdir(), `guidelines-${process.pid}.md`);
        fs.writeFileSync(f, 'Be strict about SQL.');
        const ok = parseReviewPrArgs(['--base', 'm', '--guidelines', f]) as any;
        expect(ok.guidelinesText).toBe('Be strict about SQL.');
        fs.rmSync(f);
        const bad = parseReviewPrArgs(['--base', 'm', '--guidelines', '/no/such/file.md']) as any;
        expect(bad.error).toContain('not readable');
    });
    it('rejects non-numeric --pr and dangling flags', () => {
        expect((parseReviewPrArgs(['--base', 'm', '--pr', 'x']) as any).error).toContain('--pr');
        expect((parseReviewPrArgs(['--base']) as any).error).toContain('needs a value');
    });
});

describe('#867 disk-space guard', () => {
    it('checkDiskSpace: ok at/above the threshold', () => {
        expect(checkDiskSpace(MIN_FREE_BYTES, MIN_FREE_BYTES).ok).toBe(true);
        expect(checkDiskSpace(10 * 1024 ** 3, MIN_FREE_BYTES).ok).toBe(true);
    });
    it('checkDiskSpace: not-ok + actionable message below the threshold', () => {
        const r = checkDiskSpace(0.5 * 1024 ** 3, MIN_FREE_BYTES);
        expect(r.ok).toBe(false);
        expect(r.message).toContain('GB free');
        expect(r.message).toContain('Free disk space');
    });
    it('runReviewPr aborts (exit 2) BEFORE init when free disk is below the threshold', async () => {
        const { opts, pipeline } = baseOpts({ freeBytes: () => 50 * 1024 ** 2 /* 50 MB */ });
        const out = await runReviewPr(opts);
        expect(out.ok).toBe(false);
        expect(out.exitCode).toBe(2);
        expect(out.error).toContain('GB free');
        // Guard fired before the pipeline did any work.
        expect(pipeline.initialize).not.toHaveBeenCalled();
    });
});

describe('#896 — lastExistingRebuildIndex (final non-deferred cascade target)', () => {
    const exists = (s: Set<string>) => (abs: string) => s.has(abs);

    it('returns the loop index of the last existing file', () => {
        const items = [{ abs: 'a' }, { abs: 'b' }, { abs: 'c' }];
        expect(lastExistingRebuildIndex(items, exists(new Set(['a', 'b', 'c'])))).toBe(2);
    });

    it('ignores a trailing deleted file — the cascade lands on the last EXISTING one', () => {
        const items = [{ abs: 'a' }, { abs: 'b' }, { abs: 'gone' }];
        // 'gone' does not exist (deleted in the PR) → last existing is index 1.
        expect(lastExistingRebuildIndex(items, exists(new Set(['a', 'b'])))).toBe(1);
    });

    it('on a duplicate path, picks the LATER occurrence (old findIndex picked the first for both → deferred all)', () => {
        // a appears twice; both exist; trailing 'del' is removed.
        const items = [{ abs: 'a' }, { abs: 'a' }, { abs: 'b' }, { abs: 'del' }];
        const idx = lastExistingRebuildIndex(items, exists(new Set(['a', 'b'])));
        expect(idx).toBe(2); // 'b' is the genuine last existing file
        // exactly one index is the non-deferred target — the others all defer.
        const deferFlags = items.map((_, i) => i !== idx);
        expect(deferFlags.filter((d) => !d)).toHaveLength(1);
        expect(deferFlags[2]).toBe(false);
    });

    it('returns -1 when every changed file was deleted (no rebuild, no cascade needed)', () => {
        const items = [{ abs: 'x' }, { abs: 'y' }];
        expect(lastExistingRebuildIndex(items, exists(new Set()))).toBe(-1);
    });
});
