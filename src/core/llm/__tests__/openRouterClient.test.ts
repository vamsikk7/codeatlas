import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture fetch calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { sendOpenRouterRequest, isTrustedAuthHost, type OpenRouterConfig, LlmError, classifyHttpStatus, classifyFetchError } from '../openRouterClient';

function makeConfig(overrides: Partial<OpenRouterConfig> = {}): OpenRouterConfig {
    return {
        apiKey: 'sk-test',
        model: 'test-model',
        timeoutMs: 5000,
        ...overrides,
    };
}

function mockJsonResponse(body: any, status = 200) {
    return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    });
}

beforeEach(() => {
    mockFetch.mockReset();
});

describe('sendOpenRouterRequest — endpoint resolution', () => {
    it('uses openrouter URL by default', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'test' }]);
        expect(mockFetch.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('uses ollama URL for ollama provider', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ provider: 'ollama', apiKey: '' }), [{ role: 'user', content: 'test' }]);
        expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    });

    it('endpoint override takes precedence over provider URL', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ provider: 'openai', endpoint: 'http://my-proxy:8080/v1/chat/completions' }), [{ role: 'user', content: 'test' }]);
        expect(mockFetch.mock.calls[0][0]).toBe('http://my-proxy:8080/v1/chat/completions');
    });
});

describe('sendOpenRouterRequest — authorization header', () => {
    it('includes Authorization header when apiKey is set', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: 'sk-test' }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer sk-test');
    });

    it('omits Authorization header when apiKey is empty', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: '', provider: 'ollama' }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBeUndefined();
    });
});

describe('#885 — API key only attaches to trusted hosts', () => {
    it('isTrustedAuthHost: built-in provider hosts + loopback are trusted; others are not', () => {
        expect(isTrustedAuthHost('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
        expect(isTrustedAuthHost('https://api.openai.com/v1/chat/completions')).toBe(true);
        expect(isTrustedAuthHost('https://api.anthropic.com/v1/messages')).toBe(true);
        expect(isTrustedAuthHost('http://localhost:11434/v1/chat/completions')).toBe(true);
        expect(isTrustedAuthHost('http://127.0.0.1:8080/v1/chat/completions')).toBe(true);
        expect(isTrustedAuthHost('https://evil.test/v1/chat/completions')).toBe(false);
        expect(isTrustedAuthHost('https://openrouter.ai.evil.test/v1')).toBe(false); // suffix attack
        expect(isTrustedAuthHost('not-a-url')).toBe(false); // fail closed
    });

    it('does NOT send the API key to a custom (untrusted) provider URL', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: 'sk-secret', provider: 'https://evil.test/v1/chat/completions' }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBeUndefined();
    });

    it('does NOT send the API key to a custom endpoint override (untrusted host)', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: 'sk-secret', endpoint: 'https://evil.test/v1/chat/completions' }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBeUndefined();
    });

    it('does NOT leak the anthropic x-api-key header to an untrusted host', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ content: [{ text: 'ok' }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: 'sk-secret', provider: 'anthropic', endpoint: 'https://evil.test/v1/messages' }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['x-api-key']).toBeUndefined();
        expect(headers['Authorization']).toBeUndefined();
    });

    it('DOES send the key to a custom host when the caller consents via allowCustomEndpointAuth', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: 'sk-secret', endpoint: 'https://my-proxy.corp/v1/chat/completions', allowCustomEndpointAuth: true }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer sk-secret');
    });

    it('still sends the key to the built-in OpenRouter host (no regression)', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ apiKey: 'sk-secret' }), [{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer sk-secret');
    });
});

describe('sendOpenRouterRequest — maxTokens handling', () => {
    it('omits max_tokens from OpenAI body when maxTokens is undefined', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ maxTokens: undefined }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.max_tokens).toBeUndefined();
    });

    it('includes max_tokens in OpenAI body when explicitly set', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ maxTokens: 500 }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.max_tokens).toBe(500);
    });

    it('defaults to 4096 for Anthropic when maxTokens is undefined', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ content: [{ text: 'ok' }] }));
        await sendOpenRouterRequest(makeConfig({ provider: 'anthropic' }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.max_tokens).toBe(4096);
    });
});

