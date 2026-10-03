/**
 * openRouterClient.ts
 *
 * Generic chat completions client supporting OpenRouter, OpenAI, and Anthropic-compatible APIs.
 * All three use the same /v1/chat/completions format (Anthropic via their OpenAI-compatible endpoint).
 * Uses Node's built-in `fetch` (Node 18+) — no SDK needed.
 */

/** Known provider base URLs */
const PROVIDER_URLS: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    openai: 'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    ollama: 'http://localhost:11434/v1/chat/completions',
};

/**
 * #885 — hosts the API key may be attached to. Derived from the built-in
 * provider base URLs plus loopback (the user's own machine). The workspace /
 * env key is NEVER sent to any host outside this set unless the caller passes
 * `allowCustomEndpointAuth: true` (set ONLY after explicit per-endpoint user
 * consent). Without this gate, a free-form `provider:"https://evil/v1"` (e.g.
 * from a prompt-injected agent calling the MCP tools, where `preflightLlmAuth`
 * back-fills the real `OPENROUTER_API_KEY`) would POST the key to the attacker.
 */
const TRUSTED_AUTH_HOSTS: ReadonlySet<string> = new Set(
    [
        ...Object.values(PROVIDER_URLS).map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }),
        'localhost', '127.0.0.1', '::1', '0.0.0.0',
    ].filter(Boolean),
);

/**
 * #885 — may the API key be attached to this endpoint? True for the built-in
 * provider hosts + loopback; false for everything else (and for unparseable
 * URLs, which fail closed). Exported for the consent layer + tests.
 */
export function isTrustedAuthHost(endpoint: string): boolean {
    try {
        return TRUSTED_AUTH_HOSTS.has(new URL(endpoint).hostname.toLowerCase());
    } catch {
        return false; // unparseable → untrusted, fail closed
    }
}

export interface OpenRouterConfig {
    apiKey: string;
    model: string;
    timeoutMs: number;
    /** Provider: 'openrouter' (default), 'openai', 'anthropic', 'ollama', 'custom', or a custom base URL */
    provider?: string;
    /** Maximum tokens for the response. Omit to let the model decide (Anthropic defaults to 4096). */
    maxTokens?: number;
    /** Request structured JSON output. Supported by OpenAI/OpenRouter/Ollama. Ignored for Anthropic. */
    responseFormat?: 'json_object';
    /** Override endpoint URL. Takes precedence over provider-based URL resolution. */
    endpoint?: string;
    /**
     * #885 — explicit opt-in to attach the API key to a NON-built-in endpoint
     * host. Default (undefined/false) means the key is sent only to the trusted
     * provider hosts + loopback. The consent layer sets this to `true` after the
     * user approves a specific custom URL — never set it from untrusted input.
     */
    allowCustomEndpointAuth?: boolean;
    /**
     * Sampling temperature. Defaults to 0.3 (mild creativity, kept stable for
     * AI Review's tone). Naming / annotation callers that need byte-identical
     * output across rebuilds (Issue #429) pass `temperature: 0`.
     */
    temperature?: number;
    /**
     * #939 — OpenRouter reasoning effort for reasoning-capable models
     * (e.g. deepseek-v4-flash). Maps to the OpenRouter `reasoning: { effort }`
     * request field ("minimal"|"low"|"medium"|"high"|"xhigh" — passed through
     * verbatim so the model/provider validates). Omit to disable reasoning.
     * Ignored for the Anthropic body format. Wired from CODEATLAS_LLM_REASONING_EFFORT.
     */
    reasoningEffort?: string;
}

