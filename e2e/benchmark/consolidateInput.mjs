#!/usr/bin/env node
/**
 * consolidateInput.mjs — #940. Merge the self-tagged dry-run dumps (each line
 * {repo, pr, pass, chars, tokens, system, user}) from one or more dirs into ONE
 * all-calls.json: a flat array of every LLM call's exact input, indexed per PR.
 * This is the replay corpus — fed to replayModel.mjs to run any model WITHOUT
 * re-running the CodeAtlas pipeline.
 *
 * Usage: node consolidateInput.mjs <out.json> <dumpsDir> [<dumpsDir2> ...]
 */
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'results/input-collection/all-calls.json';
const dirs = process.argv.slice(3);
if (!dirs.length) { console.error('usage: consolidateInput.mjs <out.json> <dumpsDir>...'); process.exit(2); }

const calls = [];
const perPrIdx = {};
const seenPr = new Set();
for (const dir of dirs) {
    if (!fs.existsSync(dir)) { console.error(`skip missing ${dir}`); continue; }
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
        const lines = fs.readFileSync(path.join(dir, f), 'utf-8').trim().split('\n').filter(Boolean);
        for (const line of lines) {
            let o; try { o = JSON.parse(line); } catch { continue; }
            const repo = o.repo || '(unknown)';
            const pr = String(o.pr || (f.match(/_pr(\d+)\./) || [])[1] || '?');
            const key = `${repo}#${pr}`;
            // Later dirs win: if this PR already collected from an earlier dir, skip (dedupe).
            if (perPrIdx[key] === undefined && seenPr.has(key)) continue;
            perPrIdx[key] = (perPrIdx[key] ?? -1) + 1;
            seenPr.add(key);
            calls.push({ repo, pr, key, idx: perPrIdx[key], pass: o.pass, inChars: (o.system || '').length + (o.user || '').length, system: o.system, user: o.user });
        }
    }
    // mark PRs seen in this dir so a later dir can override only if it has them
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(calls, null, 0));

// summary
const byPr = {};
for (const c of calls) { (byPr[c.key] ??= { calls: 0, chars: 0, entry: 0, project: 0 }); byPr[c.key].calls++; byPr[c.key].chars += c.inChars; byPr[c.key][c.pass] = (byPr[c.key][c.pass] || 0) + 1; }
const prs = Object.keys(byPr);
console.log(`Collected ${calls.length} calls across ${prs.length} PRs → ${out}`);
console.log(`total input chars: ${calls.reduce((a, c) => a + c.inChars, 0).toLocaleString()} (~${Math.round(calls.reduce((a, c) => a + c.inChars, 0) / 4 / 1000)}k tokens)`);
console.log('per-PR: ' + prs.map((k) => `${k.split('/').pop()}(${byPr[k].calls})`).join(' '));
