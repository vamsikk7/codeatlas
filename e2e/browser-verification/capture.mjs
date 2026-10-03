#!/usr/bin/env node
/**
 * capture.mjs — Phase 1 (mechanical capture).
 *
 * Drives the live CodeAtlas dashboard for ONE repo and dumps artifacts per case
 * (screenshot + DOM + console) into the output tree. No evaluation, no vision,
 * near-zero LLM. Parallel-safe: run one process per repo, each writing only its
 * own --out tree.
 *
 *   node e2e/browser-verification/capture.mjs \
 *     --suite e2e/browser-verification/repos/polar.suite.json \
 *     --url http://localhost:7742 --build 9.0.30-run01 \
 *     --out tmp/verification-runs/9.0.30-run01/polar \
 *     [--suites SETUP,L1,L2A,LABEL,HEALTH] [--limit 50]
 *
 * The judge (Phase 2, separate session) reads _capture-manifest.json + each case
 * folder, LOOKS at screenshot.png, and writes actual.md / analysis.md / result.json.
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, isAbsolute } from 'path';

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, [])
);
const SUITE = args.suite;
const URL = (args.url || 'http://localhost:7742').replace(/\/$/, '');
const BUILD = args.build || 'dev';
const OUT = args.out || `tmp/verification-runs/${BUILD}/out`;
const ONLY_SUITES = args.suites ? new Set(args.suites.split(',')) : null;
const PRIORITY = args.priority ? new Set(args.priority.split(',')) : null;
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
// Skip the first OFFSET matching cases — lets a long suite (e.g. 104 DIFF cases)
// run in bounded chunks: --offset 0 --limit 8, then --offset 8 --limit 8, …
const OFFSET = args.offset ? parseInt(args.offset, 10) : 0;
const FEATURES = args.features ? parseInt(args.features, 10) : 3; // endpoints per feature-walk
if (!SUITE) { console.error('Missing --suite'); process.exit(2); }

const suite = JSON.parse(readFileSync(SUITE, 'utf8'));
const repo = suite.repo;
// Absolute workspace root on disk for the repo under test — needed by the
// stateful diff-injection primitives ({editFile}) so a case can perturb real
// source and observe the ~modified cascade. Prefer --repo-root, else the suite's
// declared root, else the polar dogfood path.
const REPO_ROOT = (args['repo-root'] && args['repo-root'] !== 'true')
  ? args['repo-root']
  : (repo.rootPath || repo.root || repo.path || '/home/dev/work/personal/polar');

// ---- stateful diff injection: save-and-restore stack ----
// {editFile} pushes the ORIGINAL bytes here; revertAll() restores them (exact
// bytes — never `git checkout`, which is coarse and can clobber unrelated work).
// revertAll runs after every case AND on any exit so a crashed run never leaves
// polar dirty.
const restoreStack = [];
function resolveRepoPath(p) {
  return isAbsolute(p) ? p : join(REPO_ROOT, p);
}
function editRepoFile(relPath, { find, replace, content, append } = {}) {
  const abs = resolveRepoPath(relPath);
  if (!existsSync(abs)) return { ok: false, reason: `not found: ${abs}` };
  const original = readFileSync(abs, 'utf8');
  restoreStack.push({ abs, original });
  let next;
  if (content !== undefined) next = String(content);
  else if (append !== undefined) next = original + String(append);
  else if (find !== undefined) {
    const re = new RegExp(find, replace && replace.includes('$') ? 'm' : 'm');
    if (!re.test(original)) { restoreStack.pop(); return { ok: false, reason: `find /${find}/ not matched in ${relPath}` }; }
    next = original.replace(re, replace ?? '');
  } else return { ok: false, reason: 'editFile needs find|content|append' };
  if (next === original) { restoreStack.pop(); return { ok: false, reason: `no-op edit on ${relPath}` }; }
  writeFileSync(abs, next);
  return { ok: true, abs };
}
function revertAll() {
  while (restoreStack.length) {
    const { abs, original } = restoreStack.pop();
    try { writeFileSync(abs, original); } catch { /* best-effort restore */ }
  }
}
// Safety net: never leave the repo dirty if the process dies mid-case.
process.on('exit', revertAll);
process.on('SIGINT', () => { revertAll(); process.exit(130); });
process.on('SIGTERM', () => { revertAll(); process.exit(143); });

// A tuning agent supplies per-case action overrides here (caseId -> [steps]).
// Steps: {goto}, {clickText,nth}, {click:<cssSelector>,nth}, {pickerPick:<id-substr|index>}, {press:<key>},
//        {type:<text>}, {wait}, {shot}, {expectHashPrefix}.
// Cases without an override use the built-in route/drill defaults.
const ACTIONS = args.actions ? JSON.parse(readFileSync(args.actions, 'utf8')) : {};
// What layer a drill case should LAND on — capture flags landed:false as needsTuning.
const EXPECT_PREFIX = { L3: '#/sequence/', NAV: '#/sequence/', ANCHOR: '#/sequence/', L4: '#/file/', L5: '#/flow/' };

