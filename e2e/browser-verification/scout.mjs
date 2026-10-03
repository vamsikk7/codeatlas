#!/usr/bin/env node
/**
 * Scout — the Recon capture runner.
 *
 * Walks one or many repos and, for each, spawns the per-repo capture engine
 * (capture.mjs) which drives the live dashboard and dumps screenshots + DOM +
 * artifacts. Scout handles selection (all / smoke / limited), url mapping, and
 * a run-level roll-up. A TUNING AGENT (see execution.phase1_capture) supervises
 * — inspecting DOM, authoring --actions, and re-running until landed==true.
 *
 * Modes:
 *   node scout.mjs --all                 # every repo in the catalog
 *   node scout.mjs --smoke               # P0 cases, fast render/detect suites, every repo
 *   node scout.mjs --repos go-gin,ts-nestjs
 *   node scout.mjs --suites L1,L2A --limit 20 --repos polar
 *
 * Common flags:
 *   --url http://localhost:7742          # single dashboard (the workspace that's up)
 *   --urls polar=http://localhost:7742,go-gin=http://localhost:7842
 *   --build 9.0.30-run01                 # output build folder (default: run-<ts>)
 *   --priority P0,P1   --actions <tuned.json>   --concurrency 1
 *
 * NOTE: Scout drives CAPTURE only. Bringing up each repo's dashboard (VSIX
 * reopen or MCP daemon) + the pre-run git-reset/re-init/resync is a separate
 * step (SETUP-04). Then point --url/--urls at the running dashboard(s).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = join(__dirname, 'repos');
const ENGINE = join(__dirname, 'capture.mjs');
const INDEX = JSON.parse(readFileSync(join(REPOS_DIR, '_index.json'), 'utf8'));

const SMOKE_SUITES = 'SETUP,L1,L2A,L2B,LABEL,HEALTH,DETECT,ENTRYPOINTS,REALTIME,RENDERFLOW,CLUSTER,TOUR';

// ---- args ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const ALL = flag('all');
const SMOKE = flag('smoke');
const reposArg = val('repos', null);
const suitesArg = val('suites', SMOKE ? SMOKE_SUITES : null);
const priorityArg = val('priority', SMOKE ? 'P0' : null);
const limitArg = val('limit', null);
const actionsArg = val('actions', null);
const url = val('url', 'http://localhost:7742');
const urlsArg = val('urls', null);
const build = val('build', `run-${Date.now()}`);
const outRoot = val('out-root', `tmp/verification-runs/${build}`);
const concurrency = parseInt(val('concurrency', '1'), 10);

if (!ALL && !SMOKE && !reposArg) {
  console.log('Scout — pick a scope: --all | --smoke | --repos <a,b,...>\n' +
    'e.g.  node scout.mjs --smoke --url http://localhost:7742 --build 9.0.30-smoke');
  process.exit(2);
}

// url map (per-repo overrides)
const urlMap = {};
if (urlsArg) for (const pair of urlsArg.split(',')) { const [r, u] = pair.split('='); if (r && u) urlMap[r] = u; }
const urlFor = (repo) => urlMap[repo] || url;

// repo selection
let repos = INDEX.repos.map((r) => r.repo);
if (reposArg) {
  const want = new Set(reposArg.split(','));
  repos = repos.filter((r) => want.has(r));
  const missing = [...want].filter((w) => !repos.includes(w));
  if (missing.length) console.warn(`[scout] unknown repos ignored: ${missing.join(', ')}`);
}

if (!repos.length) { console.error('[scout] no repos selected'); process.exit(2); }

mkdirSync(outRoot, { recursive: true });

function captureRepo(repo) {
  return new Promise((resolve) => {
    const suitePath = join(REPOS_DIR, `${repo}.suite.json`);
    if (!existsSync(suitePath)) return resolve({ repo, ok: false, err: 'no suite file' });
    const out = join(outRoot, repo);
    const a = ['--suite', suitePath, '--url', urlFor(repo), '--build', build, '--out', out];
    if (suitesArg) a.push('--suites', suitesArg);
    if (priorityArg) a.push('--priority', priorityArg);
    if (limitArg) a.push('--limit', limitArg);
    if (actionsArg) a.push('--actions', actionsArg);
    const p = spawn('node', [ENGINE, ...a], { cwd: process.cwd() });
    let outbuf = '', errbuf = '';
    p.stdout.on('data', (d) => (outbuf += d));
    p.stderr.on('data', (d) => (errbuf += d));
    p.on('close', (code) => {
      let manifest = null;
      try { manifest = JSON.parse(readFileSync(join(out, '_capture-manifest.json'), 'utf8')); } catch { /* none */ }
      resolve({ repo, ok: code === 0, code, line: outbuf.trim().split('\n').pop(), err: errbuf.trim().split('\n').pop(), manifest });
    });
  });
}

// promise pool
async function run() {
  const started = Date.now();
  console.log(`[scout] build=${build} repos=${repos.length} concurrency=${concurrency} suites=${suitesArg || 'ALL'} priority=${priorityArg || 'ALL'}`);
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < repos.length) {
      const repo = repos[idx++];
      const r = await captureRepo(repo);
      results.push(r);
      const m = r.manifest;
      console.log(`  ${repo.padEnd(24)} ${r.ok ? 'ok' : 'FAIL'} ` + (m ? `covered=${m.covered.length} needsTuning=${m.needsTuning.length} skipped=${m.skipped.length}` : (r.err || '')));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const tally = results.reduce((t, r) => {
    const m = r.manifest || { covered: [], needsTuning: [], skipped: [] };
    t.covered += m.covered.length; t.needsTuning += m.needsTuning.length; t.skipped += m.skipped.length;
    return t;
  }, { covered: 0, needsTuning: 0, skipped: 0 });

  const runState = {
    build, url, urls: urlMap, mode: SMOKE ? 'smoke' : ALL ? 'all' : 'repos', repos,
    suites: suitesArg || 'ALL', priority: priorityArg || 'ALL',
    startedMs: started, finishedMs: Date.now(),
    perRepo: results.map((r) => ({ repo: r.repo, ok: r.ok, covered: r.manifest?.covered.length ?? 0, needsTuning: r.manifest?.needsTuning.length ?? 0, skipped: r.manifest?.skipped.length ?? 0 })),
    totals: tally,
    nextStep: `Judge with:  node e2e/browser-verification/arbiter.mjs --plan --build ${build}  (then an agent follows arbiter.md, then --rollup)`
  };
  writeFileSync(join(outRoot, 'run-state.json'), JSON.stringify(runState, null, 2) + '\n');
  console.log(`[scout] done -> ${outRoot}  covered=${tally.covered} needsTuning=${tally.needsTuning} skipped=${tally.skipped}`);
  console.log(`[scout] ${runState.nextStep}`);
}

run().catch((e) => { console.error('[scout] fatal:', e.message); process.exit(1); });
