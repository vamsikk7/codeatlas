#!/usr/bin/env node
/**
 * prefetchBranches.mjs — #870. Get every benchmark PR checkout-ready AHEAD of
 * time, fully SEPARATED from CodeAtlas init.
 *
 * For each PR in the manifest it:
 *   1. resolves base/head SHAs (GitHub API, retried; reuses already-resolved
 *      SHAs from a prior run),
 *   2. ensures the repo clone (blob:none),
 *   3. fetches base+head, creates ready-named branches `pr<N>-base` / `pr<N>-head`,
 *   4. MATERIALISES both trees' blobs (checkout) so a later review checkout is
 *      instant — this is the slow part (cold blob fetch), done ONCE here instead
 *      of per review run,
 *   5. writes `manifest-resolved.json` (manifest + SHAs) so the review runner
 *      skips the flaky per-run API resolution.
 *
 * NO CodeAtlas init happens here. Aborts cleanly if disk drops below the guard.
 *
 * Usage: node e2e/benchmark/prefetchBranches.mjs [--repo owner/name] [--min-free-gb 5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const REPO_FILTER = flag('repo', '');
const MIN_FREE = Number(flag('min-free-gb', '5')) * 1024 ** 3;
const REPOS_DIR = process.env.BENCH_REPOS_DIR || path.join(HERE, 'repos');
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR || path.join(HERE, 'results');
const RESOLVED_OUT = path.join(HERE, 'manifest-resolved.json');

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf-8'));
// reuse SHAs already resolved by a previous dry-run / prefetch
const priorShas = {};
for (const f of ['run-dry-run.json', path.basename(RESOLVED_OUT)]) {
    const p = f === path.basename(RESOLVED_OUT) ? RESOLVED_OUT : path.join(RESULTS_DIR, f);
    if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const cases = Array.isArray(j.cases) ? j.cases : Object.values(j);
        for (const c of cases) if (c.url && c.base && c.head) priorShas[c.url] = { base: c.base, head: c.head };
    }
}

const git = (a, cwd) => execFileSync('git', a, { cwd, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const freeBytes = () => { try { const s = fs.statfsSync(REPOS_DIR); return s.bavail * s.bsize; } catch { return Infinity; } };

async function resolveDiff(it) {
    if (priorShas[it.url]) return { ...it, ...priorShas[it.url] };
    const token = process.env.GITHUB_TOKEN || '';
    let last;
    for (let a = 1; a <= 4; a++) {
        try {
            const res = await fetch(`https://api.github.com/repos/${it.repo}/pulls/${it.pr}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codeatlas-prefetch', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
            if (!res.ok) throw new Error(`GitHub ${it.repo}#${it.pr} → ${res.status}`);
            const m = await res.json();
            return { ...it, base: m.base?.sha, head: m.head?.sha };
        } catch (e) { last = e; if (a < 4) await new Promise((r) => setTimeout(r, 1500 * a)); }
    }
    throw last;
}

function ensureClone(repo) {
    const dir = path.join(REPOS_DIR, repo.replace('/', '__'));
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(REPOS_DIR, { recursive: true });
        console.error(`  cloning ${repo}…`);
        git(['clone', '--quiet', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}.git`, dir], REPOS_DIR);
    }
    return dir;
}

let cases = manifest.cases;
if (REPO_FILTER) cases = cases.filter((c) => c.repo === REPO_FILTER);
const resolved = [];
const perRepo = {};
let ready = 0, failed = 0;
for (const raw of cases) {
    if (freeBytes() < MIN_FREE) { console.error(`\nABORT: disk below ${(MIN_FREE / 1024 ** 3).toFixed(0)} GB free — stopping prefetch to protect the volume.`); break; }
    let it;
    try { it = await resolveDiff(raw); } catch (e) { console.error(`  resolve FAILED ${raw.repo}#${raw.pr}: ${e.message}`); failed++; continue; }
    const rp = perRepo[it.repo] || (perRepo[it.repo] = { ready: 0, failed: 0, t0: Date.now() });
    try {
        const dir = ensureClone(it.repo);
        const t0 = Date.now();
        git(['fetch', '--quiet', 'origin', it.base, it.head], dir);
        git(['branch', '-f', `pr${it.pr}-base`, it.base], dir);
        git(['branch', '-f', `pr${it.pr}-head`, it.head], dir);
        // materialise both trees' blobs so a later review checkout is instant
        git(['checkout', '--quiet', '--force', it.head], dir);
        git(['checkout', '--quiet', '--force', it.base], dir);
        const secs = Math.round((Date.now() - t0) / 1000);
        // #870 — local manifest entry the reviewer follows directly (no clone/fetch/API).
        resolved.push({ ...it, dir, baseBranch: `pr${it.pr}-base`, headBranch: `pr${it.pr}-head` });
        ready++; rp.ready++;
        console.error(`  ✓ ${it.repo}#${it.pr} ready (base+head materialised, ${secs}s)`);
    } catch (e) { failed++; rp.failed++; console.error(`  ✗ ${it.repo}#${it.pr}: ${String(e.message).slice(0, 120)}`); }
    fs.writeFileSync(RESOLVED_OUT, JSON.stringify({ ...manifest, cases: resolved }, null, 2));
}

console.error(`\n═══ prefetch: ${ready} PRs ready, ${failed} failed → ${RESOLVED_OUT}`);
for (const [repo, d] of Object.entries(perRepo)) console.error(`  ${repo}: ${d.ready} ready, ${d.failed} failed`);
console.error(`disk free: ${(freeBytes() / 1024 ** 3).toFixed(1)} GB`);
process.exit(failed > 0 ? 1 : 0);