// ---- service resolution (multirepo -> subRepos; else best-effort) ----
const subRepos = repo.subRepos || null;
const isBackendName = (s) => /server|api|backend|svc|service/i.test(s);
const isFrontendName = (s) => /client|web|app|mobile|frontend|ui/i.test(s);

function servicesFor() {
  if (subRepos && subRepos.length) return subRepos;
  return ['workspace']; // single-repo fallback; DOM discovery below may refine
}

const routeFor = (s) => `#/features/${s}`;

/** Map a case to the shots the mechanical runner can produce, or null to skip. */
function shotsForCase(c, services, primary, frontend) {
  const suiteId = c._suite;
  const F = (s, extra = {}) => ({ label: `features-${s}`, route: routeFor(s), ...extra });
  switch (suiteId) {
    case 'SETUP':
    case 'L1':
    case 'DETECT':
      return [{ label: 'system-design', route: '#/system-design' }];
    case 'CLUSTER':
      // Cluster assertions (count/naming/domains) live on the L2a feature view
      // header + the Business Domains map — NOT #/system-design (the wrong-route
      // capture the judge flagged). Capture both.
      return [{ label: `features-${primary}`, route: routeFor(primary) }, { label: 'domains', route: '#/domain/workspace' }];
    case 'L2A':
    case 'L2B':
    case 'ENTRYPOINTS':
    case 'REALTIME':
    case 'NONAPI':
      return [F(primary)];
    case 'LABEL':
      return [F(primary, { readToolbar: true }), ...(frontend && frontend !== primary ? [F(frontend, { readToolbar: true })] : [])];
    case 'RENDERFLOW':
    case 'MOBILE':
      return [F(frontend || primary)];
    case 'HEALTH':
      return [{ label: 'health', route: '#/health/report' }];
    case 'MAP':
      return [{ label: 'knowledge-map', route: '#/map/workspace' }, { label: 'business-domains', route: '#/domain/workspace' }];
    case 'TOUR':
      return [{ label: 'tour', route: '#/tour/workspace' }];
    case 'L3':
    case 'L4':
    case 'L5':
    case 'NAV':
    case 'ANCHOR':
      return [F(primary, { drill: true })];
    default:
      return null; // DIFF/FEATURE/REPLAY/IMPACT/OVERLAYS/COMMENTS/AIREVIEW/SEARCH/EXPORT/PERF/LIFECYCLE/PARITY/MULTIREPO/TOOLS -> need interactive/tool/bash capture
  }
}

