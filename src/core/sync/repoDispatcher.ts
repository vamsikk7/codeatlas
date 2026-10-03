/**
 * ADR-034 Phase D Tier-1 (#789 — Phase D: parallel per-repo parse + per-repo watcher (ADR-034)) — `RepoDispatcher` (in-process).
 *
 * Replaces `WorkspaceOrchestrator`'s serial per-repo init loop with a
 * concurrency-capped `Promise.all`. Each repo's runner runs as today
 * (in-process, async), but multiple can be in-flight at once up to the
 * cap — bounded by `min(8, os.cpus().length)` by default so a 42-repo
 * workspace doesn't OOM by spawning 42 simultaneous parses.
 *
 * Tier-2 (#789-D2, separate ship) adds true CPU parallelism via a
 * `worker_threads` pool with the same dispatcher API — `RepoDispatcher`
 * is the seam where modes are swapped.
 *
 * Design notes (per ADR-034 perf analysis):
 *   - p-limit-style semaphore (in-house; no new dep) — controls how many
 *     repos are initialising concurrently
 *   - Deterministic repo order — repos are dispatched in sorted-by-name
 *     order so logs / progress callbacks fire in a predictable sequence
 *   - Per-repo timeout (10 min default) — a runaway parse can't block
 *     siblings forever
 *   - Failure isolation — any single repo throw is caught + reported via
 *     `onRepoFailed`, never aborts the batch
 *   - Reentrancy guard — calling `dispatch()` while a prior call is still
 *     running rejects with an explicit error (avoids interleaved writes
 *     to the same repo)
 */
import * as os from 'os';
import type { RepoStoreRegistry } from '../storage/repoStoreRegistry';
import type { RepoRow } from '../storage/storeInterfaces';
import type { WorkerPool } from './workerPool';
import type { WorkerResult } from './repoWorker';

export interface RepoDispatchOptions {
    /** Maximum repos in-flight at once. Defaults to min(8, cpu count). */
    concurrencyLimit?: number;
    /**
     * Concurrency mode:
     *   - 'in-process' — Tier-1, semaphore-gated Promise.all over async runners.
     *   - 'worker-threads' — Tier-2, repos parsed in dedicated worker_threads
     *     workers via a persistent pool. Real CPU parallelism (each worker has
     *     its own V8 isolate / Babel / tree-sitter). The dispatcher hands the
     *     worker side off to `opts.workerPool`; after the worker reports done,
     *     `opts.tier2PostInit` runs on the main thread to register the store
     *     in the registry + apply the produced summary.
     */
    mode?: 'in-process' | 'worker-threads';
    /** Required when mode='worker-threads'. */
    workerPool?: WorkerPool;
    /**
     * Required when mode='worker-threads'. Runs on the main thread AFTER the
     * worker has persisted the per-repo state.db. Receives the WorkerResult so
     * the caller can re-open the SnapshotStore, register it, and apply the
     * summary to the aggregator. Errors propagate as repo failures.
     */
    tier2PostInit?: (params: {
        workspaceRoot: string;
        repoRoot: string;
        repoId: string;
        registry: RepoStoreRegistry;
        log: (msg: string) => void;
        workerResult: WorkerResult;
    }) => Promise<void>;
    /** Per-repo abort threshold. Default 10 minutes. */
    timeoutPerRepoMs?: number;
    /** Fires when a repo's runner is about to start. */
    onRepoStart?: (repoId: string, rootPath: string) => void;
    /** Fires when a repo's runner completes successfully. */
    onRepoFinish?: (repoId: string, rootPath: string, durationMs: number) => void;
    /** Fires when a repo's runner throws. */
    onRepoFailed?: (repoId: string, rootPath: string, error: Error) => void;
}

export interface RepoDispatchResult {
    totalDurationMs: number;
    perRepoDurationsMs: Record<string, number>;
    failures: ReadonlyArray<{ repoId: string; rootPath: string; error: string }>;
}

/**
 * Driver fired per repo. `RepoDispatcher` is agnostic about what the
 * runner does — Phase B's production runner constructs a SnapshotStore +
 * SyncOrchestrator and runs `initialize()`. Tests can pass a mock.
 */
export type RepoRunner = (params: {
    workspaceRoot: string;
    repoRoot: string;
    repoId: string;
    registry: RepoStoreRegistry;
    log: (msg: string) => void;
}) => Promise<void>;

export class RepoDispatcher {
    private inFlight = false;

    constructor(
        private readonly registry: RepoStoreRegistry,
        private readonly log: (msg: string) => void = () => { /* noop */ },
    ) {}

