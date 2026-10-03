/**
 * handlerHarness.ts — Issue 372 / ADR-025
 *
 * INVARIANT: every handler-layer test instantiates this harness instead of
 * hand-rolling stubs for the 30+ fields on HandlerContext. The recent
 * Bug 1-9 cluster (working-changes diff colors) had to be reproduced live
 * because nothing exercised the message-handler integration layer; the
 * harness exists to catch the next batch of bugs in unit tests.
 *
 * Pattern:
 *   const h = makeHarness();
 *   h.dispatch('replayWorkingDiff');
 *   expect(h.broadcastedMessages()).toContainEqual(
 *     expect.objectContaining({ type: 'setGitDiffContext' })
 *   );
 */

import { vi } from 'vitest';
import type { HandlerContext } from '../handlerContext';
import type { Snapshot, WorkspaceState } from '../../core/graph/graphTypes';

interface BroadcastEntry {
    target: 'all' | string;
    message: any;
}

export interface HandlerHarness {
    ctx: HandlerContext;
    /** Messages broadcast through panelManager.broadcastMessage. */
    broadcasted: BroadcastEntry[];
    /** Direct sends through wsBridge.sendTo. */
    unicasted: BroadcastEntry[];
    /** Output-channel log lines (drains internally). */
    logs: string[];
    /** Snapshot of the in-memory store, mutated by handlers. */
    state: WorkspaceState;
    /** Set baseline for the test run. */
    setBaseline: (s: Partial<Snapshot>) => void;
    /** Set working snapshot for the test run. */
    setWorking: (s: Partial<Snapshot>) => void;
    /** Replace the active gitDiffState (for testing diff-mode handlers). */
    setGitDiffState: (s: any) => void;
    /** Read the active gitDiffState as the handler sees it. */
    getGitDiffState: () => any;
    /** Track setContext('codeatlas:gitDiffActive', X) calls. */
    setContextCalls: Array<{ key: string; value: any }>;
}

const emptySnapshot = (): Snapshot => ({
    files: {},
    apiIndex: {},
    graphs: {},
});

const emptyState = (): WorkspaceState => ({
    version: 1,
    schema_version: 2,
    workspaceRoot: '/test/workspace',
    baseline: emptySnapshot(),
    working: emptySnapshot(),
    comments: [],
    settings: { autoUpdate: true },
});

