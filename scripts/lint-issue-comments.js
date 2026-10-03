#!/usr/bin/env node
/**
 * lint-issue-comments.js — Issue #373 Phase A (2026-06-07).
 *
 * Scans src/ for "tribal-knowledge" comments — bare `Issue N` / `#N` /
 * `(issue N)` references that point at a number with no title or
 * descriptive context. These are the comments #373 originally flagged
 * as a maintainability tax: a future reader has to grep ISSUES.md to
 * recover the intent.
 *
 * Output is human-readable to stdout; rc=0 always. Run via:
 *
 *   node scripts/lint-issue-comments.js          # full repo, group by file
 *   node scripts/lint-issue-comments.js --count  # just print the totals
 *   node scripts/lint-issue-comments.js --json   # machine-readable for CI
 *
 * Non-destructive — produces a report only. Use `scripts/migrate-issue-comments.js`
 * (companion script — Phase B) to rewrite tribal comments inline using
 * the titles from ISSUES.md.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['src'];

// Match bare references — i.e. with NO descriptive text AFTER the
// number. `Issue 359 — Cascade chain ...` is GOOD; `Issue 359.` or
// just `Issue 359` standing alone is the pattern this catches.
//
// Three shapes we look for:
//   1. `Issue NNN`  + nothing meaningful after the number
//   2. `(#NNN)` or `#NNN` standing alone (parenthetical or end-of-comment)
//   3. `(issue NNN)` parenthetical
//
// We deliberately allow `Issue NNN — <title>` / `Issue NNN: <title>` —
// those comments self-describe and are not the target.
const PATTERNS = [
    /\bIssue\s+(\d{2,4})\b(?![\s:—\-——])/, // "Issue 359" with no continuation
    /\(#(\d{2,4})\)/,                              // "(#359)"
    /\(issue\s+(\d{2,4})\)/i,                      // "(issue 359)"
];

const args = process.argv.slice(2);
const COUNT_ONLY = args.includes('--count');
const JSON_OUT = args.includes('--json');

/** @returns {string[]} */
function walk(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
            if (e.name.startsWith('.') || e.name === 'node_modules') continue;
            const p = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
        }
    }
    return out;
}

function scan(file) {
    const src = fs.readFileSync(file, 'utf-8');
    const hits = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Only inspect comment lines. Skip JSDoc/block headers that
        // already describe the issue richly (`/** Issue 359 — Cascade
        // chain has cyclic data flow */`) — the regex's negative
        // lookahead handles that.
        const isComment = /^\s*(?:\/\/|\*|\/\*|<!--)/.test(line);
        if (!isComment) continue;
        for (const pattern of PATTERNS) {
            const m = line.match(pattern);
            if (m) {
                hits.push({
                    line: i + 1,
                    issue: m[1],
                    text: line.trim().slice(0, 200),
                });
                break; // one match per line is enough
            }
        }
    }
    return hits;
}

const files = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d)));
const results = [];
let total = 0;
for (const f of files) {
    const hits = scan(f);
    if (hits.length > 0) {
        results.push({ file: path.relative(ROOT, f), hits });
        total += hits.length;
    }
}

if (JSON_OUT) {
    console.log(JSON.stringify({ total, files: results.length, results }, null, 2));
    process.exit(0);
}

if (COUNT_ONLY) {
    console.log(`#373 tribal-comment scan: ${total} match${total === 1 ? '' : 'es'} across ${results.length} file${results.length === 1 ? '' : 's'}`);
    process.exit(0);
}

console.log(`#373 — bare 'Issue N' / '#N' references in source comments (${total} total)\n`);
for (const { file, hits } of results) {
    console.log(`${file} (${hits.length})`);
    for (const h of hits) {
        console.log(`  L${h.line}  #${h.issue}  ${h.text}`);
    }
    console.log();
}
console.log(`Total: ${total} bare reference${total === 1 ? '' : 's'} across ${results.length} file${results.length === 1 ? '' : 's'}.`);
console.log('Run `node scripts/migrate-issue-comments.js` to enrich them with their ISSUES.md titles.');