const skipReason = {
  DIFF: 'requires edit+resync (stateful) — interactive capture',
  FEATURE: 'requires scaffolding extra files — interactive capture',
  REPLAY: 'requires replay stepping — interactive capture',
  IMPACT: 'requires running Impact — interactive capture',
  OVERLAYS: 'requires opening overlays panel — interactive capture',
  COMMENTS: 'requires add-comment+resync — interactive capture',
  AIREVIEW: 'requires AI run — interactive capture',
  SEARCH: 'requires search input — interactive capture',
  EXPORT: 'requires export action — interactive capture',
  PERF: 'perf sampled via a bash companion, not a screenshot',
  LIFECYCLE: 'reinit/resync timed via a bash companion',
  PARITY: 'cross-build compare — judge diffs the two builds\' shots',
  MULTIREPO: 'scope-picker interaction — interactive capture',
  TOOLS: 'MCP JSON-RPC — captured by a tool-call companion, not the browser',
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1568, height: 820 } });
  const page = await context.newPage();
  const consoleLog = [];
  page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));

  // discovery
  let services = servicesFor();
  await page.goto(`${URL}/index.html#/system-design`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);
  const primary = services.find(isBackendName) || services[0];
  const frontend = services.find(isFrontendName) || null;

  const manifest = { build: BUILD, repo: repo.id, url: URL, capturedAt: null, services, primary, frontend, covered: [], needsTuning: [], skipped: [] };

  // Node interactivity probe (BUG: L4 file-diagram nodes reported rigid).
  async function probeNodeDrag() {
    try {
      const node = page.locator('.react-flow__node').first();
      if (!(await node.count().catch(() => 0))) return { present: false };
      const box = await node.boundingBox(); if (!box) return { present: false };
      const before = (await node.getAttribute('style').catch(() => '')) || '';
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const after = (await node.getAttribute('style').catch(() => '')) || '';
      return { present: true, draggable: before !== after };
    } catch { return { present: false }; }
  }

  // Feature-walk: L2a -> for N endpoints, drill L3 -> L4 (participant) -> L5 (message),
  // screenshotting each hop, recording landing + participant order + node drag.
  // This is what surfaces broken message->L5 / function->L5 nav + wrong participant order.
  // Poll location.hash until it starts with one of `prefixes` (the click's async
  // navigation has settled) or `timeoutMs` elapses. Fixes the stale-`landed`-flag
  // false negatives (BUG-CAPTURE-L4L5-SELECTOR) where the hash was read BEFORE the
  // navigation updated location.hash, so a drill that DID land was recorded as
  // landed:false — the windtunnel crying wolf on a working feature.
  const settleHash = async (prefixes, timeoutMs = 3500) => {
    const start = Date.now();
    let h = await page.evaluate(() => location.hash).catch(() => '');
    while (Date.now() - start < timeoutMs) {
      if (prefixes.some((p) => h.startsWith(p))) return h;
      await page.waitForTimeout(250);
      h = await page.evaluate(() => location.hash).catch(() => '');
    }
    return h;
  };

  async function captureFlowWalk(caseDir, service, n) {
    const featUrl = `${URL}/index.html#/features/${service}`;
    const click = async (re, nth = 0) => { const el = page.getByText(new RegExp(re)).nth(nth); if (await el.count().catch(() => 0)) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(1700); return true; } return false; };
    const hash = () => page.evaluate(() => location.hash).catch(() => '');
    await page.goto(featUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2200);
    const total = await page.getByText(/^(GET|POST|PUT|PATCH|DELETE)$/).count().catch(() => 0);
    const count = Math.min(n, total);
    const chains = [];
    for (let i = 0; i < count; i++) {
      // Spread the sample ACROSS the list so we hit DIFFERENT features (not just the
      // first feature's endpoints) — endpoint-specific bugs (e.g. POST /orders/{id}/invoice)
      // only surface this way.
      const idx = count > 1 ? Math.round((i * (total - 1)) / (count - 1)) : 0;
      await page.goto(featUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1800);
      const epDir = join(caseDir, `ep-${String(i + 1).padStart(2, '0')}`);
      mkdirSync(epDir, { recursive: true });
      let endpoint = '';
      try { endpoint = (await page.getByText(/^(GET|POST|PUT|PATCH|DELETE)$/).nth(idx).locator('xpath=..').innerText()).replace(/\s+/g, ' ').trim().slice(0, 60); } catch { /* */ }
      // L3
      await click('^(GET|POST|PUT|PATCH|DELETE)$', idx);
      const l3 = await hash();
      await page.screenshot({ path: join(epDir, 'L3-sequence.png') }).catch(() => {});
      const participants = await page.evaluate(() => {
        const marks = [...document.querySelectorAll('*')].filter((e) => /^«(actor|module|database|external)»$/.test((e.textContent || '').trim()));
        return marks.map((e) => { const r = e.getBoundingClientRect(); const card = e.closest('div'); const nm = ((card && (card.previousElementSibling || card.parentElement)) ? (card.previousElementSibling || card.parentElement).textContent : '') || ''; return { x: Math.round(r.x), subtitle: (e.textContent || '').trim(), name: nm.trim().split('\n')[0].slice(0, 30) }; }).sort((a, b) => a.x - b.x).map((p) => `${p.name || '?'} ${p.subtitle}`);
      }).catch(() => []);
      // L4 via a «module» participant. The sequence is a React Flow canvas
      // (SequenceView) — participants are `.react-flow__node`s whose click fires
      // onNodeClick → File Diagram. The OLD `.py$` TEXT click hit the
      // non-clickable "API SEQUENCE order.py" header (dup text), so L4 landed
      // 0/N. Click the actual «module» participant NODE instead.
      let l4 = null;
      const modNode = page.locator('.react-flow__node', { hasText: '«module»' }).first();
      if (await modNode.count().catch(() => 0)) {
        await modNode.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        const h = await settleHash(['#/file/', '#/flow/']);
        await page.screenshot({ path: join(epDir, 'L4-file.png') }).catch(() => {});
        const drag = await probeNodeDrag();
        l4 = { hash: h, landed: h.startsWith('#/file/'), nodesDraggable: drag.draggable ?? null };
        await page.goBack().catch(() => {}); await page.waitForTimeout(1400);
      }
      // L5 via a message (BUG under test: often does NOT reach #/flow/)
      let l5 = null;
      if (!(await hash()).startsWith('#/sequence/')) { await page.goto(featUrl, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(1500); await click('^(GET|POST|PUT|PATCH|DELETE)$', idx); }
      if (await click('_service\\.|\\.list\\b|\\.get\\b|\\.create\\b|\\.update\\b|\\.generate|…', 0)) {
        const h = await settleHash(['#/flow/']);
        await page.screenshot({ path: join(epDir, 'L5-flow.png') }).catch(() => {});
        l5 = { hash: h, landed: h.startsWith('#/flow/') };
      }
      chains.push({ endpoint, l3, participants, l4, l5 });
    }
    return { service, endpointsWalked: count, chains };
  }

  // Frontend/mobile SCREEN walk (the FE analogue of captureFlowWalk). A developer
  // exploring a frontend repo picks a SCREEN from the L2a screen list and expects
  // to drill into its render flow (L3) and component<->hook<->data graph (L4). This
  // records: (a) whether the L2a list is ORGANISED by screens/pages/components,
  // (b) per-screen whether the row DRILLS at all (frontend rows currently no-op —
  // BUG-FE-NO-L3L4L5), and (c) the toolbar noun (should read "Entry Points").
  async function captureScreenWalk(caseDir, service, n) {
    const featUrl = `${URL}/index.html#/features/${service}`;
    const hash = () => page.evaluate(() => location.hash).catch(() => '');
    await page.goto(featUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(2500);
    const grouping = await page.evaluate(() => {
      const txt = document.body.innerText;
      return {
        screensLabel: /\bscreens?\b/i.test(txt),
        hasPageComponents: /page\.tsx|\.tsx\b|\.swift\b|\.dart\b/.test(txt),
        frameworkBreakdown: (txt.match(/(expo-router|nextjs-app|nextjs-pages|ios-swiftui|react-native|react|flutter)\s+\d+/gi) || []).slice(0, 6),
        toolbarNoun: (Array.from(document.querySelectorAll('.ca-command-bar-btn')).map((b) => (b.textContent || '').trim()).find((t) => /Entry Points|APIs/.test(t)) || null),
        // route-group headers like "/(checkout)/*", "/(main)/*" = organised by page/route
        routeGroups: (txt.match(/\/\([a-z0-9_-]+\)\/\*/gi) || []).slice(0, 8),
      };
    }).catch(() => ({}));
    await page.screenshot({ path: join(caseDir, '01-screen-list.png') }).catch(() => {});
    // screen LEAF rows carry a route path with a char AFTER the `/(group)/` segment
    // (so we skip `/(group)/*` GROUP HEADERS, which correctly don't drill), or a page file
    const rowRe = /\/\([a-z0-9_-]+\)\/[a-z0-9[]|page\.tsx|\.swift$|\.dart$/i;
    const total = await page.getByText(rowRe).count().catch(() => 0);
    const count = Math.min(n, total);
    const chains = [];
    for (let i = 0; i < count; i++) {
      await page.goto(featUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(1600);
      const dir = join(caseDir, `screen-${String(i + 1).padStart(2, '0')}`);
      mkdirSync(dir, { recursive: true });
      let screen = '';
      try { screen = (await page.getByText(rowRe).nth(i).innerText()).replace(/\s+/g, ' ').trim().slice(0, 70); } catch { /* */ }
      const before = await hash();
      await page.getByText(rowRe).nth(i).click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
      // Screen row → screen-content L2b (#/screen/<id>) or a render-flow route.
      const scHash = await settleHash(['#/screen', '#/flow/', '#/sequence/', '#/file/']);
      await page.screenshot({ path: join(dir, '01-screen-content.png') }).catch(() => {});
      const scLanded = scHash !== before && !/^#\/features\//.test(scHash);
      // The screen-content panel's 5 sections (+ collapsible Visual elements).
      const sections = scLanded ? await page.evaluate(() => {
        const t = document.body.innerText;
        return {
          interactions: /\bInteractions?\b/.test(t),
          dataSources: /\bData\s*sources?\b/i.test(t),
          lifecycle: /\bLifecycle\b/i.test(t),
          navIn: /\bNavigation\s+in\b/i.test(t),
          navOut: /\bNavigation\s+out\b/i.test(t),
          visual: /\bVisual\s+elements?\b/i.test(t),
        };
      }).catch(() => ({})) : {};
      // Deeper drill from screen-content: a data/interaction/component item → L3/L4/L5.
      let deeper = null;
      if (scLanded) {
        const drill = page.getByText(/use(Query|SWR|Mutation|Infinite)|fetch\b|axios|\.tsx\b|\.ts\b|→|->/).first();
        if (await drill.count().catch(() => 0)) {
          await drill.click({ timeout: 3000 }).catch(() => {});
          const dh = await settleHash(['#/flow/', '#/file/', '#/sequence/']);
          await page.screenshot({ path: join(dir, '02-deeper-drill.png') }).catch(() => {});
          deeper = { hash: dh, landed: /^#\/(flow|file|sequence)\//.test(dh) };
        }
      }
      chains.push({ screen, screenContent: { hash: scHash, landed: scLanded, sections }, deeper });
    }
    return { service, grouping, screensWalked: count, totalScreens: total, chains };
  }

  // A tuning agent's action DSL — deterministic primitives it composes per case.
  async function runActions(steps, caseDir) {
    const out = [];
    let n = 0;
    for (const step of steps) {
      if (step.goto) { await page.goto(`${URL}/index.html${step.goto}`, { waitUntil: 'domcontentloaded' }).catch(() => {}); await page.waitForTimeout(step.wait || 2000); }
      else if (step.clickText) { const el = page.getByText(new RegExp(step.clickText)).nth(step.nth || 0); if (await el.count().catch(() => 0)) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(step.wait || 1600); } }
      else if (step.click) { const el = page.locator(step.click).nth(step.nth || 0); if (await el.count().catch(() => 0)) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(step.wait || 1600); } }
      // {clickNode:'«module»'} — click a React Flow node by its text (participants
      // in the L3 sequence, service/infra nodes in L1). Text-only clicks hit
      // non-clickable dup labels; the node click fires onNodeClick → navigation.
      else if (step.clickNode) { const el = page.locator('.react-flow__node', { hasText: new RegExp(step.clickNode) }).nth(step.nth || 0); if (await el.count().catch(() => 0)) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(step.wait || 2000); } }
      // Reliable ScopePicker row pick — the modal rows are <button data-testid=
      // "ca-scope-picker-item" data-scope-item-id=…>. A fuzzy text/coordinate click
      // misses the button (hits a nested span or screenshot-space px), so drive it
      // by the STABLE testid: {pickerPick:'server'} matches data-scope-item-id OR
      // row text (substring, case-insensitive); {pickerPick:0} picks by index.
      else if (step.pickerPick !== undefined) {
        await page.evaluate((sel) => {
          const rows = [...document.querySelectorAll('[data-testid="ca-scope-picker-item"]')];
          const row = typeof sel === 'number' ? rows[sel]
            : rows.find((r) => new RegExp(String(sel), 'i').test(r.getAttribute('data-scope-item-id') || '') || new RegExp(String(sel), 'i').test(r.textContent || ''));
          if (row) row.click();
        }, step.pickerPick).catch(() => {});
        await page.waitForTimeout(step.wait || 2000);
      }
      else if (step.press) { await page.keyboard.press(step.press).catch(() => {}); await page.waitForTimeout(step.wait || 800); }
      else if (step.type !== undefined) { await page.keyboard.type(String(step.type), { delay: 30 }).catch(() => {}); await page.waitForTimeout(step.wait || 800); }
      // ── Stateful diff injection ──────────────────────────────────────────
      // {editFile:'server/polar/x.py', find:'def foo\\(', replace:'def foo(  # PERTURB\\n'}
      // Perturbs REAL source so the live extension's file-watcher rebuilds and
      // the ~modified cascade lands. Pair with {waitResync} then screenshot the
      // annotated layers. {revertAll} (or case-end auto-revert) restores bytes.
      else if (step.editFile) {
        const r = editRepoFile(step.editFile, step);
        out.push({ editFile: step.editFile, ok: r.ok, reason: r.reason || null, level: step.level || null });
        continue; // disk op — no screenshot
      }
      else if (step.revertAll) { revertAll(); continue; }
      // {waitResync:3500} — let the save→debounce→rebuild→cascade settle. Optionally
      // poll for a diff marker so we don't screenshot before annotations paint.
      else if (step.waitResync !== undefined) {
        const ms = typeof step.waitResync === 'number' ? step.waitResync : 4000;
        await page.waitForTimeout(ms);
        continue;
      }
      // {clickCommand:'Sync'|'Code Review'|'Replay'} — click a command-bar button
      // by its visible label (the ☰ toolbar entries).
      else if (step.clickCommand) {
        await page.evaluate((name) => {
          const btns = [...document.querySelectorAll('.ca-command-bar button, .ca-command-bar [role="button"], .ca-command-bar-btn, button')];
          const b = btns.find((x) => new RegExp(name, 'i').test((x.textContent || '').trim()));
          if (b) b.click();
        }, step.clickCommand).catch(() => {});
        await page.waitForTimeout(step.wait || 2500);
      }
      // {replay:'play'|'step'|'stop'} — drive the commit-timeline replay controls.
      else if (step.replay) {
        const sym = step.replay === 'play' ? '▶' : step.replay === 'step' ? '⏭|›|Next|▶▶' : '■|⏹|Stop|✕';
        await page.evaluate((s) => {
          const els = [...document.querySelectorAll('button, [role="button"]')];
          const b = els.find((x) => new RegExp(s).test((x.textContent || '').trim()));
          if (b) b.click();
        }, sym).catch(() => {});
        await page.waitForTimeout(step.wait || 2500);
      }
      // {aiReview:true} — trigger the ✨ Code Review run and wait for findings.
      else if (step.aiReview) {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button, [role="button"]')].find((x) => /Code Review|Ask AI|✨/i.test((x.textContent || '').trim()));
          if (b) b.click();
        }).catch(() => {});
        await page.waitForTimeout(step.wait || 8000);
      }
      // {injectMessage:{type:'aiReviewResult',result:{…}}} — dispatch a server→
      // webview MessageEvent straight into the page. This activates OVERLAY state
      // (AI review findings, comments, impact, …) WITHOUT a live LLM/backend, so
      // cross-feature "overlay active × navigate" interactions become testable and
      // deterministic. Feeding deliberately INCOMPLETE payloads (missing byGraph/
      // summary/bindings) is how we regression-guard BUG-AIREVIEW-BLOCKS-L2NAV
      // (an unguarded overlay render used to crash the whole diagram → nav dead).
      else if (step.injectMessage !== undefined) {
        await page.evaluate((m) => { window.dispatchEvent(new MessageEvent('message', { data: m })); }, step.injectMessage).catch(() => {});
        await page.waitForTimeout(step.wait || 1500);
        continue; // state injection — no screenshot of its own
      }
      else if (step.wait) { await page.waitForTimeout(step.wait); }
      if (step.shot || step.clickText || step.click || step.clickNode || step.pickerPick !== undefined || step.press || step.type !== undefined || step.goto || step.clickCommand || step.replay || step.aiReview || step.waitShot) {
        const file = `${String(++n).padStart(2, '0')}-${step.shot || step.label || 'step'}.png`;
        await page.screenshot({ path: join(caseDir, file) }).catch(() => {});
        // Crash detection (BUG-AIREVIEW-BLOCKS-L2NAV class): flag if the render
        // boundary tripped or the app blanked. The arbiter treats crashed:true as
        // an automatic FAIL — a diagram must survive any overlay/data state.
        const probe = await page.evaluate(() => {
          const t = document.body?.innerText || '';
          return {
            hash: location.hash,
            crashed: /Something went wrong|error occurred while rendering/i.test(t),
            blank: t.trim().length < 20,
            hasDiagram: !!document.querySelector('.react-flow, .ca-api-list, [class*="feature"]'),
          };
        }).catch(() => ({ hash: '', crashed: false, blank: false, hasDiagram: false }));
        out.push({ file, route: probe.hash, crashed: probe.crashed, blank: probe.blank, hasDiagram: probe.hasDiagram, expectHashPrefix: step.expectHashPrefix });
      }
    }
    return out;
  }
  let count = 0;
  let matched = 0; // cases that pass the suite/priority filter (for --offset chunking)

  for (const s of suite.suites) {
    if (ONLY_SUITES && !ONLY_SUITES.has(s.id)) continue;
    for (const c of s.cases) {
      if (PRIORITY && !PRIORITY.has(c.priority)) continue;
      matched++;
      if (matched <= OFFSET) continue;   // skip this chunk's predecessors
      if (count >= LIMIT) break;
      const cc = { ...c, _suite: s.id };
      const caseDir = join(OUT, s.id, c.id);
      const writeExpected = () => writeFileSync(join(caseDir, 'expected.md'), `# ${c.id} — ${c.title}\n\n**Priority:** ${c.priority}  **Scope:** ${c.scope}  **Builds:** ${(c.builds || []).join(', ')}\n\n## Steps\n${(c.steps || []).map((x) => `- ${x}`).join('\n')}\n\n## Expected\n${(c.expected || []).map((x) => `- ${x}`).join('\n')}\n\n## Verify\n- method: ${c.verify?.method}\n- assertions: ${(c.verify?.assertions || []).join('; ')}\n`);

      // CONNECT-01 = the multi-endpoint L3->L4->L5 feature-walk (handled BEFORE route-capture).
      if (c.id === 'CONNECT-01') {
        mkdirSync(caseDir, { recursive: true });
        writeExpected();
        const walk = await captureFlowWalk(caseDir, primary, FEATURES);
        writeFileSync(join(caseDir, 'capture.json'), JSON.stringify({ case: c.id, suite: s.id, build: BUILD, repo: repo.id, service: primary, flowWalk: walk, capturedAt: null }, null, 2) + '\n');
        const brokenL5 = walk.chains.filter((ch) => ch.l5 && !ch.l5.landed).map((ch) => ch.endpoint);
        const brokenL4 = walk.chains.filter((ch) => ch.l4 && !ch.l4.landed).map((ch) => ch.endpoint);
        const rigid = walk.chains.filter((ch) => ch.l4 && ch.l4.nodesDraggable === false).map((ch) => ch.endpoint);
        manifest.covered.push({ case: c.id, suite: s.id, frames: [`${walk.endpointsWalked} endpoints × L3/L4/L5`], dir: join(s.id, c.id), landed: brokenL5.length === 0 });
        if (brokenL5.length || brokenL4.length || rigid.length) manifest.needsTuning.push({ case: c.id, suite: s.id, reason: `L5-unreached:[${brokenL5.join(', ') || 'none'}] L4-unreached:[${brokenL4.join(', ') || 'none'}] rigidNodes:[${rigid.join(', ') || 'none'}] — verify the click selector; if a correct click still doesn't open Function Flow, it is a CONFIRMED navigation BUG` });
        count++;
        continue;
      }

      // WALK-<REPO> = polar-scoped deep walk. Backend repos → captureFlowWalk
      // (L2a→L3→L4→L5 endpoint drill); frontend/mobile → captureScreenWalk.
      if (c.id.startsWith('WALK-')) {
        const isFe = /clients|web|app|mobile|frontend|ui/i.test(c.id) || (c.tags || []).includes('clients');
        const svc = isFe ? (frontend || 'clients') : (primary || 'server');
        mkdirSync(caseDir, { recursive: true });
        writeExpected();
        const walk = isFe ? await captureScreenWalk(caseDir, svc, FEATURES) : await captureFlowWalk(caseDir, svc, FEATURES);
        writeFileSync(join(caseDir, 'capture.json'), JSON.stringify({ case: c.id, suite: s.id, build: BUILD, repo: repo.id, service: svc, [isFe ? 'screenWalk' : 'flowWalk']: walk, capturedAt: null }, null, 2) + '\n');
        const broken = isFe
          ? (walk.chains || []).filter((ch) => !ch.screenContent?.landed).map((ch) => ch.screen)
          : (walk.chains || []).filter((ch) => (ch.l5 && !ch.l5.landed) || (ch.l4 && !ch.l4.landed)).map((ch) => ch.endpoint);
        manifest.covered.push({ case: c.id, suite: s.id, frames: [`${isFe ? walk.screensWalked : walk.endpointsWalked} × drill`], dir: join(s.id, c.id), landed: broken.length === 0 });
        if (broken.length) manifest.needsTuning.push({ case: c.id, suite: s.id, reason: `did not drill:[${broken.slice(0, 5).join(', ') || 'none'}]` });
        count++;
        continue;
      }

      // RENDER-WALK / RENDER-02 = the FRONTEND per-screen L2a->L3->L4 walk.
      if (c.id === 'RENDER-WALK' || c.id === 'RENDER-02') {
        const feService = frontend || primary;
        mkdirSync(caseDir, { recursive: true });
        writeExpected();
        const walk = await captureScreenWalk(caseDir, feService, FEATURES);
        writeFileSync(join(caseDir, 'capture.json'), JSON.stringify({ case: c.id, suite: s.id, build: BUILD, repo: repo.id, service: feService, screenWalk: walk, capturedAt: null }, null, 2) + '\n');
        const noDrill = walk.chains.filter((ch) => !ch.screenContent?.landed).map((ch) => ch.screen);
        const organised = !!(walk.grouping?.screensLabel && (walk.grouping?.routeGroups?.length || walk.grouping?.hasPageComponents));
        // screen-content 5-section coverage across the walked screens (Round 2)
        const REQ = ['interactions', 'dataSources', 'lifecycle', 'navIn', 'navOut'];
        const missingSections = REQ.filter((k) => !walk.chains.some((ch) => ch.screenContent?.sections?.[k]));
        manifest.covered.push({ case: c.id, suite: s.id, frames: [`${walk.screensWalked}/${walk.totalScreens} screens × content/drill`], dir: join(s.id, c.id), landed: noDrill.length === 0 });
        if (noDrill.length || missingSections.length) manifest.needsTuning.push({ case: c.id, suite: s.id, reason: `screens NOT drilling:[${noDrill.slice(0, 4).join(', ') || 'none'}] missing screen-content sections:[${missingSections.join(', ') || 'none'}] organisedByScreens=${organised} toolbarNoun=${walk.grouping?.toolbarNoun}` });
        count++;
        continue;
      }

      const shots = shotsForCase(cc, services, primary, frontend);
      // A case with explicit ACTIONS is capturable even if it has no default
      // route-shot mapping — this is how the previously-stubbed stateful suites
      // (DIFF/REPLAY/IMPACT/AIREVIEW/OVERLAYS/SEARCH/…) now run: the case carries
      // an {editFile}/{waitResync}/{replay}/{aiReview} action program.
      if (!shots && !ACTIONS[c.id]) {
        manifest.skipped.push({ case: c.id, suite: s.id, reason: skipReason[s.id] || 'not route-capturable' });
        continue;
      }
      mkdirSync(caseDir, { recursive: true });
      writeExpected();

      const frames = [];
      let toolbarL2b = null;
      let frameNo = 0;
      const snap = async (label, route) => {
        const isSingle = shots.length === 1 && !shots[0].drill;
        const file = isSingle ? 'screenshot.png' : `${String(++frameNo).padStart(2, '0')}-${label}.png`;
        await page.screenshot({ path: join(caseDir, file), fullPage: false }).catch(() => {});
        const hash = await page.evaluate(() => location.hash).catch(() => route);
        frames.push({ file, label, route: hash || route, toolbarL2b: undefined });
        return hash;
      };
      const clickFirst = async (re) => {
        const el = page.getByText(re).first();
        if (await el.count().catch(() => 0)) { await el.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(1800); return true; }
        return false;
      };
      const override = ACTIONS[c.id];
      const perturbations = [];
      if (override) {
        for (const af of await runActions(override, caseDir)) {
          if (af.editFile) perturbations.push(af);
          else frames.push({ file: af.file, label: 'action', route: af.route, crashed: af.crashed, blank: af.blank, hasDiagram: af.hasDiagram, expectHashPrefix: af.expectHashPrefix });
        }
      } else
      for (const shot of shots) {
        const url = `${URL}/index.html${shot.route}`;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2200);
          if (shot.readToolbar) {
            toolbarL2b = await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('.ca-command-bar button, .ca-command-bar [role="button"]'));
              return btns.map((b) => (b.textContent || '').trim()).find((x) => /API|Entry Point/i.test(x)) || null;
            }).catch(() => null);
          }
          if (shot.drill) {
            // Deterministic CLICK-THROUGH: L2a -> (click endpoint row) L3 -> (click message) L5.
            await snap('L2a', shot.route);
            if (await clickFirst(/^(GET|POST|PUT|PATCH|DELETE)$/)) {
              const l3 = await snap('L3', null);
              // from L3, click the first message label to drill to the flow
              if (await clickFirst(/->|→|GET |POST |PUT |PATCH |DELETE /)) {
                await snap('L5-flow', null);
              }
              shot.route = l3;
            } else {
              await snap('L2a-noclick', shot.route);
            }
          } else {
            const f = await snap(shot.label, shot.route);
            if (shot.readToolbar) frames[frames.length - 1].toolbarL2b = toolbarL2b;
          }
        } catch { await snap(shot.label + '-err', shot.route); }
      }
      // dump DOM text + console of the last view
      const domText = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || '').catch(() => '');
      writeFileSync(join(caseDir, 'dom.txt'), domText);
      writeFileSync(join(caseDir, 'console.txt'), consoleLog.slice(-80).join('\n'));
      // Landing check: did an interactive/drill case reach the layer it should?
      const expectPrefix = EXPECT_PREFIX[s.id];
      const landed = expectPrefix ? frames.some((f) => (f.route || '').startsWith(expectPrefix)) : null;
      const actionsSource = override ? 'agent-tuned actions' : (shots.some((x) => x.drill) ? 'default drill (first endpoint row)' : 'route navigation');
      // A crashed/blank frame is a CONFIRMED render bug (BUG-AIREVIEW-BLOCKS-L2NAV
      // class) — the diagram must never blank/error-boundary regardless of overlay
      // or data state. Surface it prominently so the arbiter fails the case.
      const crashedFrames = frames.filter((f) => f.crashed || f.blank).map((f) => f.file);
      writeFileSync(join(caseDir, 'capture.json'), JSON.stringify({ case: c.id, suite: s.id, build: BUILD, repo: repo.id, frames, perturbations, crashedFrames, expectHashPrefix: expectPrefix || null, landed, actionsSource, capturedAt: null }, null, 2) + '\n');
      manifest.covered.push({ case: c.id, suite: s.id, frames: frames.map((f) => f.file), perturbed: perturbations.length > 0, crashed: crashedFrames.length > 0, dir: join(s.id, c.id), landed });
      if (crashedFrames.length) manifest.needsTuning.push({ case: c.id, suite: s.id, reason: `CONFIRMED RENDER CRASH — diagram blanked / error-boundary tripped on frame(s): [${crashedFrames.join(', ')}]. The overlay/data state must never crash the diagram.` });
      if (expectPrefix && !landed) manifest.needsTuning.push({ case: c.id, suite: s.id, expected: expectPrefix, got: frames.map((f) => f.route).filter(Boolean).pop() || null, reason: 'drill did not reach the expected layer — a tuning agent must set ACTIONS[' + c.id + '] with the right click target' });
      // STATEFUL CLEANUP: restore any files this case perturbed, then let the
      // extension re-cascade back to clean so the NEXT case starts from a pristine
      // baseline (never rely on git — exact-byte restore).
      if (perturbations.length) { revertAll(); await page.waitForTimeout(3000); }
      count++;
    }
  }

  writeFileSync(join(OUT, '_capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await browser.close();
  console.log(`[capture] ${repo.id} @ ${URL}: covered=${manifest.covered.length} skipped=${manifest.skipped.length} -> ${OUT}`);
}

main().catch((e) => { console.error('[capture] fatal:', e.message); process.exit(1); });
