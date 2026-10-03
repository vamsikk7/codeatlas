/**
 * staleNamingCallback.test.ts — #844 (2026-06-11)
 *
 * User repro: a fire-and-forget LLM-naming callback scheduled over an
 * earlier, PARTIAL cluster map (drift-scan rebuild racing init) resolved
 * after a later full init and wholesale-replaced working AND baseline
 * clusters with its 1-cluster map. Every later L2a diff then showed
 * phantom "+ ADDED" clusters (5 added · 1 modified live).
 *
 * Pins the two-part fix against a REAL store + orchestrator:
 *   1. stale generations are dropped;
 *   2. even a CURRENT-generation enrichment merges names only — it can
 *      never change cluster cardinality in either snapshot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';

const FILES: Record<string, string> = {
    'auth/auth.service.js': `function getCurrentUser(id) { return db.find(id); }\nmodule.exports = { getCurrentUser };\n`,
    'article/article.service.js': `function listArticles() { return db.all(); }\nmodule.exports = { listArticles };\n`,
    'tag/tag.service.js': `function listTags() { return db.tags(); }\nmodule.exports = { listTags };\n`,
};

describe('#844 — stale/partial naming enrichment cannot corrupt cluster state', () => {
    let fixtureDir: string;
    let scenario: ScenarioResult;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-naming-'));
        for (const [rel, content] of Object.entries(FILES)) {
            fs.mkdirSync(path.dirname(path.join(fixtureDir, rel)), { recursive: true });
            fs.writeFileSync(path.join(fixtureDir, rel), content, 'utf-8');
        }
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
            name: 'stale-naming-fixture', version: '1.0.0', dependencies: { express: '^4.0.0' },
        }), 'utf-8');
        scenario = await runScenario({ repoPath: fixtureDir, edits: [] });
    }, 60_000);

    afterAll(() => {
        scenario?.dispose();
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function clusterCounts() {
        return {
            working: Object.keys(scenario.store.getWorking().clusters ?? {}).length,
            baseline: Object.keys(scenario.store.getBaseline().clusters ?? {}).length,
        };
    }

    it('a STALE-generation enrichment is dropped entirely', async () => {
        const sync: any = scenario.sync;
        const before = clusterCounts();
        expect(before.working).toBeGreaterThanOrEqual(2);
        expect(before.baseline).toBe(before.working);

        const staleGeneration = sync.stateGeneration;
        // A new rebuild supersedes the scheduled pass (bumps the generation).
        const anyFile = path.join(scenario.repoCopyDir, 'auth/auth.service.js');
        await sync.rebuildFile(anyFile);

        const firstId = Object.keys(scenario.store.getWorking().clusters)[0];
        const partialMap = { [firstId]: { ...scenario.store.getWorking().clusters[firstId], name: 'STALE NAME' } };
        const applied = sync.applyClusterNameEnrichment(partialMap, staleGeneration);

        expect(applied).toBe(false);
        const after = clusterCounts();
        expect(after).toEqual({ working: before.working, baseline: before.baseline });
        expect(scenario.store.getWorking().clusters[firstId].name).not.toBe('STALE NAME');
    });

    it('THE repro shape: a current-generation 1-cluster enrichment merges the name but preserves cardinality in BOTH snapshots', () => {
        const sync: any = scenario.sync;
        const before = clusterCounts();
        const ids = Object.keys(scenario.store.getWorking().clusters);
        const target = ids[0];
        const partialMap = { [target]: { ...scenario.store.getWorking().clusters[target], name: 'User Authentication' } };

        const applied = sync.applyClusterNameEnrichment(partialMap, sync.stateGeneration);

        expect(applied).toBe(true);
        const after = clusterCounts();
        expect(after, 'cardinality may never change').toEqual(before);
        expect(scenario.store.getWorking().clusters[target].name).toBe('User Authentication');
        expect(scenario.store.getBaseline().clusters[target].name).toBe('User Authentication');
        // Every OTHER cluster survives untouched in baseline — the pre-fix
        // wholesale replace would have left exactly one.
        for (const id of ids) {
            expect(scenario.store.getBaseline().clusters[id]).toBeDefined();
        }
    });
});
