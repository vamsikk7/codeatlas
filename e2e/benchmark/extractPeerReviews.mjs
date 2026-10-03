#!/usr/bin/env node
/**
 * extractPeerReviews.mjs — #849 (2026-06-12).
 *
 * Pull the SHIPPED reviews of peer tools (entelligence, coderabbit by
 * default) out of the Martian benchmark's `results/benchmark_data.json` —
 * plus their judged tp/fp/fn per PR from the dashboard JSON — so our arms
 * can be compared side-by-side against real competitor output on the SAME
 * PRs, before anything is published.
 *
 * Output: $BENCH_RESULTS_DIR/peer_reviews.json
 *
 * Usage:
 *   node e2e/benchmark/extractPeerReviews.mjs
 *     [--bench /tmp/martian-bench] [--tools entelligence,coderabbit]
 *     [--judge anthropic_claude-opus-4-5-20251101]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const BENCH_DIR = flag('bench', '/tmp/martian-bench');
const TOOLS = flag('tools', 'entelligence,coderabbit').split(',').map((s) => s.trim()).filter(Boolean);
const JUDGE = flag('judge', 'anthropic_claude-opus-4-5-20251101');

const data = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'offline', 'results', 'benchmark_data.json'), 'utf-8'));
const dash = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'offline', 'analysis', 'benchmark_dashboard.json'), 'utf-8'));

// Judged metrics per PR per tool, from the chosen judge model.
const judged = {};
for (const pr of dash.models?.[JUDGE]?.prs ?? []) {
    judged[pr.url] = pr.tool_metrics ?? {};
}

const out = {};
let captured = 0;
for (const [url, entry] of Object.entries(data)) {
    const peers = (entry.reviews ?? []).filter((r) => TOOLS.includes(r.tool));
    if (peers.length === 0) continue;
    out[url] = {
        pr_title: entry.pr_title,
        source_repo: entry.source_repo,
        golden_comments: entry.golden_comments,
        peers: peers.map((r) => ({
            tool: r.tool,
            review_comments: r.review_comments,
            judged: judged[url]?.[r.tool] ?? null,   // {tp, fp, fn} from the published judge run
        })),
    };
    captured += peers.length;
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });
const outPath = path.join(RESULTS_DIR, 'peer_reviews.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

// Aggregate published scores for quick reference.
const totals = {};
for (const e of Object.values(out)) {
    for (const p of e.peers) {
        if (!p.judged) continue;
        const t = (totals[p.tool] ??= { tp: 0, fp: 0, fn: 0 });
        t.tp += p.judged.tp; t.fp += p.judged.fp; t.fn += p.judged.fn;
    }
}
for (const [tool, t] of Object.entries(totals)) {
    const precision = t.tp / Math.max(1, t.tp + t.fp);
    const recall = t.tp / Math.max(1, t.tp + t.fn);
    console.error(`${tool}: tp=${t.tp} fp=${t.fp} fn=${t.fn} → precision ${(precision * 100).toFixed(1)}% recall ${(recall * 100).toFixed(1)}% (judge: ${JUDGE})`);
}
console.error(`\n${Object.keys(out).length} PRs, ${captured} peer reviews → ${outPath}`);
