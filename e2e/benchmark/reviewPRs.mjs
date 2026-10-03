#!/usr/bin/env node
/**
 * reviewPRs.mjs — #868. Single-command CodeAtlas PR-review pipeline.
 *
 * Reads a manifest of repos+PRs, downloads each repo + PR diff, builds the
 * baseline→head CodeAtlas snapshot, runs the 6-layer graph-context review with
 * the nominal guidelines pack, against ANY provider/model, SEQUENTIALLY.
 * No GitHub publish (review-pr dry-run). Local default needs no key.
 * Raw findings are written PER-RUN to results/run-<model>.json so different
 * models/runs never clobber each other.
 *
 * Config: edit CONFIG below or set env. Default = local ollama (no key).
 * Frontier model: set CODEATLAS_LLM_PROVIDER + CODEATLAS_LLM_MODEL + a key —
 * nothing else changes.
 *
 * Usage:
 *   node e2e/benchmark/reviewPRs.mjs                        # local default, manifest.json
 *   CODEATLAS_LLM_MODEL=igorls/gemma-4-12B-it-heretic-GGUF:latest \
 *     CODEATLAS_LLM_TIMEOUT_MS=480000 node e2e/benchmark/reviewPRs.mjs
 *   CODEATLAS_LLM_PROVIDER=openrouter CODEATLAS_LLM_MODEL=anthropic/claude-3.7-sonnet \
 *     OPENROUTER_API_KEY=sk-... node e2e/benchmark/reviewPRs.mjs
 *   node e2e/benchmark/reviewPRs.mjs --pr calcom/cal.com#8087 --limit 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MCP = path.join(ROOT, 'dist', 'mcp-server.js');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const flagAll = (n) => args.reduce((a, v, i) => (v === '--' + n && args[i + 1] ? [...a, args[i + 1]] : a), []);

// ── CONFIG — local default; drop in OpenRouter for frontier models ────────────
// #939 — read e2e/benchmark/llm.config.json (gitignored: { provider, apiKey, model,
// endpoint?, reasoning?, concurrency? }) so the key/model live in one file like the
// parallel runner. Precedence: env var > llm.config.json > built-in default.
const llmCfgPath = path.join(HERE, 'llm.config.json');
const llmCfg = fs.existsSync(llmCfgPath) ? JSON.parse(fs.readFileSync(llmCfgPath, 'utf-8')) : {};
const CONFIG = {
    provider: process.env.CODEATLAS_LLM_PROVIDER || llmCfg.provider || 'ollama',
    model: process.env.CODEATLAS_LLM_MODEL || llmCfg.model || 'deepseek-coder:6.7b',
    endpoint: process.env.CODEATLAS_LLM_ENDPOINT || llmCfg.endpoint || '',   // provider=custom: full chat-completions URL
    apiKey: process.env.OPENROUTER_API_KEY || process.env.CODEATLAS_LLM_API_KEY || llmCfg.apiKey || '', // local needs none
    reasoning: process.env.CODEATLAS_LLM_REASONING_EFFORT || llmCfg.reasoning || '', // #939 reasoning effort
    perCallMs: Number(process.env.CODEATLAS_LLM_TIMEOUT_MS) || 120_000,
    perPrMs: Number(process.env.BENCH_PR_TIMEOUT_MS) || 3_600_000,
    singleCall: process.env.CODEATLAS_REVIEW_SINGLE_CALL === '1',
    guidelines: process.env.CODEATLAS_GUIDELINES || path.join(HERE, 'review-guidelines.md'),
    reposDir: process.env.BENCH_REPOS_DIR || path.join(HERE, 'repos'),
    resultsDir: process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results'),
};

const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const slug = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
const OUT = path.join(CONFIG.resultsDir, `run-${slug(CONFIG.model)}.json`);

// #876 — parse the review-pr stderr context signals (baseline size, per-phase
// build timing, the changed-file extraction summary, parse failures) so a
// dry-run report can answer "is CodeAtlas setting the RIGHT data into context
// per PR?" — not just the token count.
function parseContext(stderr) {
    const s = String(stderr || '');
    const m = (re) => (s.match(re) || []);
    const base = m(/baseline initialized at base commit \((\d+) files, (\d+|\?) entry points/);
    const ext = m(/extraction: (\d+) entry points? in changed files \((\d+)\/(\d+) changed files? are source\)/);
    const cov = m(/coverage: (\d+)\/(\d+) changed source files in review context \((\d+) entry-anchored, (\d+) changed-pass, (\d+) infra\) · (\d+) reviewed-blind(?:\s*\((\d+) prod, (\d+) test\/ui\))?(?::\s*([^\n]*))?/);
    const tim = m(/init=([\d.]+)s \(scan=([\d.]+)s parse=([\d.]+)s build=([\d.]+)s\)/);
    const ph = m(/build phases: callgraph=([\d.]+)s services=([\d.]+)s communities=([\d.]+)s feature=([\d.]+)s graphs=([\d.]+)s/);
    const pf = m(/baseline parse failures: ([^\n—]+)/);
    return {
        baseFiles: base[1] ? Number(base[1]) : null,
        baseEntryPoints: base[2] && base[2] !== '?' ? Number(base[2]) : null,
        changedTotal: ext[3] ? Number(ext[3]) : null,
        changedSource: ext[2] ? Number(ext[2]) : null,
        entryPointsInChanged: ext[1] ? Number(ext[1]) : null,
        extractionGap: /⚠ 0 entry points extracted/.test(s),
        covInContext: cov[1] ? Number(cov[1]) : null,
        covTotal: cov[2] ? Number(cov[2]) : null,
        covEntryAnchored: cov[3] ? Number(cov[3]) : null,
        covChangedPass: cov[4] ? Number(cov[4]) : null,
        covInfra: cov[5] ? Number(cov[5]) : null,
        covBlind: cov[6] ? Number(cov[6]) : null,
        covBlindProd: cov[7] ? Number(cov[7]) : null,
        covBlindRest: cov[8] ? Number(cov[8]) : null,
        covBlindFiles: cov[9] ? cov[9].trim() : null,
        initS: tim[1] ? Number(tim[1]) : null,
        scanS: tim[2] ? Number(tim[2]) : null,
        parseS: tim[3] ? Number(tim[3]) : null,
        buildS: tim[4] ? Number(tim[4]) : null,
        phases: ph[1] ? { callgraph: +ph[1], services: +ph[2], communities: +ph[3], feature: +ph[4], graphs: +ph[5] } : null,
        parseFailures: pf[1] ? pf[1].trim() : null,
    };
}

function loadPRs() {
    const prFlags = flagAll('pr');
    if (prFlags.length) return prFlags.map((s) => { const [repo, pr] = s.split('#'); return { repo, pr: Number(pr) }; });
    // #870 — prefer the prefetched local manifest (SHAs + local dir + ready branches).
    const resolvedMf = path.join(HERE, 'manifest-resolved.json');
    const mf = flag('manifest', fs.existsSync(resolvedMf) ? resolvedMf : path.join(HERE, 'manifest.json'));
    const cs = flag('cases', path.join(CONFIG.resultsDir, 'cases.json'));
    if (fs.existsSync(mf)) return JSON.parse(fs.readFileSync(mf, 'utf-8')).cases;
    if (fs.existsSync(cs)) return Object.values(JSON.parse(fs.readFileSync(cs, 'utf-8'))).map((c) => ({ repo: c.repoSlug, base: c.baseSha, head: c.headSha, url: c.url, title: c.prTitle, golden: c.goldenCount }));
    console.error('no --pr, manifest.json, or cases.json — run buildManifest.mjs first');
    process.exit(2);
}

async function resolveDiff(it) {
    if (it.base && it.head) return it; // SHAs already in the manifest/cases — no API call
    const token = process.env.GITHUB_TOKEN || '';
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            const res = await fetch(`https://api.github.com/repos/${it.repo}/pulls/${it.pr}`, {
                headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codeatlas-review', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            });
            if (!res.ok) throw new Error(`GitHub ${it.repo}#${it.pr} → ${res.status}`);
            const m = await res.json();
            return { ...it, base: m.base?.sha, head: m.head?.sha, title: it.title || m.title };
        } catch (e) {
            lastErr = e;
            if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt)); // backoff on transient fetch failures
        }
    }
    throw lastErr;
}

const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
function ensureClone(repo) {
    const dir = path.join(CONFIG.reposDir, repo.replace('/', '__'));
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(CONFIG.reposDir, { recursive: true });
        console.error(`  cloning ${repo}…`);
        git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}.git`, dir], CONFIG.reposDir);
    }
    return dir;
}

if (!fs.existsSync(MCP)) { console.error('dist/mcp-server.js missing — run `node esbuild.js`'); process.exit(2); }
const hasGuide = fs.existsSync(CONFIG.guidelines);
const env = {
    ...process.env,
    CODEATLAS_REVIEW_NO_RESTORE: '1', // #871 — skip the ~200s restore cold-fetch; we reset before each PR
    CODEATLAS_LLM_PROVIDER: CONFIG.provider, CODEATLAS_LLM_MODEL: CONFIG.model, CODEATLAS_LLM_TIMEOUT_MS: String(CONFIG.perCallMs),
    ...(CONFIG.endpoint ? { CODEATLAS_LLM_ENDPOINT: CONFIG.endpoint } : {}),
    ...(CONFIG.apiKey ? { OPENROUTER_API_KEY: CONFIG.apiKey } : {}),
    ...(CONFIG.reasoning ? { CODEATLAS_LLM_REASONING_EFFORT: CONFIG.reasoning } : {}), // #939
    ...(CONFIG.singleCall ? { CODEATLAS_REVIEW_SINGLE_CALL: '1' } : {}),
};

console.error(`provider=${CONFIG.provider} model=${CONFIG.model}${CONFIG.singleCall ? ' single-call' : ' per-entry'} guidelines=${hasGuide ? path.basename(CONFIG.guidelines) : 'NONE'} → ${path.basename(OUT)} (sequential, no publish)`);

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')) : {};
let list = loadPRs();
const repoFilter = flag('repo', '');           // #869 — run a single repo (per-repo progress reporting)
if (repoFilter) list = list.filter((c) => c.repo === repoFilter);
if (LIMIT > 0) list = list.slice(0, LIMIT);
let done = 0, failed = 0;
for (const raw of list) {
    let it;
    try { it = await resolveDiff(raw); } catch (e) { console.error(`resolve failed ${raw.repo}#${raw.pr}: ${e.message}`); failed++; continue; }
    const key = it.url || `${it.repo}#${it.pr}`;
    // #930 — slug(key) truncates at 60 chars, so long org/repo names (e.g.
    // ai-code-review-evaluation/discourse-graphite) push `/pull/N` past the cut
    // and every PR collides onto ONE dump/stderr filename, clobbering all but the
    // last. Discriminate by the PR number (or head sha) so per-PR captures survive.
    const fileSlug = `${slug(key).slice(0, 44)}_pr${it.pr ?? (it.head || '').slice(0, 7)}`;
    if (out[key]?.summaryBody || out[key]?.error) { console.error(`cached: ${key}`); continue; }
    console.error(`\n=== ${it.repo} ${it.pr ? '#' + it.pr : (it.head || '').slice(0, 7)} — ${it.title || ''}`);
    try {
        // #870 — when prefetched (local manifest), use the local dir + ready
        // branches and SKIP clone/fetch entirely (commits are already materialized).
        const dir = it.dir && fs.existsSync(path.join(it.dir, '.git')) ? it.dir : ensureClone(it.repo);
        const prefetched = it.baseBranch && it.headBranch;
        if (!prefetched) git(['fetch', '--quiet', 'origin', it.base, it.head], dir);
        git(['reset', '--hard', '--quiet'], dir); git(['clean', '-fdq'], dir);
        const baseRef = it.baseBranch || it.base, headRef = it.headBranch || it.head;
        const cmd = [MCP, 'review-pr', dir, '--base', baseRef, '--head', headRef];
        if (hasGuide) cmd.push('--guidelines', CONFIG.guidelines);
        const t0 = Date.now();
        // Eval: when dry-running, dump the exact per-PR LLM input to a .jsonl the
        // oracle reviewer reads from (one line per entry/project call).
        let prEnv = env;
        if (process.env.CODEATLAS_REVIEW_DRY_RUN === '1') {
            const dumpFile = path.join(CONFIG.resultsDir, 'dumps', `${fileSlug}.jsonl`);
            fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
            try { fs.rmSync(dumpFile, { force: true }); } catch { /* fresh per run */ }
            // #940 — tag each dumped call with repo/pr so the consolidated all-calls.json
            // is self-describing and replayable to any model without re-running CodeAtlas.
            prEnv = { ...env, CODEATLAS_DRY_DUMP_FILE: dumpFile, CODEATLAS_DRY_REPO: it.repo, CODEATLAS_DRY_PR: String(it.pr ?? (it.head || '').slice(0, 7)) };
        }
        const proc = spawnSync('node', cmd, { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, env: prEnv, timeout: CONFIG.perPrMs });
        // #876 — persist EACH PR's stderr (not just the last) so the context
        // signals are inspectable per PR.
        const stderrDir = path.join(CONFIG.resultsDir, 'stderr');
        try { fs.mkdirSync(stderrDir, { recursive: true }); fs.writeFileSync(path.join(stderrDir, `${fileSlug}.log`), `# ${cmd.join(' ')}\n` + String(proc.stderr || '')); } catch { /* debug */ }
        try { fs.writeFileSync(path.join(CONFIG.resultsDir, 'last-reviewpr-stderr.log'), `# ${cmd.join(' ')}\n` + String(proc.stderr || '')); } catch { /* debug */ }
        if (proc.status !== 0) throw new Error(`review-pr exit ${proc.status}: ${String(proc.stderr).split('\n').filter((l) => l.includes('ERROR')).join(' | ').slice(0, 300)}`);
        const p = JSON.parse(proc.stdout);
        const ctx = parseContext(proc.stderr);
        out[key] = {
            repo: it.repo, pr: it.pr, base: it.base, head: it.head, provider: CONFIG.provider, model: CONFIG.model, golden: it.golden,
            findingsCount: p.findingsCount, inline: p.inline, outside: p.outside, summaryBody: p.summaryBody,
            context: ctx, // #876 — per-PR context-quality signals
            // mirror the benchmark runner's meter shape so compareResults reads either file
            meter: { findingsCount: p.findingsCount, inlineCount: (p.inline || []).length, tokensUsed: p.tokensUsed, reviewDurationMs: p.durationMs, wallClockMs: Date.now() - t0 },
        };
        done++;
        const tu = p.tokensUsed || {};
        console.error(`  ok: ${p.findingsCount} findings · ${(tu.byPass?.entry?.calls || 0)}e+${(tu.byPass?.project?.calls || 0)}p calls · ${(tu.prompt || 0).toLocaleString()} input tok · ${ctx.entryPointsInChanged ?? '?'}/${ctx.changedSource ?? '?'} entry-pts · cov ${ctx.covInContext ?? '?'}/${ctx.covTotal ?? '?'} (${ctx.covBlind ?? '?'} blind)${ctx.extractionGap ? ' ⚠GAP' : ''} · init ${ctx.initS ?? '?'}s · ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) { failed++; out[key] = { repo: it.repo, pr: it.pr, error: String(e.message).slice(0, 400) }; console.error(`  FAILED: ${e.message}`); }
    fs.mkdirSync(CONFIG.resultsDir, { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
}
console.error(`\n=== ${CONFIG.model}: ${done} reviewed, ${failed} failed → ${OUT}`);
process.exit(failed > 0 ? 1 : 0);
