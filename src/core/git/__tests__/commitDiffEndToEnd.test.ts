/**
 * commitDiffEndToEnd.test.ts
 *
 * Issue 285: end-to-end coverage for `buildCommitDiffGraphs` against a real
 * 2-commit git repo. The real-world verification suite uses `--depth=1`
 * shallow clones which only have one commit, so this test creates a tmp
 * workspace with two commits and exercises the full diff pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { setGrammarsDir, resetTreeSitterForTesting } from '../../parser/treeSitterParser';
import { buildCommitDiffGraphs } from '../commitDiffer';

let workspace: string;
let baseHash: string;
let headHash: string;

beforeAll(() => {
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-diff-e2e-'));
    const run = (cmd: string) => execSync(cmd, { cwd: workspace, stdio: 'pipe' }).toString().trim();

    run('git init -q -b main');
    run('git config user.email test@example.com');
    run('git config user.name Test');
    run('git config commit.gpgsign false');

    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'app.js'), `
const express = require('express');
const app = express();
function listUsers(req, res) {
    res.json([]);
}
app.get('/users', listUsers);
module.exports = app;
`);
    run('git add -A');
    run('git commit -q -m "initial"');
    baseHash = run('git rev-parse HEAD');

    fs.writeFileSync(path.join(workspace, 'src', 'app.js'), `
const express = require('express');
const app = express();
function listUsers(req, res) {
    res.json([{ id: 1 }]);
}
function createUser(req, res) {
    res.status(201).json({});
}
app.get('/users', listUsers);
app.post('/users', createUser);
module.exports = app;
`);
    run('git add -A');
    run('git commit -q -m "add createUser"');
    headHash = run('git rev-parse HEAD');
});

afterAll(() => {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

describe('buildCommitDiffGraphs (Issue 285)', () => {
    it('produces diff graphs between two real commits', { timeout: 60_000 }, async () => {
        const result = await buildCommitDiffGraphs(workspace, baseHash, headHash);
        expect(result).toBeDefined();
        // Should detect both routes in HEAD snapshot
        expect(result.headSnapshot.apiIndex).toBeDefined();
        const headApis = Object.values(result.headSnapshot.apiIndex);
        const headRoutes = new Set(headApis.map(a => a.route));
        expect(headRoutes.has('/users')).toBe(true);

        // Base only has GET /users; head adds POST. So head should have at least
        // one API the base doesn't.
        const baseApis = Object.values(result.baseSnapshot.apiIndex);
        expect(headApis.length).toBeGreaterThan(baseApis.length);

        // File graph for src/app.js exists in both snapshots
        expect(result.headSnapshot.graphs['file:src/app.js']).toBeDefined();
        expect(result.baseSnapshot.graphs['file:src/app.js']).toBeDefined();

        // Diffed file graph should reflect the changed file
        const diffed = result.diffedGraphs['file:src/app.js'];
        if (diffed) {
            // Either the file graph itself is unchanged but a node-level diff
            // is present, or the apiIndex shows the new POST route.
            expect(diffed.nodes?.length ?? 0).toBeGreaterThan(0);
        }
    });

    it('rejects an unknown HEAD hash with a clear message', async () => {
        await expect(
            buildCommitDiffGraphs(workspace, baseHash, 'deadbeef'.repeat(5).slice(0, 40)),
        ).rejects.toThrow(/HEAD commit .* not found locally/);
    });
});
