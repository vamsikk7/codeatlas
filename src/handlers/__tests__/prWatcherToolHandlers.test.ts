/**
 * prWatcherToolHandlers.test.ts — #851 (2026-06-12)
 *
 * Extension-side (VSIX) contract for the PR watcher card — parity with the
 * standalone handlers: status round-trip + toggle persisted in
 * workspaceState + start/stop forwarding.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', async () => (await import('../../__mocks__/vscode')));

import { makeHarness } from './handlerHarness';
import { registerPrWatcherHandlers } from '../prWatcherHandlers';

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
    } as any;
}

function setup(watcher: any | undefined) {
    const h = makeHarness();
    (h.ctx as any).prWatcher = watcher ? () => watcher : undefined;
    const handlers = new Map<string, (msg: any, panelId: string) => void>();
    const register = (type: string, fn: (msg: any, panelId: string) => void) => {
        handlers.set(type, fn);
    };
    registerPrWatcherHandlers(register as any, h.ctx as any);
    return {
        h,
        dispatch(msg: any, panelId = 'test-panel') {
            const fn = handlers.get(msg.type);
            if (!fn) throw new Error(`No handler registered for ${msg.type}`);
            return fn(msg, panelId);
        },
    };
}

async function flush() { await new Promise((r) => setTimeout(r, 10)); }

describe('PR watcher tool handlers (#851, extension side)', () => {
    it('getPrWatcherStatus broadcasts the refreshed status', async () => {
        const watcher = mkWatcher();
        const { h, dispatch } = setup(watcher);
        dispatch({ type: 'getPrWatcherStatus' });
        await flush();
        const msg = h.broadcasted.find((b) => b.message.type === 'prWatcherStatus');
        expect(msg).toBeTruthy();
        expect(msg!.message.status.repoSlug).toBe('acme/widgets');
        expect(watcher.refreshPrereqs).toHaveBeenCalled();
    });

    it('getPrWatcherStatus without a watcher broadcasts status:null', async () => {
        const { h, dispatch } = setup(undefined);
        dispatch({ type: 'getPrWatcherStatus' });
        await flush();
        const msg = h.broadcasted.find((b) => b.message.type === 'prWatcherStatus');
        expect(msg).toBeTruthy();
        expect(msg!.message.status).toBeNull();
    });

    it('setPrWatcherEnabled true starts the watcher and persists in workspaceState', async () => {
        const watcher = mkWatcher();
        const { h, dispatch } = setup(watcher);
        dispatch({ type: 'setPrWatcherEnabled', enabled: true });
        await flush();
        expect(watcher.start).toHaveBeenCalled();
        expect((h.ctx as any).context.workspaceState.update)
            .toHaveBeenCalledWith('codeatlas.prWatcherEnabled', true);
        const status = h.broadcasted.find((b) => b.message.type === 'prWatcherStatus');
        expect(status!.message.status.enabled).toBe(true);
        const note = h.broadcasted.find((b) => b.message.type === 'showNotification');
        expect(note!.message.message).toContain('PR watcher ON');
    });

    it('setPrWatcherEnabled false stops the watcher', async () => {
        const watcher = mkWatcher({ enabled: true });
        const { h, dispatch } = setup(watcher);
        dispatch({ type: 'setPrWatcherEnabled', enabled: false });
        await flush();
        expect(watcher.stop).toHaveBeenCalled();
        expect((h.ctx as any).context.workspaceState.update)
            .toHaveBeenCalledWith('codeatlas.prWatcherEnabled', false);
    });
});
