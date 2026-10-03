/**
 * ADR-034 Phase D Tier-2 (#789-D2) — worker entry point.
 *
 * Runs a single per-repo init (SnapshotStore.load + SyncOrchestrator.initialize)
 * inside a dedicated `worker_threads` worker. The main thread spawns N of these
 * via `workerPool.ts` (sized to `min(8, os.cpus().length)`) and queues repo
 * tasks across them; each worker stays warm and processes multiple repos
 * sequentially so we pay WASM init cost (~100ms per sql.js + tree-sitter
 * bootstrap) once per worker, not once per repo.
 *
 * IPC contract (parentPort messages):
 *
 *   main → worker:  { type: 'init-repo', task: WorkerTask, requestId: number }
 *   worker → main:  { type: 'ready' }                              // on boot
 *   worker → main:  { type: 'log', requestId, msg }                // forwarded log lines
 *   worker → main:  { type: 'done', requestId, result: WorkerResult }
 *   worker → main:  { type: 'error', requestId, error: string }
 *
 * The worker never shares JS object state with the main thread. The summary
 * (a plain JSON object) is the only structured handoff; everything else lives
 * on disk inside the repo's `.codeatlas/state.db`, which the main thread
 * re-opens after the worker reports `done`.
 *
 * Wasm assets: sql.js + tree-sitter wasm files live under `dist/` and are
 * loaded by the same resolvers the main thread uses. esbuild bundles this
 * worker into `dist/repo-worker.js`, alongside the main extension bundle,
 * so the relative `__dirname` math in the storage + parser layers resolves
 * to the same files.
 */

import { parentPort, isMainThread } from 'worker_threads';
import { SnapshotStore } from '../storage/snapshotStore';
import { CommentStore } from '../storage/commentStore';
import { SyncOrchestrator } from './syncOrchestrator';
import { setGrammarsDir } from '../parser/treeSitterParser';
import type { RepoSummary } from './repoSummary';

export interface WorkerTask {
    repoId: string;
    repoRoot: string;
    workspaceRoot: string;
}

export interface WorkerResult {
    repoId: string;
    /** RepoSummary produced by SyncOrchestrator.produceSummary; null on failure. */
    summary: RepoSummary | null;
    /** Whether the worker persisted the per-repo state.db successfully. */
    persisted: boolean;
    /** Wall-clock duration of the init, milliseconds. */
    durationMs: number;
}

interface InitMessage {
    type: 'init-repo';
    task: WorkerTask;
    requestId: number;
    /** Optional grammars dir override. Defaults to the dist/ sibling. */
    grammarsDir?: string;
}

interface DoneMessage {
    type: 'done';
    requestId: number;
    result: WorkerResult;
}

interface ErrorMessage {
    type: 'error';
    requestId: number;
    error: string;
}

interface LogMessage {
    type: 'log';
    requestId: number;
    msg: string;
}

interface ReadyMessage {
    type: 'ready';
}

export type WorkerInbound = InitMessage;
export type WorkerOutbound = ReadyMessage | DoneMessage | ErrorMessage | LogMessage;

// Only execute the worker loop when actually running inside a worker thread.
// This guard lets the file be imported by the main thread for type sharing
// without booting a parser stack.
if (!isMainThread && parentPort) {
    bootWorker(parentPort);
}

function bootWorker(port: NonNullable<typeof parentPort>): void {
    // `treeSitterParser.ts` resolves the grammars dir via __dirname-relative
    // walks that work from either dist/ or src/. The worker bundle lives in
    // the same dist/ as the main extension bundle so the existing resolver
    // finds `<repo-root>/grammars/`. We only override below if the main
    // thread sends a different dir alongside the task (e.g. tests).

    port.postMessage({ type: 'ready' } satisfies ReadyMessage);

    port.on('message', async (msg: WorkerInbound) => {
        if (msg.type !== 'init-repo') return;
        const { task, requestId, grammarsDir } = msg;
        const t0 = Date.now();
        const log = (line: string): void => {
            port.postMessage({ type: 'log', requestId, msg: line } satisfies LogMessage);
        };
        try {
            if (grammarsDir) {
                try { setGrammarsDir(grammarsDir); } catch (err: any) { log(`[worker] setGrammarsDir failed: ${err?.message ?? err}`); }
            }

            const store = new SnapshotStore(task.repoRoot);
            store.setLogger(log);
            await store.load();

            const commentStore = new CommentStore([]);
            const orch = new SyncOrchestrator(
                task.workspaceRoot,
                store,
                commentStore,
                undefined,        // ignorePatterns — pick up later via .gitignore
                undefined,        // maxFileSize — default
                task.repoRoot,    // ADR-034 Phase B distinct repo scope
            );
            orch.setLogger(log);
            await orch.initialize();

            // Persist before producing summary so the disk state is the
            // authoritative artifact when the main thread later opens this
            // repo's store for file-watcher routing.
            store.save();

            let summary: RepoSummary | null = null;
            try {
                summary = orch.produceSummary(task.repoId);
            } catch (sumErr: any) {
                log(`[worker] produceSummary failed (non-fatal): ${sumErr?.message ?? sumErr}`);
            }

            // Close the store handle in the worker so the main thread can
            // re-open the same .codeatlas/state.db file without DB lock
            // contention on shared file systems.
            try { store.close(); } catch { /* ignore */ }

            const result: WorkerResult = {
                repoId: task.repoId,
                summary,
                persisted: true,
                durationMs: Date.now() - t0,
            };
            port.postMessage({ type: 'done', requestId, result } satisfies DoneMessage);
        } catch (err: any) {
            const message = err?.stack ? String(err.stack) : String(err?.message ?? err);
            port.postMessage({ type: 'error', requestId, error: message } satisfies ErrorMessage);
        }
    });
}
