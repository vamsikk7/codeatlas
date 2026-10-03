/**
 * embeddingClient.test.ts — Issue #709.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    cosineSimilarity,
    generateEmbedding,
    topKNearest,
} from '../embeddingClient';

function fakeFetchOllama(vector: number[]): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify({ embedding: vector }), { status: 200 })) as unknown as typeof fetch;
}
function fakeFetchOpenAi(vector: number[]): typeof fetch {
    return vi.fn(async () => new Response(
        JSON.stringify({ data: [{ embedding: vector }] }),
        { status: 200 },
    )) as unknown as typeof fetch;
}
function fakeFetchFail(status = 500): typeof fetch {
    return vi.fn(async () => new Response('upstream error', { status })) as unknown as typeof fetch;
}

describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
        expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
    });
    it('returns 0 for orthogonal vectors', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });
    it('returns -1 for antiparallel vectors', () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    });
    it('returns NaN for length mismatch', () => {
        expect(Number.isNaN(cosineSimilarity([1, 2], [1, 2, 3]))).toBe(true);
    });
    it('returns NaN for empty input', () => {
        expect(Number.isNaN(cosineSimilarity([], []))).toBe(true);
    });
    it('returns NaN for zero vector', () => {
        expect(Number.isNaN(cosineSimilarity([0, 0], [1, 1]))).toBe(true);
    });
});

describe('generateEmbedding — Ollama', () => {
    it('parses the Ollama embeddings response shape', async () => {
        const fetchImpl = fakeFetchOllama([0.1, 0.2, 0.3]);
        const result = await generateEmbedding('hello', { provider: 'ollama' }, { fetchImpl });
        expect(result).not.toBeNull();
        expect(result!.provider).toBe('ollama');
        expect(result!.model).toBe('nomic-embed-text');
        expect(result!.vector).toEqual([0.1, 0.2, 0.3]);
    });

    it('returns null when the server errors', async () => {
        const result = await generateEmbedding('hello', { provider: 'ollama' }, { fetchImpl: fakeFetchFail() });
        expect(result).toBeNull();
    });

    it('respects custom endpoint + model', async () => {
        const fetchImpl = vi.fn(async (url: any) => {
            expect(String(url)).toContain('https://my-ollama');
            return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
        }) as unknown as typeof fetch;
        await generateEmbedding('x', {
            provider: 'ollama',
            endpoint: 'https://my-ollama/',
            model: 'custom-embed',
        }, { fetchImpl });
        expect(fetchImpl).toHaveBeenCalled();
    });
});

describe('generateEmbedding — OpenAI', () => {
    it('parses the OpenAI embeddings response shape', async () => {
        const fetchImpl = fakeFetchOpenAi([0.5, 0.6, 0.7]);
        const result = await generateEmbedding('hello', {
            provider: 'openai',
            apiKey: 'sk-fake',
        }, { fetchImpl });
        expect(result).not.toBeNull();
        expect(result!.provider).toBe('openai');
        expect(result!.model).toBe('text-embedding-3-small');
        expect(result!.vector).toEqual([0.5, 0.6, 0.7]);
    });

    it('includes the Authorization header when an apiKey is supplied', async () => {
        const fetchImpl = vi.fn(async (_url: any, init: any) => {
            expect(init?.headers?.Authorization).toBe('Bearer sk-fake');
            return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 });
        }) as unknown as typeof fetch;
        await generateEmbedding('x', { provider: 'openai', apiKey: 'sk-fake' }, { fetchImpl });
        expect(fetchImpl).toHaveBeenCalled();
    });

    it('returns null on empty vector response', async () => {
        const fetchImpl = fakeFetchOpenAi([]);
        const result = await generateEmbedding('x', { provider: 'openai', apiKey: 'k' }, { fetchImpl });
        expect(result).toBeNull();
    });
});

describe('generateEmbedding — guards', () => {
    it('returns null for disabled provider', async () => {
        const result = await generateEmbedding('x', { provider: 'disabled' });
        expect(result).toBeNull();
    });

    it('returns null for empty input', async () => {
        const result = await generateEmbedding('', { provider: 'ollama' }, { fetchImpl: fakeFetchOllama([1]) });
        expect(result).toBeNull();
    });

    it('returns null for whitespace-only input', async () => {
        const result = await generateEmbedding('   \n  ', { provider: 'ollama' }, { fetchImpl: fakeFetchOllama([1]) });
        expect(result).toBeNull();
    });
});

describe('topKNearest', () => {
    it('returns the k highest-score entries in descending order', () => {
        const query = [1, 0, 0];
        const corpus = [
            { id: 'a', vector: [1, 0, 0] },     // score 1
            { id: 'b', vector: [0.9, 0.1, 0] }, // score ~0.99
            { id: 'c', vector: [0, 1, 0] },     // score 0
            { id: 'd', vector: [-1, 0, 0] },    // score -1
        ];
        const result = topKNearest(query, corpus, 2);
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('a');
        expect(result[1].id).toBe('b');
        expect(result[0].score).toBeGreaterThan(result[1].score);
    });

    it('returns empty for empty corpus or k=0', () => {
        expect(topKNearest([1], [], 5)).toEqual([]);
        expect(topKNearest([1], [{ id: 'a', vector: [1] }], 0)).toEqual([]);
    });

    it('skips entries with mismatched dimensionality (NaN score)', () => {
        const query = [1, 0];
        const corpus = [
            { id: 'a', vector: [1, 0] },
            { id: 'b', vector: [1, 0, 0] }, // wrong dim → NaN → skipped
        ];
        const result = topKNearest(query, corpus, 5);
        expect(result.map(r => r.id)).toEqual(['a']);
    });
});
