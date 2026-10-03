#!/usr/bin/env node
/**
 * tokenReport.mjs — #869. Summarise the DRY-RUN input-token meter:
 * per-PR INPUT tokens (entry + project passes), call counts, and the estimated
 * INPUT cost at a chosen $/1M-token price. No LLM was called — these are the
 * tokens CodeAtlas WOULD send, so you can size an OpenRouter run before paying.
 *
 * Usage:
 *   node e2e/benchmark/tokenReport.mjs [--results run-dry-run.json] [--price 3.0]
 *   (--price = USD per 1M input tokens; default 3.0 ≈ Claude Sonnet input)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const RESULTS = flag('results', path.join(HERE, 'results', 'run-dry-run.json'));
const PRICE = Number(flag('price', '3.0'));
if (!fs.existsSync(RESULTS)) { console.error(`no dry-run results at ${RESULTS} — run reviewPRs.mjs with CODEATLAS_REVIEW_DRY_RUN=1 first`); process.exit(2); }
const r = JSON.parse(fs.readFileSync(RESULTS, 'utf-8'));

function table(headers, rows) {
    const w = headers.map((h, i) => Math.max(String(h).length, ...rows.map((x) => String(x[i] ?? '').length)));
    const line = (l, m, rr) => l + w.map((x) => '─'.repeat(x + 2)).join(m) + rr;
    const fmt = (cells) => '│' + cells.map((c, i) => ' ' + String(c ?? '').padEnd(w[i]) + ' ').join('│') + '│';
    const out = [line('┌', '┬', '┐'), fmt(headers), line('├', '┼', '┤')];
    rows.forEach((x, i) => { out.push(fmt(x)); if (i < rows.length - 1) out.push(line('├', '┼', '┤')); });
    out.push(line('└', '┴', '┘'));
    return out.join('\n');
}

const num = (u) => (u.match(/pull\/(\d+)/) || [])[1] || u;
const rows = [];
const T = { e: 0, p: 0, calls: 0, cost: 0, prs: 0 };
const perRepo = {};
const summaries = [];
for (const [k, v] of Object.entries(r)) {
    if (v.error) { rows.push([`#${num(k)}`, v.repo || '?', 'ERR', '—', '—', '—', '—']); continue; }
    const tu = (v.meter?.tokensUsed) || v.tokensUsed || {};
    const bp = tu.byPass || { entry: { prompt: 0, calls: 0 }, project: { prompt: 0, calls: 0 } };
    const eTok = bp.entry.prompt || 0, pTok = bp.project.prompt || 0, total = eTok + pTok;
    const calls = (bp.entry.calls || 0) + (bp.project.calls || 0);
    const cost = total / 1e6 * PRICE;
    rows.push([`#${num(k)}`, v.repo, `${calls} (${bp.entry.calls || 0}e+${bp.project.calls || 0}p)`, eTok.toLocaleString(), pTok.toLocaleString(), total.toLocaleString(), '$' + cost.toFixed(3)]);
    T.e += eTok; T.p += pTok; T.calls += calls; T.cost += cost; T.prs++;
    const rp = perRepo[v.repo] || (perRepo[v.repo] = { tok: 0, cost: 0, prs: 0 }); rp.tok += total; rp.cost += cost; rp.prs++;
    summaries.push(`  #${num(k)} (${v.repo}): ${bp.entry.calls || 0} entry + ${bp.project.calls || 0} project = ${calls} calls, ${total.toLocaleString()} input tokens → ~$${cost.toFixed(3)} input @ $${PRICE}/1M`);
}
rows.push(['TOTAL', '—', T.calls, T.e.toLocaleString(), T.p.toLocaleString(), (T.e + T.p).toLocaleString(), '$' + T.cost.toFixed(2)]);

console.log(`\n══ DRY-RUN input-token cost — NO LLM called · input price $${PRICE}/1M tokens · ${T.prs} PRs ══`);
console.log('\n[A] Per-PR — input tokens (entry + project passes) + estimated input cost.\n');
console.log(table(['PR', 'repo', 'calls (e+p)', 'entry tok', 'project tok', 'total tok', 'est $ (input)'], rows));
console.log('\n[B] Per-repo:');
for (const [repo, d] of Object.entries(perRepo)) console.log(`  ${repo}: ${d.prs} PRs · ${d.tok.toLocaleString()} input tok · ~$${d.cost.toFixed(2)}`);
console.log('\n[C] Per-PR estimate (output cost is extra — generation-dependent, not counted here):');
for (const s of summaries) console.log(s);
console.log(`\nTotal: ${T.prs} PRs · ${T.calls} calls · ${(T.e + T.p).toLocaleString()} input tokens · ~$${T.cost.toFixed(2)} input @ $${PRICE}/1M.`);
