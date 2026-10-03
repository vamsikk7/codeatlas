#!/usr/bin/env node
/**
 * extractReviewInput.mjs — #930 eval helper.
 *
 * Turns each dry-run dump (the EXACT system+user CodeAtlas ships to the LLM) into
 * a compact, human-reviewable markdown file pairing the assembled diff with the
 * Martian golden bugs — so an oracle reviewer (Claude) can score recall from ONLY
 * what CodeAtlas put in context. Also prints a before/after marker-coverage table.
 *
 * Usage: node extractReviewInput.mjs <dumpsDir> [<beforeDumpsDir>]
 */
import fs from 'node:fs';
import path from 'node:path';

const dumpsDir = process.argv[2] || 'results/after929/dumps';
const beforeDir = process.argv[3] || 'results/eval30/dumps';
const GOLDEN = process.argv[4] || '/tmp/martian-bench/offline/golden_comments/cal_dot_com.json';
const outDir = path.join(path.dirname(dumpsDir), process.argv[5] || 'review-input');
fs.mkdirSync(outDir, { recursive: true });

// Golden bugs keyed by PR number.
const golden = {};
if (fs.existsSync(GOLDEN)) {
    const raw = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8'));
    const arr = Array.isArray(raw) ? raw : (raw.prs || raw.cases || Object.values(raw));
    for (const pr of arr) {
        const num = pr.pr ?? pr.number ?? (String(pr.url || '').match(/\/pull\/(\d+)/) || [])[1];
        if (num != null) golden[String(num)] = pr.comments || pr.golden || pr.bugs || [];
    }
}

// Count diff markers in a dump's user payloads, per pass.
function markerStats(file) {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agg = { entry: { c: 0, plus: 0, minus: 0 }, project: { c: 0, plus: 0, minus: 0 }, newfile: 0, toolarge: 0 };
    for (const l of lines) {
        const u = l.user || '';
        const plus = (u.match(/\+\d+: /g) || []).length;
        const minus = (u.match(/-     /g) || []).length;
        const p = agg[l.pass] || (agg[l.pass] = { c: 0, plus: 0, minus: 0 });
        p.c++; p.plus += plus; p.minus += minus;
        agg.newfile += (u.match(/NEW FILE — all/g) || []).length;
        agg.toolarge += (u.match(/FILE TOO LARGE TO DIFF/g) || []).length;
    }
    return agg;
}

// Pull file → diff-window text out of a dump for review.
function assembleDiff(file) {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const blocks = [];
    for (const l of lines) {
        let parsed;
        try { parsed = JSON.parse(l.user); } catch { continue; }
        // project pass: { files: [{filePath, content}] }
        if (Array.isArray(parsed.files)) {
            for (const f of parsed.files) blocks.push({ pass: l.pass, filePath: f.filePath, content: f.content });
        }
        // entry pass: { entryPoint, pack:{handlerSource, participantSources, ...} }
        if (parsed.pack || parsed.entryPoint) {
            const ep = parsed.entryPoint || {};
            const hs = parsed.pack?.handlerSource;
            if (hs) blocks.push({ pass: l.pass, filePath: `${ep.method || ''} ${ep.route || ''} → ${ep.filePath || ''}`, content: hs });
            for (const ps of (parsed.pack?.participantSources || [])) {
                if (ps?.source) blocks.push({ pass: l.pass, filePath: `(downstream) ${ps.filePath || ''}`, content: ps.source });
            }
        }
        // single-call: { entryPoints: [...] }
        for (const e of (parsed.entryPoints || [])) {
            const hs = e.pack?.handlerSource;
            const ep = e.entryPoint || {};
            if (hs) blocks.push({ pass: l.pass, filePath: `${ep.method || ''} ${ep.route || ''} → ${ep.filePath || ''}`, content: hs });
        }
    }
    return blocks;
}

const files = fs.readdirSync(dumpsDir).filter((f) => f.endsWith('.jsonl')).sort();
const table = [];
for (const f of files) {
    const pr = (f.match(/_pr(\d+)\./) || f.match(/pull_(\d+)/) || f.match(/_(\d+)\./) || [])[1] || f;
    const after = markerStats(path.join(dumpsDir, f));
    const before = markerStats(path.join(beforeDir, f));
    const g = golden[String(pr)] || [];
    const blocks = assembleDiff(path.join(dumpsDir, f));

    const fmt = (s) => s ? `${s.entry.c}e/${s.project.c}p ${s.entry.plus + s.project.plus}+ ${s.entry.minus + s.project.minus}- nf:${s.newfile} big:${s.toolarge}` : '—';
    table.push({ pr, golden: g.length,
        before: before ? before.entry.plus + before.entry.minus + before.project.plus + before.project.minus : 0,
        after: after ? after.entry.plus + after.entry.minus + after.project.plus + after.project.minus : 0,
        beforeStr: fmt(before), afterStr: fmt(after) });

    // Write the per-PR review file.
    const md = [];
    md.push(`# cal.com #${pr} — CodeAtlas review input (after #929)\n`);
    md.push(`## Golden bugs (${g.length})\n`);
    g.forEach((c, i) => {
        const sev = c.severity || c.priority || '';
        const body = c.body || c.comment || c.description || JSON.stringify(c);
        const loc = c.path || c.file || c.location || '';
        md.push(`**G${i + 1}** ${sev ? `[${sev}] ` : ''}${loc ? `(${loc}) ` : ''}${String(body).replace(/\s+/g, ' ').trim()}\n`);
    });
    md.push(`\n## Assembled diff blocks (${blocks.length})\n`);
    for (const b of blocks) {
        md.push(`\n### [${b.pass}] ${b.filePath}\n`);
        md.push('```diff');
        md.push(String(b.content).split('\n').slice(0, 400).join('\n'));
        md.push('```');
    }
    fs.writeFileSync(path.join(outDir, `pr-${pr}.md`), md.join('\n'));
}

// Marker-coverage before/after table.
console.log('PR      golden  before(+/-)  after(+/-)   before-markers  after-markers');
for (const r of table) {
    console.log(`#${String(r.pr).padEnd(6)} ${String(r.golden).padEnd(7)} ${String(r.before).padEnd(12)} ${String(r.after).padEnd(12)} ${r.beforeStr.padEnd(28)} ${r.afterStr}`);
}
console.log(`\nPer-PR review files → ${outDir}/pr-<n>.md`);
