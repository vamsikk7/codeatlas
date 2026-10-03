/**
 * evictedStoreCascade.test.ts — #833 (2026-06-11).
 *
 * On workspaces with more sub-repos than the RepoStoreRegistry LRU cap
 * (30), eviction flushes + CLOSES the victim's sqlite handle while its
 * SyncOrchestrator stays referenced by `perRepoOrchestrators`. The next
 * file save then routed into a closed store: `save()` silently no-ops, so
 * the live cascade looked dead — the exact 132-repo serverless-monorepo
 * symptom from the 2026-06-11 sweep (working hash frozen 30s+ after an
 * edit).
 *
 * Pins: rebuildFile against an evicted (closed) store re-opens it and the
 * cascade lands on disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';

const SERVER_JS = `const express = require('express');
const app = express();

function listItems(req, res) {
    res.json([{ id: 1 }]);
}

app.get('/api/items', listItems);
app.listen(3000);
`;

describe('#833 — cascade survives registry LRU eviction (closed store re-opens on rebuild)', () => {
    let fixtureDir: string;
    let scenario: ScenarioResult;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evicted-store-'));
        fs.writeFileSync(path.join(fixtureDir, 'server.js'), SERVER_JS, 'utf-8');
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
            name: 'evicted-fixture', version: '1.0.0', dependencies: { express: '^4.0.0' },
        }), 'utf-8');
        scenario = await runScenario({ repoPath: fixtureDir, edits: [] });
    }, 60_000);

    afterAll(() => {
        scenario?.dispose();
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('edit after eviction lands in the persisted working snapshot', async () => {
        const oldHash = (scenario.store.getWorking().files['server.js'] as any)?.hash;
        expect(oldHash).toBeDefined();

        // Simulate RepoStoreRegistry.evictIfNeeded(): flush + close.
        scenario.store.save();
        scenario.store.close();

        // Disk edit routed to the still-referenced orchestrator (what the
        // WorkspaceWatcher does for any repo evicted past the LRU cap).
        const abs = path.join(scenario.repoCopyDir, 'server.js');
        fs.writeFileSync(abs, SERVER_JS.replace('{ id: 1 }', '{ id: 1, name: "after-eviction" }'), 'utf-8');
        await scenario.sync.rebuildFile(abs);
        scenario.store.save();

        // In-memory must reflect the edit…
        const memHash = (scenario.store.getWorking().files['server.js'] as any)?.hash;
        expect(memHash).toBeDefined();
        expect(memHash).not.toBe(oldHash);

        // …and so must the DB (a FRESH store instance reads the new hash).
        const reloaded = await scenario.reloadFromDisk();
        const diskHash = (reloaded.working.files['server.js'] as any)?.hash;
        expect(diskHash, 'persisted working hash must reflect the post-eviction edit').toBe(memHash);
    });
});
