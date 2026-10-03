/**
 * graphMutationQueue.test.ts — Issue 359 / ADR-020
 *
 * Pins the single-writer invariant: tasks never interleave even when
 * submitted concurrently. The recent cascade-on-navigation work added
 * 7+ call sites that mutate the snapshot store; without serialization,
 * concurrent saves + cascade calls can corrupt shared state.
 */

import { describe, it, expect } from 'vitest';
import { GraphMutationQueue } from '../graphMutationQueue';

describe('GraphMutationQueue', () => {
    it('runs tasks strictly in FIFO order', async () => {
        const q = new GraphMutationQueue();
        const order: number[] = [];
        const promises = [1, 2, 3, 4, 5].map((n) =>
            q.enqueue({
                run: async () => {
                    // Stagger durations to expose any out-of-order execution.
                    await new Promise(r => setTimeout(r, 5 - n));
                    order.push(n);
                    return n;
                },
            })
        );
        await Promise.all(promises);
        expect(order).toEqual([1, 2, 3, 4, 5]);
    });

    it('serializes overlapping submissions — no interleave', async () => {
        const q = new GraphMutationQueue();
        let active = 0;
        let maxConcurrent = 0;
        const work = async () => {
            active++;
            maxConcurrent = Math.max(maxConcurrent, active);
            await new Promise(r => setTimeout(r, 2));
            active--;
        };
        await Promise.all(
            Array.from({ length: 10 }, () => q.enqueue({ run: work })),
        );
        // Single-writer invariant: never more than 1 task active concurrently.
        expect(maxConcurrent).toBe(1);
    });

    it('coalesces tasks with the same key when one is already queued', async () => {
        const q = new GraphMutationQueue();
        let runs = 0;
        // Block the queue with a long-running task so subsequent ones wait.
        const blocker = q.enqueue({
            run: async () => {
                await new Promise(r => setTimeout(r, 30));
                runs++;
                return 'blocker';
            },
        });
        // Three submissions with the same key while blocker is running.
        const a = q.enqueue({ key: 'cascade', run: async () => { runs++; return 'a'; } });
        const b = q.enqueue({ key: 'cascade', run: async () => { runs++; return 'b'; } });
        const c = q.enqueue({ key: 'cascade', run: async () => { runs++; return 'c'; } });
        const results = await Promise.all([blocker, a, b, c]);
        // Only ONE keyed task actually runs (blocker + 1 cascade = 2 runs total).
        expect(runs).toBe(2);
        // The coalesced promises all resolve to the same value (whichever
        // task body actually ran — typically the first submission's).
        expect(results[1]).toBe(results[2]);
        expect(results[2]).toBe(results[3]);
    });

    it('does not coalesce tasks without keys', async () => {
        const q = new GraphMutationQueue();
        let runs = 0;
        const work = async () => { runs++; return runs; };
        const results = await Promise.all([
            q.enqueue({ run: work }),
            q.enqueue({ run: work }),
            q.enqueue({ run: work }),
        ]);
        expect(runs).toBe(3);
        expect(results).toEqual([1, 2, 3]);
    });

    it('rejects callers when a task throws, but keeps draining', async () => {
        const q = new GraphMutationQueue();
        const a = q.enqueue({ run: async () => { throw new Error('boom'); } });
        const b = q.enqueue({ run: async () => 'survived' });
        await expect(a).rejects.toThrow('boom');
        await expect(b).resolves.toBe('survived');
    });

    it('supports synchronous tasks', async () => {
        const q = new GraphMutationQueue();
        const v = await q.enqueueSync('test', () => 42);
        expect(v).toBe(42);
    });

    it('waitForIdle resolves once the queue drains', async () => {
        const q = new GraphMutationQueue();
        q.enqueue({ run: async () => { await new Promise(r => setTimeout(r, 10)); return 1; } });
        q.enqueue({ run: async () => { await new Promise(r => setTimeout(r, 10)); return 2; } });
        await q.waitForIdle();
        expect(q.isRunning()).toBe(false);
        expect(q.pending()).toBe(0);
    });
});
