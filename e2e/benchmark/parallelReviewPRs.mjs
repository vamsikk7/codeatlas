#!/usr/bin/env node
/**
 * parallelReviewPRs.mjs — #922. Round-based PARALLEL PR-review runner for the
 * REAL OpenRouter run.
 *
 * Each `--round` invocation runs ONE round = the next not-yet-done PR from EACH
 * repo (so the 7 repos advance in lock-step), executed with at most
 * `concurrency` repos in flight at once (default 2 — MEMORY-SAFE; parallel
 * big-repo inits at 3–4 GB each will OOM the machine, so do NOT raise this
 * without the RAM).
 *
 * The assistant is the JUDGE: this script emits, per PR, the CodeAtlas findings
 * + the golden review comments + token usage to results/round-<N>.json. Scoring
 * (precision / recall / F1, golden-comments-matched, judge commentary) is done
 * by the orchestrator after each round, which then waits for your continue/exit.
 *
 * Config: e2e/benchmark/llm.config.json (gitignored) → { provider, apiKey, model,
 * concurrency }. Env overrides: OPENROUTER_API_KEY, CODEATLAS_LLM_MODEL,
 * CODEATLAS_LLM_PROVIDER, BENCH_CONCURRENCY.
 *
 * Usage:
 *   node e2e/benchmark/parallelReviewPRs.mjs --round     # run the next round
 *   node e2e/benchmark/parallelReviewPRs.mjs --status    # remaining PRs + tokens
 *   node e2e/benchmark/parallelReviewPRs.mjs --reset     # clear results (start over)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MCP = path.join(ROOT, 'dist', 'mcp-server.js');
const args = process.argv.slice(2);

// ── config ────────────────────────────────────────────────────────────────
const cfgPath = path.join(HERE, 'llm.config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) : {};
const CONFIG = {
    provider: process.env.CODEATLAS_LLM_PROVIDER || cfg.provider || 'openrouter',
    model: process.env.CODEATLAS_LLM_MODEL || cfg.model || 'anthropic/claude-3.7-sonnet',
    apiKey: process.env.OPENROUTER_API_KEY || cfg.apiKey || '',
    concurrency: Number(process.env.BENCH_CONCURRENCY || cfg.concurrency || 2),
    perCallMs: Number(process.env.CODEATLAS_LLM_TIMEOUT_MS) || 300_000,
    perPrMs: Number(process.env.BENCH_PR_TIMEOUT_MS) || 3_600_000,
    guidelines: process.env.CODEATLAS_GUIDELINES || path.join(HERE, 'review-guidelines.md'),
    resultsDir: process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results'),
    goldenDir: process.env.BENCH_GOLDEN_DIR || path.join(os.homedir(), 'codeatlas-martian-bench', 'offline', 'golden_comments'),
};
const OUT = path.join(CONFIG.resultsDir, 'run-openrouter.json');

if (!fs.existsSync(MCP)) { console.error('dist/mcp-server.js missing — run `npm run package`'); process.exit(2); }

// ── manifest + golden ───────────────────────────────────────────────────────
const mf = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest-resolved.json'), 'utf-8'));
const cases = mf.cases;

function loadGolden() {
    const map = {};
    if (!fs.existsSync(CONFIG.goldenDir)) return map;
    for (const f of fs.readdirSync(CONFIG.goldenDir)) {
        if (!f.endsWith('.json')) continue;
        try {
            const d = JSON.parse(fs.readFileSync(path.join(CONFIG.goldenDir, f), 'utf-8'));
            const prs = Array.isArray(d) ? d : (d.prs || d.data || [d]);
            for (const pr of prs) { if (pr.url) map[pr.url] = (pr.comments || []); }
        } catch { /* skip malformed */ }
    }
    return map;
}
const golden = loadGolden();

const byRepo = {};
for (const c of cases) (byRepo[c.repo] = byRepo[c.repo] || []).push(c);
const keyOf = (c) => c.url || `${c.repo}#${c.pr}`;
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')) : {};
const isDone = (c) => out[keyOf(c)] && (out[keyOf(c)].findings !== undefined || out[keyOf(c)].error);
const tokTotal = (t) => (t?.prompt || 0) + (t?.completion || 0);

// ── --reset / --status ──────────────────────────────────────────────────────
if (args.includes('--reset')) {
    if (fs.existsSync(OUT)) fs.rmSync(OUT);
    console.error('results/run-openrouter.json cleared. (round-*.json left in place.)');
    process.exit(0);
}
if (args.includes('--status')) {
    let cum = 0, done = 0;
    for (const k of Object.keys(out)) { cum += tokTotal(out[k].tokens); if (out[k].findings !== undefined || out[k].error) done++; }
    console.error(`done ${done}/${cases.length} · remaining ${cases.length - done} · cumulative tokens ${cum.toLocaleString()}`);
    for (const [repo, cs] of Object.entries(byRepo)) {
        const rem = cs.filter((c) => !isDone(c)).length;
        console.error(`  ${repo}: ${cs.length - rem}/${cs.length} done · ${rem} remaining`);
    }
    process.exit(0);
}

