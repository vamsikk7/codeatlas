/**
 * relay.test.ts — Issue #602 Phase 2 transport tests.
 *
 * We mock `global.fetch` so the tests are deterministic + don't make
 * real network calls. The relay's only job is to coordinate
 * substitution + headers + auth + response shaping — the actual
 * fetch implementation is exchanged at runtime.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeRequest as _executeRequest, type SendRequestArgs } from '../relay';

// These tests model the user-initiated workbench Send, which allows
// loopback/private dev hosts (#887). Default the flag so the localhost
// fixtures dispatch; the SSRF-block behaviour is covered in hostGuard.test.ts.
const executeRequest = (args: SendRequestArgs) => _executeRequest({ allowPrivateHosts: true, ...args });

interface FakeResponseInit {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    text?: string;
}

function fakeResponse(init: FakeResponseInit = {}): Response {
    const headers = new Headers(init.headers ?? {});
    return new Response(init.text ?? '', {
        status: init.status ?? 200,
        statusText: init.statusText ?? 'OK',
        headers,
    });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    (global as any).fetch = fetchMock;
});

async function runWithFakeResponse(args: SendRequestArgs, init: FakeResponseInit = {}) {
    fetchMock.mockResolvedValue(fakeResponse({ text: '{"ok":true}', headers: { 'content-type': 'application/json' }, ...init }));
    return executeRequest(args);
}

describe('executeRequest', () => {
    it('rejects relative / non-http URLs without calling fetch', async () => {
        const res = await executeRequest({ method: 'GET', url: '/api/x' });
        expect(res.error).toMatch(/absolute/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves env vars in URL + headers + body before sending', async () => {
        const res = await runWithFakeResponse({
            method: 'POST',
            url: '{{base}}/api/articles',
            headers: { 'X-Trace': '{{trace}}' },
            body: '{"title":"{{title}}"}',
            env: { base: 'http://localhost:3000', trace: 'abc', title: 'Hello' },
        });
        expect(res.status).toBe(200);
        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('http://localhost:3000/api/articles');
        const reqInit = call[1] as { method: string; headers: Record<string, string>; body: string };
        expect(reqInit.method).toBe('POST');
        expect(reqInit.headers['X-Trace']).toBe('abc');
        expect(reqInit.body).toBe('{"title":"Hello"}');
    });

    it('adds Bearer Authorization header when bearerToken is supplied', async () => {
        await runWithFakeResponse({
            method: 'GET',
            url: 'http://localhost/api/me',
            bearerToken: 'tok123',
        });
        const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(reqInit.headers.Authorization).toBe('Bearer tok123');
    });

    it('does NOT overwrite a user-provided Authorization header', async () => {
        await runWithFakeResponse({
            method: 'GET',
            url: 'http://localhost/api/me',
            headers: { Authorization: 'Token user-provided' },
            bearerToken: 'tok123',
        });
        const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(reqInit.headers.Authorization).toBe('Token user-provided');
    });

    it('adds API-key header when apiKey + apiKeyHeader are supplied', async () => {
        await runWithFakeResponse({
            method: 'GET',
            url: 'http://localhost/api/me',
            apiKey: 'k1',
            apiKeyHeader: 'X-API-Key',
        });
        const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(reqInit.headers['X-API-Key']).toBe('k1');
    });

    it('defaults Content-Type to application/json when body is valid JSON', async () => {
        await runWithFakeResponse({
            method: 'POST',
            url: 'http://localhost/x',
            body: '{"a":1}',
        });
        const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(reqInit.headers['Content-Type']).toBe('application/json');
    });

    it('defaults Content-Type to text/plain when body is not JSON', async () => {
        await runWithFakeResponse({
            method: 'POST',
            url: 'http://localhost/x',
            body: 'just text',
        });
        const reqInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(reqInit.headers['Content-Type']).toBe('text/plain');
    });

    it('strips body for GET / HEAD / OPTIONS', async () => {
        await runWithFakeResponse({
            method: 'GET',
            url: 'http://localhost/x',
            body: 'should-not-go',
        });
        const reqInit = fetchMock.mock.calls[0][1] as { body?: string };
        expect(reqInit.body).toBeUndefined();
    });

    it('shapes the response: status + headers + body + durationMs', async () => {
        const res = await runWithFakeResponse({ method: 'GET', url: 'http://localhost/x' }, {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
            text: '{"ok":true}',
        });
        expect(res.status).toBe(200);
        expect(res.statusText).toBe('OK');
        expect(res.headers['content-type']).toBe('application/json');
        expect(res.headers['x-trace']).toBe('abc');
        expect(res.body).toBe('{"ok":true}');
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('surfaces a network error via the `error` field', async () => {
        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const res = await executeRequest({ method: 'GET', url: 'http://localhost/x' });
        expect(res.status).toBe(0);
        expect(res.error).toContain('ECONNREFUSED');
    });

    it('formats a GraphQL request with query + variables + operationName', async () => {
        await runWithFakeResponse({
            method: 'GET', // overridden
            url: 'http://localhost/graphql',
            graphql: {
                query: 'query Q($id: ID!) { user(id: $id) { id name } }',
                variables: { id: 'u1' },
                operationName: 'Q',
            },
        });
        const reqInit = fetchMock.mock.calls[0][1] as { method: string; body: string; headers: Record<string, string> };
        expect(reqInit.method).toBe('POST');
        expect(reqInit.headers['Content-Type']).toBe('application/json');
        const parsed = JSON.parse(reqInit.body);
        expect(parsed.query).toBe('query Q($id: ID!) { user(id: $id) { id name } }');
        expect(parsed.variables).toEqual({ id: 'u1' });
        expect(parsed.operationName).toBe('Q');
    });

    it('GraphQL helper still substitutes env vars inside the query', async () => {
        await runWithFakeResponse({
            method: 'POST',
            url: 'http://localhost/graphql',
            graphql: { query: 'query { node(id: "{{nodeId}}") { id } }' },
            env: { nodeId: 'abc' },
        });
        const reqInit = fetchMock.mock.calls[0][1] as { body: string };
        expect(JSON.parse(reqInit.body).query).toBe('query { node(id: "abc") { id } }');
    });

    it('treats unknown content-types as binary placeholder', async () => {
        const res = await runWithFakeResponse({ method: 'GET', url: 'http://localhost/x' }, {
            headers: { 'content-type': 'application/octet-stream' },
            text: 'binary-bytes-here',
        });
        expect(res.body).toMatch(/^\[Binary \d+ bytes/);
    });
});
