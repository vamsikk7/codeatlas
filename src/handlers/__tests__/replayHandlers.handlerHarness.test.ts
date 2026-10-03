/**
 * replayHandlers.handlerHarness.test.ts — Issue 372 / ADR-025
 *
 * Starter integration test for the replay handlers using the new
 * handlerHarness. Pins behavior that the recent Bug 1 cluster broke:
 * `replayWorkingDiff` must surface a `setGitDiffContext` so AI Review
 * shows up in the toolbar during working-changes replay.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    window: { showInformationMessage: vi.fn() },
    commands: { executeCommand: vi.fn() },
    // analytics.track reads vscode.env on every call — provide a stub.
    env: {
        machineId: 'test-machine',
        sessionId: 'test-session',
        appName: 'Visual Studio Code',
        uriScheme: 'vscode',
    },
    version: '1.0.0',
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

import { makeHarness } from './handlerHarness';
import { registerReplayHandlers } from '../replayHandlers';

function setupReplayHandlers() {
    const h = makeHarness();
    const handlers = new Map<string, (msg: any, panelId: string) => void>();
    const register = (type: string, fn: (msg: any, panelId: string) => void) => {
        handlers.set(type, fn);
    };
    registerReplayHandlers(register, h.ctx);
    return {
        h,
        dispatch(type: string, message: any = {}, panelId = 'test-panel') {
            const fn = handlers.get(type);
            if (!fn) throw new Error(`No handler registered for ${type}`);
            return fn(message, panelId);
        },
    };
}

describe('replayHandlers — Bug 1 regression (Issue 372 / ADR-025)', () => {
    it('replayWorkingDiff with no working changes → "no changes" notification, no gitDiffState', () => {
        const { h, dispatch } = setupReplayHandlers();
        // Default state: baseline === working (both empty).
        dispatch('replayWorkingDiff');
        const msgs = h.broadcasted.map(b => b.message);
        // INVARIANT: when no changes, the user gets the explainer toast and
        // gitDiffState stays null (AI Review button doesn't surface).
        expect(msgs.some(m => m.message?.includes('No working changes'))).toBe(true);
        expect(h.getGitDiffState()).toBeNull();
    });

    it('replayWorkingDiff with working diff → sets gitDiffState + broadcasts setGitDiffContext', () => {
        const { h, dispatch } = setupReplayHandlers();
        // Make working differ from baseline so workingDiffersFromBaseline returns true.
        h.state.baseline.files['/foo.ts'] = { path: '/foo.ts', hash: 'a', mtime: 0, content: 'old', symbols: { functions: [], variables: [], imports: [] } } as any;
        h.state.working.files['/foo.ts'] = { path: '/foo.ts', hash: 'b', mtime: 0, content: 'new', symbols: { functions: [], variables: [], imports: [] } } as any;
        dispatch('replayWorkingDiff');
        // INVARIANT (Bug 1 / Issue 355 — Telemetry not gated on `vscode.env.isTelemetryEnabled`): gitDiffState gets populated so AI
        // Review can read the diff. setGitDiffContext is broadcast so the
        // webview shows the diff badge + AI Review button.
        const gitDiff = h.getGitDiffState();
        expect(gitDiff).not.toBeNull();
        expect(gitDiff.headHash).toBe('working');
        expect(gitDiff.baseHash).toBe('baseline');
        const ctxBroadcast = h.broadcasted.find(b => b.message?.type === 'setGitDiffContext');
        expect(ctxBroadcast).toBeDefined();
        expect(ctxBroadcast!.message.headLabel).toBe('Working (uncommitted)');
    });

    it('stopReplay calls replayOrchestrator.stop', () => {
        const { h, dispatch } = setupReplayHandlers();
        dispatch('stopReplay');
        expect(h.ctx.replayOrchestrator.stop).toHaveBeenCalled();
    });
});

describe('replayHandlers — negative-path notification text (Issue #393)', () => {
    /**
     * Locks in the exact toast wording for each replayWorkingDiff failure
     * branch. Today's "No working changes to replay" regression only
     * surfaced in the live extension because no test asserted the
     * broadcast `showNotification` message text. These assertions catch
     * future drift in any of the 3 negative paths.
     */

    function makeBroadcastFilter(h: ReturnType<typeof makeHarness>) {
        return h.broadcasted.filter(b => b.message?.type === 'showNotification').map(b => b.message);
    }

    it('no-working-changes branch broadcasts exact toast text and `info` level', () => {
        const { h, dispatch } = setupReplayHandlers();
        // Default state: baseline === working (both empty) → workingDiffersFromBaseline returns false.
        dispatch('replayWorkingDiff');
        const notifications = makeBroadcastFilter(h);
        expect(notifications.length).toBe(1);
        expect(notifications[0].level).toBe('info');
        expect(notifications[0].message).toBe('No working changes to replay. Edit some files first.');
    });

    it('no-working-changes branch does NOT call playFromDiffResult', () => {
        const { h, dispatch } = setupReplayHandlers();
        dispatch('replayWorkingDiff');
        expect(h.ctx.commitTimelineReplay.playFromDiffResult).not.toHaveBeenCalled();
    });

    it('no-changed-layers branch broadcasts the "No changed layers to replay" toast', () => {
        const { h, dispatch } = setupReplayHandlers();
        // Force workingDiffersFromBaseline to return true...
        h.state.baseline.files['/foo.ts'] = { path: '/foo.ts', hash: 'a', mtime: 0, content: 'old', symbols: { functions: [], variables: [], imports: [] } } as any;
        h.state.working.files['/foo.ts'] = { path: '/foo.ts', hash: 'b', mtime: 0, content: 'new', symbols: { functions: [], variables: [], imports: [] } } as any;
        // ...but force the replayer to report isPlaying=false so the
        // "no changed layers" branch fires inside the if (hasChanges)
        // block. playFromDiffResult is a vi.fn() that doesn't actually
        // flip isPlaying, so this branch naturally activates.
        (h.ctx.commitTimelineReplay as any).isPlaying = false;
        dispatch('replayWorkingDiff');
        const notifications = makeBroadcastFilter(h);
        const noLayersToast = notifications.find(n => n.message === 'No changed layers to replay.');
        expect(noLayersToast, 'expected the "no changed layers" toast').toBeDefined();
        expect(noLayersToast!.level).toBe('info');
    });

    it('exception in handler body broadcasts error-level toast with the exception message', () => {
        const { h, dispatch } = setupReplayHandlers();
        // Sabotage snapshotStore so accessing files throws — exercise the
        // try/catch error path in replayWorkingDiff.
        h.ctx.snapshotStore.getBaseline = () => { throw new Error('boom-test'); };
        dispatch('replayWorkingDiff');
        const notifications = makeBroadcastFilter(h);
        const errToast = notifications.find(n => n.level === 'error');
        expect(errToast, 'expected error-level toast on handler exception').toBeDefined();
        expect(errToast!.message).toContain('replayWorkingDiff failed');
        expect(errToast!.message).toContain('boom-test');
    });

    it('lazy-content scenario: hashes differ but .content is undefined → handler still proceeds (Issue today regression)', () => {
        const { h, dispatch } = setupReplayHandlers();
        // Simulate the post-save state: .content is undefined on both
        // FileRecords, but the hashes still differ. The fix from today
        // (`.content` → `.hash` comparison) means workingDiffersFromBaseline
        // returns true here; the pre-fix bug would silently report
        // "No working changes to replay".
        h.state.baseline.files['/foo.ts'] = { path: '/foo.ts', hash: 'aaa', mtime: 0, content: undefined as any, symbols: { functions: [], variables: [], imports: [] } } as any;
        h.state.working.files['/foo.ts'] = { path: '/foo.ts', hash: 'bbb', mtime: 0, content: undefined as any, symbols: { functions: [], variables: [], imports: [] } } as any;
        dispatch('replayWorkingDiff');
        const notifications = makeBroadcastFilter(h);
        // Must NOT see "No working changes" — the handler should pass the
        // hasChanges gate based on hash inequality.
        expect(notifications.some(n => n.message === 'No working changes to replay. Edit some files first.'))
            .toBe(false);
        // gitDiffState must be populated.
        expect(h.getGitDiffState()).not.toBeNull();
    });

    it('hasChanges-true → setGitDiffContext is broadcast (Issue 355 regression)', () => {
        const { h, dispatch } = setupReplayHandlers();
        h.state.baseline.files['/foo.ts'] = { path: '/foo.ts', hash: 'a', mtime: 0, content: 'old', symbols: { functions: [], variables: [], imports: [] } } as any;
        h.state.working.files['/foo.ts'] = { path: '/foo.ts', hash: 'b', mtime: 0, content: 'new', symbols: { functions: [], variables: [], imports: [] } } as any;
        dispatch('replayWorkingDiff');
        // Exact payload pinning — protects against today's class of bug where
        // the cascade-bundle keys silently shift across refactors.
        const ctx = h.broadcasted.find(b => b.message?.type === 'setGitDiffContext')?.message;
        expect(ctx).toBeDefined();
        expect(ctx.baseHash).toBe('baseline');
        expect(ctx.headHash).toBe('working');
        expect(ctx.baseLabel).toBe('Baseline');
        expect(ctx.headLabel).toBe('Working (uncommitted)');
    });
});