// ── work selection ──────────────────────────────────────────────────────────
if (CONFIG.provider !== 'ollama' && !CONFIG.apiKey) {
    console.error(`No API key for provider "${CONFIG.provider}". Add it to ${path.relative(ROOT, cfgPath)} (apiKey) or set OPENROUTER_API_KEY.`);
    process.exit(2);
}
// DEFAULT = single sequential PR (--next). `--round` = one-per-repo parallel.
const SINGLE = !args.includes('--round');
let work;
if (SINGLE) {
    // round-robin: the repo with the FEWEST completed PRs goes next (even spread),
    // tie-break by manifest order. ONE PR at a time — sequential, memory-safe.
    let pick = null, fewest = Infinity;
    for (const [, cs] of Object.entries(byRepo)) {
        const next = cs.find((c) => !isDone(c));
        if (!next) continue;
        const doneN = cs.filter(isDone).length;
        if (doneN < fewest) { fewest = doneN; pick = next; }
    }
    if (!pick) { console.error('ALL DONE — no remaining PRs. Use --reset to start over.'); process.exit(0); }
    work = [pick];
} else {
    work = [];
    for (const cs of Object.values(byRepo)) { const next = cs.find((c) => !isDone(c)); if (next) work.push(next); }
    if (work.length === 0) { console.error('ALL DONE — no remaining PRs. Use --reset to start over.'); process.exit(0); }
}
const round = work;

const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const env = {
    ...process.env,
    CODEATLAS_REVIEW_NO_RESTORE: '1',
    CODEATLAS_LLM_PROVIDER: CONFIG.provider,
    CODEATLAS_LLM_MODEL: CONFIG.model,
    CODEATLAS_LLM_TIMEOUT_MS: String(CONFIG.perCallMs),
    ...(CONFIG.apiKey ? { OPENROUTER_API_KEY: CONFIG.apiKey } : {}),
};
const hasGuide = fs.existsSync(CONFIG.guidelines);

