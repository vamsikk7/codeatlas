#!/usr/bin/env node
/**
 * generate-polar-scoped.mjs — build a FULLY-SCOPED polar test suite.
 *
 * Reads polar's per-sub-repo CodeAtlas state DBs, enumerates every feature
 * (cluster) and the entry-point TYPES within it, and emits:
 *   - polar-scoped.suite.json  — 100-200 cases across 5 dimensions
 *   - polar-scoped.actions.json — the ACTIONS program per case (drives capture.mjs)
 *
 * Dimensions (see the user's directive: full L1→L5 walk of every entry-point type
 * per feature; inject a diff at different code levels for ≥1 entry point per
 * feature; observe replay + the code-review context each change generates):
 *   WALK   — per sub-repo, a deep endpoint walk L2a→L3→L4→L5 (participants + functions)
 *   TYPE   — per (repo, entry-point-type), open one entry point of that type and drill
 *   DIFF   — per feature × 3 code-levels (comment / new-symbol / handler-body) →
 *            {editFile} → {waitResync} → screenshot the PER-REPO diff → {revertAll}
 *   REPLAY — per sub-repo, drive the commit-timeline replay over real git history
 *   REVIEW — per feature, inject a diff then run AI Code Review and capture the context
 *
 * Usage:
 *   node e2e/browser-verification/generate-polar-scoped.mjs \
 *     [--polar /home/dev/work/personal/polar] [--out e2e/browser-verification]
 *     [--features-per-repo 20] [--endpoints-per-walk 14]
 */
import { execFileSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return a;
}, []));
const POLAR = args.polar && args.polar !== 'true' ? args.polar : '/home/dev/work/personal/polar';
const OUT = args.out && args.out !== 'true' ? args.out : 'e2e/browser-verification';
const FEATURES_PER_REPO = parseInt(args['features-per-repo'] || '20', 10);
const ENDPOINTS_PER_WALK = parseInt(args['endpoints-per-walk'] || '14', 10);
const REVIEW_FEATURES = parseInt(args['review-features'] || '8', 10);

// Sub-repos that carry entry points (docs/handbook have none).
const SUBREPOS = [
  { repo: 'server', graph: 'feature:service:main', lang: 'py' },
  { repo: 'clients', graph: null, lang: 'ts' }, // clients: pick the largest feature graph
];

function sql(db, q) {
  try { return execFileSync('sqlite3', [db, q], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }); }
  catch { return ''; }
}

/** Derive a stable, human "feature" key from an entry point's file path.
 *  server/polar/<feature>/…  → <feature>;  clients/apps/<app>/…|packages/<pkg>/… → app/pkg. */
