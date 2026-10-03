/**
 * ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — cross-repo chain runner tests.
 *
 * Covers ChainStep.repoId + RunChainArgs.resolveBaseUrl: per-step
 * base URL prefix logic, error handling when the resolver returns
 * empty/missing, and backward compat with single-repo flows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runChain as _runChain, type ChainStep, type RunChainArgs } from '../runChain';

// Workbench-modeling tests → allow loopback/private dev hosts (#887).
const runChain = (args: RunChainArgs) => _runChain({ allowPrivateHosts: true, ...args });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    (global as any).fetch = fetchMock;
});

function jsonResponse(
    body: unknown,
    init: Partial<{ status: number; headers: Record<string, string> }> = {},
) {
    const status = init.status ?? 200;
    const headers = new Headers({ 'content-type': 'application/json', ...(init.headers ?? {}) });
    return new Response(JSON.stringify(body), { status, statusText: 'OK', headers });
}

describe('runChain — cross-repo base URL (Phase I)', () => {
    it('prefixes a relative URL with the resolved base for the step repo', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: '/api/users', repoId: 'svc-a' }],
            resolveBaseUrl: (id) => (id === 'svc-a' ? 'http://localhost:3000' : ''),
        });
        expect(out.passed).toBe(1);
        const called = fetchMock.mock.calls[0][0] as string;
        expect(called).toBe('http://localhost:3000/api/users');
        expect(out.steps[0].resolvedUrl).toBe('http://localhost:3000/api/users');
    });

    it('strips trailing slashes on the resolved base before joining', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        await runChain({
            steps: [{ id: 's1', method: 'GET', url: '/api/x', repoId: 'svc-a' }],
            resolveBaseUrl: () => 'http://localhost:3000///',
        });
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/x');
    });

    it('leaves an absolute URL untouched even when repoId is set', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        // 203.0.113.7 = RFC-5737 TEST-NET-3 (literal, non-private → passes the
        // #887 guard without a DNS round-trip; a fake hostname would resolve-fail).
        await runChain({
            steps: [{ id: 's1', method: 'GET', url: 'http://203.0.113.7/x', repoId: 'svc-a' }],
            resolveBaseUrl: () => 'http://localhost:3000',
        });
        expect(fetchMock.mock.calls[0][0]).toBe('http://203.0.113.7/x');
    });

    it('routes each step to its own repo across a multi-repo chain', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ token: 'abc' }))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));
        const steps: ChainStep[] = [
            {
                id: 'login', method: 'POST', url: '/auth/login',
                repoId: 'auth-svc',
                extract: { token: { scope: 'json', path: '$.token' } },
            },
            {
                id: 'me', method: 'GET', url: '/me',
                repoId: 'profile-svc',
                bearerToken: '{{token}}',
            },
        ];
        const out = await runChain({
            steps,
            resolveBaseUrl: (id) => ({
                'auth-svc': 'http://localhost:3001',
                'profile-svc': 'http://localhost:3002',
            }[id] ?? ''),
        });
        expect(out.passed).toBe(2);
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/auth/login');
        expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:3002/me');
        // Env propagates across repos.
        const secondInit = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
        expect(secondInit.headers.Authorization).toBe('Bearer abc');
    });

    it('refuses dispatch with a clear error when resolveBaseUrl returns empty', async () => {
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: '/api/x', repoId: 'svc-unknown' }],
            resolveBaseUrl: () => '',
        });
        expect(out.errored).toBe(1);
        expect(out.steps[0].outcome).toBe('errored');
        expect(out.steps[0].response.error).toMatch(/svc-unknown/);
        expect(out.steps[0].response.error).toMatch(/dev base URL/i);
        // The relay was never called.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses dispatch when resolveBaseUrl callback is missing entirely', async () => {
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: '/api/x', repoId: 'svc-a' }],
            // no resolveBaseUrl
        });
        expect(out.errored).toBe(1);
        expect(out.steps[0].outcome).toBe('errored');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('aborts subsequent steps on first base-URL error when stopOnFirstFailure', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
        const out = await runChain({
            steps: [
                { id: 's1', method: 'GET', url: '/api/x', repoId: 'svc-a' },
                { id: 's2', method: 'GET', url: 'http://localhost/ok' },
            ],
            resolveBaseUrl: () => '',
            stopOnFirstFailure: true,
        });
        expect(out.aborted).toBe(true);
        expect(out.steps).toHaveLength(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('single-repo flow (no repoId on any step) is unchanged — resolver never consulted', async () => {
        const resolver = vi.fn(() => 'http://NOPE');
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: 'http://localhost/y' }],
            resolveBaseUrl: resolver,
        });
        expect(out.passed).toBe(1);
        expect(resolver).not.toHaveBeenCalled();
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost/y');
    });

    it('relative URL with no repoId — bypasses Phase I error path (no cross-repo error emitted)', async () => {
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: '/api/legacy' }],
        });
        // We don't gate on whether the relay accepts a bare relative URL —
        // that's pre-existing behavior. What matters is that Phase I's
        // "dev base URL" error path is NOT triggered when repoId is unset.
        const err = out.steps[0].response.error ?? '';
        expect(err).not.toMatch(/dev base URL/i);
    });

    it('env substitution still applies after base-URL prefix', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
        const out = await runChain({
            steps: [{ id: 's1', method: 'GET', url: '/users/{{id}}', repoId: 'svc-a' }],
            resolveBaseUrl: () => 'http://localhost:3000',
            initialEnv: { id: '42' },
        });
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/users/42');
        expect(out.steps[0].resolvedUrl).toBe('http://localhost:3000/users/42');
    });

    it('mixed repo step then single-repo step — both dispatch correctly', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
        await runChain({
            steps: [
                { id: 's1', method: 'GET', url: '/scoped', repoId: 'svc-a' },
                { id: 's2', method: 'GET', url: 'http://203.0.113.8/abs' }, // RFC-5737 literal (no DNS)
            ],
            resolveBaseUrl: (id) => (id === 'svc-a' ? 'http://localhost:3000' : ''),
        });
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/scoped');
        expect(fetchMock.mock.calls[1][0]).toBe('http://203.0.113.8/abs');
    });
});
