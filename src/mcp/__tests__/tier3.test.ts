/**
 * tier3.test.ts — unit tests for the four Tier 3 MCP features.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    SnapshotWatcher,
    exportOpenApiSpec,
    exportFunctionCallingSpec,
    compareWorkspaces,
    summarisePayload,
} from '../tier3';

describe('SnapshotWatcher', () => {
    let dir: string;
    let dbPath: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-watch-'));
        fs.mkdirSync(path.join(dir, '.codeatlas'), { recursive: true });
        dbPath = path.join(dir, '.codeatlas', 'state.db');
        fs.writeFileSync(dbPath, 'initial');
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('starts only when state.db exists', () => {
        const w1 = new SnapshotWatcher(dir);
        expect(w1.start()).toBe(true);
        w1.stop();

        const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-watch-empty-'));
        const w2 = new SnapshotWatcher(missingDir);
        expect(w2.start()).toBe(false);
        fs.rmSync(missingDir, { recursive: true, force: true });
    });

    // Helper — spin-wait for a predicate with an explicit ceiling so the
    // tests don't rely on `fs.watchFile`'s 100ms poll cycle aligning with
    // a fixed `setTimeout`. The 2-second ceiling is well above the
    // watcher's 100ms poll + 250ms debounce on every host we run on,
    // including loaded CI boxes, while typical local hits resolve in
    // ~250-400ms. Replaces the 2026-06-02 flake (`expect(events.length)
    // .toBeGreaterThan(0)` after a 400ms fixed wait).
    async function waitUntil(check: () => boolean, ceilingMs = 5000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < ceilingMs) {
            if (check()) return true;
            await new Promise(r => setTimeout(r, 10));
        }
        return check();
    }

    it('notifies listeners after a debounced db change', async () => {
        const w = new SnapshotWatcher(dir);
        w.start();
        const events: any[] = [];
        w.subscribe((e) => events.push(e));
        fs.writeFileSync(dbPath, 'updated');
        // Belt-and-braces: explicit mtime bump for hosts where the WAL
        // write doesn't move the mtime by enough for the 100ms poll cycle
        // to detect on the first pass.
        const now = Date.now() / 1000;
        fs.utimesSync(dbPath, now, now);
        await waitUntil(() => events.length > 0);
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].workspaceRoot).toBe(dir);
        w.stop();
    });

    it('coalesces rapid changes into one event', async () => {
        const w = new SnapshotWatcher(dir);
        w.start();
        const events: any[] = [];
        w.subscribe((e) => events.push(e));
        // Rapid burst — should coalesce to one notification.
        for (let i = 0; i < 5; i++) fs.writeFileSync(dbPath, `burst-${i}`);
        const now = Date.now() / 1000;
        fs.utimesSync(dbPath, now, now);
        await waitUntil(() => events.length >= 1);
        // Give the debouncer's window time to expire so a stray late
        // notification (which would defeat the coalescing assertion)
        // surfaces during the assertion window rather than after it.
        await new Promise(r => setTimeout(r, 400));
        expect(events.length).toBe(1);
        w.stop();
    });

    it('unsubscribe stops further notifications', async () => {
        const w = new SnapshotWatcher(dir);
        w.start();
        const events: any[] = [];
        const unsub = w.subscribe((e) => events.push(e));
        unsub();
        fs.writeFileSync(dbPath, 'after-unsub');
        const now = Date.now() / 1000;
        fs.utimesSync(dbPath, now, now);
        // No event expected — wait past the debounce window then assert.
        await new Promise((r) => setTimeout(r, 500));
        expect(events.length).toBe(0);
        w.stop();
    });
});

describe('exportOpenApiSpec', () => {
    it('produces an OpenAPI 3.1 doc with one path per tool', () => {
        const tools = [
            { name: 'foo', description: 'Foo tool', inputSchema: { type: 'object', properties: {}, required: [] } },
            { name: 'bar', description: 'Bar tool', inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } },
        ];
        const spec = exportOpenApiSpec(tools) as any;
        expect(spec.openapi).toBe('3.1.0');
        expect(Object.keys(spec.paths)).toEqual(['/tools/foo', '/tools/bar']);
        expect(spec.paths['/tools/bar'].post.operationId).toBe('bar');
        expect(spec.paths['/tools/bar'].post.requestBody.required).toBe(true);
        expect(spec.paths['/tools/foo'].post.requestBody.required).toBe(false);
    });
});

describe('exportFunctionCallingSpec', () => {
    it('produces an OpenAI/Anthropic function spec', () => {
        const tools = [{ name: 'hi', description: 'Hi', inputSchema: { type: 'object', properties: {} } }];
        const spec = exportFunctionCallingSpec(tools);
        expect(spec).toEqual([{ name: 'hi', description: 'Hi', parameters: { type: 'object', properties: {} } }]);
    });
});

describe('compareWorkspaces', () => {
    let leftRoot: string;
    let rightRoot: string;

    beforeAll(async () => {
        // Build two minimal SnapshotStore states with different api sets.
        leftRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-left-'));
        rightRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-right-'));
        const { SnapshotStore } = await import('../../core/storage/snapshotStore');
        for (const [root, routes] of [
            [leftRoot, ['GET /shared', 'POST /onlyLeft']],
            [rightRoot, ['GET /shared', 'DELETE /onlyRight']],
        ] as Array<[string, string[]]>) {
            const store = new SnapshotStore(root);
            await store.load();
            const working = store.getWorking();
            for (const r of routes) {
                const [method, route] = r.split(' ');
                working.apiIndex[`${method}:${route}::src/x.ts::h`] = {
                    apiId: `${method}:${route}::src/x.ts::h`,
                    method, route, handlerName: 'h', filePath: 'src/x.ts',
                    anchor: { filePath: 'src/x.ts' },
                };
            }
            store.save();
        }
    });
    afterAll(() => {
        try { fs.rmSync(leftRoot, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(rightRoot, { recursive: true, force: true }); } catch { /* */ }
    });

    it('reports only-in-left, only-in-right, and shared entry points', async () => {
        const result = await compareWorkspaces(leftRoot, rightRoot);
        const left = result.onlyInLeft.map((e) => `${e.method} ${e.route}`);
        const right = result.onlyInRight.map((e) => `${e.method} ${e.route}`);
        expect(left).toContain('POST /onlyLeft');
        expect(right).toContain('DELETE /onlyRight');
        expect(result.shared).toBeGreaterThanOrEqual(1);
    });
});