function featureKey(filePath) {
  if (!filePath) return 'misc';
  let m = filePath.match(/\/polar\/([a-z0-9_]+)/i);        // FastAPI backend
  if (m) return m[1];
  m = filePath.match(/(?:apps|packages)\/([a-z0-9_-]+)/i);  // JS/TS monorepo
  if (m) return m[1];
  m = filePath.match(/(?:migrations|scripts|tests)\//i);
  if (m) return filePath.split('/').slice(-2, -1)[0] || 'root';
  return filePath.split('/').slice(0, 2).join('/') || 'misc';
}

/** Load a sub-repo's features from the `apis` table — uniform for backend
 *  (HTTP/JOB/CLI/…) and frontend (SCREEN/NAV_ROUTE/NETWORK/…). Returns
 *  [{label,sampleFile,ext,handler,types[],apiCount}] sorted by size, plus a
 *  flat `_types` map type→representative entry point. */
function loadFeatures(sub) {
  const db = join(POLAR, sub.repo, '.codeatlas', 'state.db');
  if (!existsSync(db)) return [];
  // Pull every entry point as JSON lines (method|route|filePath|handlerName).
  const raw = sql(db, "SELECT json_extract(record_json,'$.method')||'\t'||coalesce(json_extract(record_json,'$.route'),'')||'\t'||coalesce(json_extract(record_json,'$.filePath'),'')||'\t'||coalesce(json_extract(record_json,'$.handlerName'),'') FROM apis WHERE snapshot_kind='working';");
  const rows = raw.trim().split('\n').filter(Boolean).map((l) => {
    const [method, route, filePath, handler] = l.split('\t');
    return { method, route, filePath, handler: handler || null };
  }).filter((r) => r.method && r.filePath && /\.(py|ts|tsx|js|jsx|dart|swift|kt)$/.test(r.filePath));
  // group into features
  const byFeat = new Map();
  const byType = new Map();
  for (const r of rows) {
    const key = featureKey(r.filePath);
    if (!byFeat.has(key)) byFeat.set(key, { label: key, files: new Set(), types: new Set(), apiCount: 0, rep: r });
    const f = byFeat.get(key);
    f.files.add(r.filePath); f.types.add(r.method); f.apiCount++;
    // prefer an HTTP/handler-bearing rep for the diff target
    if (r.handler && (!f.rep.handler)) f.rep = r;
    if (!byType.has(r.method)) byType.set(r.method, r);
  }
  const feats = [...byFeat.values()].map((f) => {
    const sampleFile = f.rep.filePath;
    const ext = (sampleFile.match(/\.(\w+)$/) || [, ''])[1];
    return { label: f.label, sampleFile, ext, handler: f.rep.handler, types: [...f.types], apiCount: f.apiCount };
  }).filter((f) => f.apiCount > 0).sort((a, b) => b.apiCount - a.apiCount);
  feats._types = byType; // stash the type→rep map for TYPE cases
  return feats;
}

// language-aware edit programs for the 3 diff levels.
function editFor(level, feat) {
  const f = feat.sampleFile;
  if (feat.ext === 'py') {
    if (level === 'comment') return { editFile: f, append: '\n# CA-E2E-DIFF-PROBE comment-level change\n', level };
    if (level === 'new-symbol') return { editFile: f, append: '\n\ndef ca_e2e_diff_probe():  # CA-E2E-DIFF-PROBE structural add\n    return 42\n', level };
    if (level === 'handler-body' && feat.handler) return { editFile: f, find: `def ${feat.handler}\\(`, replace: `def ${feat.handler}(  # CA-E2E-DIFF-PROBE body-level\\n`, level };
    return { editFile: f, append: '\n# CA-E2E-DIFF-PROBE\n', level };
  }
  // ts/tsx/js
  if (level === 'comment') return { editFile: f, append: '\n// CA-E2E-DIFF-PROBE comment-level change\n', level };
  if (level === 'new-symbol') return { editFile: f, append: '\n\nexport function caE2eDiffProbe() { return 42; } // CA-E2E-DIFF-PROBE structural add\n', level };
  if (level === 'handler-body' && feat.handler) return { editFile: f, find: `(function|const)\\s+${feat.handler}\\b`, replace: `$1 ${feat.handler} /* CA-E2E-DIFF-PROBE body-level */`, level };
  return { editFile: f, append: '\n// CA-E2E-DIFF-PROBE\n', level };
}

const mkCase = (id, title, tags, steps, expected, assertions) => ({
  id, title, priority: 'P1', builds: ['vsix'], scope: 'multirepo',
  route: null, steps: steps || [], expected: expected || [],
  verify: { method: 'visual+dom', assertions: assertions || [] },
  tags: tags || [], capability: null, status: 'untested',
});

// ── build the matrix ────────────────────────────────────────────────────────
const suites = {};
const actions = {};
const push = (suiteId, c) => { (suites[suiteId] ||= []).push(c); };

for (const sub of SUBREPOS) {
  const feats = loadFeatures(sub);
  const repo = sub.repo;
  const featUrl = `#/features/${repo}`;
  if (!feats.length) { console.warn(`[gen] no features for ${repo}`); continue; }

  // WALK — one deep endpoint walk per sub-repo (L2a→L3→L4→L5, many endpoints).
  {
    const id = `WALK-${repo.toUpperCase()}`;
    push('WALK', mkCase(id, `Deep L1→L5 walk of ${repo} — ${ENDPOINTS_PER_WALK} endpoints × participants+functions`,
      ['walk', repo, 'connect'],
      [`Open ${featUrl}`, 'Drill each endpoint L3 (sequence) → L4 (participant file) → L5 (function flow)', 'Screenshot every hop'],
      ['participant order caller-before-callee', 'L4 lands on #/file/', 'L5 lands on #/flow/'],
      ['landed_l3', 'landed_l4', 'landed_l5']));
    // Uses the built-in flowWalk via a WALK-* handler (added to capture.mjs); no ACTIONS needed.
  }

  // TYPE — one entry point of each distinct type, drilled. Backend and frontend
  // L2a lists are STRUCTURALLY different: backend = API rows (GET/POST/…) that
  // open a React-Flow sequence (L3) whose «module» participants open File
  // Diagrams (L4); frontend = SCREEN rows (route paths / page.tsx) that open a
  // screen-content panel (L2b) whose data/interaction items drill deeper.
  const isFe = /clients|web|app|mobile|frontend|ui/i.test(repo);
  const seenTypes = new Set();
  let typeIdx = 0;
  for (const feat of feats) {
    for (const t of feat.types) {
      if (seenTypes.has(t)) continue;
      seenTypes.add(t);
      const id = `TYPE-${repo.toUpperCase()}-${t}`;
      push('ENTRYTYPES', mkCase(id, `${repo}: open a ${t} entry point (feature "${feat.label}") and drill`,
        ['entrytype', repo, t.toLowerCase(), isFe ? 'frontend' : 'backend'],
        [`Open ${featUrl}`, isFe ? 'Click a screen row → screen-content' : `Click a ${t} row → L3 → «module» participant → L4`, 'Screenshot each layer'],
        [`a ${t} entry point exists and drills to a real diagram`],
        ['type_present', 'drill_landed']));
      actions[id] = isFe
        ? [
            { goto: featUrl, wait: 3000, shot: `L2a-${repo}` },
            // spread the screen picks so distinct screens are captured per type
            { clickText: '\\/\\([a-z0-9_-]+\\)\\/[a-z0-9\\[]|page\\.tsx', nth: (typeIdx % 8), wait: 2600, shot: 'screen-content', expectHashPrefix: '#/screen' },
            { clickText: 'use(Query|SWR|Mutation|Infinite)|fetch\\b|axios|\\.tsx\\b|→|->', nth: 0, wait: 2600, shot: 'deeper-drill', expectHashPrefix: '#/flow/' },
          ]
        : [
            { goto: featUrl, wait: 3000, shot: `L2a-${repo}` },
            { clickText: `^${t}$`, nth: 0, wait: 2600, shot: `L3-${t}` },
            { clickNode: '«module»', nth: 0, wait: 2800, shot: 'L4-participant', expectHashPrefix: '#/file/' },
          ];
      typeIdx++;
    }
  }

  // DIFF — per feature × 3 levels: inject → waitResync → per-repo diff shot → revert.
  const diffFeats = feats.slice(0, FEATURES_PER_REPO);
  for (const feat of diffFeats) {
    for (const level of ['comment', 'new-symbol', 'handler-body']) {
      const edit = editFor(level, feat);
      if (level === 'handler-body' && !feat.handler) continue; // no handler to target
      const safe = feat.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 20);
      const id = `DIFF-${repo.toUpperCase()}-${safe}-${level}`;
      push('DIFF', mkCase(id, `${repo}/${feat.label}: ${level} diff annotates the containing layers`,
        ['diff', repo, level, 'stateful'],
        [`Baseline-shot ${featUrl}`, `Edit ${feat.sampleFile} (${level})`, 'Wait for the auto-watcher cascade (~30s, big repo)', 'Screenshot the per-repo view showing ~modified', 'Revert byte-clean'],
        ['per-repo view shows a ~modified marker on the edited feature/file after the edit', 'view returns to clean after revert'],
        ['diff_visible', 'reverted_clean']));
      actions[id] = [
        { goto: featUrl, wait: 3000, shot: 'before-clean' },
        edit,
        { waitResync: repo === 'server' ? 18000 : 12000 },
        { goto: '#/system-design', wait: 3000, shot: 'L1-after-edit' },
        { goto: featUrl, wait: 3500, shot: 'perrepo-L2a-after-edit' },
        { revertAll: true },
        { waitResync: repo === 'server' ? 14000 : 9000 },
        { goto: featUrl, wait: 3000, shot: 'after-revert-clean' },
      ];
    }
  }

  // REPLAY — drive the commit-timeline replay over the sub-repo's real git history.
  {
    const id = `REPLAY-${repo.toUpperCase()}`;
    push('REPLAY', mkCase(id, `Replay ${repo}'s commit timeline — steps render architecture evolution`,
      ['replay', repo],
      ['Open #/system-design', 'Trigger Replay', `Pick the ${repo} repo`, 'Step through commits', 'Screenshot the stepping'],
      ['replay picker opens', 'stepping advances and re-renders diagrams'],
      ['replay_opened', 'replay_stepped']));
    actions[id] = [
      { goto: '#/system-design', wait: 3000, shot: 'L1' },
      { clickCommand: 'Replay', wait: 3000, shot: 'replay-picker' },
      { pickerPick: repo, wait: 4000, shot: 'replay-first-step' },
      { replay: 'play', wait: 4000, shot: 'replay-playing' },
      { replay: 'step', wait: 3000, shot: 'replay-next' },
      { replay: 'stop', wait: 2000, shot: 'replay-stopped' },
    ];
  }

  // REVIEW — per top-feature, inject a diff then run AI Code Review + capture context.
  for (const feat of feats.slice(0, REVIEW_FEATURES)) {
    const edit = editFor('new-symbol', feat);
    const safe = feat.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 20);
    const id = `REVIEW-${repo.toUpperCase()}-${safe}`;
    push('AIREVIEW', mkCase(id, `Code Review context for a change in ${repo}/${feat.label}`,
      ['aireview', repo, 'stateful'],
      [`Edit ${feat.sampleFile} (new symbol)`, 'Wait for cascade', 'Run AI Code Review', 'Capture the generated review context/findings', 'Revert'],
      ['review runs and produces findings/context referencing the changed symbol'],
      ['review_ran', 'context_captured']));
    actions[id] = [
      edit,
      { waitResync: repo === 'server' ? 30000 : 15000 },
      { goto: '#/system-design', wait: 3000, shot: 'L1-with-change' },
      { aiReview: true, wait: 12000, shot: 'review-running' },
      { wait: 8000, shot: 'review-findings', waitShot: true },
      { revertAll: true },
      { waitResync: repo === 'server' ? 18000 : 9000 },
    ];
  }
}

