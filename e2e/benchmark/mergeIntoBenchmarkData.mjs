#!/usr/bin/env node
/**
 * mergeIntoBenchmarkData.mjs — #849 (2026-06-12).
 *
 * Merge both arms' review results into the Martian benchmark's
 * `benchmark_data.json` shape so its steps 2→5 (extract / dedup / judge /
 * export) run unchanged:
 *
 *   { [golden_url]: { pr_title, original_url, source_repo, golden_comments,
 *                     golden_source_file, az_comment,
 *                     reviews: [{ tool, repo_name, pr_url, review_comments }] } }
 *
 * Usage:
 *   node e2e/benchmark/mergeIntoBenchmarkData.mjs
 *     [--bench /tmp/martian-bench]
 *     [--out /tmp/martian-bench/offline/results/benchmark_data.json]
 *     [--run N]   pick one repetition when arms were run with --runs > 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// BENCH_RESULTS_DIR override — keep run outputs out of the repo (e.g. /tmp) for pre-publish review.
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const BENCH_DIR = flag('bench', '/tmp/martian-bench');
const OUT = flag('out', path.join(BENCH_DIR, 'offline', 'results', 'benchmark_data.json'));
const RUN = parseInt(flag('run', '1'), 10) || 1;

const GOLDEN_DIR = path.join(BENCH_DIR, 'offline', 'golden_comments');
const goldenByUrl = {};
for (const gf of fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'))) {
    for (const pr of JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, gf), 'utf-8'))) {
        goldenByUrl[pr.url] = { ...pr, source_file: gf };
    }
}

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf-8')) : {};
let merged = 0;
for (const armFile of ['codeatlas_reviews.json', 'raw_llm_reviews.json']) {
    const p = path.join(RESULTS_DIR, armFile);
    if (!fs.existsSync(p)) { console.error(`skip (missing): ${armFile}`); continue; }
    const arm = JSON.parse(fs.readFileSync(p, 'utf-8'));
    for (const rec of Object.values(arm)) {
        if (!rec.review_comments) continue;            // failed case
        if ((rec.run ?? 1) !== RUN) continue;          // one repetition per merge
        const golden = goldenByUrl[rec.url];
        if (!golden) { console.error(`no golden for ${rec.url}`); continue; }
        if (!out[rec.url]) {
            out[rec.url] = {
                pr_title: golden.pr_title,
                original_url: golden.url,
                source_repo: rec.repoSlug,
                golden_comments: golden.comments,
                golden_source_file: golden.source_file,
                az_comment: golden.az_comment ?? null,
                reviews: [],
            };
        }
        out[rec.url].reviews = out[rec.url].reviews.filter((r) => r.tool !== rec.tool);
        out[rec.url].reviews.push({
            tool: rec.tool,
            repo_name: rec.repoSlug,
            pr_url: rec.url,
            review_comments: rec.review_comments,
        });
        merged++;
    }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`merged ${merged} reviews (run ${RUN}) → ${OUT}`);
console.error('Next (from the benchmark clone): cd offline && uv run python -m code_review_benchmark.step2_extract_comments --tool codeatlas');