describe('summarisePayload', () => {
    it('summarises an EntryPointPack into a brief', () => {
        const pack = {
            entryPoint: { method: 'GET', route: '/users', auth: 'required', middlewares: ['auth.required'], clusterLabel: 'auth' },
            callsInto: [{ participant: 'db.ts' }, { participant: 'logger.ts' }, { participant: 'cache.ts' }, { participant: 'queue.ts' }, { participant: 'mail.ts' }],
            messages: [{ from: 'API Client', to: 'auth.controller.ts', label: 'getUser()' }],
            flowNodes: new Array(10).fill({}),
            siblings: new Array(3).fill({}),
            diff: { modifiedFunctions: ['x'], modifiedMessages: ['m'], modifiedFlowNodes: 2 },
        };
        const summary = summarisePayload(pack);
        expect(summary.title).toBe('GET /users');
        expect(summary.bullets.some((b) => b.includes('Auth: required'))).toBe(true);
        expect(summary.bullets.some((b) => b.includes('Calls into:'))).toBe(true);
        expect(summary.bullets.some((b) => b.includes('Diff:'))).toBe(true);
    });

    it('summarises a DiffSummary', () => {
        const diff = {
            changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
            addedEntryPoints: [{ method: 'GET', route: '/new' }],
            deletedEntryPoints: [],
            modifiedEntryPoints: [{ method: 'POST', route: '/users' }],
            modifiedClusters: [{ id: 'cluster:auth', label: 'auth' }],
        };
        const summary = summarisePayload(diff);
        expect(summary.title).toBe('Diff Summary');
        expect(summary.bullets[0]).toContain('4 files changed');
    });

    it('summarises an ImpactOfChange', () => {
        const impact = {
            entryPoints: [
                { method: 'GET', route: '/a', auth: 'required' },
                { method: 'POST', route: '/b', auth: 'required' },
                { method: 'DELETE', route: '/c' },
            ],
            affectedSequenceIds: [],
        };
        const summary = summarisePayload(impact);
        expect(summary.title).toBe('Impact Of Change');
        expect(summary.bullets[0]).toContain('3 entry points');
    });

    it('summarises a HealthReport', () => {
        const report = { deadFunctions: ['x', 'y'], godFiles: ['z'], highCouplingFiles: [], cyclicDependencies: [], orphanedClusters: [] };
        const summary = summarisePayload(report);
        expect(summary.title).toBe('Health Report');
        expect(summary.bullets.length).toBe(5);
    });

    it('caps bullets via maxBullets', () => {
        const pack = {
            entryPoint: { method: 'GET', route: '/x', auth: 'required', clusterLabel: 'c' },
            callsInto: [{ participant: 'a' }],
            messages: [],
            flowNodes: [],
            siblings: [],
            diff: { modifiedFunctions: [] },
        };
        const summary = summarisePayload(pack, 2);
        expect(summary.bullets.length).toBe(2);
    });

    it('reports object shape for unknown payload', () => {
        const summary = summarisePayload({ foo: 1, bar: 2 });
        expect(summary.bullets[0]).toContain('foo');
        expect(summary.bullets[0]).toContain('bar');
    });
});