// clean the stray noop guard I pushed above
if (suites.DIFF) suites.DIFF = suites.DIFF.filter((c) => c && c.id);

// ── assemble the suite file (mirror the per-repo suite shape capture.mjs reads) ──
const polarSuite = JSON.parse(execFileSync('cat', [join(OUT, 'repos', 'polar.suite.json')], { encoding: 'utf8' }));
const scoped = {
  $schema: 'polar-scoped',
  meta: {
    generatedFrom: 'generate-polar-scoped.mjs', repo: 'polar',
    note: 'Fully-scoped polar walkthrough + diff/replay/review suite. Stateful cases perturb real source via {editFile} and auto-revert (exact-byte). Run headless against a live 7742 (VSIX) instance.',
  },
  repo: polarSuite.repo,
  runnableBuilds: ['vsix'],
  capabilities: polarSuite.capabilities,
  outputDir: 'tmp/verification-runs/<build>/polar-scoped',
  suites: Object.entries(suites).map(([id, cases]) => ({ id, cases })),
};

const total = scoped.suites.reduce((n, s) => n + s.cases.length, 0);
writeFileSync(join(OUT, 'polar-scoped.suite.json'), JSON.stringify(scoped, null, 2) + '\n');
writeFileSync(join(OUT, 'polar-scoped.actions.json'), JSON.stringify(actions, null, 2) + '\n');
console.log(`[gen] wrote ${total} cases across ${scoped.suites.length} suites + ${Object.keys(actions).length} action programs`);
for (const s of scoped.suites) console.log(`  ${s.id}: ${s.cases.length}`);
