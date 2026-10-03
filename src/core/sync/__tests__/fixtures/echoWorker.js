// Test fixture for workerPool tests. Speaks the repoWorker protocol but
// returns canned results — no SnapshotStore, no SyncOrchestrator. Lets us
// exercise the pool's lifecycle, queueing, and recovery semantics without
// dragging the whole pipeline into a unit test.
//
// Behaviour:
//   - on boot:                emits { type: 'ready' }
//   - on { type: 'init-repo' } with repoId !== 'crash-me':
//       emits { type: 'done', requestId, result: { repoId, summary: null, persisted: true, durationMs: 0 } }
//   - on { type: 'init-repo' } with repoId === 'crash-me':
//       throws (so the worker exits with code 1, exercising respawn)
//   - on { type: 'init-repo' } with repoId === 'reject-me':
//       emits { type: 'error', requestId, error: 'rejected by fixture' }
//   - on { type: 'init-repo' } with repoId starting 'slow-':
//       waits 80ms before reporting done (so callers can observe queueing)

const { parentPort } = require('worker_threads');

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async (msg) => {
    if (msg.type !== 'init-repo') return;
    const { task, requestId } = msg;
    if (task.repoId === 'crash-me') {
        // Force the worker to die so the pool exercises its respawn path.
        throw new Error('echoWorker crash');
    }
    if (task.repoId === 'reject-me') {
        parentPort.postMessage({ type: 'error', requestId, error: 'rejected by fixture' });
        return;
    }
    if (task.repoId.startsWith('slow-')) {
        await new Promise((r) => setTimeout(r, 80));
    }
    parentPort.postMessage({
        type: 'done',
        requestId,
        result: {
            repoId: task.repoId,
            summary: null,
            persisted: true,
            durationMs: 0,
        },
    });
});
