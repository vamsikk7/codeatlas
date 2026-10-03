/**
 * Regression (T3-tier): a body edit inside an inline ANONYMOUS route handler
 * (`router.get('/x', (req, res) => { ...+new statement... })`) must stamp the
 * diff cascade — L5 flow AND the L3 sequence AND the L2 api-list/feature — as
 * modified. A NAMED handler with the identical edit is the control.
 *
 * The change is body-only (no call added/removed) so it does NOT surface via
 * the sequence builder's structural diff; it relies on the L5 flow diff, which
 * is where the anon-handler regression lived (symbolExtractor omitted `bodySrc`
 * → the save-time reconstruction built invalid JS → buildDiffMap parse-failed →
 * zero stamped nodes → L3/L2 read unchanged).
 *
 * Uses the real SnapshotStore + SyncOrchestrator cascade harness (runScenario +
 * rebuildFile), i.e. the same path the live extension runs on save.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, modifiedApiListEntries, type ScenarioResult } from '../../../e2e/real-projects/cascadeHarness';

const NAMED = `const express = require('express');
const router = express.Router();
function getX(req, res) {
  const timestamp = Date.now();
  res.json({ ok: true, timestamp });
}
router.get('/x', getX);
module.exports = router;
`;

const ANON = `const express = require('express');
const router = express.Router();
router.get('/x', (req, res) => {
  const timestamp = Date.now();
  res.json({ ok: true, timestamp });
});
module.exports = router;
`;

function mkFixture(prefix: string, code: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'x.js'), code, 'utf-8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'anon-repro', version: '1.0.0', dependencies: { express: '^4.0.0' },
    }), 'utf-8');
    return dir;
}

// Body-only logic edit: insert a new statement inside the handler (no new
// inter-module call / participant), then rebuild through the live cascade.
async function editBodyAndRebuild(scn: ScenarioResult) {
    const abs = path.join(scn.repoCopyDir, 'src', 'x.js');
    const src = fs.readFileSync(abs, 'utf-8');
    fs.writeFileSync(abs, src.replace(
        'const timestamp = Date.now();',
        'const _probe = 42;\n  const timestamp = Date.now();',
    ), 'utf-8');
    await scn.sync.rebuildFile(abs);
    return scn.store.getWorking();
}

const flowMods = (working: any, fnName: string) => {
    const g = working.graphs[`flow:src/x.js:${fnName}`];
    return { present: !!g, dirty: g ? g.nodes.filter((n: any) => n.diff && n.diff !== 'unchanged').length : 0, g };
};

// L3: any sequence:* graph carrying a modified node or edge.
const seqMods = (working: any) => Object.entries(working.graphs)
    .filter(([gid]) => gid.startsWith('sequence:'))
    .filter(([, g]: any) => (g.nodes ?? []).some((n: any) => n.diff && n.diff !== 'unchanged')
        || (g.edges ?? []).some((e: any) => e.diff && e.diff !== 'unchanged'))
    .map(([gid]) => gid);

// L2b: the seq-authoritative signal the API-list panel actually renders — an
// api-list:* graph with a modified entry (apiDiff treats the endpoint's
// sequence graph as authoritative, so this is gated on the L3/L5 diff, NOT on
// the L4-bodyText backstop that marks feature/apiIndex regardless).
const apiListMods = (working: any) => Object.entries(working.graphs)
    .filter(([gid]) => gid.startsWith('api-list:'))
    .map(([gid, g]) => ({ gid, mods: modifiedApiListEntries(g as any) }))
    .filter(a => a.mods.length > 0);

describe('regression: inline anon handler body edit → L5/L3/L2 modified', () => {
    let namedFix: string, anonFix: string;
    let named: ScenarioResult, anon: ScenarioResult;
    let namedWorking: any, anonWorking: any;

    beforeAll(async () => {
        namedFix = mkFixture('anon-repro-named-', NAMED);
        anonFix = mkFixture('anon-repro-anon-', ANON);
        named = await runScenario({ repoPath: namedFix, edits: [] });
        anon = await runScenario({ repoPath: anonFix, edits: [] });
        namedWorking = await editBodyAndRebuild(named);
        anonWorking = await editBodyAndRebuild(anon);
    }, 120_000);

    afterAll(() => {
        named?.dispose(); anon?.dispose();
        try { fs.rmSync(namedFix, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { fs.rmSync(anonFix, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // ---- Control: named handler ----
    it('NAMED handler body edit stamps the L5 flow diff (control)', () => {
        const f = flowMods(namedWorking, 'getX');
        expect(f.present, 'named flow graph must exist').toBe(true);
        expect(f.dirty, 'named flow graph should have ≥1 modified node').toBeGreaterThanOrEqual(1);
    });

    // ---- The bug the user reported: L5, L3 AND L2 for the anon handler ----
    it('ANON body edit → L5 flow modified', () => {
        const f = flowMods(anonWorking, 'anonymous@GET:/x');
        expect(f.present, 'anon flow graph must exist').toBe(true);
        const labels = f.g ? f.g.nodes.map((n: any) => `${n.diff}|${String(n.label).slice(0, 28)}`) : [];
        expect(f.dirty, `expected ≥1 modified L5 node. nodes=${labels.join(' ;; ')}`).toBeGreaterThanOrEqual(1);
    });

    it('ANON body edit → L3 sequence modified', () => {
        const hits = seqMods(anonWorking);
        const all = Object.keys(anonWorking.graphs).filter(g => g.startsWith('sequence:'));
        expect(hits.length, `expected ≥1 modified L3 sequence. sequence graphs=${all.join(', ')}`).toBeGreaterThanOrEqual(1);
    });

    it('ANON body edit → L2b api-list entry modified (seq-authoritative)', () => {
        const withMods = apiListMods(anonWorking);
        const all = Object.entries(anonWorking.graphs)
            .filter(([gid]) => gid.startsWith('api-list:'))
            .map(([gid, g]: any) => ({ gid, mods: modifiedApiListEntries(g) }));
        expect(withMods.length, `expected ≥1 api-list with a modified entry (the L2b panel signal). apiLists=${JSON.stringify(all)}`).toBeGreaterThanOrEqual(1);
    });
});
