#!/usr/bin/env node
/**
 * extractJudgeInput.mjs — #939. Pair each PR's Martian golden bugs with CodeAtlas's
 * ACTUAL findings (from a real LLM run) so an oracle can judge TP/FP/FN → P/R/F1.
 * Usage: node extractJudgeInput.mjs <runJson> <goldenJson> <outSubdir>
 */
import fs from 'node:fs';
import path from 'node:path';

const runPath = process.argv[2] || 'results/llm-run/run-deepseek_deepseek-v4-flash.json';
const goldenPath = process.argv[3] || '/tmp/martian-bench/offline/golden_comments/cal_dot_com.json';
const outDir = process.argv[4] || 'results/llm-run/judge-input';
fs.mkdirSync(outDir, { recursive: true });

const golden = {};
for (const pr of JSON.parse(fs.readFileSync(goldenPath, 'utf-8'))) {
    const num = (String(pr.url).match(/pull\/(\d+)/) || [])[1];
    if (num) golden[num] = pr.comments || [];
}

const run = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
const summary = [];
for (const [k, v] of Object.entries(run)) {
    const pr = (k.match(/pull.(\d+)/) || [])[1];
    if (!pr || v.error) continue;
    const g = golden[pr] || [];
    // Findings: inline (body has "🔴 **Title** (sev)\n\n desc") + outside (title/body).
    const findings = [];
    for (const c of (v.inline || [])) {
        const m = String(c.body).match(/\*\*(.+?)\*\*\s*\((\w+)\)\s*\n+([\s\S]*?)(?:\n```|$)/);
        findings.push({ src: 'inline', file: c.path, line: c.line, title: m ? m[1] : String(c.body).slice(0, 80), severity: m ? m[2] : '', body: (m ? m[3] : String(c.body)).replace(/\s+/g, ' ').trim().slice(0, 400) });
    }
    for (const f of (v.outside || [])) {
        findings.push({ src: 'outside', file: f.anchor?.filePath || '', title: f.title || '', severity: f.severity || '', body: String(f.body || '').replace(/\s+/g, ' ').trim().slice(0, 400) });
    }
    summary.push({ pr, golden: g.length, findings: findings.length, tok: v.meter?.tokensUsed?.prompt || 0, comp: v.meter?.tokensUsed?.completion || 0, calls: v.meter?.tokensUsed?.calls || 0, wallMs: v.meter?.wallClockMs || v.durationMs || 0 });

    const md = [];
    md.push(`# cal.com #${pr} — JUDGE INPUT (CodeAtlas findings vs Martian golden)\n`);
    md.push(`tokens(in/comp)=${v.meter?.tokensUsed?.prompt}/${v.meter?.tokensUsed?.completion} · calls=${v.meter?.tokensUsed?.calls} · golden=${g.length} · findings=${findings.length}\n`);
    md.push(`## GOLDEN bugs (${g.length}) — ground truth`);
    g.forEach((c, i) => md.push(`- **GOLD-${i + 1}** [${c.severity || ''}] ${String(c.comment || '').replace(/\s+/g, ' ').trim()}`));
    md.push(`\n## CodeAtlas FINDINGS (${findings.length}) — what the reviewer reported`);
    findings.forEach((f, i) => md.push(`- **FIND-${i + 1}** [${f.severity}] (${f.file}${f.line ? ':' + f.line : ''}) ${f.title} — ${f.body}`));
    fs.writeFileSync(path.join(outDir, `pr-${pr}.md`), md.join('\n'));
}
summary.sort((a, b) => a.pr - b.pr);
console.log(JSON.stringify(summary));
console.log(`judge files → ${outDir}/pr-<n>.md`);
