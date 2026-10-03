/**
 * embeddingClient.ts — Issue #709 embedding generation + cosine search.
 *
 * Tries provider endpoints in order, falls through to "disabled" on
 * the first that returns nothing usable. The provider preference list
 * mirrors the existing LLM provider preference (Ollama → OpenAI → other),
 * so users who already configured a local Ollama get embeddings for free
 * without provisioning a cloud key.
 *
 * Returns vectors as plain `number[]`. Storage is left to the caller —
 * typically the new `embeddings` sqlite table (schema v10 once #709
 * lands a migration). The cosine helper here is pure math + works on
 * any equal-length vector pair.
 *
 * SECURITY: this module never reads source code on its own. The caller
 * decides what text to send for embedding. Existing redaction helpers
 * in `llmNamingService.redactSecrets` should be applied before the
 * caller hands the text to `generateEmbedding`.
 */

export interface EmbeddingProviderConfig {
    /** Provider id — used to pick the SDK + URL pattern. */
    provider: 'ollama' | 'openai' | 'custom' | 'disabled';
    /** Endpoint URL. Ollama default: `http://localhost:11434`.
     *  OpenAI default: `https://api.openai.com/v1`. */
    endpoint?: string;
    /** Model name. Ollama: `nomic-embed-text`. OpenAI: `text-embedding-3-small`. */
    model?: string;
    /** API key for hosted providers. */
    apiKey?: string;
    /** Request timeout in ms. Default 15_000. */
    timeoutMs?: number;
}

export interface EmbeddingResult {
    /** Provider that actually served the embedding. */
    provider: 'ollama' | 'openai' | 'custom';
    /** The model id (verbatim, as returned by the provider). */
    model: string;
    /** Dense vector. Dimensionality depends on the model. */
    vector: number[];
}

/**
 * Cosine similarity between two equal-length vectors. Returns NaN when
 * either vector is zero-length. Defined separately so callers can do
 * k-nearest-neighbor searches without instantiating a client.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) return NaN;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0) return NaN;
    return dot / denom;
}

/**
 * Generate an embedding for a single piece of text. Returns null when
 * the configured provider rejects + no fallback succeeds.
 */
export async function generateEmbedding(
    text: string,
    config: EmbeddingProviderConfig,
    options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<EmbeddingResult | null> {
    if (config.provider === 'disabled') return null;
    if (!text || text.trim().length === 0) return null;
    const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) return null;

    switch (config.provider) {
        case 'ollama':
            return ollamaEmbed(text, config, fetchImpl, options?.signal);
        case 'openai':
            return openAiEmbed(text, config, fetchImpl, options?.signal);
        case 'custom':
            // Custom endpoint: assume OpenAI-compatible (Ollama / vLLM / many
            // self-hosted servers expose this shape).
            return openAiEmbed(text, config, fetchImpl, options?.signal);
    }
}

/**
 * Top-k nearest neighbours over a corpus. Linear scan — fine for the
 * snapshot sizes CodeAtlas typically sees (< 50k entries). Larger
 * corpora would justify an ANN index; that's outside the MVP.
 */
export function topKNearest<T>(
    query: readonly number[],
    corpus: ReadonlyArray<{ id: T; vector: readonly number[] }>,
    k: number,
): Array<{ id: T; score: number }> {
    if (corpus.length === 0 || k <= 0) return [];
    const scored = corpus
        .map(entry => ({ id: entry.id, score: cosineSimilarity(query, entry.vector) }))
        .filter(s => !Number.isNaN(s.score))
        .sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

// ─── Provider implementations ────────────────────────────────────────────────

async function ollamaEmbed(
    text: string,
    config: EmbeddingProviderConfig,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<EmbeddingResult | null> {
    const endpoint = (config.endpoint ?? 'http://localhost:11434').replace(/\/$/, '');
    const model = config.model ?? 'nomic-embed-text';
    const url = `${endpoint}/api/embeddings`;
    const timer = withTimeout(config.timeoutMs ?? 15_000, signal);
    try {
        const resp = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, prompt: text }),
            signal: timer.signal,
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as { embedding?: number[] };
        if (!Array.isArray(data.embedding) || data.embedding.length === 0) return null;
        return { provider: 'ollama', model, vector: data.embedding };
    } catch {
        return null;
    } finally {
        timer.dispose();
    }
}

async function openAiEmbed(
    text: string,
    config: EmbeddingProviderConfig,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<EmbeddingResult | null> {
    const endpoint = (config.endpoint ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = config.model ?? 'text-embedding-3-small';
    const url = `${endpoint}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const timer = withTimeout(config.timeoutMs ?? 15_000, signal);
    try {
        const resp = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model, input: text }),
            signal: timer.signal,
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
        const vector = data?.data?.[0]?.embedding;
        if (!Array.isArray(vector) || vector.length === 0) return null;
        return { provider: config.provider === 'custom' ? 'custom' : 'openai', model, vector };
    } catch {
        return null;
    } finally {
        timer.dispose();
    }
}

function withTimeout(ms: number, parentSignal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const ctrl = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ctrl.abort(new Error('embedding timeout')), ms);
    let parentHandler: (() => void) | undefined;
    if (parentSignal) {
        parentHandler = () => ctrl.abort(new Error('parent signal aborted'));
        parentSignal.addEventListener('abort', parentHandler);
    }
    return {
        signal: ctrl.signal,
        dispose: () => {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }
            if (parentSignal && parentHandler) {
                parentSignal.removeEventListener('abort', parentHandler);
            }
        },
    };
}
