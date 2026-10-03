/**
 * ADR-034 Phase D Tier-1 (#789 — Phase D: parallel per-repo parse + per-repo watcher (ADR-034)) — RepoDispatcher tests.
 *
 * Covers concurrency cap, deterministic order, callbacks, failure
 * isolation, reentrancy guard, per-repo timeout, and result shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RepoDispatcher } from '../repoDispatcher';
import type { RepoRunner } from '../repoDispatcher';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import type { RepoRow } from '../../storage/storeInterfaces';

beforeEach(() => RepoStoreRegistry.setForTest(null));
afterEach(() => RepoStoreRegistry.setForTest(null));

function row(rootPath: string, repoId: string = `r-${rootPath}`): RepoRow {
    return {
        repoId, name: rootPath || 'root', rootPath, realpathHash: repoId,
        technology: null, status: 'ready', lastInitAt: 0, errorMessage: null,
        fallbackStatePath: null, stateDbSchemaVersion: 9, summarySchemaVersion: 1,
        diff: null,
    };
}

describe('RepoDispatcher — happy path', () => {
    it('dispatches every repo and reports per-repo durations', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('alpha'), row('beta'), row('gamma')];
        const seen: string[] = [];
        const runner: RepoRunner = async ({ repoId }) => { seen.push(repoId); };

        const result = await dispatcher.dispatch(repos, '/workspace', runner);

        expect(seen.sort()).toEqual(['r-alpha', 'r-beta', 'r-gamma']);
        expect(Object.keys(result.perRepoDurationsMs).sort()).toEqual(['r-alpha', 'r-beta', 'r-gamma']);
        expect(result.failures).toHaveLength(0);
        expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('dispatches in deterministic order (sorted by rootPath)', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('zeta'), row('alpha'), row('mid')];
        const startedOrder: string[] = [];
        const runner: RepoRunner = async () => { /* noop */ };
        const result = await dispatcher.dispatch(
            repos, '/workspace', runner,
            { onRepoStart: (_id, rootPath) => startedOrder.push(rootPath), concurrencyLimit: 1 },
        );
        expect(startedOrder).toEqual(['alpha', 'mid', 'zeta']);
        expect(result.failures).toHaveLength(0);
    });

    it('fires onRepoStart + onRepoFinish for every repo', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('a'), row('b')];
        const started: string[] = [];
        const finished: string[] = [];
        await dispatcher.dispatch(
            repos, '/workspace', async () => { /* noop */ },
            {
                onRepoStart: (id) => started.push(id),
                onRepoFinish: (id) => finished.push(id),
            },
        );
        expect(started.sort()).toEqual(['r-a', 'r-b']);
        expect(finished.sort()).toEqual(['r-a', 'r-b']);
    });
});

describe('RepoDispatcher — concurrency cap', () => {
    it('respects concurrencyLimit (1) — fully serial', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('a'), row('b'), row('c')];
        let inFlight = 0;
        let maxConcurrent = 0;
        const runner: RepoRunner = async () => {
            inFlight += 1;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight -= 1;
        };
        await dispatcher.dispatch(repos, '/workspace', runner, { concurrencyLimit: 1 });
        expect(maxConcurrent).toBe(1);
    });

    it('respects concurrencyLimit (2) — parallel up to 2', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('a'), row('b'), row('c'), row('d'), row('e')];
        let inFlight = 0;
        let maxConcurrent = 0;
        const runner: RepoRunner = async () => {
            inFlight += 1;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            await new Promise((r) => setTimeout(r, 8));
            inFlight -= 1;
        };
        await dispatcher.dispatch(repos, '/workspace', runner, { concurrencyLimit: 2 });
        expect(maxConcurrent).toBe(2);
    });
});

describe('RepoDispatcher — failure isolation', () => {
    it('one repo throws — others succeed; failure recorded', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('good'), row('bad'), row('ok')];
        const runner: RepoRunner = async ({ repoId }) => {
            if (repoId === 'r-bad') throw new Error('parser exploded');
        };
        const result = await dispatcher.dispatch(repos, '/workspace', runner);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].repoId).toBe('r-bad');
        expect(result.failures[0].error).toMatch(/parser exploded/);
        expect(Object.keys(result.perRepoDurationsMs).sort()).toEqual(['r-bad', 'r-good', 'r-ok']);
    });

    it('onRepoFailed fires for the failing repo only', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('good'), row('bad')];
        const failed: Array<{ id: string; msg: string }> = [];
        await dispatcher.dispatch(
            repos, '/workspace',
            async ({ repoId }) => { if (repoId === 'r-bad') throw new Error('boom'); },
            { onRepoFailed: (id, _path, err) => failed.push({ id, msg: err.message }) },
        );
        expect(failed).toHaveLength(1);
        expect(failed[0].id).toBe('r-bad');
        expect(failed[0].msg).toBe('boom');
    });
});

describe('RepoDispatcher — reentrancy', () => {
    it('rejects a second dispatch while the first is still running', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('a'), row('b')];
        const slowRunner: RepoRunner = async () => {
            await new Promise((r) => setTimeout(r, 30));
        };
        const first = dispatcher.dispatch(repos, '/workspace', slowRunner);
        await new Promise((r) => setTimeout(r, 5));
        expect(dispatcher.isInFlight()).toBe(true);
        await expect(dispatcher.dispatch(repos, '/workspace', slowRunner)).rejects.toThrow(/reentrant/);
        await first;
        expect(dispatcher.isInFlight()).toBe(false);
    });

    it('after a dispatch finishes, a new one is allowed', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('a')];
        const runner: RepoRunner = async () => { /* noop */ };
        await dispatcher.dispatch(repos, '/workspace', runner);
        await expect(dispatcher.dispatch(repos, '/workspace', runner)).resolves.toBeDefined();
    });
});

