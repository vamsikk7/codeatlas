/**
 * ADR-034 Phase D Tier-2 (#789-D2) — worker pool that drives `repoWorker.ts`.
 *
 * The pool is a persistent set of N `worker_threads` Workers, sized to
 * `min(8, os.cpus().length)`. Repo init tasks are queued; whenever a worker
 * is free it pulls the next task. Workers stay warm across the whole pool
 * lifetime so we pay sql.js + tree-sitter WASM init exactly once per worker
 * (~100ms each).
 *
 * The pool is intentionally minimal — it owns the message-passing protocol
 * defined in `repoWorker.ts` and exposes a single `runTask(task)` Promise.
 * The `RepoDispatcher` consumes it when `mode: 'tier2'` is selected; on any
 * pool construction failure (worker bundle missing, WASM resolution failure,
 * worker_threads not available) the dispatcher transparently degrades to
 * Tier-1 — no user-visible regression.
 *
 * Lifecycle:
 *   `new WorkerPool({ workerScriptPath, size, grammarsDir })`  → constructs N workers
 *   `await pool.ready()`                                       → resolves once every worker emits 'ready'
 *   `await pool.runTask(task)`                                 → enqueues; resolves with WorkerResult
 *   `pool.close()`                                             → terminates every worker; idempotent
 *
 * Error handling:
 *   - Worker crashes mid-task → the affected task rejects with the worker
 *     error; the pool respawns a replacement worker so subsequent tasks
 *     still have capacity.
 *   - `runTask` after `close()` rejects synchronously.
 */

import { Worker } from 'worker_threads';
import * as os from 'os';
import type { WorkerResult, WorkerTask } from './repoWorker';

export interface WorkerPoolOptions {
    /** Absolute path to the bundled `repo-worker.js` produced by esbuild. */
    workerScriptPath: string;
    /** Pool size. Defaults to `min(8, os.cpus().length)`. */
    size?: number;
    /** Optional grammars dir hint forwarded to every worker. */
    grammarsDir?: string;
    /** Optional logger; receives forwarded worker logs + pool diagnostics. */
    log?: (msg: string) => void;
}

interface PendingTask {
    task: WorkerTask;
    resolve: (result: WorkerResult) => void;
    reject: (err: Error) => void;
    requestId: number;
}

interface WorkerSlot {
    worker: Worker;
    ready: boolean;
    busy: boolean;
    currentRequestId: number | null;
    currentResolve: ((result: WorkerResult) => void) | null;
    currentReject: ((err: Error) => void) | null;
    readyPromise: Promise<void>;
}

let _nextRequestId = 1;

export class WorkerPool {
    private slots: WorkerSlot[] = [];
    private queue: PendingTask[] = [];
    private closed = false;
    private readonly size: number;

    constructor(private readonly opts: WorkerPoolOptions) {
        this.size = Math.max(1, opts.size ?? Math.min(8, os.cpus().length));
        for (let i = 0; i < this.size; i += 1) {
            this.slots.push(this.spawnSlot());
        }
    }

    /** Resolves once every worker has emitted its initial `ready` message. */
    async ready(): Promise<void> {
        await Promise.all(this.slots.map((s) => s.readyPromise));
    }

    /** Queue a task; resolves with the worker's `WorkerResult`. */
    runTask(task: WorkerTask): Promise<WorkerResult> {
        if (this.closed) {
            return Promise.reject(new Error('[WorkerPool] pool is closed; runTask rejected'));
        }
        return new Promise<WorkerResult>((resolve, reject) => {
            const requestId = _nextRequestId++;
            this.queue.push({ task, resolve, reject, requestId });
            this.dispatchNext();
        });
    }

