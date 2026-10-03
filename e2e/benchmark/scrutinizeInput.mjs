#!/usr/bin/env node
/**
 * scrutinizeInput.mjs — #934 follow-up. Scans the dry-run dumps (the EXACT input
 * CodeAtlas ships to the review LLM) for INPUT-QUALITY problems, independent of
 * golden-bug recall:
 *   - redaction: code shredded mid-identifier (over-redaction) OR a real secret leaked
 *   - truncation: window/overflow markers ("NOT shown", "TOO LARGE TO DIFF")
 *   - mis-detected entries: frontend kinds (NETWORK/SCREEN/NAV_ROUTE) with a degenerate slice
 *   - empty content: file blocks with ~no content
 *   - duplication: a file shown in BOTH the entry pass and the project pass
 *   - markerless: a project-pass file with content but 0 +/- markers (diff-blind regression)
 *
 * Usage: node scrutinizeInput.mjs <dumpsDir>
 */
import fs from 'node:fs';
import path from 'node:path';

const dumpsDir = process.argv[2] || 'results/combined934/dumps';
const files = fs.readdirSync(dumpsDir).filter((f) => f.endsWith('.jsonl')).sort();

const LEAK = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const OVER_REDACT = /[A-Za-z0-9_]\[REDACTED\]|\[REDACTED\][A-Za-z0-9_]/g; // [REDACTED] glued to an identifier = shredded code
const FRONTEND_KINDS = new Set(['NETWORK', 'SCREEN', 'NAV_ROUTE', 'DI_BINDING']);

const totals = { leak: 0, overRedact: 0, truncated: 0, misEntry: 0, empty: 0, dup: 0, markerless: 0 };
const rows = [];

for (const f of files) {
    const pr = (f.match(/_pr(\d+)\./) || f.match(/pull_(\d+)/) || f.match(/_(\d+)\./) || [])[1] || f;
    const repo = /discourse/.test(f) ? 'discourse' : /cal/.test(f) ? 'cal.com' : f.slice(0, 12);
    const lines = fs.readFileSync(path.join(dumpsDir, f), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const r = { repo, pr, leak: 0, overRedact: 0, truncated: 0, misEntry: [], empty: 0, dup: 0, markerless: 0, leakSamples: [], overSamples: [] };
    const entryFiles = new Set();
    const projFiles = new Set();

    for (const l of lines) {
        const u = l.user || '';
        for (const m of (u.match(LEAK) || [])) { r.leak++; if (r.leakSamples.length < 3) r.leakSamples.push(m.slice(0, 24)); }
        for (const m of (u.match(OVER_REDACT) || [])) { r.overRedact++; if (r.overSamples.length < 4) r.overSamples.push(m); }
        r.truncated += (u.match(/NOT shown|TOO LARGE TO DIFF/g) || []).length;

        let parsed;
        try { parsed = JSON.parse(u); } catch { continue; }
        // entry pass / single-call
        const eps = parsed.entryPoint ? [parsed] : (parsed.entryPoints || []);
        for (const e of eps) {
            const ep = e.entryPoint || {};
            const hs = e.pack?.handlerSource ?? '';
            if (ep.filePath) entryFiles.add(ep.filePath);
            const slice = String(hs).split('\n').filter((x) => x.trim()).length;
            if (FRONTEND_KINDS.has(String(ep.method)) && slice <= 3) r.misEntry.push(`${ep.method} ${ep.filePath || ''}`.slice(0, 60));
        }
        // project pass
        if (Array.isArray(parsed.files)) {
            for (const fb of parsed.files) {
                projFiles.add(fb.filePath);
                const c = String(fb.content || '');
                if (c.trim().length < 5) r.empty++;
                const hasMarker = /\+\d+: |-     |NEW FILE|TOO LARGE/.test(c);
                if (c.trim().length >= 40 && !hasMarker) r.markerless++;
            }
        }
    }
    for (const fp of projFiles) if (entryFiles.has(fp)) r.dup++;
    r.misEntry = [...new Set(r.misEntry)];

    totals.leak += r.leak; totals.overRedact += r.overRedact; totals.truncated += r.truncated;
    totals.misEntry += r.misEntry.length; totals.empty += r.empty; totals.dup += r.dup; totals.markerless += r.markerless;
    rows.push(r);
}

console.log('repo      PR    leak  over-redact  truncated  mis-entry  dup(e∩p)  markerless');
for (const r of rows) {
    console.log(`${r.repo.padEnd(9)} ${String(r.pr).padEnd(5)} ${String(r.leak).padEnd(5)} ${String(r.overRedact).padEnd(12)} ${String(r.truncated).padEnd(10)} ${String(r.misEntry.length).padEnd(10)} ${String(r.dup).padEnd(9)} ${r.markerless}`);
}
console.log(`\nTOTALS  leak=${totals.leak}  over-redact=${totals.overRedact}  truncated=${totals.truncated}  mis-entry=${totals.misEntry}  empty=${totals.empty}  dup=${totals.dup}  markerless=${totals.markerless}`);
console.log('\n--- samples ---');
for (const r of rows) {
    if (r.leakSamples.length) console.log(`LEAK ${r.repo}#${r.pr}:`, r.leakSamples.join(' | '));
    if (r.overSamples.length) console.log(`OVER-REDACT ${r.repo}#${r.pr}:`, r.overSamples.join(' | '));
    if (r.misEntry.length) console.log(`MIS-ENTRY ${r.repo}#${r.pr}:`, r.misEntry.join(' | '));
}
