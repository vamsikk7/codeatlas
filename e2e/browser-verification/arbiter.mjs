#!/usr/bin/env node
/**
 * Arbiter — the Recon judge runner.
 *
 * Runs in a SEPARATE session from Scout. Two mechanical modes bookend the
 * agent's vision judging:
 *
 *   node arbiter.mjs --plan   --build <build>   # build the judge worklist from captured artifacts
 *      -> then an AGENT follows arbiter.md: opens each screenshot, writes result.json
 *   node arbiter.mjs --rollup --build <build>   # aggregate verdicts -> summary.md + issues
 *
 * Arbiter itself never evaluates (no vision). It only prepares the worklist and
 * rolls up the verdicts the judging agent produced.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const build = val('build', null);
if (!build) { console.error('Arbiter: --build <build> required'); process.exit(2); }
const ROOT = val('out-root', `tmp/verification-runs/${build}`);
if (!existsSync(ROOT)) { console.error(`Arbiter: no run at ${ROOT} — run Scout first`); process.exit(2); }

const repoDirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function loadManifest(repo) {
  try { return JSON.parse(readFileSync(join(ROOT, repo, '_capture-manifest.json'), 'utf8')); } catch { return null; }
}

if (flag('plan')) {
  const items = [];
  let blockedByCapture = 0;
  for (const repo of repoDirs) {
    const m = loadManifest(repo);
    if (!m) continue;
    for (const cov of m.covered) {
      const dir = join(repo, cov.suite, cov.case);
      items.push({
        repo, suite: cov.suite, case: cov.case, dir,
        screenshots: cov.frames || [],
        expected: join(dir, 'expected.md'),
        capture: join(dir, 'capture.json'),
        landed: cov.landed,
        hint: cov.landed === false ? 'capture did NOT land the expected layer — verdict likely BLOCKED unless a tuning agent re-captures' : null
      });
    }
    blockedByCapture += m.needsTuning.length;
  }
  const worklist = {
    build, root: ROOT, generatedForRepos: repoDirs, total: items.length, blockedByCapture,
    rubric: 'e2e/browser-verification/arbiter.md',
    instructions: 'For each item: open the screenshot(s) under ROOT/<dir>/, read expected.md, and write ROOT/<dir>/{actual.md, analysis.md, result.json} with a pass|fail|blocked verdict. Then: node arbiter.mjs --rollup --build ' + build,
    items
  };
  writeFileSync(join(ROOT, '_judge-worklist.json'), JSON.stringify(worklist, null, 2) + '\n');
  console.log(`[arbiter] plan: ${items.length} cases to judge across ${repoDirs.length} repos (${blockedByCapture} capture-needsTuning) -> ${join(ROOT, '_judge-worklist.json')}`);
  console.log('[arbiter] next: an agent follows arbiter.md, then `node arbiter.mjs --rollup --build ' + build + '`');
  process.exit(0);
}

if (flag('rollup')) {
  const bySuite = {}, byRepo = {}, byVerdict = { pass: 0, fail: 0, blocked: 0, 'n/a': 0, unjudged: 0 };
  const fails = [];
  let total = 0;
  for (const repo of repoDirs) {
    const m = loadManifest(repo);
    if (!m) continue;
    byRepo[repo] = { pass: 0, fail: 0, blocked: 0, unjudged: 0 };
    for (const cov of m.covered) {
      total++;
      const rp = join(ROOT, repo, cov.suite, cov.case, 'result.json');
      let verdict = 'unjudged';
      let observed = '';
      if (existsSync(rp)) { try { const r = JSON.parse(readFileSync(rp, 'utf8')); verdict = r.verdict || 'unjudged'; observed = r.observed || ''; } catch { /* */ } }
      byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
      byRepo[repo][verdict] = (byRepo[repo][verdict] || 0) + 1;
      bySuite[cov.suite] = bySuite[cov.suite] || { pass: 0, fail: 0, blocked: 0, unjudged: 0 };
      bySuite[cov.suite][verdict] = (bySuite[cov.suite][verdict] || 0) + 1;
      if (verdict === 'fail') fails.push({ repo, case: cov.case, suite: cov.suite, observed });
    }
  }
  const line = (o) => `pass ${o.pass || 0} · fail ${o.fail || 0} · blocked ${o.blocked || 0} · unjudged ${o.unjudged || 0}`;
  let md = `# Recon summary — build ${build}\n\n**Totals:** ${total} cases · ${line(byVerdict)}\n\n## By suite\n\n`;
  for (const s of Object.keys(bySuite).sort()) md += `- **${s}** — ${line(bySuite[s])}\n`;
  md += `\n## By repo\n\n`;
  for (const r of Object.keys(byRepo).sort()) md += `- **${r}** — ${line(byRepo[r])}\n`;
  md += `\n## Failures (${fails.length})\n\n`;
  for (const f of fails) md += `- **${f.repo}/${f.case}** (${f.suite}) — ${f.observed}\n`;
  writeFileSync(join(ROOT, 'summary.md'), md);
  console.log(`[arbiter] rollup: ${total} cases · ${line(byVerdict)} -> ${join(ROOT, 'summary.md')}`);
  if (fails.length) console.log(`[arbiter] ${fails.length} FAIL(s) — copy them into ISSUES.md`);
  process.exit(0);
}

console.log('Arbiter — judge runner. Usage:\n  node arbiter.mjs --plan   --build <build>\n  node arbiter.mjs --rollup --build <build>');
