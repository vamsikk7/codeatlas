#!/usr/bin/env node
/**
 * buildManifest.mjs — #868. Generate the repos+PRs manifest the review runner
 * iterates, straight from the Martian benchmark's golden_comments (the
 * authoritative PR list). No GitHub API, no keys — base/head are resolved
 * lazily by the runner at review time (and cached in its results file).
 *
 * Usage:
 *   git clone --depth 1 https://github.com/withmartian/code-review-benchmark /tmp/martian-bench
 *   node e2e/benchmark/buildManifest.mjs [--bench /tmp/martian-bench] [--out manifest.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const BENCH = flag('bench', '/tmp/martian-bench');
const OUT = flag('out', path.join(HERE, 'manifest.json'));
const GOLD = path.join(BENCH, 'offline', 'golden_comments');

if (!fs.existsSync(GOLD)) {
    console.error(`golden_comments not found at ${GOLD} — clone the benchmark first:`);
    console.error('  git clone --depth 1 https://github.com/withmartian/code-review-benchmark /tmp/martian-bench');
    process.exit(2);
}

const parseUrl = (u) => {
    const m = (u || '').match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { repo: `${m[1]}/${m[2]}`, pr: Number(m[3]) } : null;
};

const cases = [];
const repos = {};
for (const f of fs.readdirSync(GOLD).filter((x) => x.endsWith('.json')).sort()) {
    const prs = JSON.parse(fs.readFileSync(path.join(GOLD, f), 'utf-8'));
    for (const pr of prs) {
        const id = parseUrl(pr.url);
        if (!id) continue;
        const golden = (pr.comments || []).length;
        cases.push({ repo: id.repo, pr: id.pr, url: pr.url, title: pr.pr_title || '', golden });
        const r = repos[id.repo] || (repos[id.repo] = { prs: [], goldenTotal: 0 });
        r.prs.push(id.pr);
        r.goldenTotal += golden;
    }
}

const manifest = {
    source: 'withmartian/code-review-benchmark',
    note: 'Repos + PRs to cover. base/head are resolved by the runner (reviewPRs.mjs) via the GitHub API and cached in its results file — no SHAs baked here so the manifest stays diff-friendly.',
    repoCount: Object.keys(repos).length,
    prCount: cases.length,
    goldenTotal: cases.reduce((a, c) => a + c.golden, 0),
    repos,
    cases,
};
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));
console.error(`manifest: ${manifest.prCount} PRs across ${manifest.repoCount} repos, ${manifest.goldenTotal} golden comments → ${OUT}`);
for (const [r, d] of Object.entries(repos)) console.error(`  ${r}: ${d.prs.length} PRs, ${d.goldenTotal} golden`);