export function makeHarness(): HandlerHarness {
    const broadcasted: BroadcastEntry[] = [];
    const unicasted: BroadcastEntry[] = [];
    const logs: string[] = [];
    const setContextCalls: Array<{ key: string; value: any }> = [];
    const state = emptyState();
    let gitDiffState: any = null;
    let aiReviewResult: any = null;

    const noopFn = vi.fn();

    const snapshotStore: any = {
        getBaseline: () => state.baseline,
        getWorking: () => state.working,
        getWorkingServices: () => state.working.services ?? {},
        updateWorkingGraph: (id: string, graph: any) => {
            state.working.graphs[id] = graph;
        },
        removeWorkingGraph: (id: string) => {
            delete state.working.graphs[id];
        },
        getComments: () => state.comments,
        save: noopFn,
        load: noopFn,
        clearAllFiles: noopFn,
    };

    const panelManager: any = {
        broadcastMessage: (msg: any) => broadcasted.push({ target: 'all', message: msg }),
        sendToPanel: (panelId: string, msg: any) => unicasted.push({ target: panelId, message: msg }),
        navigatePanel: vi.fn(),
        navigateActive: vi.fn(() => false),
        openPanel: vi.fn(),
        getPanelContext: vi.fn(),
        getActivePanelId: vi.fn(),
        disposeAll: vi.fn(),
        updatePanel: vi.fn(),
    };

    const wsBridge: any = {
        hasClients: () => false,
        broadcast: (msg: any) => broadcasted.push({ target: 'all', message: msg }),
        sendTo: (clientId: string, msg: any) => unicasted.push({ target: `ws:${clientId}`, message: msg }),
        getPort: vi.fn(() => 7742),
    };

    // #547: synthetic PlatformAdapter mirroring the extension's fanout
    // (panelManager + wsBridge). Tests that broadcast through the new
    // platform surface land in the same `broadcasted` array the older
    // panelManager-direct calls do, so existing assertions keep passing.
    const platform: any = {
        broadcast: (msg: any) => broadcasted.push({ target: 'all', message: msg }),
        updateGraph: (graphId: string, graph: any) => {
            broadcasted.push({ target: 'all', message: { type: 'updateGraph', graphId, graph } });
        },
        getSecret: vi.fn(async () => undefined),
        setSecret: vi.fn(async () => undefined),
        refreshSidebar: vi.fn(),
        revealApi: vi.fn(),
        revealService: vi.fn(),
        revealCluster: vi.fn(),
    };

    // Minimal mocks for everything else HandlerContext expects. Tests can
    // reach in and replace specific fields via `harness.ctx.<field> = ...`
    // when they need finer-grained behavior.
    const ctx = {
        workspaceRoot: '/test/workspace',
        platform,
        context: {
            secrets: {
                get: vi.fn(async () => ''),
                store: vi.fn(async () => undefined),
            },
            globalState: {
                get: vi.fn((_k: string, dflt?: any) => dflt),
                update: vi.fn(async () => undefined),
            },
            workspaceState: {
                get: vi.fn((_k: string, dflt?: any) => dflt),
                update: vi.fn(async () => undefined),
            },
            extension: { id: 'test.codeatlas-live', packageJSON: { version: 'test' } },
        } as any,
        panelManager,
        snapshotStore,
        syncOrchestrator: {
            applyDiffCascadeToLiveGraphs: vi.fn(() => []),
            upgradeClusterServiceAnnotationsLight: vi.fn(() => []),
            enqueueCascade: vi.fn(async () => []),
            rebuildFile: vi.fn(async () => ({ graphIds: [] })),
            initialize: vi.fn(async () => ({ fileCount: 0, apiCount: 0, graphCount: 0, truncated: false, totalFound: 0, parseFailures: {} })),
            resync: vi.fn(async () => undefined),
            syncDriftedFilesFromDisk: vi.fn(async () => []),
            isAutoUpdateEnabled: vi.fn(() => true),
            setAutoUpdate: vi.fn(),
        } as any,
        commentStore: { clear: vi.fn(), getAll: vi.fn(() => []), reanchor: vi.fn(), toJSON: vi.fn(() => []) } as any,
        sourceNavigator: { open: vi.fn() } as any,
        gitDiffStore: { load: vi.fn(() => null), save: vi.fn(), clear: vi.fn() } as any,
        wsBridge,
        apiExplorerProvider: { findItemByApiId: vi.fn(() => null), refresh: vi.fn() } as any,
        apiTreeView: { reveal: vi.fn(() => Promise.resolve()) } as any,
        featureExplorerProvider: { findItemByClusterId: vi.fn(() => null), refresh: vi.fn() } as any,
        featureTreeView: { reveal: vi.fn(() => Promise.resolve()) } as any,
        microserviceExplorerProvider: { findItemByServiceId: vi.fn(() => null), refresh: vi.fn() } as any,
        microserviceTreeView: { reveal: vi.fn(() => Promise.resolve()) } as any,
        commentsProvider: { setComments: vi.fn(), refresh: vi.fn() } as any,
        llmNamingService: { configure: vi.fn(), isConfigured: false } as any,
        clerkAuthPageUrl: 'https://example.test/auth',
        commitTimelineReplay: { play: vi.fn(), playFromDiffResult: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), skipCommit: vi.fn(), nextStep: vi.fn(), prevStep: vi.fn(), playFocused: vi.fn(), isPlaying: false } as any,
        changeLog: { add: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn() } as any,
        replayOrchestrator: { stop: vi.fn() } as any,
        getGitDiffState: () => gitDiffState,
        setGitDiffState: (s: any) => { gitDiffState = s; },
        getGitDiffSnapshots: () => null,
        setGitDiffSnapshots: vi.fn(),
        getAiReviewResult: () => aiReviewResult,
        setAiReviewResult: (r: any) => { aiReviewResult = r; },
        getReplayAfterDiff: vi.fn(() => false),
        setReplayAfterDiff: vi.fn(),
        getGitHubToken: vi.fn(() => undefined),
        setGitHubToken: vi.fn(),
        getGitHubUser: vi.fn(() => null),
        setGitHubUser: vi.fn(),
        fetchGitHubUser: vi.fn(async () => null),
        performGitHubConnect: vi.fn(async () => undefined),
        handleRequestGitDiff: vi.fn(async () => undefined),
        handleCommitSelected: vi.fn(async () => undefined),
        handleBranchSelected: vi.fn(async () => undefined),
        handleRequestPrDiff: vi.fn(async () => undefined),
        handlePrSelected: vi.fn(async () => undefined),
        handleRequestBranchDiff: vi.fn(async () => undefined),
        handleClearGitDiff: vi.fn(),
        buildWorkspaceInfo: vi.fn(() => ({ type: 'workspaceInfo' })),
        routeDiagramToWelcome: vi.fn(),
        log: (m: string) => logs.push(m),
        notifyBrowser: vi.fn((level: string, msg: string) => {
            broadcasted.push({ target: 'all', message: { type: 'showNotification', level, message: msg } });
        }),
    } as unknown as HandlerContext;

    return {
        ctx,
        broadcasted,
        unicasted,
        logs,
        state,
        setBaseline: (s: Partial<Snapshot>) => { Object.assign(state.baseline, s); },
        setWorking: (s: Partial<Snapshot>) => { Object.assign(state.working, s); },
        setGitDiffState: (s: any) => { gitDiffState = s; },
        getGitDiffState: () => gitDiffState,
        setContextCalls,
    };
}
