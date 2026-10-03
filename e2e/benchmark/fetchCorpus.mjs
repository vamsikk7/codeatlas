#!/usr/bin/env node
/**
 * fetchCorpus.mjs — #849 (2026-06-12).
 *
 * Step 1 of the CodeAtlas-vs-raw-LLM benchmark: resolve the Martian
 * code-review-benchmark golden PRs (50 PRs across cal.com / discourse /
 * grafana / keycloak / sentry) into runnable cases — owner/repo, PR number,
 * base/head SHAs, base ref — via the GitHub API, and write
 * `e2e/benchmark/results/cases.json`.
 *
 * Usage:
 *   GITHUB_TOKEN=$(gh auth token) node e2e/benchmark/fetchCorpus.mjs
 *     [--bench /tmp/martian-bench]   path to the cloned Martian benchmark
 *     [--limit N]                    first N cases only (smoke runs)
 *
 * Idempotent: cases already resolved in cases.json are kept (re-run after
 * rate limits or network blips).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// BENCH_RESULTS_DIR override — keep run outputs out of the repo (e.g. /tmp) for pre-publish review.
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results');
const CASES_PATH = path.join(RESULTS_DIR, 'cases.json');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const BENCH_DIR = flag('bench', '/tmp/martian-bench');
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const TOKEN = process.env.GITHUB_TOKEN ?? '';

const GOLDEN_DIR = path.join(BENCH_DIR, 'offline', 'golden_comments');
if (!fs.existsSync(GOLDEN_DIR)) {
    console.error(`golden_comments not found at ${GOLDEN_DIR} — clone the benchmark first:`);
    console.error('  git clone --depth 1 https://github.com/withmartian/code-review-benchmark /tmp/martian-bench');
    process.exit(2);
}

function parsePrUrl(url) {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) throw new Error(`unparseable PR url: ${url}`);
    return { owner: m[1], repo: m[2], prNumber: parseInt(m[3], 10) };
}

async function gh(pathPart) {
    const res = await fetch(`https://api.github.com${pathPart}`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'codeatlas-benchmark',
            ...(TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {}),
        },
    });
    if (!res.ok) throw new Error(`GitHub ${pathPart} → ${res.status}`);
    return res.json();
}

const existing = fs.existsSync(CASES_PATH)
    ? JSON.parse(fs.readFileSync(CASES_PATH, 'utf-8'))
    : {};

const goldenFiles = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort();
let all = [];
for (const gf of goldenFiles) {
    const sourceKey = gf.replace('.json', '');
    const prs = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, gf), 'utf-8'));
    for (const pr of prs) all.push({ sourceKey, pr });
}
if (LIMIT > 0) all = all.slice(0, LIMIT);

const out = { ...existing };
let resolved = 0, skipped = 0, failed = 0;
for (const { sourceKey, pr } of all) {
    const id = pr.url;
    if (out[id]?.headSha) { skipped++; continue; }
    try {
        const { owner, repo, prNumber } = parsePrUrl(pr.url);
        const meta = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`);
        out[id] = {
            sourceKey,
            prTitle: pr.pr_title,
            url: pr.url,
            repoSlug: `${owner}/${repo}`,
            prNumber,
            baseSha: meta.base?.sha,
            headSha: meta.head?.sha,
            baseRef: meta.base?.ref,
            changedFiles: meta.changed_files,
            additions: meta.additions,
            deletions: meta.deletions,
            goldenCount: (pr.comments ?? []).length,
        };
        resolved++;
        console.error(`resolved ${owner}/${repo}#${prNumber} (${meta.changed_files} files, +${meta.additions}/−${meta.deletions})`);
    } catch (err) {
        failed++;
        console.error(`FAILED ${pr.url}: ${err.message}`);
    }
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(CASES_PATH, JSON.stringify(out, null, 2));
console.error(`\ncases.json: ${Object.keys(out).length} total (${resolved} resolved now, ${skipped} cached, ${failed} failed)`);
if (failed > 0) process.exit(1);