export const DEFAULT_OPENROUTER_CONFIG: Omit<OpenRouterConfig, 'apiKey'> = {
    model: 'openrouter/free',
    // UX-49 (2026-06-04): bumped from 10s → 30s. Even hosted endpoints
    // (OpenAI / Anthropic / OpenRouter) can take 10-20s on cold cache,
    // and the previous 10s default produced spurious aborts. Local
    // providers override this to 120s via per-caller config (see
    // llmNamingService.configure / aiReviewHandlers).
    timeoutMs: 30_000,
    provider: 'openrouter',
};

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface OpenRouterResponse {
    text: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Issue 609: classified LLM error kinds. Drives the user-facing failure banner
 * + remediation hint in `AiReviewErrorBanner`. Adding a new kind here means
 * adding a matching case in the banner's message table.
 */
export type LlmErrorKind =
    | 'network'           // TCP/DNS/timeout — connection never landed
    | 'auth'              // 401/403 — API key bad or missing
    | 'rate-limit'        // 429 — back off
    | 'model-not-found'   // 404 on model id
    | 'server-error'      // 5xx from the provider
    | 'schema-invalid'    // LLM returned non-JSON / malformed output
    | 'unknown';          // anything else

export class LlmError extends Error {
    readonly kind: LlmErrorKind;
    readonly status?: number;
    readonly rawBody?: string;
    readonly provider?: string;
    constructor(kind: LlmErrorKind, message: string, opts?: { status?: number; rawBody?: string; provider?: string }) {
        super(message);
        this.name = 'LlmError';
        this.kind = kind;
        this.status = opts?.status;
        this.rawBody = opts?.rawBody;
        this.provider = opts?.provider;
    }
}

/**
 * Classify an HTTP status code from an LLM provider into a stable error kind.
 * Exported so callers (perEntryReviewer, naming service) can re-use it when
 * they wrap the raw fetch.
 */
export function classifyHttpStatus(status: number): LlmErrorKind {
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'model-not-found';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
    return 'unknown';
}

/** Classify a thrown error (from fetch) into a LlmErrorKind. */
export function classifyFetchError(err: unknown): LlmErrorKind {
    const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
    if (msg.includes('abort')) return 'network'; // aborted (timeout or user cancel)
    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('timeout')) return 'network';
    return 'unknown';
}

/**
 * Resolve the API endpoint URL from a provider name or custom URL.
 */
function resolveEndpoint(provider: string): string {
    if (provider.startsWith('http://') || provider.startsWith('https://')) {
        return provider; // custom URL passed directly
    }
    return PROVIDER_URLS[provider.toLowerCase()] ?? PROVIDER_URLS.openrouter;
}

/**
 * Send a chat completion request.
 * Works with OpenRouter, OpenAI, and any OpenAI-compatible API.
 *
 * @param config - API key, model, timeout, and optional provider
 * @param messages - Chat messages array
 * @returns Assistant's reply text, model used, and token usage
 */
