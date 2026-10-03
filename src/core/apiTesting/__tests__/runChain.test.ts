/**
 * runChain.test.ts — Issue #603 Phase 3 collection chain runner.
 *
 * The runner reuses `executeRequest` from the Phase 2 relay; we stub
 * `global.fetch` so the orchestration logic (env carry-through,
 * extraction, assertions) is exercised without real HTTP.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runChain as _runChain, type ChainStep, type RunChainArgs } from '../runChain';

// These tests exercise the user-initiated workbench runner, which allows
// loopback/private dev hosts (#887 SSRF guard). Default the flag so the
// existing localhost fixtures keep dispatching; the SSRF-block behaviour is
// covered directly in hostGuard.test.ts.
const runChain = (args: RunChainArgs) => _runChain({ allowPrivateHosts: true, ...args });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    (global as any).fetch = fetchMock;
});

function jsonResponse(body: unknown, init: Partial<{ status: number; headers: Record<string, string> }> = {}) {
    const status = init.status ?? 200;
    const headers = new Headers({ 'content-type': 'application/json', ...(init.headers ?? {}) });
    return new Response(JSON.stringify(body), { status, statusText: 'OK', headers });
}

describe('runChain', () => {
    it('runs a single passing step', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: 'http://localhost/x' }],
        });
        expect(out.passed).toBe(1);
        expect(out.failed).toBe(0);
        expect(out.steps[0].outcome).toBe('passed');
    });

    it('carries env vars between steps via extract', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ user: { token: 'abc' } }))
            .mockResolvedValueOnce(jsonResponse({ profile: { id: 1 } }));
        const steps: ChainStep[] = [
            {
                id: 'login',
                method: 'POST',
                url: 'http://localhost/auth/login',
                body: '{"email":"a@b.com"}',
                extract: { token: { scope: 'json', path: '$.user.token' } },
            },
            {
                id: 'me',
                method: 'GET',
                url: 'http://localhost/me',
                bearerToken: '{{token}}',
            },
        ];
        const out = await runChain({ steps });
        expect(out.passed).toBe(2);
        expect(out.finalEnv.token).toBe('abc');
        // Second call carried Bearer abc.
        const secondCall = fetchMock.mock.calls[1];
        const reqInit = secondCall[1] as { headers: Record<string, string> };
        expect(reqInit.headers.Authorization).toBe('Bearer abc');
    });

    it('runs assertions and marks failures without aborting', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ ok: true }, { status: 200 }))
            .mockResolvedValueOnce(jsonResponse({ ok: true }, { status: 500 }));
        const steps: ChainStep[] = [
            { id: 's1', method: 'GET', url: 'http://localhost/x', assert: { statusEquals: 200 } },
            { id: 's2', method: 'GET', url: 'http://localhost/y', assert: { statusBetween: [200, 299] } },
        ];
        const out = await runChain({ steps });
        expect(out.passed).toBe(1);
        expect(out.failed).toBe(1);
        expect(out.steps[1].assertFailures).toContain('status expected in 200..299, got 500');
        expect(out.aborted).toBe(false);
    });

    it('aborts on first failure when stopOnFirstFailure is set', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({}, { status: 500 }))
            .mockResolvedValue(jsonResponse({}, { status: 200 }));
        const steps: ChainStep[] = [
            { id: 's1', method: 'GET', url: 'http://localhost/a' },
            { id: 's2', method: 'GET', url: 'http://localhost/b' },
        ];
        const out = await runChain({ steps, stopOnFirstFailure: true });
        expect(out.steps).toHaveLength(1);
        expect(out.aborted).toBe(true);
        // The second step's URL never got called.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports `errored` when the request itself fails', async () => {
        fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: 'http://localhost/x' }],
        });
        expect(out.errored).toBe(1);
        expect(out.steps[0].outcome).toBe('errored');
    });

    it('skips extraction when the request failed', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }));
        const out = await runChain({
            steps: [{
                id: 's1', method: 'GET', url: 'http://localhost/x',
                extract: { token: { scope: 'json', path: '$.token' } },
            }],
        });
        expect(out.steps[0].extracted).toEqual({});
        expect(out.finalEnv.token).toBeUndefined();
    });

    it('checks body assertions', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ msg: 'hello world' }));
        const out = await runChain({
            steps: [{
                id: 's1', method: 'GET', url: 'http://localhost/x',
                assert: { bodyContains: 'hello', bodyNotContains: 'oops' },
            }],
        });
        expect(out.steps[0].assertFailures).toEqual([]);
        expect(out.steps[0].outcome).toBe('passed');
    });

    it('runs pre-request scripts and propagates env mutations', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}));
        const out = await runChain({
            steps: [{
                id: 's1', method: 'GET', url: 'http://localhost/x',
                preRequestScript: `pm.environment.set('seeded', '1');`,
            }],
        });
        expect(out.passed).toBe(1);
        expect(out.finalEnv.seeded).toBe('1');
    });

    it('runs post-response scripts with pm.response + pm.test', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ user: { id: 42, token: 'tk' } }));
        const out = await runChain({
            steps: [{
                id: 's1', method: 'POST', url: 'http://localhost/login',
                postResponseScript: `
                    const body = pm.response.json();
                    pm.environment.set('userId', String(body.user.id));
                    pm.environment.set('token', body.user.token);
                    pm.test('status is 200', () => pm.expect(pm.response.status).toBe(200));
                `,
            }],
        });
        expect(out.passed).toBe(1);
        expect(out.finalEnv.userId).toBe('42');
        expect(out.finalEnv.token).toBe('tk');
        expect(out.steps[0].testResults).toHaveLength(1);
        expect(out.steps[0].testResults[0].passed).toBe(true);
    });

    it('marks step as failed when a pm.test fails', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 200 }));
        const out = await runChain({
            steps: [{
                id: 's1', method: 'GET', url: 'http://localhost/x',
                postResponseScript: `pm.test('wrong', () => pm.expect(1).toBe(2));`,
            }],
        });
        expect(out.passed).toBe(0);
        expect(out.failed).toBe(1);
        expect(out.steps[0].testResults[0].passed).toBe(false);
    });

    it('checks header presence assertions', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({}, { headers: { 'x-trace': '1' } }));
        const out = await runChain({
            steps: [
                {
                    id: 's1', method: 'GET', url: 'http://localhost/x',
                    assert: { hasHeader: 'X-Trace' },
                },
                {
                    id: 's2', method: 'GET', url: 'http://localhost/y',
                    assert: { hasHeader: 'X-Missing' },
                },
            ],
        });
        fetchMock.mockResolvedValueOnce(jsonResponse({}));
        // First step passes; second one fails on the missing header.
        expect(out.steps[0].assertFailures).toEqual([]);
        expect(out.steps[1].assertFailures[0]).toMatch(/X-Missing/);
    });
});
