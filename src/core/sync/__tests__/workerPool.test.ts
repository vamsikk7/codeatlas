/**
 * ADR-034 Phase D Tier-2 (#789-D2) — WorkerPool tests.
 *
 * The fixture worker at `./fixtures/echoWorker.js` speaks the same protocol
 * as the production `repoWorker.ts` but skips the SnapshotStore work. That
 * keeps these tests fast (~100ms total) while still exercising the real
 * `worker_threads` boundary — no mocks of Worker, postMessage, or exit
 * events.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { WorkerPool } from '../workerPool';

const FIXTURE = path.join(__dirname, 'fixtures', 'echoWorker.js');

describe('WorkerPool', () => {
    const pools: WorkerPool[] = [];
    afterEach(async () => {
        await Promise.all(pools.splice(0).map((p) => p.close().catch(() => {})));
    });

    function makePool(size = 2): WorkerPool {
        const p = new WorkerPool({ workerScriptPath: FIXTURE, size });
        pools.push(p);
        return p;
    }

    it('spawns the requested number of workers and reports them via getSize', async () => {
        const pool = makePool(3);
        await pool.ready();
        expect(pool.getSize()).toBe(3);
    });

    it('runs a single task to completion', async () => {
        const pool = makePool(1);
        const r = await pool.runTask({ repoId: 'a', repoRoot: '/tmp/a', workspaceRoot: '/tmp' });
        expect(r.repoId).toBe('a');
        expect(r.persisted).toBe(true);
    });

    it('queues tasks beyond pool size', async () => {
        const pool = makePool(2);
        await pool.ready();
        const tasks = ['slow-1', 'slow-2', 'slow-3', 'slow-4'].map((id) =>
            pool.runTask({ repoId: id, repoRoot: `/tmp/${id}`, workspaceRoot: '/tmp' }),
        );
        // Right after enqueue, 2 tasks should be running and 2 queued.
        expect(pool.getQueueDepth()).toBeGreaterThan(0);
        const results = await Promise.all(tasks);
        expect(results.map((r) => r.repoId).sort()).toEqual(['slow-1', 'slow-2', 'slow-3', 'slow-4']);
    });

    it('propagates a worker-reported error to the caller', async () => {
        const pool = makePool(1);
        await expect(
            pool.runTask({ repoId: 'reject-me', repoRoot: '/tmp/r', workspaceRoot: '/tmp' }),
        ).rejects.toThrow(/rejected by fixture/);
    });

    it('recovers when a worker crashes — pool stays sized, next task succeeds', async () => {
        const pool = makePool(1);
        await pool.ready();
        await expect(
            pool.runTask({ repoId: 'crash-me', repoRoot: '/tmp/crash', workspaceRoot: '/tmp' }),
        ).rejects.toBeDefined();
        // Subsequent task on the respawned worker still works.
        const r = await pool.runTask({ repoId: 'ok', repoRoot: '/tmp/ok', workspaceRoot: '/tmp' });
        expect(r.repoId).toBe('ok');
        expect(pool.getSize()).toBe(1);
    });

    it('routes parallel tasks across multiple workers', async () => {
        const pool = makePool(4);
        await pool.ready();
        const t0 = Date.now();
        const results = await Promise.all(
            ['slow-a', 'slow-b', 'slow-c', 'slow-d'].map((id) =>
                pool.runTask({ repoId: id, repoRoot: `/tmp/${id}`, workspaceRoot: '/tmp' }),
            ),
        );
        const elapsed = Date.now() - t0;
        expect(results).toHaveLength(4);
        // Serial would be 4 × 80ms = 320ms; with 4 workers it should land
        // closer to one slow window. Generous bound for CI variance.
        expect(elapsed).toBeLessThan(280);
    });

    it('runTask after close() rejects', async () => {
        const pool = makePool(1);
        await pool.ready();
        await pool.close();
        await expect(
            pool.runTask({ repoId: 'x', repoRoot: '/tmp/x', workspaceRoot: '/tmp' }),
        ).rejects.toThrow(/closed/);
    });

    it('close() is idempotent', async () => {
        const pool = makePool(2);
        await pool.ready();
        await pool.close();
        await expect(pool.close()).resolves.toBeUndefined();
    });

    it('close() rejects pending queued tasks', async () => {
        const pool = makePool(1);
        await pool.ready();
        // Attach catch() handlers immediately so the brief unhandled-
        // rejection window between close() and the await assertions
        // doesn't trip node's PromiseRejectionHandledWarning.
        const inflight = pool
            .runTask({ repoId: 'slow-block', repoRoot: '/tmp/b', workspaceRoot: '/tmp' })
            .then(() => ({ status: 'ok' as const }))
            .catch((e: Error) => ({ status: 'err' as const, message: e.message }));
        const queued = pool
            .runTask({ repoId: 'never-runs', repoRoot: '/tmp/n', workspaceRoot: '/tmp' })
            .then(() => ({ status: 'ok' as const }))
            .catch((e: Error) => ({ status: 'err' as const, message: e.message }));
        await pool.close();
        const q = await queued;
        const i = await inflight;
        expect(q.status).toBe('err');
        expect((q as { message: string }).message).toMatch(/closed/);
        expect(i.status).toBe('err');
    });
});