describe('sendOpenRouterRequest — responseFormat', () => {
    it('includes response_format in OpenAI body when set', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: '{}' } }] }));
        await sendOpenRouterRequest(makeConfig({ responseFormat: 'json_object' }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.response_format).toEqual({ type: 'json_object' });
    });

    it('omits response_format when not set', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.response_format).toBeUndefined();
    });

    it('does not include response_format for Anthropic even when set', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ content: [{ text: 'ok' }] }));
        await sendOpenRouterRequest(makeConfig({ provider: 'anthropic', responseFormat: 'json_object' }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.response_format).toBeUndefined();
    });
});

describe('sendOpenRouterRequest — temperature override (#429)', () => {
    it('defaults to 0.3 when temperature is not specified', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.temperature).toBe(0.3);
    });

    it('passes temperature=0 through to the OpenAI-compatible request body', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig({ temperature: 0 }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.temperature).toBe(0);
        expect(body.top_p).toBe(1);
    });

    it('passes temperature=0 through to the Anthropic request body', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ content: [{ text: 'ok' }] }));
        await sendOpenRouterRequest(makeConfig({ provider: 'anthropic', temperature: 0 }), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.temperature).toBe(0);
        // Anthropic body does not carry top_p — only OpenAI-compatible bodies do.
        expect(body.top_p).toBeUndefined();
    });

    it('omits top_p when temperature is the default (non-zero)', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ choices: [{ message: { content: 'ok' } }] }));
        await sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'test' }]);
        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.top_p).toBeUndefined();
    });
});

// Issue 609 — LlmError classification
describe('LlmError classification (Issue 609)', () => {
    it('classifyHttpStatus: 401/403 → auth', () => {
        expect(classifyHttpStatus(401)).toBe('auth');
        expect(classifyHttpStatus(403)).toBe('auth');
    });
    it('classifyHttpStatus: 404 → model-not-found', () => {
        expect(classifyHttpStatus(404)).toBe('model-not-found');
    });
    it('classifyHttpStatus: 429 → rate-limit', () => {
        expect(classifyHttpStatus(429)).toBe('rate-limit');
    });
    it('classifyHttpStatus: 5xx → server-error', () => {
        expect(classifyHttpStatus(500)).toBe('server-error');
        expect(classifyHttpStatus(502)).toBe('server-error');
        expect(classifyHttpStatus(503)).toBe('server-error');
    });
    it('classifyHttpStatus: 418 / other → unknown', () => {
        expect(classifyHttpStatus(418)).toBe('unknown');
    });
    it('classifyFetchError: ECONNREFUSED-style messages → network', () => {
        expect(classifyFetchError(new Error('fetch failed'))).toBe('network');
        expect(classifyFetchError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe('network');
        expect(classifyFetchError(new Error('getaddrinfo ENOTFOUND foo.example'))).toBe('network');
    });
    it('classifyFetchError: AbortError → network', () => {
        expect(classifyFetchError(new Error('The operation was aborted'))).toBe('network');
    });
    it('classifyFetchError: anything else → unknown', () => {
        expect(classifyFetchError(new Error('weird parse glitch'))).toBe('unknown');
    });

    it('sendOpenRouterRequest throws LlmError(auth) on 401', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ error: 'bad key' }, 401));
        await expect(
            sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'hi' }]),
        ).rejects.toMatchObject({ name: 'LlmError', kind: 'auth', status: 401 });
    });
    it('sendOpenRouterRequest throws LlmError(rate-limit) on 429', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ error: 'too many' }, 429));
        await expect(
            sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'hi' }]),
        ).rejects.toMatchObject({ name: 'LlmError', kind: 'rate-limit', status: 429 });
    });
    it('sendOpenRouterRequest throws LlmError(network) when fetch itself rejects', async () => {
        mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
        await expect(
            sendOpenRouterRequest(makeConfig({ provider: 'ollama' }), [{ role: 'user', content: 'hi' }]),
        ).rejects.toMatchObject({ name: 'LlmError', kind: 'network' });
    });
    it('LlmError carries rawBody for "View raw response" UI', async () => {
        mockFetch.mockReturnValueOnce(mockJsonResponse({ error: 'invalid model id' }, 404));
        const promise = sendOpenRouterRequest(makeConfig(), [{ role: 'user', content: 'hi' }]);
        let caught: LlmError | undefined;
        try { await promise; } catch (e) { caught = e as LlmError; }
        expect(caught).toBeDefined();
        expect(caught!.kind).toBe('model-not-found');
        expect(caught!.rawBody).toContain('invalid model id');
    });
});
