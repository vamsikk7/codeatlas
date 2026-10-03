/**
 * llmConnectionProbe.ts - UX (2026-06-04)
 *
 * Provider-aware connectivity probe used by the home page "Test
 * Connection" button. Translates the LLM Config into a minimal
 * read-only HTTP request, fires it with a 10-second AbortController
 * timeout, and reports back whether the endpoint is reachable + how
 * fast it answered.
 *
 * Probes are intentionally chosen to be free / non-billable:
 *   - openai     - GET /v1/models
 *   - openrouter - GET /api/v1/models
 *   - anthropic  - GET /v1/messages with x-api-key (will 400 on empty body, but auth is verified before the body check, so a 401 means key is wrong and any non-401 means we reached the API)
 *   - ollama     - GET <endpoint>/api/tags
 *   - custom     - HEAD <endpoint>
 *
 * Returns a single object the webview renders unchanged.
 */

export interface LlmProbeConfig {
    provider: string;          // 'openai' | 'openrouter' | 'anthropic' | 'ollama' | 'custom' | ...
    endpoint?: string | null;  // overrides the default for the provider when set
    apiKey?: string | null;
}

export interface LlmProbeResult {
    ok: boolean;
    message: string;
    latencyMs?: number;
}

const DEFAULT_ENDPOINTS: Record<string, string> = {
    openai: 'https://api.openai.com/v1/models',
    openrouter: 'https://openrouter.ai/api/v1/models',
    anthropic: 'https://api.anthropic.com/v1/messages',
    ollama: 'http://localhost:11434/api/tags',
};

const PROBE_TIMEOUT_MS = 10000;

/**
 * Returns the URL we'll actually hit for the probe + the HTTP method
 * + the headers. Pure (no I/O) so we can unit-test the routing logic
 * without making network calls.
 */
export function buildProbeRequest(cfg: LlmProbeConfig): {
    url: string;
    method: 'GET' | 'HEAD' | 'POST';
    headers: Record<string, string>;
    body?: string;
} {
    const provider = (cfg.provider ?? '').toLowerCase().trim();
    const apiKey = (cfg.apiKey ?? '').trim();
    const endpointOverride = (cfg.endpoint ?? '').trim();

    if (provider === 'ollama') {
        // Ollama: when the user wrote a /v1/chat/completions URL, infer
        // the base + hit /api/tags instead so we don't trigger a model
        // pull. Otherwise use whatever they typed (already a probe URL).
        const root = endpointOverride
            ? endpointOverride.replace(/\/v1\/chat\/completions\/?$/, '').replace(/\/+$/, '')
            : 'http://localhost:11434';
        return {
            url: root.endsWith('/api/tags') ? root : `${root}/api/tags`,
            method: 'GET',
            headers: { Accept: 'application/json' },
        };
    }

    if (provider === 'openai') {
        return {
            url: endpointOverride || DEFAULT_ENDPOINTS.openai,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
            },
        };
    }

    if (provider === 'openrouter') {
        return {
            url: endpointOverride || DEFAULT_ENDPOINTS.openrouter,
            method: 'GET',
            headers: {
                Authorization: apiKey ? `Bearer ${apiKey}` : '',
                Accept: 'application/json',
            },
        };
    }

    if (provider === 'anthropic') {
        // Anthropic doesn't expose a list-models endpoint; the cheapest
        // auth check is a POST /v1/messages with an empty body — the
        // server validates the key BEFORE the body so a 400 still means
        // "key accepted" and a 401 means "key wrong".
        return {
            url: endpointOverride || DEFAULT_ENDPOINTS.anthropic,
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: '{}',
        };
    }

    // 'custom' or unknown — HEAD the configured endpoint.
    return {
        url: endpointOverride || 'http://localhost:8080',
        method: 'HEAD',
        headers: {},
    };
}

/**
 * Interpret an HTTP response from the probe into a user-facing message.
 * For Anthropic specifically, 400 = "auth passed, body rejected" which
 * is a successful probe.
 */
export function interpretProbeResponse(
    cfg: LlmProbeConfig,
    status: number,
    latencyMs: number,
): LlmProbeResult {
    const provider = (cfg.provider ?? '').toLowerCase().trim();

    if (status >= 200 && status < 300) {
        return { ok: true, message: 'Connected', latencyMs };
    }

    // Anthropic: 400 from POST /v1/messages with empty body still
    // means the API key + endpoint are good.
    if (provider === 'anthropic' && status === 400) {
        return { ok: true, message: 'Connected', latencyMs };
    }

    if (status === 401 || status === 403) {
        return { ok: false, message: `HTTP ${status}: invalid or missing API key`, latencyMs };
    }

    if (status === 404) {
        return { ok: false, message: `HTTP 404: endpoint not found`, latencyMs };
    }

    if (status >= 500) {
        return { ok: false, message: `HTTP ${status}: upstream LLM service error`, latencyMs };
    }

    return { ok: false, message: `HTTP ${status}`, latencyMs };
}

/**
 * Run the probe end to end. Caller-supplied fetch (Node global, dom,
 * or a test stub). Returns the same shape the webview consumes.
 */
export async function probeLlmConnection(
    cfg: LlmProbeConfig,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<LlmProbeResult> {
    const req = buildProbeRequest(cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
        const res = await fetchImpl(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            signal: controller.signal,
        });
        const latencyMs = Date.now() - t0;
        return interpretProbeResponse(cfg, res.status, latencyMs);
    } catch (err: any) {
        const latencyMs = Date.now() - t0;
        const name = err?.name ?? '';
        const message = err?.message ?? String(err);
        if (name === 'AbortError') {
            return { ok: false, message: `Timed out after ${Math.round(timeoutMs / 1000)}s`, latencyMs };
        }
        if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
            return { ok: false, message: `Couldn't resolve the LLM host (DNS)`, latencyMs };
        }
        if (/ECONNREFUSED|connection refused/i.test(message)) {
            return { ok: false, message: `Connection refused — is the server running?`, latencyMs };
        }
        return { ok: false, message: message.slice(0, 200), latencyMs };
    } finally {
        clearTimeout(timer);
    }
}