    /** Terminate every worker. Subsequent runTask() calls reject. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const pending = this.queue.splice(0);
        for (const p of pending) {
            p.reject(new Error('[WorkerPool] closed before task ran'));
        }
        await Promise.all(
            this.slots.map(async (s) => {
                if (s.currentReject) {
                    s.currentReject(new Error('[WorkerPool] closed during task'));
                }
                try { await s.worker.terminate(); } catch { /* ignore */ }
            }),
        );
        this.slots = [];
    }

    /** Test hook — current pool size after any respawns. */
    getSize(): number { return this.slots.length; }

    /** Test hook — current depth of the queued-but-not-running list. */
    getQueueDepth(): number { return this.queue.length; }

    // ─── internals ──────────────────────────────────────────────────────

    private spawnSlot(): WorkerSlot {
        const w = new Worker(this.opts.workerScriptPath);
        let resolveReady!: () => void;
        const readyPromise = new Promise<void>((res) => { resolveReady = res; });
        const slot: WorkerSlot = {
            worker: w,
            ready: false,
            busy: false,
            currentRequestId: null,
            currentResolve: null,
            currentReject: null,
            readyPromise,
        };

        w.on('message', (msg: any) => {
            if (msg && msg.type === 'ready' && !slot.ready) {
                slot.ready = true;
                resolveReady();
                // CRITICAL: tasks queued before the worker came online get
                // dispatched as soon as it's ready. Without this, runTask()
                // called pre-ready hangs forever.
                this.dispatchNext();
                return;
            }
            this.handleWorkerMessage(slot, msg);
        });
        // @types/node 26 types the 'error' payload as `unknown` rather than
        // `Error` -- correctly, since a worker can reject with any value.
        // Narrow it so a non-Error throw still produces a usable message
        // instead of `[object Object]` downstream.
        w.on('error', (err: unknown) => this.handleWorkerExit(
            slot,
            err instanceof Error ? err : new Error(String(err)),
        ));
        w.on('exit', (code) => {
            if (code !== 0) {
                this.handleWorkerExit(slot, new Error(`[WorkerPool] worker exited with code ${code}`));
            }
        });

        return slot;
    }

    private handleWorkerMessage(slot: WorkerSlot, msg: any): void {
        if (!msg) return;
        if (msg.type === 'ready') return;       // handled in readyPromise
        if (msg.type === 'log') {
            this.opts.log?.(msg.msg);
            return;
        }
        if (msg.type === 'done' && slot.currentRequestId === msg.requestId) {
            const resolve = slot.currentResolve;
            this.releaseSlot(slot);
            resolve?.(msg.result as WorkerResult);
            this.dispatchNext();
            return;
        }
        if (msg.type === 'error' && slot.currentRequestId === msg.requestId) {
            const reject = slot.currentReject;
            this.releaseSlot(slot);
            reject?.(new Error(msg.error ?? 'worker reported error without message'));
            this.dispatchNext();
            return;
        }
    }

    private handleWorkerExit(slot: WorkerSlot, err: Error): void {
        if (this.closed) return;
        this.opts.log?.(`[WorkerPool] worker died: ${err.message}`);
        if (slot.currentReject) {
            slot.currentReject(err);
        }
        // Drop the dead slot and spawn a replacement so capacity stays N.
        const idx = this.slots.indexOf(slot);
        if (idx >= 0) {
            this.slots.splice(idx, 1);
            this.slots.push(this.spawnSlot());
        }
        this.dispatchNext();
    }

    private releaseSlot(slot: WorkerSlot): void {
        slot.busy = false;
        slot.currentRequestId = null;
        slot.currentResolve = null;
        slot.currentReject = null;
    }

    private dispatchNext(): void {
        if (this.closed) return;
        if (this.queue.length === 0) return;
        const free = this.slots.find((s) => !s.busy && s.ready);
        if (!free) return;
        const pending = this.queue.shift()!;
        free.busy = true;
        free.currentRequestId = pending.requestId;
        free.currentResolve = pending.resolve;
        free.currentReject = pending.reject;
        free.worker.postMessage({
            type: 'init-repo',
            task: pending.task,
            requestId: pending.requestId,
            grammarsDir: this.opts.grammarsDir,
        });
    }
}
