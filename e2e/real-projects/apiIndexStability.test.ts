/**
 * apiIndexStability.test.ts — #830 (2026-06-11).
 *
 * The rebuild path must not grow phantom apiIndex records. Found during
 * the #817 live-verify: init produced 2 records for an Express file
 * (real handler names), but ONE rebuildFile added two `::express`
 * siblings — `detectFrameworkApis`'s nearest-identifier fallback — because
 * the rebuild path skipped the tuple-keyed dedup the INIT path applies
 * (syncOrchestrator init: dedup by (method, route, filePath) + the
 * Issue-414 `${…}` template-route filter).
 *
 * Boots the real SnapshotStore + SyncOrchestrator on a tmpdir Express
 * fixture, rebuilds after a body edit, and pins the apiIndex key set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';

const SERVER_JS = `const express = require('express');
const app = express();

function listItems(req, res) {
    res.json([{ id: 1, name: 'widget' }]);
}

function getItem(req, res) {
    res.json({ id: req.params.id });
}

app.get('/api/items', listItems);
app.get('/api/items/:id', getItem);

app.listen(3000, () => console.log('up'));
`;

describe('#830 — apiIndex stays stable across rebuilds (no phantom framework-detector records)', () => {
    let fixtureDir: string;
    let scenario: ScenarioResult;

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-stability-'));
        fs.writeFileSync(path.join(fixtureDir, 'server.js'), SERVER_JS, 'utf-8');
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
            name: 'api-stability-fixture', version: '1.0.0', dependencies: { express: '^4.0.0' },
        }), 'utf-8');

        scenario = await runScenario({
            repoPath: fixtureDir,
            edits: [{
                filePath: 'server.js',
                op: { op: 'addLinesToFunction', fnName: 'listItems', lines: ["    console.log('[probe] body edit');"] },
            }],
        });
    }, 60_000);

    afterAll(() => {
        scenario?.dispose();
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('after one rebuild: same record count as init, no ::express phantoms', () => {
        const keys = Object.keys(scenario.store.getWorking().apiIndex ?? {});
        expect(keys.filter(k => k.endsWith('::express'))).toEqual([]);
        // Exactly the two real routes, keyed by their real handler names.
        expect(keys.sort()).toEqual([
            'GET:/api/items/:id::server.js::getItem',
            'GET:/api/items::server.js::listItems',
        ].sort());
    });

    it('repeated rebuilds do not accumulate records', async () => {
        const abs = path.join(scenario.repoCopyDir, 'server.js');
        // Touch the file twice more through the same pipeline.
        for (const probe of ['second', 'third']) {
            const content = fs.readFileSync(abs, 'utf-8');
            fs.writeFileSync(abs, content.replace("console.log('up')", `console.log('up-${probe}')`), 'utf-8');
            await scenario.sync.rebuildFile(abs);
        }
        const keys = Object.keys(scenario.store.getWorking().apiIndex ?? {});
        expect(keys).toHaveLength(2);
        expect(keys.filter(k => k.includes('::express'))).toEqual([]);
    });
});
