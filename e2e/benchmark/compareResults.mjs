#!/usr/bin/env node
/**
 * compareResults.mjs — #868. Render the head-to-head comparison as TWO tables:
 *   [1] Per-PR — golden caught (per tool) + CodeAtlas run stats.
 *   [2] Aggregate — tp / fp / fn + Recall / Precision / F1 + scope.
 *
 *   CodeRabbit / Claude-Code : OFFICIAL Martian-judge scores (dashboard).
 *   Entelligence             : self-judged on these 10 PRs, plus its own
 *                              published 47.2% (own 67-bug set) as a scope row.
 *   CodeAtlas                : run stats from the per-run results file; self-judged.
 *
 * Raw findings stay per-run in their own JSON (results/run-<model>.json).
 *
 * Usage: node e2e/benchmark/compareResults.mjs [--bench /tmp/martian-bench] [--results <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const BENCH = flag('bench', '/tmp/martian-bench');
const RESULTS = flag('results', path.join(HERE, 'results', 'codeatlas_reviews.json'));
const ORDER = ['8087', '10600', '10967', '7232', '8330', '11059', '14943', '14740', '22345', '22532'];

function table(headers, rows) {
    const w = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
    const line = (l, m, r) => l + w.map((x) => '─'.repeat(x + 2)).join(m) + r;
    const fmt = (cells) => '│' + cells.map((c, i) => ' ' + String(c ?? '').padEnd(w[i]) + ' ').join('│') + '│';
    const out = [line('┌', '┬', '┐'), fmt(headers), line('├', '┼', '┤')];
    rows.forEach((r, i) => { out.push(fmt(r)); if (i < rows.length - 1) out.push(line('├', '┼', '┤')); });
    out.push(line('└', '┴', '┘'));
    return out.join('\n');
}

// self-judged entelligence (caught, fp, note) + CodeAtlas "read" notes
const ENT = { '8087': [1, 0, 'forEach (G2)'], '10600': [0, 0, 'walkthrough only'], '10967': [4, 4, ''], '7232': [1, 0, ''],
    '8330': [2, 0, ''], '11059': [0, 2, ''], '14943': [1, 0, ''], '14740': [1, 0, ''], '22345': [0, 0, 'walkthrough only'], '22532': [0, 0, 'walkthrough only'] };
const READ = { '8087': 'reviewed (golden forEach via project pass)', '10600': 'reviewed', '10967': 're-run paid off (was 0/1 call → 4)',
    '7232': 'full per-entry coverage', '8330': 'genuine 0', '11059': 'recovered via 60-min ceiling',
    '14943': 'small PR, genuine 0', '14740': 'full coverage, genuine 0', '22345': 'unreviewable — deepseek crashed every entry', '22532': 'reviewed' };

const dashPath = path.join(BENCH, 'offline', 'analysis', 'benchmark_dashboard.json');
const goldDir = path.join(BENCH, 'offline', 'golden_comments');
if (!fs.existsSync(dashPath)) { console.error(`benchmark missing at ${BENCH} — git clone --depth 1 https://github.com/withmartian/code-review-benchmark ${BENCH}`); process.exit(2); }
const dash = JSON.parse(fs.readFileSync(dashPath, 'utf-8'));
const judge = dash.default_model || Object.keys(dash.models)[0];
const num = (u) => (u.match(/pull\/(\d+)/) || [])[1];
const off = {}; for (const p of dash.models[judge].prs) off[num(p.url)] = p.tool_metrics || {};
const golden = {}; for (const f of fs.readdirSync(goldDir).filter((x) => x.endsWith('.json'))) for (const pr of JSON.parse(fs.readFileSync(path.join(goldDir, f), 'utf-8'))) { const n = num(pr.url || ''); if (n) golden[n] = (pr.comments || []).length; }
const ca = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf-8')) : {};
const caByNum = {}; for (const [k, v] of Object.entries(ca)) caByNum[num(k) || k] = v;
const model = Object.values(ca).find((v) => v.model)?.model || (caByNum[ORDER[0]]?.meter?.model) || 'codeatlas';

const pc = (x) => (x * 100).toFixed(0) + '%';

// ════════════════ TABLE 1 — per-PR (golden caught + CodeAtlas run stats) ══════
const H1 = ['PR', 'golden', 'CodeRabbit', 'Claude-Code', 'Entelligence', `CodeAtlas (caught/found)`, 'tokens', 'time', 'read'];
const sum = { cr: 0, cc: 0, ent: 0, ca: 0, g: 0, find: 0, tok: 0, s: 0 };
const rows1 = ORDER.map((pr) => {
    const g = golden[pr] ?? 0; sum.g += g;
    const cr = off[pr]?.coderabbit?.tp ?? '—'; const cc = off[pr]?.['claude-code']?.tp ?? '—';
    const e = ENT[pr][0]; const enote = ENT[pr][2] ? ` (${ENT[pr][2]})` : '';
    const v = caByNum[pr] || {}; const m = v.meter || {}; const found = m.findingsCount ?? (v.error ? 'ERR' : 0);
    const tok = (m.tokensUsed?.prompt || 0) + (m.tokensUsed?.completion || 0); const s = Math.round((m.wallClockMs || 0) / 1000);
    if (typeof cr === 'number') sum.cr += cr; if (typeof cc === 'number') sum.cc += cc; sum.ent += e; sum.find += (m.findingsCount || 0); sum.tok += tok; sum.s += s;
    return [`#${pr}`, g, cr, cc, `${e}${enote}`, `0/${found}`, tok.toLocaleString(), s + 's', READ[pr]];
});
rows1.push(['Total', sum.g, `${sum.cr} (${pc(sum.cr / sum.g)})`, `${sum.cc} (${pc(sum.cc / sum.g)})`, `~${sum.ent} (${pc(sum.ent / sum.g)})`, `0/${sum.find}`, sum.tok.toLocaleString(), Math.round(sum.s / 60) + 'min', '']);

// ════════════════ TABLE 2 — aggregate tp/fp/fn + R/P/F1 + scope ═══════════════
const agg = (tp, fp, fn) => { const P = tp / (tp + fp) || 0, R = tp / (tp + fn) || 0; return { P, R, F: 2 * P * R / (P + R) || 0 }; };
const offAgg = (t) => { let tp = 0, fp = 0, fn = 0; for (const pr of ORDER) { const m = off[pr]?.[t]; if (m) { tp += m.tp; fp += m.fp; fn += m.fn; } } return { tp, fp, fn, ...agg(tp, fp, fn) }; };
const cr = offAgg('coderabbit'), cc = offAgg('claude-code');
const eTp = sum.ent, eFp = ORDER.reduce((a, pr) => a + ENT[pr][1], 0), eFn = sum.g - eTp; const eA = agg(eTp, eFp, eFn);
const caFp = sum.find; // 0 golden matched → all CA findings are fp
const H2 = ['Tool', 'tp', 'fp', 'fn', 'Recall', 'Precision', 'F1', 'Source / scope'];
const rows2 = [
    ['CodeRabbit', cr.tp, cr.fp, cr.fn, pc(cr.R), pc(cr.P), pc(cr.F), 'official (claude-opus judge) · these 10 PRs'],
    ['Claude-Code', cc.tp, cc.fp, cc.fn, pc(cc.R), pc(cc.P), pc(cc.F), 'official · these 10 PRs'],
    ['Entelligence', eTp, eFp, eFn, '~' + pc(eA.R), '~' + pc(eA.P), '~' + pc(eA.F), 'self-judged · these 10 PRs'],
    ['Entelligence', '—', '—', '—', '—', '—', '47.2%', 'published · entelligence.ai own 67-bug set · all 5 repos'],
    [`CodeAtlas+${model.split('/').pop().slice(0, 18)}`, 0, caFp, sum.g, '0%', '0%', '0%', 'self-judged · these 10 PRs · local model'],
];

console.log(`\n══ AI code review — 10 cal.com PRs · judge: ${judge} · CodeAtlas model: ${model} ══`);
console.log('\n[1] Per-PR — golden caught (CodeRabbit/Claude-Code official · Entelligence self-judged) + CodeAtlas run stats.\n');
console.log(table(H1, rows1));
console.log('\n[2] Aggregate — tp/fp/fn → Recall/Precision/F1 (Entelligence has a self-judged-10PR row + its own-benchmark row).\n');
console.log(table(H2, rows2));
