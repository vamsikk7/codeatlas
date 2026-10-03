/**
 * prWatcherHandlers.test.ts — #851 (2026-06-12)
 *
 * Standalone WS contract for the PR watcher card: getPrWatcherStatus
 * round-trips a status (or null when the surface has no watcher), and
 * setPrWatcherEnabled persists the setting + starts/stops the watcher.
 */
import { describe, it, expect, vi } from 'vitest';
import { createStandaloneMessageHandler } from '../messageHandler';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { CommentStore } from '../../core/storage/commentStore';
import type { WsBridge } from '../../server/wsBridge';
import type { PrWatcher } from '../../core/review/prWatcher';

function mkDeps() {
    const broadcasts: any[] = [];
    const wsBridge = {
        broadcast: vi.fn((msg) => broadcasts.push(msg)),
        hasClients: () => true,
    } as unknown as WsBridge;
    const snapshotStore = { getWorking: () => ({ files: {}, apiIndex: {}, clusters: {}, graphs: {} }) } as unknown as SnapshotStore;
    const commentStore = {} as unknown as CommentStore;
    return { broadcasts, wsBridge, snapshotStore, commentStore };
}

function mkWatcher(over: { enabled?: boolean } = {}) {
    let enabled = over.enabled ?? false;
    const statusOf = () => ({
        enabled, repoSlug: 'acme/widgets', tokenPresent: true, llmKeyPresent: true,
        intervalMs: 300_000, lastPollAt: null, lastResult: null, lastError: null,
        reviewedCount: 0, polling: false,
    });
    return {
        refreshPrereqs: vi.fn(async () => statusOf()),
        getStatus: vi.fn(statusOf),
        start: vi.fn(() => { enabled = true; }),
        stop: vi.fn(() => { enabled = false; }),
        isEnabled: () => enabled,
    } as unknown as PrWatcher;
}

describe('PR watcher handlers (#851)', () => {
    it('getPrWatcherStatus broadcasts the refreshed status', async () => {
        const d = mkDeps();
        const watcher = mkWatcher();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            prWatcher: () => watcher,
        });
        await h.handle({ type: 'getPrWatcherStatus' }, 'c1');
        await new Promise((r) => setTimeout(r, 0));
        const msg = d.broadcasts.find((m) => m.type === 'prWatcherStatus');
        expect(msg).toBeTruthy();
        expect(msg.status.repoSlug).toBe('acme/widgets');
        expect(watcher.refreshPrereqs).toHaveBeenCalled();
    });

    it('getPrWatcherStatus without a watcher broadcasts status:null (card hides)', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'getPrWatcherStatus' }, 'c1');
        await new Promise((r) => setTimeout(r, 0));
        const msg = d.broadcasts.find((m) => m.type === 'prWatcherStatus');
        expect(msg).toBeTruthy();
        expect(msg.status).toBeNull();
    });

    it('setPrWatcherEnabled true persists the setting, starts the watcher, broadcasts status + toast', async () => {
        const d = mkDeps();
        const watcher = mkWatcher();
        const setCalls: Array<[string, unknown]> = [];
        const settings = {
            get: () => undefined,
            set: vi.fn((k: string, v: unknown) => { setCalls.push([k, v]); return true; }),
            all: () => ({}),
        } as any;
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            settings, prWatcher: () => watcher,
        });
        await h.handle({ type: 'setPrWatcherEnabled', enabled: true }, 'c1');
        await new Promise((r) => setTimeout(r, 0));
        expect(setCalls).toContainEqual(['codeatlas.prWatcherEnabled', true]);
        expect(watcher.start).toHaveBeenCalled();
        expect(d.broadcasts.find((m) => m.type === 'prWatcherStatus')?.status.enabled).toBe(true);
        expect(d.broadcasts.find((m) => m.type === 'clientToast')?.text).toContain('PR watcher ON');
    });

    it('setPrWatcherEnabled false stops the watcher', async () => {
        const d = mkDeps();
        const watcher = mkWatcher({ enabled: true });
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
            prWatcher: () => watcher,
        });
        await h.handle({ type: 'setPrWatcherEnabled', enabled: false }, 'c1');
        await new Promise((r) => setTimeout(r, 0));
        expect(watcher.stop).toHaveBeenCalled();
        expect(d.broadcasts.find((m) => m.type === 'clientToast')?.text).toContain('PR watcher OFF');
    });

    it('setPrWatcherEnabled without a watcher toasts "not available"', async () => {
        const d = mkDeps();
        const h = createStandaloneMessageHandler({
            snapshotStore: d.snapshotStore, commentStore: d.commentStore,
            wsBridge: d.wsBridge, workspaceRoot: '/repo', log: () => {},
        });
        await h.handle({ type: 'setPrWatcherEnabled', enabled: true }, 'c1');
        await new Promise((r) => setTimeout(r, 0));
        expect(d.broadcasts.find((m) => m.type === 'clientToast')?.text).toContain('not available');
    });
});
