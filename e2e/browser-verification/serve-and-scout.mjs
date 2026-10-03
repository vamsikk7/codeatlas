#!/usr/bin/env node
/**
 * serve-and-scout.mjs — ONE-AT-A-TIME multi-repo capture driver.
 *
 * For each repo (SEQUENTIALLY, never a fleet): bring up a single MCP browser
 * daemon on one shared port, wait for it to serve, run Scout capture against it,
 * then KILL the daemon before moving to the next repo. Reuses one port; only one
 * daemon is ever alive. This is the safe sequential alternative to spinning up a
 * daemon fleet.
 *
 *   node e2e/browser-verification/serve-and-scout.mjs \
 *     --repos go-gin,js-express,py-flask \
 *     --build all-run1 --port 7860 --features 3
 *
 * Guardrails: per-repo init wait cap, guaranteed daemon kill in finally, heavy
 * repos excluded by default (pass --allow-heavy to include). Judge afterwards
 * with arbiter.mjs (separate session, vision).
 */
import { readFileSync, existsSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..'); // extension/
const REPOS_DIR = join(__dirname, 'repos');
const MCP = join(ROOT, 'dist', 'mcp-server.js');
const SCOUT = join(__dirname, 'scout.mjs');
const INDEX = JSON.parse(readFileSync(join(REPOS_DIR, '_index.json'), 'utf8'));

const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const reposArg = val('repos', null);
const build = val('build', `all-${Date.now()}`);
const port = parseInt(val('port', '7860'), 10);
const features = val('features', '3');
const suitesArg = val('suites', null);
const initTimeoutMs = parseInt(val('init-timeout', '120'), 10) * 1000;
const allowHeavy = has('allow-heavy');

const HEAVY = new Set(['js-serverless-examples']);
const catalog = new Map(INDEX.repos.map((r) => [r.repo, r]));

let repos = reposArg ? reposArg.split(',') : INDEX.repos.filter((r) => r.builds.includes('mcp')).map((r) => r.repo);
repos = repos.filter((r) => { if (!catalog.has(r)) { console.warn(`[serve] unknown repo skipped: ${r}`); return false; } if (HEAVY.has(r) && !allowHeavy) { console.warn(`[serve] heavy repo skipped (pass --allow-heavy): ${r}`); return false; } return true; });

const url = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp() {
  return new Promise((res) => {
    const p = spawn('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '2', `${url}/index.html`]);
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', () => res(out.trim() === '200'));
    p.on('error', () => res(false));
  });
}

function repoAbsPath(repo) {
  const meta = catalog.get(repo);
  const p = meta && meta.file ? JSON.parse(readFileSync(join(REPOS_DIR, `${repo}.suite.json`), 'utf8')).repo.path : null;
  if (!p) return null;
  return p.startsWith('/') ? p : join(ROOT, p);
}

async function killDaemon(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch { /* */ }
  for (let i = 0; i < 20 && !child.killed; i++) { if (child.exitCode !== null) break; await sleep(150); }
  try { child.kill('SIGKILL'); } catch { /* */ }
}

async function runRepo(repo) {
  const abs = repoAbsPath(repo);
  if (!abs || !existsSync(abs)) return { repo, ok: false, err: `repo path missing: ${abs}` };
  if (!existsSync(MCP)) return { repo, ok: false, err: `mcp-server.js not built at ${MCP} (npm run package)` };
  // one daemon, this repo, this port
  const daemon = spawn('node', [MCP, abs, '--browser', '--no-stdio', '--no-open', '--port', String(port)], { stdio: 'ignore' });
  try {
    const deadline = Date.now() + initTimeoutMs;
    let up = false;
    while (Date.now() < deadline) { if (await isUp()) { up = true; break; } if (daemon.exitCode !== null) return { repo, ok: false, err: `daemon exited during init (code ${daemon.exitCode})` }; await sleep(2000); }
    if (!up) return { repo, ok: false, err: `dashboard not up within ${initTimeoutMs / 1000}s` };
    await sleep(1500);
    const a = ['--repos', repo, '--url', url, '--build', build, '--features', features];
    if (suitesArg) a.push('--suites', suitesArg);
    const r = spawnSync('node', [SCOUT, ...a], { encoding: 'utf8' });
    const line = (r.stdout || '').trim().split('\n').filter((l) => l.includes('done')).pop() || (r.stdout || '').trim().split('\n').pop();
    return { repo, ok: r.status === 0, line };
  } finally {
    await killDaemon(daemon);
    // let the port free before the next repo
    await sleep(1500);
  }
}

(async () => {
  console.log(`[serve] one-at-a-time: ${repos.length} repos on :${port} -> build ${build}`);
  const results = [];
  for (const repo of repos) {
    process.stdout.write(`  ${repo.padEnd(22)} ... `);
    const r = await runRepo(repo);
    results.push(r);
    console.log(r.ok ? (r.line || 'ok') : `FAIL: ${r.err}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`[serve] done: ${ok}/${results.length} captured. Judge: node e2e/browser-verification/arbiter.mjs --plan --build ${build}`);
})();
