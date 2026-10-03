#!/usr/bin/env node
/**
 * migrate-issue-comments.js — Issue #373 Phase B (2026-06-07).
 *
 * Rewrites tribal `// Issue NNN` comments inline, enriching them with
 * the issue's title from ISSUES.md. Companion to
 * `lint-issue-comments.js` (Phase A, the scanner).
 *
 * Strategy:
 *   1. Build a `{NNN → title}` index by parsing every `## Issue N — <title>`
 *      heading in ISSUES.md.
 *   2. Walk src/ for files that contain bare `Issue NNN` / `(#NNN)` /
 *      `(issue NNN)` comment lines.
 *   3. Replace inline:
 *        `// Issue 359` → `// Issue 359 — Cascade chain has cyclic data flow with no synchronization`
 *        `(#359)`      → `(#359 — Cascade chain has cyclic data flow with no synchronization)`
 *        `(issue 359)` → `(Issue 359 — Cascade chain has cyclic data flow with no synchronization)`
 *
 * Skip rules (= comments left untouched):
 *   - Issue N already has descriptive continuation (`Issue 359 —`/`:`/etc.)
 *   - Issue N is followed by an unrelated word boundary that's already
 *     readable (e.g. inside a longer sentence)
 *   - The corresponding ISSUES.md entry can't be found (issue number
 *     was renumbered or is from a different tracker)
 *
 * Usage:
 *   node scripts/migrate-issue-comments.js --dry-run    # default; prints diff
 *   node scripts/migrate-issue-comments.js --write      # apply changes in place
 *
 * Idempotent — running twice is a no-op because the enriched comment
 * no longer matches the bare-reference pattern.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ISSUES = path.join(ROOT, 'ISSUES.md');
const SCAN_DIRS = ['src'];

const args = process.argv.slice(2);
const WRITE = args.includes('--write');

function buildIssueIndex() {
    const text = fs.readFileSync(ISSUES, 'utf-8');
    const lines = text.split('\n');
    const idx = new Map();
    for (const line of lines) {
        // `## Issue 359 — Cascade chain has cyclic data flow with no synchronization ✅ FIXED`
        const m = line.match(/^## Issue\s+(\d{2,4})\s*[—\-:]\s*(.+?)(?:\s+(?:✅|🟡|🔴|⏸️|📋|🟢|🚫|📊|⚠️)\b.*)?$/);
        if (!m) continue;
        const num = m[1];
        let title = m[2].trim();
        // Strip trailing status emoji + status words that escaped the
        // first regex slice.
        title = title.replace(/\s+(?:✅|🟡|🔴|⏸️|📋|🟢|🚫|📊|⚠️).*$/, '').trim();
        if (!idx.has(num)) idx.set(num, title);
    }
    return idx;
}

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

const idx = buildIssueIndex();
console.log(`Built ISSUES.md index: ${idx.size} entries`);

const files = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d)));
let changedFiles = 0;
let changedLines = 0;
const sample = []; // first 10 changes for the dry-run preview

for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8');
    const lines = src.split('\n');
    let dirty = false;
    for (let i = 0; i < lines.length; i++) {
        const orig = lines[i];
        const isComment = /^\s*(?:\/\/|\*|\/\*|<!--)/.test(orig);
        if (!isComment) continue;
        let line = orig;
        // Pattern 1: `Issue NNN` with no continuation.
        line = line.replace(/\bIssue\s+(\d{2,4})\b(?![\s:—\-——])/, (m, n) => {
            const t = idx.get(n);
            return t ? `Issue ${n} — ${t}` : m;
        });
        // Pattern 2: `(#NNN)`.
        line = line.replace(/\(#(\d{2,4})\)/, (m, n) => {
            const t = idx.get(n);
            return t ? `(#${n} — ${t})` : m;
        });
        // Pattern 3: `(issue NNN)`.
        line = line.replace(/\(issue\s+(\d{2,4})\)/i, (m, n) => {
            const t = idx.get(n);
            return t ? `(Issue ${n} — ${t})` : m;
        });
        if (line !== orig) {
            lines[i] = line;
            dirty = true;
            changedLines++;
            if (sample.length < 10) {
                sample.push({
                    file: path.relative(ROOT, f),
                    line: i + 1,
                    before: orig.trim().slice(0, 160),
                    after: line.trim().slice(0, 160),
                });
            }
        }
    }
    if (dirty) {
        changedFiles++;
        if (WRITE) fs.writeFileSync(f, lines.join('\n'));
    }
}

console.log(`\n#373 migration ${WRITE ? '(WROTE)' : '(DRY RUN)'}: ${changedLines} line${changedLines === 1 ? '' : 's'} across ${changedFiles} file${changedFiles === 1 ? '' : 's'}`);
if (sample.length > 0) {
    console.log('\nFirst few changes:\n');
    for (const s of sample) {
        console.log(`  ${s.file}:${s.line}`);
        console.log(`    - ${s.before}`);
        console.log(`    + ${s.after}`);
    }
}
if (!WRITE && changedLines > 0) {
    console.log('\nRe-run with --write to apply.');
}