    /**
     * Dispatch initialisation across N repos with bounded concurrency.
     * Resolves when every repo has either finished or failed. Never
     * rejects on individual-repo failure — those land in `result.failures`.
     */
    async dispatch(
        repos: ReadonlyArray<RepoRow>,
        workspaceRoot: string,
        runner: RepoRunner,
        opts: RepoDispatchOptions = {},
    ): Promise<RepoDispatchResult> {
        if (this.inFlight) {
            throw new Error('[RepoDispatcher] dispatch() reentrant call rejected — wait for prior batch to finish');
        }
        this.inFlight = true;
        try {
            const t0 = Date.now();
            const concurrencyLimit = Math.max(1, opts.concurrencyLimit ?? Math.min(8, os.cpus().length));
            const timeoutMs = opts.timeoutPerRepoMs ?? 10 * 60 * 1000;
            const perRepoDurationsMs: Record<string, number> = {};
            const failures: Array<{ repoId: string; rootPath: string; error: string }> = [];

            // Deterministic order: sort by rootPath (basename in practice) so
            // logs + progress callbacks fire in a predictable sequence.
            const ordered = [...repos].sort((a, b) => a.rootPath.localeCompare(b.rootPath));
            const sem = new Semaphore(concurrencyLimit);

            const mode = opts.mode ?? 'in-process';
            if (mode === 'worker-threads') {
                if (!opts.workerPool) throw new Error('[RepoDispatcher] mode=worker-threads requires opts.workerPool');
                if (!opts.tier2PostInit) throw new Error('[RepoDispatcher] mode=worker-threads requires opts.tier2PostInit');
            }

            const runOne = async (row: RepoRow): Promise<void> => {
                await sem.acquire();
                const tRepo = Date.now();
                try {
                    if (opts.onRepoStart) opts.onRepoStart(row.repoId, row.rootPath);
                    const repoAbs = row.rootPath ? joinPaths(workspaceRoot, row.rootPath) : workspaceRoot;
                    if (mode === 'worker-threads') {
                        // Tier-2: worker does init + persist; main thread does
                        // registry registration + summary application.
                        const workerResult = await withTimeout(
                            opts.workerPool!.runTask({
                                repoId: row.repoId,
                                repoRoot: repoAbs,
                                workspaceRoot,
                            }),
                            timeoutMs,
                            row.repoId,
                        );
                        await opts.tier2PostInit!({
                            workspaceRoot,
                            repoRoot: repoAbs,
                            repoId: row.repoId,
                            registry: this.registry,
                            log: this.log,
                            workerResult,
                        });
                    } else {
                        await withTimeout(
                            runner({
                                workspaceRoot,
                                repoRoot: repoAbs,
                                repoId: row.repoId,
                                registry: this.registry,
                                log: this.log,
                            }),
                            timeoutMs,
                            row.repoId,
                        );
                    }
                    const ms = Date.now() - tRepo;
                    perRepoDurationsMs[row.repoId] = ms;
                    if (opts.onRepoFinish) opts.onRepoFinish(row.repoId, row.rootPath, ms);
                } catch (err: any) {
                    const ms = Date.now() - tRepo;
                    perRepoDurationsMs[row.repoId] = ms;
                    const wrapped = err instanceof Error ? err : new Error(String(err));
                    failures.push({ repoId: row.repoId, rootPath: row.rootPath, error: String(err?.message ?? err) });
                    if (opts.onRepoFailed) opts.onRepoFailed(row.repoId, row.rootPath, wrapped);
                    this.log(`[RepoDispatcher] ${row.rootPath} failed: ${wrapped.message}`);
                } finally {
                    sem.release();
                }
            };

            await Promise.all(ordered.map(runOne));
            return {
                totalDurationMs: Date.now() - t0,
                perRepoDurationsMs,
                failures,
            };
        } finally {
            this.inFlight = false;
        }
    }

    /** Test hook — exposes whether a dispatch is currently running. */
    isInFlight(): boolean { return this.inFlight; }
}

// ─── internal — semaphore ───────────────────────────────────────────────

class Semaphore {
    private slots: number;
    private waiters: Array<() => void> = [];

    constructor(capacity: number) {
        this.slots = capacity;
    }

    async acquire(): Promise<void> {
        if (this.slots > 0) {
            this.slots -= 1;
            return;
        }
        return new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) {
            next();
        } else {
            this.slots += 1;
        }
    }
}

// ─── internal — helpers ─────────────────────────────────────────────────

function joinPaths(workspaceRoot: string, rootPath: string): string {
    if (!rootPath) return workspaceRoot;
    const ws = workspaceRoot.replace(/[/\\]+$/, '');
    return `${ws}/${rootPath.replace(/^[/\\]+/, '')}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number, repoId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[RepoDispatcher] timeout after ${ms}ms initialising repo ${repoId}`)), ms);
    });
    try {
        const result = await Promise.race([p, timeout]);
        return result;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
