/**
 * PERF (2026-07-20) — `buildFeatureGraphForService` used to call the FULL
 * `applyDiffCascadeToLiveGraphs` TWICE per L2a open (once to freshen api-list
 * diffs, once to re-annotate the newly built feature graph). The second full
 * pass re-walked every sequence graph + rebuilt Map + re-clustered domains —
 * fixed-cost waste. It was replaced with the LIGHT
 * `upgradeClusterServiceAnnotationsLight` (composition-only cluster/service
 * annotation upgrade).
 *
 * These tests assert:
 *  (1) the second pass now uses the LIGHT method, NOT a second full cascade;
 *  (2) badge correctness is NOT regressed — a changed cluster's node on the
 *      freshly built feature graph still ends up `modified` (the whole point of
 *      the old second call).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
    window: {
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    commands: { executeCommand: vi.fn() },
    env: { machineId: 't', sessionId: 't', appName: 'Code', uriScheme: 'vscode' },
    version: '1.0.0',
}));

import { makeHarness } from './handlerHarness';
import { buildFeatureGraphForService } from '../navigationHandlers';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import { SyncOrchestrator } from '../../core/sync/syncOrchestrator';
import { CommentStore } from '../../core/storage/commentStore';
import type { DiagramGraph } from '../../core/graph/graphTypes';

/**
 * Seed a real store with the minimum needed for `buildFeatureGraph` +
 * `upgradeServiceClusterDiffAnnotations`:
 *  - one service, one cluster owning `svc/auth.py`
 *  - a `file:svc/auth.py` graph with a MODIFIED function node (the change signal
 *    `upgradeServiceClusterDiffAnnotations` reads to bubble the cluster node up)
 */
function seedStore(store: SnapshotStore, changed: boolean) {
    store.updateWorkingFile('svc/auth.py', {
        path: 'svc/auth.py', hash: 'h', mtime: 0, content: 'def login(): pass',
        symbols: { functions: [], variables: [], imports: [] },
    });

    const working = store.getWorking();
    working.services = {
        'service:main': {
            id: 'service:main', name: 'main', rootPath: '', technology: 'flask',
            category: 'backend', exposedApiCount: 0, consumedUrls: [], consumedServices: [],
        } as any,
    };
    working.clusters = {
        'cluster:auth': {
            id: 'cluster:auth', label: 'Auth', serviceId: 'service:main',
            files: ['svc/auth.py'], entryPoints: [], apisInCluster: [],
            internalCallCount: 0, externalCallCount: 0, modularity: 0.5,
        } as any,
    };

    // L4 file graph (clean baseline copy first — everything `unchanged`).
    const fileG: DiagramGraph = {
        graphId: 'file:svc/auth.py',
        type: 'file',
        nodes: [
            { id: 'file', type: 'file', label: 'svc/auth.py', diff: 'unchanged' },
            { id: 'fn:login', type: 'function', label: 'login', diff: 'unchanged' },
        ],
        edges: [],
        anchors: {},
        meta: { filePath: 'svc/auth.py' },
    };
    store.updateWorkingGraph('file:svc/auth.py', fileG);

    // Rotate baseline := working so the service/cluster/file all exist in the
    // baseline. Without this, buildFeatureGraph diffs against an EMPTY baseline
    // and reports every cluster as `added` (which upgradeServiceCluster… won't
    // touch — it only upgrades `unchanged`→`modified`). We want the cluster to
    // start `unchanged`, then be bubbled to `modified` ONLY by the file change.
    store.setBaselineFromWorking();

    // Now apply the working-only change: mark the L4 function node modified.
    // This is the `filesWithChanges` signal the light cascade reads to bubble
    // `cluster:auth` to `modified`.
    if (changed) {
        const wfg = store.getWorking().graphs['file:svc/auth.py'];
        const fn = wfg.nodes.find(n => n.id === 'fn:login');
        if (fn) fn.diff = 'modified';
        store.updateWorkingGraph('file:svc/auth.py', wfg);
    }
}

function makeRealOrchHarness(changed: boolean) {
    const h = makeHarness();
    const store = new SnapshotStore('/test/workspace', { inMemoryOnly: true });
    seedStore(store, changed);

    const orch = new SyncOrchestrator('/test/workspace', store, new CommentStore([]));
    orch.setLogger(() => { /* silence */ });

    // Wire the real store + orchestrator into the handler context.
    (h.ctx as any).snapshotStore = store;
    (h.ctx as any).syncOrchestrator = orch;
    return { h, store, orch };
}

describe('buildFeatureGraphForService — light second-pass cascade (perf)', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('(1) uses the LIGHT annotation upgrade, not a second full cascade', () => {
        const { h, orch } = makeRealOrchHarness(true);

        const fullSpy = vi.spyOn(orch, 'applyDiffCascadeToLiveGraphs');
        const lightSpy = vi.spyOn(orch, 'upgradeClusterServiceAnnotationsLight');

        buildFeatureGraphForService(h.ctx, 'service:main');

        // The first full cascade still runs once (freshens api-list diffs) —
        // gated by the dirty flag, which is seeded true on a fresh orchestrator.
        expect(fullSpy).toHaveBeenCalledTimes(1);
        // The old second full cascade is gone; the light upgrade runs instead.
        expect(lightSpy).toHaveBeenCalledTimes(1);
    });

    it('(2) still marks a changed cluster node `modified` on the fresh feature graph', () => {
        const { h } = makeRealOrchHarness(true);

        const graph = buildFeatureGraphForService(h.ctx, 'service:main');
        expect(graph).toBeDefined();

        const clusterNode = graph!.nodes.find(n => n.type === 'cluster');
        expect(clusterNode, 'feature graph must contain the auth cluster node').toBeDefined();
        expect(clusterNode!.diff, 'changed cluster must show the modified (~) badge').toBe('modified');
    });

    it('(2b) leaves the cluster node unchanged when nothing changed (no false badge)', () => {
        const { h } = makeRealOrchHarness(false);

        const graph = buildFeatureGraphForService(h.ctx, 'service:main');
        const clusterNode = graph!.nodes.find(n => n.type === 'cluster');
        expect(clusterNode).toBeDefined();
        expect(clusterNode!.diff ?? 'unchanged').toBe('unchanged');
    });
});
