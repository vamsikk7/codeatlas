/**
 * workspaceBootstrap.test.ts — unit tests for the self-init / watch /
 * non-codebase-detection layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceBootstrap, classifyWorkspace, shouldIgnoreChange } from '../workspaceBootstrap';

describe('shouldIgnoreChange — watcher noise filter (BUG-EXP-14 follow-up)', () => {
    it('ignores non-source noise so a watcher add-storm cannot fan out cascadeRefresh', () => {
        for (const f of [
            'contrib/db_pools/lib/LICENSE-APACHE', 'README.md', 'docs/guide.md',
            'notes.txt', 'Cargo.lock', 'package-lock.json', 'logo.png',
            'node_modules/foo/index.js', 'target/debug/x.rs', '.git/HEAD',
        ]) {
            expect(shouldIgnoreChange(f), `${f} should be ignored`).toBe(true);
        }
    });

    it('does NOT ignore real source files', () => {
        for (const f of ['src/main.rs', 'app/models/user.rb', 'lib/foo.ts', 'x.py', 'A.java', 'main.go', 'v.swift']) {
            expect(shouldIgnoreChange(f), `${f} must be watched`).toBe(false);
        }
    });
});

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

describe('classifyWorkspace', () => {
    it('counts files matching supported language extensions', () => {
        const dir = tmpdir('classify-');
        writeFile(dir, 'src/a.ts', 'export const x = 1;');
        writeFile(dir, 'src/b.py', 'def f(): pass');
        writeFile(dir, 'README.md', '# hi');
        writeFile(dir, 'node_modules/x/index.js', '// skipped');
        const result = classifyWorkspace(dir, 1000);
        expect(result.supportedFiles).toBe(2);
        // node_modules excluded from the scan, README is scanned but not supported.
        expect(result.scanned).toBe(3);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reports zero supported files for a docs-only workspace', () => {
        const dir = tmpdir('classify-docs-');
        writeFile(dir, 'README.md', 'x');
        writeFile(dir, 'docs/a.md', 'y');
        writeFile(dir, 'images/logo.png', 'binary');
        const result = classifyWorkspace(dir, 1000);
        expect(result.supportedFiles).toBe(0);
        expect(result.scanned).toBeGreaterThan(0);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('caps scan at maxScan', () => {
        const dir = tmpdir('classify-cap-');
        for (let i = 0; i < 50; i++) writeFile(dir, `f${i}.ts`, 'x');
        const result = classifyWorkspace(dir, 10);
        expect(result.scanned).toBeLessThanOrEqual(10);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('WorkspaceBootstrap', () => {
    it('detects a non-codebase and returns status without running init', async () => {
        const dir = tmpdir('bootstrap-empty-');
        writeFile(dir, 'README.md', 'x');
        const wb = new WorkspaceBootstrap(dir, { log: () => { /* silent */ } });
        const status = await wb.start();
        expect(status.status).toBe('not_a_codebase');
        if (status.status === 'not_a_codebase') {
            expect(status.supportedFiles).toBe(0);
        }
        // No state.db should have been created.
        expect(fs.existsSync(path.join(dir, '.codeatlas', 'state.db'))).toBe(false);
        wb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('initializes a snapshot for a fresh real codebase', async () => {
        const dir = tmpdir('bootstrap-init-');
        writeFile(dir, 'src/app.ts', `
            const router = require('express').Router();
            router.get('/hello', (req, res) => res.send('hi'));
            module.exports = router;
        `);
        const wb = new WorkspaceBootstrap(dir, { log: () => { /* silent */ } });
        const status = await wb.start();
        expect(status.status).toBe('ready');
        if (status.status === 'ready') {
            expect(status.mode).toBe('read_write');
            expect(status.fileCount).toBeGreaterThan(0);
        }
        // state.db should now exist.
        expect(fs.existsSync(path.join(dir, '.codeatlas', 'state.db'))).toBe(true);
        wb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }, 30_000);

    it('respects readOnly flag — falls back without grabbing the lock', async () => {
        const dir = tmpdir('bootstrap-ro-');
        writeFile(dir, 'src/app.ts', 'export const x = 1;');
        const wb = new WorkspaceBootstrap(dir, { readOnly: true, log: () => { /* silent */ } });
        const status = await wb.start();
        expect(status.status).toBe('ready');
        if (status.status === 'ready') {
            expect(status.mode).toBe('read_only');
        }
        // No state.db should have been created (no init in read-only mode).
        expect(fs.existsSync(path.join(dir, '.codeatlas', 'state.db'))).toBe(false);
        wb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to read-only when another process holds the write lock', async () => {
        const dir = tmpdir('bootstrap-lock-');
        writeFile(dir, 'src/app.ts', 'export const x = 1;');
        // First bootstrap grabs the lock.
        const wb1 = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        const s1 = await wb1.start();
        expect(s1.status).toBe('ready');
        if (s1.status === 'ready') expect(s1.mode).toBe('read_write');
        // Second bootstrap should see the lock and downgrade.
        const wb2 = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        const s2 = await wb2.start();
        expect(s2.status).toBe('ready');
        if (s2.status === 'ready') {
            expect(s2.mode).toBe('read_only');
            expect(s2.warning).toMatch(/write lock|read-only/i);
        }
        wb1.stop();
        wb2.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }, 30_000);

    it('returns error status when workspace path is missing', async () => {
        const wb = new WorkspaceBootstrap('/nonexistent/path/xyz', { log: () => { /* */ } });
        const status = await wb.start();
        expect(status.status).toBe('error');
    });

    it('exposes status getter that matches the started status', async () => {
        const dir = tmpdir('bootstrap-status-');
        writeFile(dir, 'README.md', 'x');
        const wb = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        const returned = await wb.start();
        expect(wb.getStatus()).toEqual(returned);
        wb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// ─── ADR-034 multi-repo MCP ──────────────────────────────────────────────
describe('WorkspaceBootstrap — multi-repo detection (ADR-034)', () => {
    async function seedMultiRepoWorkspace(): Promise<string> {
        const { AggregatorStore } = await import('../../core/storage/aggregatorStore');
        const { SnapshotStore } = await import('../../core/storage/snapshotStore');

        const ws = tmpdir('mcp-multi-');
        writeFile(ws, 'svc-alpha/src/index.js', `module.exports = 'alpha';`);
        writeFile(ws, 'svc-beta/src/index.js', `module.exports = 'beta';`);
        fs.mkdirSync(path.join(ws, '.codeatlas'), { recursive: true });

        const agg = new AggregatorStore(ws);
        await agg.init();
        for (const name of ['svc-alpha', 'svc-beta']) {
            agg.upsertRepo({
                repoId: `id-${name}`,
                name,
                rootPath: name,
                realpathHash: `hash-${name}`,
                technology: 'nodejs',
                status: 'ready',
                lastInitAt: Date.now(),
                errorMessage: null,
                fallbackStatePath: null,
                stateDbSchemaVersion: 9,
                summarySchemaVersion: 1,
                diff: null,
            });
        }
        agg.save();
        agg.close();

        for (const name of ['svc-alpha', 'svc-beta']) {
            const store = new SnapshotStore(path.join(ws, name));
            await store.load();
            store.save();
            store.close();
        }
        return ws;
    }

    it('detects monorepo.db and opens aggregator + per-repo stores', async () => {
        const ws = await seedMultiRepoWorkspace();
        const wb = new WorkspaceBootstrap(ws, { log: () => { /* */ } });
        await wb.start();

        const multi = wb.getMultiRepo();
        expect(multi).not.toBeNull();
        expect(multi!.repos.map((r) => r.name).sort()).toEqual(['svc-alpha', 'svc-beta']);
        expect(multi!.repoStores.size).toBe(2);
        expect(wb.getAggregator()).not.toBeNull();
        expect(multi!.primaryRepoId).toBe('id-svc-alpha');

        wb.stop();
        fs.rmSync(ws, { recursive: true, force: true });
    });

    it('honors --repo override by repo name', async () => {
        const ws = await seedMultiRepoWorkspace();
        const wb = new WorkspaceBootstrap(ws, { repo: 'svc-beta', log: () => { /* */ } });
        await wb.start();
        expect(wb.getMultiRepo()!.primaryRepoId).toBe('id-svc-beta');
        wb.stop();
        fs.rmSync(ws, { recursive: true, force: true });
    });

    it('falls back to alphabetical primary when --repo does not match', async () => {
        const ws = await seedMultiRepoWorkspace();
        let logged = '';
        const wb = new WorkspaceBootstrap(ws, {
            repo: 'svc-not-real',
            log: (m) => { logged += m + '\n'; },
        });
        await wb.start();
        expect(wb.getMultiRepo()!.primaryRepoId).toBe('id-svc-alpha');
        expect(logged).toMatch(/--repo "svc-not-real" did not match/);
        wb.stop();
        fs.rmSync(ws, { recursive: true, force: true });
    });

    it('single-repo workspace (no monorepo.db) → getMultiRepo() returns null', async () => {
        const dir = tmpdir('mcp-single-');
        writeFile(dir, 'src/a.ts', 'export const x = 1;');
        const wb = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        await wb.start();
        expect(wb.getMultiRepo()).toBeNull();
        expect(wb.getAggregator()).toBeNull();
        wb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('multi-repo with no registered repos → falls back to single-repo', async () => {
        const ws = tmpdir('mcp-multi-empty-');
        writeFile(ws, 'src/a.ts', 'export const x = 1;');
        fs.mkdirSync(path.join(ws, '.codeatlas'), { recursive: true });
        const { AggregatorStore } = await import('../../core/storage/aggregatorStore');
        const agg = new AggregatorStore(ws);
        await agg.init();
        agg.save();
        agg.close();

        const wb = new WorkspaceBootstrap(ws, { log: () => { /* */ } });
        await wb.start();
        expect(wb.getMultiRepo()).toBeNull();
        wb.stop();
        fs.rmSync(ws, { recursive: true, force: true });
    });

    // #MCP-MULTI-1 (2026-06-07): when a multi-repo workspace is opened
    // for the first time by the MCP standalone (no monorepo.db pre-built
    // by the VS Code extension), we should AUTO-DETECT the sub-repos via
    // `detectMultiRepoMode` + write a fresh aggregator entry per repo —
    // not silently fall through to single-repo mode. Without this the
    // user's bookmark `--repo` flags don't work and `list_repos` returns
    // one entry called `<workspace>`, which contradicts the dev-walkthrough
    // skill's pre-committed expectations.
    it('MCP-MULTI-1: auto-builds aggregator when sub-repos detected but monorepo.db absent', async () => {
        const ws = tmpdir('mcp-multi-auto-');
        // Two sibling sub-repos, each with its own package.json — meets the
        // multi-repo detector's "≥2 manifest siblings without an
        // orchestrator at root" condition. NO root manifest means the
        // workspace root itself isn't a project.
        writeFile(ws, 'api/package.json', JSON.stringify({ name: 'api', version: '1.0.0' }));
        writeFile(ws, 'api/src/index.js', 'module.exports = 1;');
        writeFile(ws, 'web/package.json', JSON.stringify({ name: 'web', version: '1.0.0' }));
        writeFile(ws, 'web/src/index.js', 'module.exports = 2;');

        // No .codeatlas dir, no monorepo.db — the standalone's job to
        // bootstrap one when sub-repos are detected.
        const wb = new WorkspaceBootstrap(ws, { log: () => { /* */ } });
        await wb.start();

        // Aggregator should now exist with 2 repos auto-registered.
        const multi = wb.getMultiRepo();
        expect(multi, 'multi-repo bootstrap missed sub-repos').not.toBeNull();
        expect(multi!.repos.map(r => r.name).sort()).toEqual(['api', 'web']);
        expect(wb.getAggregator()).not.toBeNull();

        wb.stop();
        fs.rmSync(ws, { recursive: true, force: true });
    });
});

// #829b (2026-06-11) — read-only daemons must track the writer process, and
// read-write daemons must catch up on files changed while they were down.
describe('WorkspaceBootstrap — #829b external-state tracking', () => {
    it('read-only bootstrap reloads when the writer flushes new state', async () => {
        const dir = tmpdir('bootstrap-829b-ro-');
        writeFile(dir, 'src/app.js', `
            const router = require('express').Router();
            router.get('/hello', function hello(req, res) { res.send('hi'); });
            module.exports = router;
        `);
        // Writer initializes + holds the lock.
        const writer = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        const ws = await writer.start();
        expect(ws.status).toBe('ready');

        // Reader downgrades to read-only (lock held) with a fast poller.
        let reloads = 0;
        const reader = new WorkspaceBootstrap(dir, { log: () => { /* */ }, externalReloadPollMs: 60 });
        reader.onExternalReload(() => { reloads++; });
        const rs = await reader.start();
        expect(rs.status).toBe('ready');
        if (rs.status === 'ready') expect(rs.mode).toBe('read_only');
        const before = Object.keys(reader.getStore().getWorking().files).length;

        // Writer adds a file + flushes.
        writeFile(dir, 'src/extra.js', 'module.exports = function extra() { return 1; };');
        await writer.handleFileChange(path.join(dir, 'src/extra.js'));

        // Poller picks it up.
        await new Promise((r) => setTimeout(r, 400));
        const after = Object.keys(reader.getStore().getWorking().files).length;
        expect(after).toBeGreaterThan(before);
        expect(reloads).toBeGreaterThan(0);

        reader.stop();
        writer.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }, 30_000);

    it('read-write bootstrap rebuilds files that changed while it was down (startup drift scan)', async () => {
        const dir = tmpdir('bootstrap-829b-drift-');
        const src = `
            const router = require('express').Router();
            router.get('/hello', function hello(req, res) { res.send('hi'); });
            module.exports = router;
        `;
        writeFile(dir, 'src/app.js', src);
        const wb1 = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        const s1 = await wb1.start();
        expect(s1.status).toBe('ready');
        const hashBefore = (wb1.getStore().getWorking().files['src/app.js'] as any)?.hash;
        wb1.stop();

        // File changes while no daemon is running.
        writeFile(dir, 'src/app.js', src.replace("res.send('hi')", "res.send('hi-v2')"));

        const wb2 = new WorkspaceBootstrap(dir, { log: () => { /* */ } });
        const s2 = await wb2.start();
        expect(s2.status).toBe('ready');
        const hashAfter = (wb2.getStore().getWorking().files['src/app.js'] as any)?.hash;
        expect(hashAfter).toBeDefined();
        expect(hashAfter).not.toBe(hashBefore);
        wb2.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }, 30_000);
});