describe('RepoDispatcher — timeouts', () => {
    it('aborts a runaway repo after timeoutPerRepoMs', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('slow')];
        const runner: RepoRunner = () => new Promise(() => { /* never resolves */ });
        const result = await dispatcher.dispatch(
            repos, '/workspace', runner,
            { timeoutPerRepoMs: 30 },
        );
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].error).toMatch(/timeout/);
    });
});

describe('RepoDispatcher — empty', () => {
    it('returns clean result for zero repos', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const runner: RepoRunner = async () => { /* unused */ };
        const result = await dispatcher.dispatch([], '/workspace', runner);
        expect(result.failures).toHaveLength(0);
        expect(Object.keys(result.perRepoDurationsMs)).toHaveLength(0);
    });
});

describe('RepoDispatcher — workspace-relative paths passed to runner', () => {
    it('repoRoot resolves under workspaceRoot when rootPath is set', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('svc-alpha', 'r-alpha')];
        const seen: { ws: string; repo: string }[] = [];
        const runner: RepoRunner = async ({ workspaceRoot, repoRoot }) => {
            seen.push({ ws: workspaceRoot, repo: repoRoot });
        };
        await dispatcher.dispatch(repos, '/some/workspace', runner);
        expect(seen[0]).toEqual({ ws: '/some/workspace', repo: '/some/workspace/svc-alpha' });
    });

    it('repoRoot equals workspaceRoot when rootPath is empty (single-repo mode)', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('', 'r-only')];
        const seen: { ws: string; repo: string }[] = [];
        await dispatcher.dispatch(repos, '/the/ws', async ({ workspaceRoot, repoRoot }) => {
            seen.push({ ws: workspaceRoot, repo: repoRoot });
        });
        expect(seen[0]).toEqual({ ws: '/the/ws', repo: '/the/ws' });
    });
});

// ─── ADR-034 Phase D Tier-2 (#789-D2) — worker-threads mode ─────────────
describe('RepoDispatcher — Tier-2 (mode=worker-threads)', () => {
    it('rejects when mode=worker-threads but no workerPool provided', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        await expect(
            dispatcher.dispatch([row('a')], '/ws', async () => {}, {
                mode: 'worker-threads',
                tier2PostInit: async () => {},
            }),
        ).rejects.toThrow(/workerPool/);
    });

    it('rejects when mode=worker-threads but no tier2PostInit provided', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const fakePool = { runTask: async () => ({ repoId: 'a', summary: null, persisted: true, durationMs: 1 }) } as any;
        await expect(
            dispatcher.dispatch([row('a')], '/ws', async () => {}, {
                mode: 'worker-threads',
                workerPool: fakePool,
            }),
        ).rejects.toThrow(/tier2PostInit/);
    });

    it('routes each repo through workerPool.runTask + tier2PostInit when mode=worker-threads', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const repos = [row('svc-a'), row('svc-b')];
        const workerTasks: string[] = [];
        const postInits: Array<{ repoId: string; durationMs: number }> = [];
        const fakePool = {
            runTask: async (task: any) => {
                workerTasks.push(task.repoId);
                return { repoId: task.repoId, summary: null, persisted: true, durationMs: 7 };
            },
        } as any;
        // The in-process runner should NEVER fire in Tier-2 mode.
        let inProcCalls = 0;
        const result = await dispatcher.dispatch(
            repos,
            '/ws',
            async () => { inProcCalls += 1; },
            {
                mode: 'worker-threads',
                workerPool: fakePool,
                tier2PostInit: async ({ repoId, workerResult }) => {
                    postInits.push({ repoId, durationMs: workerResult.durationMs });
                },
            },
        );
        expect(inProcCalls).toBe(0);
        expect(workerTasks.sort()).toEqual(['r-svc-a', 'r-svc-b']);
        expect(postInits.map((p) => p.repoId).sort()).toEqual(['r-svc-a', 'r-svc-b']);
        expect(result.failures).toEqual([]);
    });

    it('a Tier-2 post-init throw lands in result.failures', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const fakePool = {
            runTask: async (task: any) => ({ repoId: task.repoId, summary: null, persisted: true, durationMs: 1 }),
        } as any;
        const result = await dispatcher.dispatch(
            [row('svc-a'), row('svc-b')],
            '/ws',
            async () => {},
            {
                mode: 'worker-threads',
                workerPool: fakePool,
                tier2PostInit: async ({ repoId }) => {
                    if (repoId === 'r-svc-b') throw new Error('post-init blew up');
                },
            },
        );
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].repoId).toBe('r-svc-b');
        expect(result.failures[0].error).toMatch(/post-init blew up/);
    });

    it('a worker-pool runTask rejection lands in result.failures', async () => {
        const dispatcher = new RepoDispatcher(new RepoStoreRegistry());
        const fakePool = {
            runTask: async (task: any) => {
                if (task.repoId === 'r-bad') throw new Error('worker rejected');
                return { repoId: task.repoId, summary: null, persisted: true, durationMs: 1 };
            },
        } as any;
        const result = await dispatcher.dispatch(
            [row('a', 'r-a'), row('bad', 'r-bad'), row('b', 'r-b')],
            '/ws',
            async () => {},
            {
                mode: 'worker-threads',
                workerPool: fakePool,
                tier2PostInit: async () => {},
            },
        );
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].repoId).toBe('r-bad');
        expect(result.failures[0].error).toMatch(/worker rejected/);
    });
});
