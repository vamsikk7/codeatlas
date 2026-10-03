#!/usr/bin/env node
/**
 * runCodeatlasArm.mjs — #849 (2026-06-12).
 *
 * The "LLM + CodeAtlas" benchmark arm. For each case in results/cases.json:
 *   1. ensure a cached shallow clone with the PR's base+head fetched,
 *   2. run `codeatlas-mcp review-pr` (dry-run) — init at base, resync the
 *      PR's changed files, evidence-gated review, graph-derived summary,
 *   3. map the dry-run JSON to the Martian benchmark's review-comment shape
 *      ({path, line, body}; the summary becomes one general comment),
 *   4. record token usage + wall-clock per review.
 *
 * Output: results/codeatlas_reviews.json — merge into the benchmark's
 * benchmark_data.json with mergeIntoBenchmarkData.mjs, then run the Martian
 * steps 2→5 (extract / dedup / judge / export) unchanged.
 *
 * Usage:
 *   OPENROUTER_API_KEY=… [CODEATLAS_LLM_MODEL=…] node e2e/benchmark/runCodeatlasArm.mjs
 *     [--limit N] [--case <pr-url-substring>] [--runs N (default 1)]
 *     [--repos-dir e2e/benchmark/repos]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// BENCH_RESULTS_DIR override — keep run outputs out of the repo (e.g. /tmp) for pre-publish review.
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results');
const CASES_PATH = path.join(RESULTS_DIR, 'cases.json');
const OUT_PATH = path.join(RESULTS_DIR, 'codeatlas_reviews.json');
const MCP_SERVER = path.join(ROOT, 'dist', 'mcp-server.js');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const CASE_FILTER = flag('case', '');
const RUNS = Math.max(1, parseInt(flag('runs', '1'), 10) || 1);
const REPOS_DIR = path.resolve(flag('repos-dir', path.join(HERE, 'repos')));

if (!fs.existsSync(CASES_PATH)) {
    console.error('results/cases.json missing — run fetchCorpus.mjs first.');
    process.exit(2);
}
if (!fs.existsSync(MCP_SERVER)) {
    console.error(`dist/mcp-server.js missing — run \`node esbuild.js\` first.`);
    process.exit(2);
}

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Shallow clone cached per repo; base+head fetched per case (idempotent). */
function ensureClone(c) {
    const dir = path.join(REPOS_DIR, c.repoSlug.replace('/', '__'));
    if (!fs.existsSync(path.join(dir, '.git'))) {
        console.error(`  cloning ${c.repoSlug} (shallow)…`);
        fs.mkdirSync(REPOS_DIR, { recursive: true });
        git(['clone', '--quiet', '--filter=blob:none', '--no-checkout',
            `https://github.com/${c.repoSlug}.git`, dir], REPOS_DIR);
    }
    // Fetch exactly this PR's endpoints. `--depth 1` per sha keeps it cheap;
    // review-pr only needs the two trees + the diff between them.
    git(['fetch', '--quiet', 'origin', c.baseSha, c.headSha], dir);
    git(['checkout', '--quiet', c.headSha], dir);
    return dir;
}

const cases = Object.values(JSON.parse(fs.readFileSync(CASES_PATH, 'utf-8')))
    .filter((c) => c.baseSha && c.headSha)
    .filter((c) => !CASE_FILTER || c.url.includes(CASE_FILTER));
const selected = LIMIT > 0 ? cases.slice(0, LIMIT) : cases;

const out = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8')) : {};
let done = 0, failed = 0;

for (const c of selected) {
    for (let run = 1; run <= RUNS; run++) {
        const key = RUNS > 1 ? `${c.url}#run${run}` : c.url;
        if (out[key]?.review_comments) { console.error(`cached: ${key}`); continue; }
        console.error(`\n=== ${c.repoSlug}#${c.prNumber} (run ${run}/${RUNS}) — ${c.prTitle}`);
        try {
            const dir = ensureClone(c);
            const t0 = Date.now();
            const proc = spawnSync('node', [
                MCP_SERVER, 'review-pr', dir,
                '--base', c.baseSha, '--head', c.headSha,
            ], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, env: process.env, timeout: Number(process.env.BENCH_PR_TIMEOUT_MS) || 120 * 60_000 });
            const wallMs = Date.now() - t0;
            if (proc.status !== 0) {
                throw new Error(`review-pr exit ${proc.status}: ${String(proc.stderr).split('\n').filter((l) => l.includes('ERROR')).join(' | ').slice(0, 300)}`);
            }
            // stdout = the dry-run JSON (single object).
            const payload = JSON.parse(proc.stdout);
            const review_comments = [
                ...(payload.inline ?? []).map((i) => ({ path: i.path, line: i.line, body: i.body })),
                // Summary (incl. outside-diff findings + What to re-test) as
                // one general comment — the benchmark's step 2 extracts
                // individual issues from general comments via its LLM.
                { path: null, line: null, body: payload.summaryBody ?? '' },
            ];
            out[key] = {
                tool: 'codeatlas',
                url: c.url,
                repoSlug: c.repoSlug,
                prNumber: c.prNumber,
                run,
                review_comments,
                meter: {
                    tokensUsed: payload.tokensUsed ?? null,
                    model: payload.model ?? process.env.CODEATLAS_LLM_MODEL ?? null,
                    reviewDurationMs: payload.durationMs ?? null,
                    wallClockMs: wallMs,
                    findingsCount: payload.findingsCount,
                    inlineCount: (payload.inline ?? []).length,
                },
            };
            done++;
            console.error(`  ok: ${payload.findingsCount} findings, ${(payload.tokensUsed?.prompt ?? 0) + (payload.tokensUsed?.completion ?? 0)} tokens, ${Math.round(wallMs / 1000)}s`);
        } catch (err) {
            failed++;
            out[key] = { tool: 'codeatlas', url: c.url, run, error: String(err.message).slice(0, 500) };
            console.error(`  FAILED: ${err.message}`);
        }
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
        fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
    }
}

console.error(`\ncodeatlas arm: ${done} reviewed, ${failed} failed → ${OUT_PATH}`);
process.exit(failed > 0 ? 1 : 0);