function persist(r) {
    out[keyOf(r)] = r;
    fs.mkdirSync(CONFIG.resultsDir, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
}

// #922 — memory guard: the big repos (3–4 GB+ snapshot, slow init) must NEVER
// init concurrently or the machine OOMs (it has, repeatedly). A semaphore caps
// HEAVY repos at 1 in flight even when `concurrency` ≥ 2; light repos still pair.
const HEAVY = new Set(['getsentry/sentry', 'ai-code-review-evaluation/sentry-greptile', 'keycloak/keycloak', 'ai-code-review-evaluation/keycloak-greptile', 'grafana/grafana']);
let heavyInFlight = 0;
const heavyWaiters = [];
async function acquireHeavy(c) {
    if (!HEAVY.has(c.repo)) return;
    if (heavyInFlight === 0) { heavyInFlight = 1; return; }
    await new Promise((res) => heavyWaiters.push(res));
}
function releaseHeavy(c) {
    if (!HEAVY.has(c.repo)) return;
    const w = heavyWaiters.shift();
    if (w) w(); else heavyInFlight = 0;
}

async function runOne(c) {
    const dir = c.dir;
    if (!dir || !fs.existsSync(path.join(dir, '.git'))) return { repo: c.repo, pr: c.pr, url: c.url, error: `local dir missing (${dir}) — run prefetchBranches.mjs` };
    await acquireHeavy(c);
    try {
        git(['reset', '--hard', '--quiet'], dir); git(['clean', '-fdq'], dir);
        const cmd = [MCP, 'review-pr', dir, '--base', c.baseBranch || c.base, '--head', c.headBranch || c.head];
        if (hasGuide) cmd.push('--guidelines', CONFIG.guidelines);
        const t0 = Date.now();
        // #923 — capture stdout via a FILE fd, NOT a pipe. A pipe truncates the
        // child's stdout at the ~8 KB pipe buffer the moment the JSON exceeds it
        // (only on large real-finding output; empty-finding dry-runs fit one
        // buffer and always passed). A file fd is blocking + unbounded, so the
        // full JSON lands — confirmed: file-fd capture = 25 KB / 21 findings vs
        // pipe = 8 KB truncated, same review.
        fs.mkdirSync(CONFIG.resultsDir, { recursive: true });
        const outFile = path.join(CONFIG.resultsDir, `.out-${keyOf(c).replace(/[^a-z0-9]+/gi, '_')}.tmp`);
        const ofd = fs.openSync(outFile, 'w');
        const proc = await new Promise((resolve) => {
            const p = spawn('node', cmd, { env, stdio: ['ignore', ofd, 'pipe'] });
            const errC = [];
            const se = () => Buffer.concat(errC).toString('utf8');
            p.stderr.on('data', (d) => errC.push(d));
            const to = setTimeout(() => { p.kill('SIGKILL'); resolve({ status: null, stderr: se() + '\nPR_TIMEOUT' }); }, CONFIG.perPrMs);
            p.on('close', (code) => { clearTimeout(to); resolve({ status: code, stderr: se() }); });
            p.on('error', (e) => { clearTimeout(to); resolve({ status: -1, stderr: se() + '\n' + e.message }); });
        });
        try { fs.closeSync(ofd); } catch { /* already closed */ }
        const stdout = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
        try { fs.writeFileSync(path.join(CONFIG.resultsDir, `stderr-${keyOf(c).replace(/[^a-z0-9]+/gi, '_')}.log`), String(proc.stderr || '')); } catch { /* debug */ }
        if (proc.status !== 0) throw new Error(`review-pr exit ${proc.status}: ${String(proc.stderr).split('\n').filter((l) => l.includes('ERROR') || l.includes('TIMEOUT')).join(' | ').slice(0, 250)}`);
        let p;
        try { p = JSON.parse(stdout); }
        catch (pe) {
            try { fs.writeFileSync(path.join(CONFIG.resultsDir, `stdout-${keyOf(c).replace(/[^a-z0-9]+/gi, '_')}.json`), stdout); } catch { /* debug */ }
            throw new Error(`stdout JSON parse failed (${pe.message}) — raw saved to stdout-*.json (${stdout.length} bytes)`);
        }
        try { fs.rmSync(outFile); } catch { /* cleanup */ }
        return {
            repo: c.repo, pr: c.pr, url: c.url,
            goldenCount: c.golden, golden: golden[c.url] || [],
            findingsCount: p.findingsCount,
            findings: { inline: p.inline || [], outside: p.outside || [], summary: p.summaryBody || '' },
            tokens: p.tokensUsed || {},
            wallMs: Date.now() - t0,
        };
    } catch (e) {
        return { repo: c.repo, pr: c.pr, url: c.url, goldenCount: c.golden, golden: golden[c.url] || [], error: String(e.message).slice(0, 300) };
    } finally {
        releaseHeavy(c);
    }
}

// concurrency-limited execution (memory-safe worker pool)
async function runPool(items, n) {
    const results = new Array(items.length);
    let i = 0;
    async function worker() { while (i < items.length) { const idx = i++; results[idx] = await runOne(items[idx]); persist(results[idx]); console.error(`  ✓ ${results[idx].repo} #${results[idx].pr}${results[idx].error ? ' — ERR' : ` — ${results[idx].findingsCount} findings, ${tokTotal(results[idx].tokens).toLocaleString()} tok`}`); } }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return results;
}

const label = SINGLE ? 'PR' : 'ROUND';
const fileRe = SINGLE ? /^pr-\d+\.json$/ : /^round-\d+\.json$/;
const seqNum = fs.existsSync(CONFIG.resultsDir) ? fs.readdirSync(CONFIG.resultsDir).filter((f) => fileRe.test(f)).length + 1 : 1;
const fileName = SINGLE ? `pr-${seqNum}.json` : `round-${seqNum}.json`;
console.error(`\n═══ ${label} ${seqNum} — ${round.length} PR${round.length === 1 ? '' : 's'}${SINGLE ? ' (sequential, one at a time)' : ` (1 per repo · concurrency ${CONFIG.concurrency})`} · model ${CONFIG.model} ═══`);
for (const c of round) console.error(`  ${c.repo} #${c.pr} (golden=${c.golden})`);
console.error('');

const results = await runPool(round, SINGLE ? 1 : CONFIG.concurrency);
fs.mkdirSync(CONFIG.resultsDir, { recursive: true });
fs.writeFileSync(path.join(CONFIG.resultsDir, fileName), JSON.stringify(SINGLE ? results[0] : results, null, 2));

// cumulative aggregate (the assistant judges P/R/F1 + golden-matched from this file)
let rTok = 0; for (const r of results) rTok += tokTotal(r.tokens);
let cum = 0, done = 0; for (const k of Object.keys(out)) { cum += tokTotal(out[k].tokens); if (out[k].findings !== undefined || out[k].error) done++; }
console.error(`\n═══ ${label} ${seqNum} DONE → results/${fileName} ═══`);
console.error(`tokens this ${label.toLowerCase()} ${rTok.toLocaleString()} · cumulative tokens ${cum.toLocaleString()} · done ${done}/${cases.length} · remaining ${cases.length - done}`);
console.error(`JUDGE NEXT: score results/${fileName} (findings vs golden) → P/R/F1 + matched + commentary, then await continue/exit.`);
process.exit(0);
