/**
 * regressionScopeRevert.test.ts — #829 (2026-06-10).
 *
 * T3 scenario for the in-memory hash-divergence bug surfaced by #827's
 * regression-scope live verification: after an edit→revert cycle the
 * persisted DB returns to hash parity, but the live extension kept
 * reporting the file as `modified` until a full resync.
 *
 * Boots the REAL SnapshotStore + SyncOrchestrator against a tmpdir
 * fixture (same pipeline as the live extension's file-save path),
 * applies a probe edit, rebuilds, REVERTS the edit, rebuilds again,
 * and asserts:
 *   1. in-memory working.files[fp].hash === baseline.files[fp].hash
 *   2. computeRegressionScope(working, baseline) is EMPTY
 *   3. a fresh store reloaded from the same SQLite agrees (control)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { computeRegressionScope } from '../../src/core/analysis/regressionScope';

const FIXTURE_APP = `const express = require('express');
const { findUser } = require('./util');
const app = express();

app.get('/api/user', async (req, res) => {
    const user = await getCurrentUser(req.query.id);
    res.json(user);
});

async function getCurrentUser(id) {
    if (!id) {
        throw new Error('id required');
    }
    return findUser(id);
}

module.exports = { app, getCurrentUser };
`;

const FIXTURE_UTIL = `function findUser(id) {
    return { id, name: 'user-' + id };
}
module.exports = { findUser };
`;

describe('#829 — edit→revert cycle leaves in-memory snapshots at hash parity', () => {
    let fixtureDir: string;
    let scenario: ScenarioResult;
    const REL = 'app.js';

    beforeAll(async () => {
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-revert-fixture-'));
        fs.writeFileSync(path.join(fixtureDir, 'app.js'), FIXTURE_APP, 'utf-8');
        fs.writeFileSync(path.join(fixtureDir, 'util.js'), FIXTURE_UTIL, 'utf-8');
        fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify({
            name: 'rs-revert-fixture', version: '1.0.0', dependencies: { express: '^4.0.0' },
        }), 'utf-8');

        scenario = await runScenario({
            repoPath: fixtureDir,
            edits: [{
                filePath: REL,
                op: { op: 'addLinesToFunction', fnName: 'getCurrentUser', lines: ["    console.log('[probe] #829');"] },
            }],
        });
    }, 60_000);

    afterAll(() => {
        scenario?.dispose();
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('sanity: probe edit marks the file modified (hash + scope)', () => {
        const w = scenario.store.getWorking();
        const b = scenario.store.getBaseline();
        expect(w.files[REL].hash).not.toBe(b.files[REL].hash);
        const scope = computeRegressionScope({ working: w, baseline: b });
        expect(scope.changedEntities.map(e => e.filePath)).toContain(REL);
    });

    it('after reverting the edit + rebuild: in-memory hashes return to parity and the scope is empty', async () => {
        // Revert: restore the ORIGINAL content on disk, then rebuild via
        // the same orchestrator path the live extension uses on save.
        const edit = scenario.appliedEdits[0];
        const absPath = path.join(scenario.repoCopyDir, REL);
        fs.writeFileSync(absPath, edit.oldContent, 'utf-8');
        await scenario.sync.rebuildFile(absPath);
        scenario.store.save();

        const w = scenario.store.getWorking();
        const b = scenario.store.getBaseline();

        // The #829 live symptom: DB clean but in-memory hash still diverges.
        expect(w.files[REL].hash, 'in-memory working hash must return to baseline parity after revert').toBe(b.files[REL].hash);

        const scope = computeRegressionScope({ working: w, baseline: b });
        expect(scope.changedEntities, 'regression scope must be empty after revert').toEqual([]);
        expect(scope.testsToRun).toEqual([]);
        expect(scope.testCommand).toBeNull();
    });

    it('control: a fresh store reloaded from the same SQLite also reads clean', async () => {
        const reloaded = await scenario.reloadFromDisk();
        expect(reloaded.working.files[REL].hash).toBe(reloaded.baseline.files[REL].hash);
        const scope = computeRegressionScope({ working: reloaded.working, baseline: reloaded.baseline });
        expect(scope.changedEntities).toEqual([]);
    });
});
