#!/usr/bin/env node
/**
 * clean.mjs — clear Recon test-run results under tmp/verification-runs/.
 *
 *   node e2e/browser-verification/clean.mjs                 # clear ALL runs
 *   node e2e/browser-verification/clean.mjs --build all-run1  # clear one build
 *   node e2e/browser-verification/clean.mjs --dry-run       # preview, delete nothing
 *   node e2e/browser-verification/clean.mjs --yes           # skip the confirm prompt
 *
 * SAFETY: only ever operates INSIDE <repo>/tmp/verification-runs. It refuses to
 * resolve or delete anything outside that directory. Does NOT touch source, the
 * per-repo suites, or any daemon — results artifacts only.
 */
import { rmSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..'); // extension/
const RUNS = resolve(REPO, 'tmp', 'verification-runs');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const dryRun = has('dry-run');
const build = val('build');

if (!existsSync(RUNS)) { console.log(`[clean] nothing to clean — ${RUNS} does not exist`); process.exit(0); }

// Hard guard: every target must live strictly inside RUNS.
function assertInside(p) {
  const r = resolve(p);
  if (r !== RUNS && !r.startsWith(RUNS + '/')) {
    console.error(`[clean] REFUSING to delete outside tmp/verification-runs:\n  ${r}`);
    process.exit(2);
  }
  return r;
}

function dirSize(p) {
  let b = 0;
  try { for (const e of readdirSync(p, { withFileTypes: true })) { const f = join(p, e.name); b += e.isDirectory() ? dirSize(f) : statSync(f).size; } } catch { /* */ }
  return b;
}

const targets = (build ? [join(RUNS, build)] : readdirSync(RUNS).map((d) => join(RUNS, d))).map(assertInside).filter(existsSync);

if (targets.length === 0) { console.log('[clean] no run folders to clear.'); process.exit(0); }

let totalBytes = 0;
for (const t of targets) totalBytes += dirSize(t);
const rel = (p) => p.replace(REPO + '/', '');

console.log(`[clean] target: tmp/verification-runs/${build ? build : '(ALL runs)'}`);
for (const t of targets) console.log(`  - ${rel(t)}  (${(dirSize(t) / 1e6).toFixed(1)} MB)`);
console.log(`[clean] ${targets.length} run folder(s), ${(totalBytes / 1e6).toFixed(1)} MB total`);

if (dryRun) { console.log('[clean] --dry-run: nothing deleted.'); process.exit(0); }

function remove() {
  for (const t of targets) rmSync(t, { recursive: true, force: true });
  console.log(`[clean] removed ${targets.length} run folder(s), freed ${(totalBytes / 1e6).toFixed(1)} MB.`);
}

if (has('yes')) { remove(); process.exit(0); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question(`[clean] delete the above? [y/N] `, (ans) => {
  rl.close();
  if (/^y(es)?$/i.test(ans.trim())) remove();
  else console.log('[clean] aborted — nothing deleted.');
});
