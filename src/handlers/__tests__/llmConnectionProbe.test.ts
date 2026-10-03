import { describe, it, expect, vi } from 'vitest';
import {
    buildProbeRequest,
    interpretProbeResponse,
    probeLlmConnection,
} from '../llmConnectionProbe';

describe('buildProbeRequest', () => {
    it('OpenAI: GET /v1/models with Authorization bearer', () => {
        const req = buildProbeRequest({ provider: 'openai', apiKey: 'sk-test' });
        expect(req.url).toBe('https://api.openai.com/v1/models');
        expect(req.method).toBe('GET');
        expect(req.headers.Authorization).toBe('Bearer sk-test');
    });

    it('OpenRouter: GET /api/v1/models with Authorization bearer', () => {
        const req = buildProbeRequest({ provider: 'openrouter', apiKey: 'or-test' });
        expect(req.url).toBe('https://openrouter.ai/api/v1/models');
        expect(req.headers.Authorization).toBe('Bearer or-test');
    });

    it('Anthropic: POST /v1/messages with x-api-key header', () => {
        const req = buildProbeRequest({ provider: 'anthropic', apiKey: 'sk-ant' });
        expect(req.url).toBe('https://api.anthropic.com/v1/messages');
        expect(req.method).toBe('POST');
        expect(req.headers['x-api-key']).toBe('sk-ant');
        expect(req.headers['anthropic-version']).toBeTruthy();
    });

    it('Ollama: GET /api/tags on the default port when no endpoint set', () => {
        const req = buildProbeRequest({ provider: 'ollama' });
        expect(req.url).toBe('http://localhost:11434/api/tags');
        expect(req.method).toBe('GET');
        expect(req.headers.Authorization).toBeUndefined();
    });

    it('Ollama: rewrites a /v1/chat/completions URL into /api/tags so the probe is cheap', () => {
        const req = buildProbeRequest({
            provider: 'ollama',
            endpoint: 'http://localhost:11434/v1/chat/completions',
        });
        expect(req.url).toBe('http://localhost:11434/api/tags');
    });

    it('Custom provider: HEAD the configured endpoint', () => {
        const req = buildProbeRequest({ provider: 'custom', endpoint: 'http://localhost:7000' });
        expect(req.url).toBe('http://localhost:7000');
        expect(req.method).toBe('HEAD');
    });

    it('Unknown provider falls back to HEAD on the endpoint', () => {
        const req = buildProbeRequest({ provider: 'mystery', endpoint: 'https://example.test' });
        expect(req.method).toBe('HEAD');
        expect(req.url).toBe('https://example.test');
    });
});

describe('interpretProbeResponse', () => {
    it('2xx → ok=true', () => {
        const r = interpretProbeResponse({ provider: 'openai' }, 200, 120);
        expect(r.ok).toBe(true);
        expect(r.message).toBe('Connected');
        expect(r.latencyMs).toBe(120);
    });

    it('401 → ok=false with API-key hint', () => {
        const r = interpretProbeResponse({ provider: 'openai' }, 401, 88);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/invalid or missing API key/);
    });

    it('Anthropic: 400 with empty body still counts as auth-passed', () => {
        const r = interpretProbeResponse({ provider: 'anthropic' }, 400, 200);
        expect(r.ok).toBe(true);
    });

    it('Non-Anthropic: 400 is treated as failure', () => {
        const r = interpretProbeResponse({ provider: 'openai' }, 400, 200);
        expect(r.ok).toBe(false);
    });

    it('5xx → ok=false with upstream service hint', () => {
        const r = interpretProbeResponse({ provider: 'openai' }, 503, 50);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/upstream LLM service/);
    });

    it('404 → ok=false with endpoint-not-found hint', () => {
        const r = interpretProbeResponse({ provider: 'ollama' }, 404, 20);
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/endpoint not found/);
    });
});

describe('probeLlmConnection (with stub fetch)', () => {
    it('returns ok=true on 2xx', async () => {
        const fakeFetch = vi.fn(async () => ({ status: 200 }) as Response);
        const res = await probeLlmConnection({ provider: 'openai', apiKey: 'k' }, fakeFetch as any, 1000);
        expect(res.ok).toBe(true);
        expect(res.message).toBe('Connected');
        expect(fakeFetch).toHaveBeenCalledWith(
            'https://api.openai.com/v1/models',
            expect.objectContaining({
                method: 'GET',
                headers: expect.objectContaining({ Authorization: 'Bearer k' }),
            }),
        );
    });

    it('returns ok=false on 401', async () => {
        const fakeFetch = vi.fn(async () => ({ status: 401 }) as Response);
        const res = await probeLlmConnection({ provider: 'openai', apiKey: 'bad' }, fakeFetch as any, 1000);
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/invalid or missing API key/);
    });

    it('translates AbortError (timeout) into a friendly message', async () => {
        const fakeFetch = vi.fn(async () => {
            const e = new Error('aborted');
            (e as any).name = 'AbortError';
            throw e;
        });
        const res = await probeLlmConnection({ provider: 'openai' }, fakeFetch as any, 100);
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/Timed out after/);
    });

    it('translates ECONNREFUSED into a "Connection refused" message', async () => {
        const fakeFetch = vi.fn(async () => {
            const e = new Error('connect ECONNREFUSED 127.0.0.1:11434');
            throw e;
        });
        const res = await probeLlmConnection({ provider: 'ollama' }, fakeFetch as any, 1000);
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/Connection refused/);
    });

    it('translates DNS resolution failures (ENOTFOUND)', async () => {
        const fakeFetch = vi.fn(async () => {
            const e = new Error('getaddrinfo ENOTFOUND api.exmaple.com');
            throw e;
        });
        const res = await probeLlmConnection({ provider: 'openai' }, fakeFetch as any, 1000);
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/Couldn't resolve the LLM host/);
    });
});
