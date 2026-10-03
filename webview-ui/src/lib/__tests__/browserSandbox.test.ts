/**
 * browserSandbox.test.ts — Issue #603 Phase 3.6.
 *
 * Tests the graceful-fallback path. The QuickJS-active path activates
 * when `quickjs-emscripten` is installed; the test runner doesn't have
 * the dep, so `runBrowserScript` returns `{ available: false }` with a
 * clear hint. That's the contract: callers can detect "preview not
 * available, fall back to the server-side runner".
 */

import { describe, it, expect } from 'vitest';
import { runBrowserScript } from '../browserSandbox';

const baseRequest = {
    method: 'POST',
    url: 'http://localhost/api/users/login',
    headers: { 'Content-Type': 'application/json' },
    body: '{"email":"a@b.com"}',
};

describe('runBrowserScript — graceful unavailable', () => {
    it('returns available:false when quickjs-emscripten is not installed', async () => {
        const out = await runBrowserScript({
            source: `pm.environment.set('flag', 'on');`,
            env: { seed: 's' },
            request: baseRequest,
        });
        expect(out.available).toBe(false);
        expect(out.error).toContain('quickjs-emscripten');
        // env is passed through unchanged so the caller can hand it
        // straight to the server-side runner without copy work.
        expect(out.env).toEqual({ seed: 's' });
        expect(out.testResults).toEqual([]);
    });

    it('shape includes empty logs + testResults', async () => {
        const out = await runBrowserScript({
            source: 'noop',
            env: {},
            request: baseRequest,
            response: { status: 200, statusText: 'OK', headers: {}, body: '{}' },
        });
        expect(out.testResults).toEqual([]);
        expect(out.logs).toEqual([]);
    });
});