export async function sendOpenRouterRequest(
    config: OpenRouterConfig,
    messages: ChatMessage[],
    /**
     * Optional external abort signal. When the caller supplies one, an abort
     * triggers via `signal.aborted` cancels the in-flight fetch — useful for
     * superseded NL queries / AI Reviews where a newer request makes the
     * older response irrelevant. The internal timeout still applies.
     * See ADR-018 / Issue 366 — In-flight LLM requests not aborted on supersede.
     */
    externalSignal?: AbortSignal,
): Promise<OpenRouterResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    // If the caller's signal aborts, propagate to our controller so the fetch
    // is canceled. We can't pass two signals to fetch directly; chaining is
    // the standard pattern.
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const provider = config.provider ?? 'openrouter';
    const endpoint = config.endpoint || resolveEndpoint(provider);
    const isAnthropic = provider.toLowerCase() === 'anthropic';
    // #885 — only attach the API key to a trusted host (built-in providers +
    // loopback), or to a custom host the user has explicitly consented to via
    // `allowCustomEndpointAuth`. An injected/custom `provider` URL therefore
    // can't exfiltrate the back-filled workspace key.
    const mayAttachAuth = !!config.apiKey && (isTrustedAuthHost(endpoint) || config.allowCustomEndpointAuth === true);

    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Auth header — skip for keyless providers (e.g. Ollama) and untrusted hosts (#885)
        if (mayAttachAuth) {
            headers['Authorization'] = `Bearer ${config.apiKey}`;
        }

        // Provider-specific headers
        if (provider.toLowerCase() === 'openrouter') {
            headers['HTTP-Referer'] = 'https://codeatlas.live';
            headers['X-Title'] = 'CodeAtlas VS Code';
        }
        if (isAnthropic) {
            if (mayAttachAuth) {
                headers['x-api-key'] = config.apiKey;
            }
            headers['anthropic-version'] = '2023-06-01';
            delete headers['Authorization'];
        }

        // Anthropic uses a different request body format
        // Anthropic requires max_tokens; OpenAI-compatible APIs: omit to let model decide
        // Issue #429 — `temperature: 0` (and `top_p: 1`) are required for the
        // naming pass so the same prompt always returns the same name across
        // rebuilds. Other callers (AI Review) keep the default mild creativity.
        const temperature = config.temperature ?? 0.3;
        const body = isAnthropic
            ? JSON.stringify({
                model: config.model,
                max_tokens: config.maxTokens ?? 4096,
                messages: messages.filter(m => m.role !== 'system'),
                system: messages.find(m => m.role === 'system')?.content,
                temperature,
            })
            : JSON.stringify({
                model: config.model,
                messages,
                ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
                ...(config.responseFormat ? { response_format: { type: config.responseFormat } } : {}),
                temperature,
                ...(temperature === 0 ? { top_p: 1 } : {}),
                // #939 — OpenRouter reasoning effort (deepseek-v4-flash et al.).
                ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
            });

        let resp: Response;
        try {
            // #849 — Node fetch's underlying undici dispatcher enforces a
            // ~300s headersTimeout that fires BEFORE our AbortController when
            // slow local models (or queued concurrent calls against one
            // ollama instance) take minutes to produce the first byte —
            // surfacing as a bare "fetch failed". For timeouts beyond that
            // window, route the request through undici's own fetch + Agent
            // (same-library pairing is required — a foreign Agent on the
            // global fetch is rejected) so `timeoutMs` is the single source
            // of truth. Falls back to global fetch if undici isn't resolvable.
            let doFetch: typeof fetch = fetch;
            let dispatcher: unknown;
            if (config.timeoutMs > 290_000) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const undici = require('undici');
                    dispatcher = new undici.Agent({ headersTimeout: config.timeoutMs, bodyTimeout: config.timeoutMs });
                    doFetch = undici.fetch as typeof fetch;
                } catch { /* keep global fetch + default dispatcher */ }
            }
            resp = await doFetch(endpoint, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
                ...(dispatcher ? { dispatcher } : {}),
            } as RequestInit) as Response;
        } catch (err: unknown) {
            // Issue 609: classify network-level failures (DNS, ECONNREFUSED,
            // timeout, abort) so the banner can surface a specific message.
            throw new LlmError(classifyFetchError(err), `${provider} request failed: ${(err as Error)?.message ?? String(err)}`, { provider });
        }

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            // Issue 609: classified HTTP error — pass status + raw body through
            // so the banner can show "View raw response" without re-fetching.
            throw new LlmError(
                classifyHttpStatus(resp.status),
                `${provider} ${resp.status}: ${errBody.slice(0, 200)}`,
                { status: resp.status, rawBody: errBody.slice(0, 4000), provider },
            );
        }

        const json = await resp.json() as any;

        // Anthropic returns { content: [{ text }] }, OpenAI/OpenRouter returns { choices: [{ message: { content } }] }
        const text = isAnthropic
            ? (json.content?.[0]?.text?.trim() ?? '')
            : (json.choices?.[0]?.message?.content?.trim() ?? '');

        return {
            text,
            model: json.model ?? config.model,
            usage: json.usage,
        };
    } finally {
        clearTimeout(timer);
    }
}
