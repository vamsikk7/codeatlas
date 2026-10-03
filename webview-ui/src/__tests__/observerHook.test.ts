/**
 * observerHook.test.ts
 *
 * Issue #780: page-side observer the live-verify skill installs from
 * Chrome MCP to capture which `graphId`s the React surface actually
 * received. The previous symbol (`window.codeatlasBridge.onMessage`)
 * was removed when the bridge was refactored, leaving the skill's
 * snippet silently no-op.
 *
 * These tests instantiate the helper, dispatch a few mock messages,
 * and assert the observer set captures the expected `graphId`s. The
 * fixture imports `wsBridge` for its side effect (installs the helper
 * on `window`); the WebSocket constructor inside is stubbed via the
 * environment so jsdom doesn't try to dial out.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Stub WebSocket so the IIFE inside wsBridge doesn't actually open a
// network connection in jsdom.
class FakeWS {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    readyState = FakeWS.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    constructor(_url: string) { /* noop */ }
    send(_data: string) { /* noop */ }
    close() { /* noop */ }
}
(globalThis as any).WebSocket = FakeWS;

beforeEach(() => {
    const w = window as any;
    // Reset between tests so each starts from a clean slate.
    delete w.__codeAtlasObserver;
    delete w.__codeAtlasObserverInstalled;
});

describe('__codeAtlasInstallObserver (#780)', () => {
    it('exposes the installer on window once wsBridge has loaded', async () => {
        await import('../wsBridge');
        expect(typeof (window as any).__codeAtlasInstallObserver).toBe('function');
    });

    it('returns a Set, registers a message listener, captures updateGraph graphIds', async () => {
        await import('../wsBridge');
        const seen: Set<string> = (window as any).__codeAtlasInstallObserver();
        expect(seen).toBeInstanceOf(Set);
        // Dispatch a fake updateGraph message — the listener should
        // populate the seen Set with its graphId.
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'updateGraph', graphId: 'file:src/foo.ts', graph: {} },
        }));
        expect(seen.has('file:src/foo.ts')).toBe(true);
    });

    it('captures timelineReplayStep step.graphId', async () => {
        await import('../wsBridge');
        const seen: Set<string> = (window as any).__codeAtlasInstallObserver();
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'timelineReplayStep', step: { graphId: 'flow:src/bar.ts:doThing' } },
        }));
        expect(seen.has('flow:src/bar.ts:doThing')).toBe(true);
    });

    it('ignores messages without a relevant type', async () => {
        await import('../wsBridge');
        const seen: Set<string> = (window as any).__codeAtlasInstallObserver();
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'unrelated', graphId: 'should:not:appear' },
        }));
        expect(seen.has('should:not:appear')).toBe(false);
        expect(seen.size).toBe(0);
    });

    it('is idempotent — calling installer twice returns the same Set + does not double-fire', async () => {
        await import('../wsBridge');
        const a: Set<string> = (window as any).__codeAtlasInstallObserver();
        const b: Set<string> = (window as any).__codeAtlasInstallObserver();
        expect(a).toBe(b);
        window.dispatchEvent(new MessageEvent('message', {
            data: { type: 'updateGraph', graphId: 'unique-graph' },
        }));
        // Both refs see the same single entry.
        expect(a.size).toBe(1);
        expect(b.size).toBe(1);
    });
});
