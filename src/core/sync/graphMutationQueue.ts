/**
 * graphMutationQueue.ts
 *
 * Issue 359 / ADR-020 — single-writer queue for graph mutations.
 *
 * INVARIANT: at most one mutation runs against the snapshot store at a
 * time. Concurrent calls to `applyDiffCascadeToLiveGraphs`, `rebuildFile`,
 * navigation handlers, and replay flows are serialized so they never
 * interleave on shared state.
 *
 * Reads remain free; only mutations queue. The queue is FIFO; tasks are
 * coalesced by identity-key when present (the same kind of mutation
 * already queued does not double-queue).
 */

export interface QueuedTask<T> {
    /**
     * Identity key for coalescing. If a task with the same key is already
     * queued and not yet running, the new task is dropped (its result
     * promise resolves to the queued task's result). Use undefined to
     * force-queue every call (default).
     */
    key?: string;

    /** The actual mutation to run. Must not throw — wrap with try/catch. */
    run: () => Promise<T> | T;
}

interface InternalEntry<T> {
    key?: string;
    run: () => Promise<T> | T;
    resolve: (value: T) => void;
    reject: (err: any) => void;
}

export class GraphMutationQueue {
    private queue: InternalEntry<any>[] = [];
    private running = false;
    private log: (msg: string) => void = () => {};

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    /**
     * Enqueue a mutation task. Returns a promise that resolves to the
     * task's return value (or rejects if it throws). Tasks run strictly
     * in submission order; reentrant submission from within a task is
     * supported (the inner task queues behind the outer).
     */
    enqueue<T>(task: QueuedTask<T>): Promise<T> {
        // Coalesce: if an unstarted task with the same key already exists,
        // attach to its outcome instead of queueing a duplicate.
        if (task.key) {
            const existing = this.queue.find(e => e.key === task.key);
            if (existing) {
                return new Promise<T>((resolve, reject) => {
                    const origResolve = existing.resolve;
                    const origReject = existing.reject;
                    existing.resolve = (v: any) => { origResolve(v); resolve(v); };
                    existing.reject = (e: any) => { origReject(e); reject(e); };
                });
            }
        }
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ key: task.key, run: task.run, resolve, reject });
            void this.drain();
        });
    }

    /**
     * Convenience: run a synchronous mutation through the queue. Caller
     * gets back a promise even though `run` is sync, to keep the API
     * uniform with async tasks.
     */
    enqueueSync<T>(key: string | undefined, run: () => T): Promise<T> {
        return this.enqueue({ key, run });
    }

    /** True while the queue is processing a task. */
    isRunning(): boolean {
        return this.running;
    }

    /** Number of tasks waiting to start. */
    pending(): number {
        return this.queue.length;
    }

    /** Wait for the queue to drain. Resolves once running=false and queue is empty. */
    async waitForIdle(): Promise<void> {
        while (this.running || this.queue.length > 0) {
            await new Promise(r => setTimeout(r, 5));
        }
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length > 0) {
                const entry = this.queue.shift()!;
                try {
                    const result = await entry.run();
                    entry.resolve(result);
                } catch (err) {
                    this.log(`[GraphMutationQueue] task failed: ${(err as any)?.message ?? err}`);
                    entry.reject(err);
                }
            }
        } finally {
            this.running = false;
        }
    }
}
