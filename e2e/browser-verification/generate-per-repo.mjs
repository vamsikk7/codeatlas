#!/usr/bin/env node
/**
 * generate-per-repo.mjs
 *
 * Splits the canonical browser+tool verification suite
 * (e2e/browser-verification-suite.json) into ONE self-contained JSON per repo,
 * so verification can run in PARALLEL (one worker/agent per repo file).
 *
 * For each repo in repoCatalog.repos it:
 *   - resolves which suites/cases apply (applicabilityRules: scope + tags + category/kind)
 *   - intersects case.builds with the repo's runnable builds (heavy repos -> mcp only)
 *   - inlines the shared bits each worker needs: preRunReset, evidenceProtocol,
 *     perfBudgets, conventions, output dir, and (for mcp) the toolCatalog
 *   - writes e2e/browser-verification/repos/<repoId>.suite.json
 *
 * Re-run after editing the master:  node e2e/browser-verification/generate-per-repo.mjs
 * The generated per-repo files are derived artifacts (regenerate any time).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MASTER = join(__dirname, '..', 'browser-verification-suite.json');
const EXPECT = join(__dirname, '..', 'real-projects', 'expectations.json');
const OUT_DIR = join(__dirname, 'repos');

const master = JSON.parse(readFileSync(MASTER, 'utf8'));
let expectations = {};
try { expectations = JSON.parse(readFileSync(EXPECT, 'utf8')); } catch { /* baseline optional */ }
const capMatrix = (master.capabilityMatrix && master.capabilityMatrix.repos) || {};

const FRONTENDISH = new Set(['frontend', 'mobile', 'fullstack', 'multirepo']);
const BACKENDISH = new Set(['backend', 'fullstack', 'multirepo', 'dogfood']);

/** Does a case apply to this repo? (mirrors master.applicabilityRules) */
function caseAppliesToRepo(c, repo, caps) {
  // Capability gate: a `capability`-tagged case runs only if the repo has it.
  if (c.capability && !caps.includes(c.capability)) return false;

  const cat = repo.category;
  const tags = c.tags || [];
  const scope = c.scope || 'workspace';

  if (scope === 'multirepo' || tags.includes('multirepo')) return cat === 'multirepo';
  if (tags.includes('workers')) return repo.hasWorkers === true;
  // Tag/scope matches are OR'd — a case tagged BOTH 'frontend' and 'mobile' (every
  // RENDERFLOW case) must apply to frontend, mobile, fullstack AND multirepo repos,
  // not just `mobile`. The old first-match-wins order let the 'mobile' check
  // short-circuit and wrongly EXCLUDE polar (multirepo) from all frontend drill
  // cases — the root cause of the missing frontend Scout coverage.
  const matchers = [];
  if (tags.includes('frontend') || scope === 'service:clients') matchers.push(FRONTENDISH.has(cat));
  if (tags.includes('mobile')) matchers.push(cat === 'mobile' || cat === 'multirepo' || cat === 'fullstack');
  if (tags.includes('backend') || scope === 'service:server') matchers.push(BACKENDISH.has(cat));
  if (matchers.length) return matchers.some(Boolean);
  // workspace / per-service -> every repo
  return true;
}

/** Runnable builds for a repo: heavy repos are MCP-only. */
function repoBuilds(repo) {
  return repo.heavy ? ['mcp'] : ['vsix', 'mcp'];
}

/** Intersect a case's builds with the repo's runnable builds. */
function caseBuilds(c, repo) {
  const allowed = new Set(repoBuilds(repo));
  return (c.builds || ['vsix', 'mcp']).filter((b) => allowed.has(b));
}

// Clean the output dir so removed repos/cases don't linger.
try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
mkdirSync(OUT_DIR, { recursive: true });

const index = [];
let totalFiles = 0;

for (const repo of master.repoCatalog.repos) {
  const runnable = repoBuilds(repo);
  const caps = capMatrix[repo.id] || [];
  const baseline = expectations[repo.id] || null;
  const suites = [];
  let caseCount = 0;
  let excluded = 0;

  for (const suite of master.suites) {
    const cases = [];
    for (const c of suite.cases) {
      if (!caseAppliesToRepo(c, repo, caps)) { excluded++; continue; }
      const builds = caseBuilds(c, repo);
      if (builds.length === 0) { excluded++; continue; } // e.g. vsix-only case on a heavy (mcp-only) repo
      cases.push({ ...c, builds });
    }
    if (cases.length > 0) suites.push({ id: suite.id, title: suite.title, description: suite.description, cases });
  }
  caseCount = suites.reduce((n, s) => n + s.cases.length, 0);

  const perRepo = {
    $schema: 'internal://codeatlas/browser-verification-suite/per-repo/v1',
    meta: {
      generatedFrom: 'e2e/browser-verification-suite.json',
      generatedFor: repo.id,
      suiteVersion: master.meta.version,
      targetExtensionVersion: master.meta.targetExtensionVersion,
      note: 'Generated artifact — regenerate with node e2e/browser-verification/generate-per-repo.mjs. Run one worker per file for parallel verification.'
    },
    repo,
    runnableBuilds: runnable,
    capabilities: caps,
    baseline: baseline,
    baselineMetrics: master.baselineMetrics ? master.baselineMetrics.fields : undefined,
    outputDir: `tmp/verification-runs/<build>/${repo.id}`,
    mandates: master.meta.mandates,
    preRunReset: master.runMatrix.preRunReset,
    perfEvaluation: master.runMatrix.perfEvaluation,
    evidenceProtocol: master.evidenceProtocol,
    evidenceRecordSchema: master.evidenceRecordSchema,
    perfBudgets: master.conventions.perfBudgets,
    conventions: {
      routeTemplates: master.conventions.routeTemplates,
      toolbar: master.conventions.toolbar,
      l2aToggle: master.conventions.l2aToggle,
      l2bSections: master.conventions.l2bSections,
      diffChannels: master.conventions.diffChannels,
      priority: master.conventions.priority,
      status: master.conventions.status
    },
    toolCatalog: runnable.includes('mcp') ? master.toolCatalog : undefined,
    suites
  };

  const file = join(OUT_DIR, `${repo.id}.suite.json`);
  writeFileSync(file, JSON.stringify(perRepo, null, 2) + '\n');
  totalFiles++;
  index.push({ repo: repo.id, category: repo.category, kind: repo.kind, builds: runnable, capabilities: caps, hasBaseline: !!baseline, suites: suites.length, cases: caseCount, excluded, file: `repos/${repo.id}.suite.json` });
}

// Write an index for the parallel runner.
writeFileSync(
  join(OUT_DIR, '_index.json'),
  JSON.stringify({
    generatedFrom: 'e2e/browser-verification-suite.json',
    suiteVersion: master.meta.version,
    repoCount: totalFiles,
    parallelRunHint: 'Hand each repos/<repo>.suite.json to a separate worker. Each is self-contained (repo meta + applicable cases + preRunReset + evidenceProtocol + perfBudgets). Evidence -> tmp/verification-runs/<build>/<repo>/...',
    repos: index
  }, null, 2) + '\n'
);

console.log(`Generated ${totalFiles} per-repo suites + _index.json in ${OUT_DIR}`);
for (const r of index) console.log(`  ${r.repo.padEnd(24)} ${String(r.builds.join('+')).padEnd(9)} cases=${String(r.cases).padStart(3)} base=${r.hasBaseline ? 'Y' : '-'} caps=[${r.capabilities.join(',')}]`);
