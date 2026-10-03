/**
 * crossFileFlowScenarios.test.ts — #905 (T3)
 *
 * Cross-file flow propagation: when a function in A changes, the orchestrator
 * rebuilds the flow graphs of every file B that imports A, diffing B's own
 * function bodies against their baseline.
 *
 * #905 hardens the baseline reconstruction at the LAST-RESORT tier — it read a
 * bare `otherBaselineFile.content` with no `getFileContent('baseline', …)`
 * fallback, and `.content` is DROPPED from the in-RAM snapshot after `save()`
 * (lazy-content). The fix adds the SQLite re-hydration fallback, matching the
 * established pattern used elsewhere in syncOrchestrator (lines 381/450/627).
 *
 * NOTE on coverage: in the standard pipeline the importer's baseline body is
 * reconstructed from the per-function `bodySrc` / `bodyText`+`signature` symbol
 * metadata — which is NOT dropped by lazy-content — so the `.content` tier is
 * shadowed and the fix is defense-in-depth (verified by inspection: a saved
 * baseline function still reports `hasBodyText: true` even with `.content`
 * dropped). This scenario therefore guards the broader contract: cross-file
 * flow propagation still produces a well-formed, real diff for the importer
 * after a save()/lazy-content cycle — the live extension's save path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, diffCounts } from './cascadeHarness';

const LIB = `function compute(x) {
  return x + 1;
}
module.exports = { compute };
`;

const CONSUMER = `const { compute } = require('./lib');

function handler(req) {
  const value = compute(req.value);
  const doubled = value * 2;
  const labelled = 'result: ' + doubled;
  return labelled;
}

module.exports = { handler };
`;

function makeFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfile-fix-'));
    fs.writeFileSync(path.join(dir, 'lib.js'), LIB, 'utf-8');
    fs.writeFileSync(path.join(dir, 'consumer.js'), CONSUMER, 'utf-8');
    return dir;
}

describe('#905 — cross-file flow propagation survives the post-save lazy-content drop', () => {
    let fixtureDir = '';
    let dispose: (() => void) | undefined;
    afterEach(() => {
        try { dispose?.(); } catch { /* best-effort */ }
        if (fixtureDir) { try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
        fixtureDir = '';
        dispose = undefined;
    });

    it("editing compute() in lib.js keeps consumer.js's flow a well-formed diff (not all-added)", async () => {
        fixtureDir = makeFixture();
        const r = await runScenario({
            repoPath: fixtureDir,
            edits: [{ filePath: 'lib.js', op: { op: 'replace', oldText: 'return x + 1;', newText: 'return x + 100;' } }],
        });
        dispose = r.dispose;

        // The baseline file's `.content` is dropped after save() (lazy-content),
        // yet the importer's flow must still reconstruct a real diff.
        expect(r.baseline.files['consumer.js']?.content).toBeUndefined();

        const consumerFlow = r.working.graphs['flow:consumer.js:handler'];
        expect(consumerFlow).toBeDefined();
        const counts = diffCounts(consumerFlow);
        // consumer.js itself was never edited, so its statements stay `unchanged`
        // — the baseline reconstruction worked. With a TOTAL baseline miss the body
        // would degrade to all-`added`; assert that did not happen.
        expect(counts.unchanged).toBeGreaterThan(0);
        expect(counts.added).toBe(0);
    });
});
