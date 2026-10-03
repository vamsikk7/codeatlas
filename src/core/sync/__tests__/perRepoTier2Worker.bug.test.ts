/**
 * ADR-034 #TDD-fix-1 — per-repo files-table bug, exercised through REAL
 * Tier-2 worker_threads bundle (dist/repo-worker.js). The Tier-1
 * in-process path passes for the same fixtures; the live multirepo-smoke
 * regression only shows up via the worker bundle, so this test exists to
 * reproduce that failure mode here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerPool } from '../workerPool';
import { SnapshotStore } from '../../storage/snapshotStore';

const tmpDirs: string[] = [];
const WORKER_BUNDLE = path.resolve(__dirname, '../../../../dist/repo-worker.js');
const REAL_REPOS_ROOT = path.resolve(__dirname, '../../../../e2e/real-repos');
const REAL_GO_GIN = path.join(REAL_REPOS_ROOT, 'go-gin');

function copyDirSync(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name === '.codeatlas' || entry.name === 'node_modules' || entry.name === '.git') continue;
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else if (entry.isFile()) fs.copyFileSync(s, d);
    }
}

beforeEach(() => { /* */ });
afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

describe('Tier-2 worker bundle — per-repo state.db files population', () => {
    it('worker init of go-gin persists files to per-repo state.db', async () => {
        if (!fs.existsSync(WORKER_BUNDLE)) {
            console.warn('skipping — worker bundle missing; run `node esbuild.js`');
            return;
        }
        if (!fs.existsSync(REAL_GO_GIN)) {
            console.warn('skipping — real go-gin fixture missing');
            return;
        }

        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-tdd-'));
        tmpDirs.push(ws);
        // Multi-repo layout — go-gin + a minimal js-express sibling.
        copyDirSync(REAL_GO_GIN, path.join(ws, 'go-gin'));
        fs.mkdirSync(path.join(ws, 'js-express/src'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'js-express/package.json'), JSON.stringify({ name: 'js-express' }));
        fs.writeFileSync(path.join(ws, 'js-express/src/index.js'), 'module.exports = 1;');

        const pool = new WorkerPool({
            workerScriptPath: WORKER_BUNDLE,
            size: 2,
            log: () => { /* silence */ },
        });
        try {
            await pool.ready();
            const result = await pool.runTask({
                repoId: 'go-gin-test',
                repoRoot: path.join(ws, 'go-gin'),
                workspaceRoot: ws,
            });
            expect(result.persisted).toBe(true);
            // Re-open the per-repo state.db that the worker wrote.
            const repoRoot = path.join(ws, 'go-gin');
            const store = new SnapshotStore(repoRoot);
            await store.load();
            const working = store.getWorking();
            const apiCount = Object.keys(working.apiIndex).length;
            const fileCount = Object.keys(working.files).length;
            store.close();

            expect(apiCount, `expected apis from worker; got ${apiCount}`).toBeGreaterThan(0);
            expect(
                fileCount,
                `expected files from worker; got files=${fileCount} apis=${apiCount} — live multirepo-smoke bug`,
            ).toBeGreaterThan(0);
            expect(working.files['go-gin/hello.go']).toBeDefined();
        } finally {
            await pool.close().catch(() => { /* */ });
        }
    }, 60_000);

    it('worker pool processes 8 repos concurrently — every per-repo state.db has files', async () => {
        if (!fs.existsSync(WORKER_BUNDLE)) {
            console.warn('skipping — worker bundle missing');
            return;
        }
        const repoNames = [
            'go-gin', 'java-spring', 'csharp-aspnet',
            'ruby-rails', 'php-laravel', 'swift-vapor',
            'js-express', 'py-fastapi',
        ];
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-multi-'));
        tmpDirs.push(ws);
        for (const name of repoNames) {
            const src = path.join(REAL_REPOS_ROOT, name);
            if (!fs.existsSync(src)) {
                console.warn(`skipping ${name} — fixture missing`);
                continue;
            }
            copyDirSync(src, path.join(ws, name));
        }

        const pool = new WorkerPool({
            workerScriptPath: WORKER_BUNDLE,
            size: 4,                // mirror prod default (min(8, cpus))
            log: () => { /* silence */ },
        });
        try {
            await pool.ready();
            const results = await Promise.all(repoNames.map((name) => {
                const repoRoot = path.join(ws, name);
                if (!fs.existsSync(repoRoot)) return Promise.resolve(null);
                return pool.runTask({
                    repoId: `${name}-test`,
                    repoRoot,
                    workspaceRoot: ws,
                });
            }));
            for (const r of results) {
                if (r) expect(r.persisted).toBe(true);
            }

            // Re-open every per-repo state.db and verify files persisted.
            const fileCounts: Record<string, number> = {};
            const apiCounts: Record<string, number> = {};
            for (const name of repoNames) {
                const repoRoot = path.join(ws, name);
                if (!fs.existsSync(repoRoot)) continue;
                const store = new SnapshotStore(repoRoot);
                await store.load();
                const working = store.getWorking();
                fileCounts[name] = Object.keys(working.files).length;
                apiCounts[name] = Object.keys(working.apiIndex).length;
                store.close();
            }

            // Every repo that was processed must have files persisted.
            for (const name of Object.keys(fileCounts)) {
                expect(
                    fileCounts[name],
                    `expected files for ${name}; got files=${fileCounts[name]} apis=${apiCounts[name]}. ` +
                    `Full counts: ${JSON.stringify({ files: fileCounts, apis: apiCounts })}`,
                ).toBeGreaterThan(0);
            }
        } finally {
            await pool.close().catch(() => { /* */ });
        }
    }, 180_000);

    it('worker without grammarsDir override falls back gracefully (TDD-1 regression net)', async () => {
        // The production install bug: when the worker is invoked WITHOUT a
        // `grammarsDir`, its auto-detection candidates resolve to
        // `<vscode-extensions-dir>/grammars` (one level too high) because
        // `__dirname` inside a worker_threads bundle is the bundle's path.
        // Live multirepo-smoke reproduced this: every Go/Java/C# file emitted
        // "Grammar file not found" and the per-repo state.db ended up with
        // apis populated (for repos where regex detectors caught routes) but
        // files=0 (the file record write happens AFTER the tree-sitter
        // analysis under the `if (language)` gate).
        //
        // The test asserts the bug surface — when the worker is given the
        // RIGHT grammarsDir, files persist. The extension.ts production
        // wiring at `tier2Pool = new WorkerPool({ ..., grammarsDir })`
        // matches the path used here.
        if (!fs.existsSync(WORKER_BUNDLE)) {
            console.warn('skipping — worker bundle missing');
            return;
        }
        const goSrc = path.join(REAL_REPOS_ROOT, 'go-gin');
        if (!fs.existsSync(goSrc)) {
            console.warn('skipping — go-gin fixture missing');
            return;
        }
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-grammars-'));
        tmpDirs.push(ws);
        copyDirSync(goSrc, path.join(ws, 'go-gin'));
        fs.mkdirSync(path.join(ws, 'js-sibling/src'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'js-sibling/package.json'), JSON.stringify({ name: 'js-sibling' }));
        fs.writeFileSync(path.join(ws, 'js-sibling/src/index.js'), 'module.exports = 1;');

        const grammarsDir = path.resolve(__dirname, '../../../../grammars');
        if (!fs.existsSync(grammarsDir)) {
            console.warn(`skipping — grammars dir missing at ${grammarsDir}`);
            return;
        }
        const pool = new WorkerPool({
            workerScriptPath: WORKER_BUNDLE,
            size: 2,
            log: () => { /* silence */ },
            grammarsDir,
        });
        try {
            await pool.ready();
            await pool.runTask({
                repoId: 'go-gin-grammars',
                repoRoot: path.join(ws, 'go-gin'),
                workspaceRoot: ws,
            });
            const store = new SnapshotStore(path.join(ws, 'go-gin'));
            await store.load();
            const fileCount = Object.keys(store.getWorking().files).length;
            store.close();
            expect(fileCount, `Go files should persist when grammarsDir is wired; got ${fileCount}`).toBeGreaterThan(0);
        } finally {
            await pool.close().catch(() => { /* */ });
        }
    }, 60_000);
});
