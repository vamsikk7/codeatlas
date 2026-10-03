import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeAiReview, clearReviewCache } from '../aiReviewEngine';
import type { DiagramGraph } from '../../graph/graphTypes';

// Mock openRouterClient
vi.mock('../openRouterClient', () => ({
    sendOpenRouterRequest: vi.fn(),
}));

// Mock llmNamingService (redactSecrets)
vi.mock('../llmNamingService', () => ({
    redactSecrets: (text: string) => text,
}));

import { sendOpenRouterRequest } from '../openRouterClient';

const mockSend = sendOpenRouterRequest as ReturnType<typeof vi.fn>;

function makeGraph(graphId: string, type: string, nodes: any[], edges: any[] = []): DiagramGraph {
    return {
        graphId,
        type: type as any,
        nodes,
        edges,
        anchors: {},
        meta: {},
    };
}

const baseConfig = {
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 5000,
    provider: 'openrouter',
};

describe('aiReviewEngine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearReviewCache();
    });

    it('returns empty result when no changed nodes exist', async () => {
        const graphs = {
            'file:src/app.ts': makeGraph('file:src/app.ts', 'file', [
                { id: 'n1', type: 'function', label: 'main', diff: 'unchanged' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(0);
        expect(result.summary.total).toBe(0);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends changed nodes to LLM and parses response', async () => {
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n1', severity: 'warning', title: 'Missing error handling', body: 'Add try-catch', category: 'code-quality' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/app.ts': makeGraph('file:src/app.ts', 'file', [
                { id: 'n1', type: 'function', label: 'main', diff: 'modified', body: 'function main() {}', anchor: { filePath: 'src/app.ts', symbol: 'main' } },
                { id: 'n2', type: 'import', label: 'lodash', diff: 'unchanged' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].severity).toBe('warning');
        expect(result.items[0].title).toBe('Missing error handling');
        expect(result.items[0].graphId).toBe('file:src/app.ts');
        expect(result.items[0].targetId).toBe('n1');
        expect(result.items[0].anchor).toEqual({ filePath: 'src/app.ts', symbol: 'main' });
        expect(result.items[0].status).toBe('open');
        expect(result.summary.warning).toBe(1);
        expect(result.summary.total).toBe(1);
        expect(result.meta.totalTokens).toBe(150);
    });

    it('groups nodes by layer and sends separate batches', async () => {
        mockSend.mockResolvedValue({
            text: '[]',
            model: 'test-model',
            usage: { prompt_tokens: 50, completion_tokens: 10 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
            'flow:src/a.ts:fn1': makeGraph('flow:src/a.ts:fn1', 'flow', [
                { id: 'n2', type: 'block', label: 'if block', diff: 'modified' },
            ]),
            'sequence:src/a.ts:handler': makeGraph('sequence:src/a.ts:handler', 'sequence', [
                { id: 'n3', type: 'participant', label: 'service', diff: 'added' },
            ]),
        };

        await executeAiReview(baseConfig, graphs);
        // 3 graphs with changed nodes → 3 batches (one per graph since each has <15 nodes)
        expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('caches results by key', async () => {
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n1', severity: 'info', title: 'Suggestion', body: 'Consider...', category: 'code-quality' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
        };

        const r1 = await executeAiReview(baseConfig, graphs, 'abc:def');
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(r1.items).toHaveLength(1);

        // Second call with same cache key should not trigger LLM
        const r2 = await executeAiReview(baseConfig, graphs, 'abc:def');
        expect(mockSend).toHaveBeenCalledTimes(1); // no additional call
        expect(r2.items).toHaveLength(1);
    });

    it('filters invalid nodeIds from LLM response', async () => {
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n1', severity: 'error', title: 'Real issue', body: 'Fix it', category: 'security' },
                { nodeId: 'FAKE_ID', severity: 'error', title: 'Hallucinated', body: 'Not real', category: 'security' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].targetId).toBe('n1');
    });

    it('handles LLM errors gracefully', async () => {
        mockSend.mockRejectedValueOnce(new Error('Rate limited'));

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(0);
        expect(result.summary.total).toBe(0);
    });

    it('handles malformed JSON response', async () => {
        mockSend.mockResolvedValueOnce({
            text: 'This is not JSON at all',
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(0);
    });

    it('parses JSON from markdown fenced response', async () => {
        mockSend.mockResolvedValueOnce({
            text: '```json\n[{"nodeId":"n1","severity":"info","title":"Tip","body":"Nice","category":"performance"}]\n```',
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].title).toBe('Tip');
    });

    it('defaults invalid severity to info', async () => {
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n1', severity: 'critical', title: 'Bad severity', body: 'Test', category: 'code-quality' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items[0].severity).toBe('info');
    });

    it('respects maxNodes option', async () => {
        mockSend.mockResolvedValue({
            text: '[]',
            model: 'test-model',
            usage: { prompt_tokens: 50, completion_tokens: 10 },
        });

        // Create a graph with 5 changed nodes
        const nodes = Array.from({ length: 5 }, (_, i) => ({
            id: `n${i}`, type: 'function', label: `fn${i}`, diff: 'modified',
        }));

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', nodes),
        };

        await executeAiReview(baseConfig, graphs, undefined, { maxNodes: 2 });
        // Should have sent 1 batch with only 2 nodes
        expect(mockSend).toHaveBeenCalledTimes(1);
        const userMsg = (mockSend.mock.calls[0][1] as any[])[1].content as string;
        // Count "### Node:" occurrences — should be 2
        const nodeCount = (userMsg.match(/### Node:/g) || []).length;
        expect(nodeCount).toBe(2);
    });

    it('builds byGraph index correctly', async () => {
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n1', severity: 'warning', title: 'Issue A', body: 'Fix', category: 'code-quality' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n2', severity: 'error', title: 'Issue B', body: 'Fix', category: 'security' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
            'flow:src/b.ts:fn2': makeGraph('flow:src/b.ts:fn2', 'flow', [
                { id: 'n2', type: 'block', label: 'if block', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.byGraph['file:src/a.ts']).toHaveLength(1);
        expect(result.byGraph['flow:src/b.ts:fn2']).toHaveLength(1);
        expect(result.summary.warning).toBe(1);
        expect(result.summary.error).toBe(1);
        expect(result.summary.total).toBe(2);
    });

    it('calls onProgress callback per batch', async () => {
        mockSend.mockResolvedValue({
            text: '[]',
            model: 'test-model',
            usage: { prompt_tokens: 50, completion_tokens: 10 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
        };

        const onProgress = vi.fn();
        await executeAiReview(baseConfig, graphs, undefined, { onProgress });
        // Initial "Reviewing N nodes..." + 1 batch completion
        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress.mock.calls[0][0]).toContain('changed nodes');
        expect(onProgress.mock.calls[1][0]).toContain('L4');
    });

    it('skips health and unknown graph types', async () => {
        const graphs = {
            'health:report': makeGraph('health:report', 'health', [
                { id: 'n1', type: 'metric', label: 'dead code', diff: 'modified' },
            ]),
            'unknown:thing': makeGraph('unknown:thing', 'other' as any, [
                { id: 'n2', type: 'node', label: 'thing', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(0);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('all items default to status open', async () => {
        mockSend.mockResolvedValueOnce({
            text: JSON.stringify([
                { nodeId: 'n1', severity: 'error', title: 'Bug', body: 'Fix', category: 'logic-bug' },
                { nodeId: 'n2', severity: 'info', title: 'Tip', body: 'Nice', category: 'performance' },
            ]),
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 50 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
                { id: 'n2', type: 'function', label: 'fn2', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.items).toHaveLength(2);
        expect(result.items.every(i => i.status === 'open')).toBe(true);
    });

    it('truncates long body and diffDetail text', async () => {
        mockSend.mockResolvedValueOnce({
            text: '[]',
            model: 'test-model',
            usage: { prompt_tokens: 100, completion_tokens: 10 },
        });

        const longBody = 'x'.repeat(500);
        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified', body: longBody },
            ]),
        };

        await executeAiReview(baseConfig, graphs);
        const userMsg = (mockSend.mock.calls[0][1] as any[])[1].content as string;
        // Body should be truncated (200 chars max + ellipsis), not the full 500 chars
        expect(userMsg).not.toContain(longBody);
        expect(userMsg).toContain('\u2026'); // truncation ellipsis
    });

    // ── Retry logic ───────────────────────────────────────────────────────────

    it('retries on transient errors then succeeds', async () => {
        // First call fails with 429, second succeeds
        mockSend
            .mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
            .mockResolvedValueOnce({
                text: JSON.stringify([
                    { nodeId: 'n1', severity: 'warning', title: 'After retry', body: 'OK', category: 'code-quality' },
                ]),
                model: 'test-model',
                usage: { prompt_tokens: 100, completion_tokens: 50 },
            });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(mockSend).toHaveBeenCalledTimes(2); // 1 fail + 1 success
        expect(result.items).toHaveLength(1);
        expect(result.items[0].title).toBe('After retry');
        expect(result.failures).toHaveLength(0);
    });

    it('retries on timeout errors', async () => {
        mockSend
            .mockRejectedValueOnce(new Error('The operation was aborted'))
            .mockResolvedValueOnce({
                text: '[]',
                model: 'test-model',
                usage: { prompt_tokens: 50, completion_tokens: 10 },
            });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(result.failures).toHaveLength(0);
    });

    it('does not retry auth errors (401/403)', async () => {
        mockSend.mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'));

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(mockSend).toHaveBeenCalledTimes(1); // no retry
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].error).toContain('401');
    });

    it('exhausts retries and records failure', async () => {
        // 3 failures (1 initial + 2 retries)
        mockSend
            .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
            .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'))
            .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'));

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(mockSend).toHaveBeenCalledTimes(3); // 1 + 2 retries
        expect(result.items).toHaveLength(0);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].layer).toBe('L4');
    });

    // ── Partial failure ───────────────────────────────────────────────────────

    it('returns partial results when some batches fail', async () => {
        // First batch succeeds, second fails
        mockSend
            .mockResolvedValueOnce({
                text: JSON.stringify([
                    { nodeId: 'n1', severity: 'info', title: 'OK', body: 'Fine', category: 'code-quality' },
                ]),
                model: 'test-model',
                usage: { prompt_tokens: 100, completion_tokens: 50 },
            })
            .mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'));

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
            'flow:src/b.ts:fn2': makeGraph('flow:src/b.ts:fn2', 'flow', [
                { id: 'n2', type: 'block', label: 'block', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        // Should have partial results (1 success) + 1 failure
        expect(result.items).toHaveLength(1);
        expect(result.items[0].title).toBe('OK');
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].layer).toBe('L5');
    });

    // ── Timeout classification ────────────────────────────────────────────────

    it('classifies timeout errors in failures', async () => {
        mockSend
            .mockRejectedValueOnce(new Error('The operation was aborted'))
            .mockRejectedValueOnce(new Error('The operation was aborted'))
            .mockRejectedValueOnce(new Error('The operation was aborted'));

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'modified' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].isTimeout).toBe(true);
        expect(result.failures[0].error).toContain('Timed out');
    });

    // ── Token estimation ──────────────────────────────────────────────────────

    it('estimateTokenUsage returns reasonable estimates', async () => {
        const { estimateTokenUsage } = await import('../aiReviewEngine');
        const est = estimateTokenUsage(10, 2);
        expect(est.inputTokens).toBeGreaterThan(0);
        expect(est.outputTokens).toBeGreaterThan(0);
        expect(est.totalTokens).toBe(est.inputTokens + est.outputTokens);
        // 10 nodes * 100 tokens + 2 batches * 250 fixed = 1500 input
        expect(est.inputTokens).toBe(1500);
    });

    // ── Progress tracking ─────────────────────────────────────────────────────

    it('reports progress with batch counter', async () => {
        mockSend.mockResolvedValue({
            text: '[]',
            model: 'test-model',
            usage: { prompt_tokens: 50, completion_tokens: 10 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
            'flow:src/a.ts:fn1': makeGraph('flow:src/a.ts:fn1', 'flow', [
                { id: 'n2', type: 'block', label: 'block', diff: 'modified' },
            ]),
        };

        const onProgress = vi.fn();
        await executeAiReview(baseConfig, graphs, undefined, { onProgress });
        // Should receive initial progress + one per batch
        expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
        // First call is the initial "Reviewing N nodes..."
        expect(onProgress.mock.calls[0][0]).toContain('changed nodes');
        // Subsequent calls include batch counter
        const batchCall = onProgress.mock.calls.find((c: any[]) => c[0].includes('Batch'));
        expect(batchCall).toBeTruthy();
        // completed and total args should be numbers
        expect(typeof batchCall![1]).toBe('number');
        expect(typeof batchCall![2]).toBe('number');
    });

    // ── Empty failures array ──────────────────────────────────────────────────

    it('returns empty failures array on full success', async () => {
        mockSend.mockResolvedValueOnce({
            text: '[]',
            model: 'test-model',
            usage: { prompt_tokens: 50, completion_tokens: 10 },
        });

        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'added' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.failures).toEqual([]);
    });

    it('empty result also has empty failures array', async () => {
        const graphs = {
            'file:src/a.ts': makeGraph('file:src/a.ts', 'file', [
                { id: 'n1', type: 'function', label: 'fn1', diff: 'unchanged' },
            ]),
        };

        const result = await executeAiReview(baseConfig, graphs);
        expect(result.failures).toEqual([]);
    });
});
