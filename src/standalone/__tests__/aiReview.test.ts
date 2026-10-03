/**
 * aiReview.test.ts — standalone AI Review entry point.
 *
 * Covers the four failure modes the user can hit:
 *   - No working changes to review → warning toast (no LLM call).
 *   - No API key configured → error toast (no LLM call).
 *   - Concurrent invocation → "already in progress" toast.
 *   - LLM failure → error toast surfaces the message.
 *
 * Plus the happy path: progress broadcasts + aiReviewResult fires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAiReview, clearAiReview, createAiReviewState } from '../aiReview';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { WsBridge } from '../../server/wsBridge';
import type { SettingsResolver } from '../settings';
import type { SecretsStore } from '../secrets';

// Hoisted vi.mock — replaces the real engine + diff bundle so we don't hit
// the network and can deterministically simulate result shapes.
vi.mock('../../handlers/replayWorkingChanges', () => ({
    workingDiffersFromBaseline: vi.fn(),
    buildWorkingDiffBundle: vi.fn(() => ({
        'sequence:src/a.ts:handler': {
            graphId: 'sequence:src/a.ts:handler', type: 'sequence',
            nodes: [{ id: 'n1', type: 'participant', diff: 'modified' }],
            edges: [], anchors: {}, meta: {},
        },
    })),
}));
vi.mock('../../core/llm/aiReviewEngine', () => ({
    executeAiReview: vi.fn(),
    isTimeoutError: vi.fn(() => false),
}));

import { workingDiffersFromBaseline, buildWorkingDiffBundle } from '../../handlers/replayWorkingChanges';
import { executeAiReview, isTimeoutError } from '../../core/llm/aiReviewEngine';

function mkDeps() {
    const broadcasts: any[] = [];
    const wsBridge = { broadcast: vi.fn((m) => broadcasts.push(m)) } as unknown as WsBridge;
    const snapshotStore = {
        getBaseline: () => ({ files: {}, graphs: {}, apiIndex: {} }),
        getWorking: () => ({ files: {}, graphs: {}, apiIndex: {} }),
    } as unknown as SnapshotStore;
    const settings = {
        get: vi.fn((key: string) => {
            if (key === 'codeatlas.llmModel') return 'openrouter/free';
            if (key === 'codeatlas.llmProvider') return 'openrouter';
            if (key === 'codeatlas.llmEndpoint') return '';
            return undefined;
        }),
        all: () => ({}),
    } as unknown as SettingsResolver;
    const secrets = {
        get: vi.fn(async () => 'sk-or-test'),
        store: vi.fn(),
        delete: vi.fn(),
    } as unknown as SecretsStore;
    return { broadcasts, wsBridge, snapshotStore, settings, secrets, log: () => {} };
}

describe('runAiReview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (workingDiffersFromBaseline as any).mockReturnValue(true);
        // `vi.clearAllMocks` clears call history but keeps `mockReturnValue` —
        // reset isTimeoutError so a previous test that flagged a timeout
        // doesn't bleed into the next.
        (isTimeoutError as any).mockReturnValue(false);
    });

    it('warns + skips when there are no working changes', async () => {
        const d = mkDeps();
        (workingDiffersFromBaseline as any).mockReturnValue(false);
        const state = createAiReviewState();
        await runAiReview(d, state);

        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('warning');
        expect(toast?.text).toContain('No working changes');
        expect(executeAiReview).not.toHaveBeenCalled();
        // loading toggled on then off
        const loadings = d.broadcasts.filter(m => m.type === 'aiReviewLoading').map(m => m.loading);
        expect(loadings).toEqual([true, false]);
    });

    it('errors + skips when no API key for hosted provider', async () => {
        const d = mkDeps();
        (d.secrets.get as any).mockResolvedValue(undefined);
        await runAiReview(d, createAiReviewState());
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        // The toast surfaces the env-var name appropriate to the provider.
        expect(toast?.text).toContain('API key');
        expect(executeAiReview).not.toHaveBeenCalled();
    });

    it('runs without an API key when provider=ollama (local LLM)', async () => {
        const d = mkDeps();
        (d.secrets.get as any).mockResolvedValue(undefined);
        (d.settings.get as any).mockImplementation((key: string) => {
            if (key === 'codeatlas.llmProvider') return 'ollama';
            if (key === 'codeatlas.llmModel') return 'llama3:8b';
            if (key === 'codeatlas.llmEndpoint') return 'http://localhost:11434';
            return undefined;
        });
        (executeAiReview as any).mockResolvedValue({
            summary: { total: 0, error: 0, warning: 0, info: 0 }, failures: [], meta: { durationMs: 10, totalTokens: 0 }, findings: [],
        });
        await runAiReview(d, createAiReviewState());
        expect(executeAiReview).toHaveBeenCalledTimes(1);
        const cfg = (executeAiReview as any).mock.calls[0][0];
        expect(cfg.provider).toBe('ollama');
        expect(cfg.endpoint).toBe('http://localhost:11434');
        // Local providers get the extended timeout (cold-start tolerance).
        expect(cfg.timeoutMs).toBeGreaterThanOrEqual(120_000);
    });

    it('passes the apiKey + endpoint through for anthropic / custom providers', async () => {
        const d = mkDeps();
        (d.settings.get as any).mockImplementation((key: string) => {
            if (key === 'codeatlas.llmProvider') return 'anthropic';
            if (key === 'codeatlas.llmModel') return 'claude-3-5-sonnet';
            if (key === 'codeatlas.llmEndpoint') return undefined;
            return undefined;
        });
        (d.secrets.get as any).mockResolvedValue('sk-ant-test');
        (executeAiReview as any).mockResolvedValue({
            summary: { total: 0, error: 0, warning: 0, info: 0 }, failures: [], meta: { durationMs: 10, totalTokens: 0 }, findings: [],
        });
        await runAiReview(d, createAiReviewState());
        const cfg = (executeAiReview as any).mock.calls[0][0];
        expect(cfg.provider).toBe('anthropic');
        expect(cfg.model).toBe('claude-3-5-sonnet');
        expect(cfg.apiKey).toBe('sk-ant-test');
    });

    it('refuses provider=custom when no endpoint is configured', async () => {
        const d = mkDeps();
        (d.settings.get as any).mockImplementation((key: string) => {
            if (key === 'codeatlas.llmProvider') return 'custom';
            if (key === 'codeatlas.llmEndpoint') return '';
            return undefined;
        });
        await runAiReview(d, createAiReviewState());
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('llmEndpoint');
        expect(executeAiReview).not.toHaveBeenCalled();
    });

    it('timeout toast reports the local-LLM limit (180s) when provider=ollama', async () => {
        const d = mkDeps();
        (d.settings.get as any).mockImplementation((key: string) => {
            if (key === 'codeatlas.llmProvider') return 'ollama';
            if (key === 'codeatlas.llmEndpoint') return 'http://localhost:11434';
            return undefined;
        });
        (d.secrets.get as any).mockResolvedValue('');
        (executeAiReview as any).mockRejectedValue(new Error('aborted'));
        (isTimeoutError as any).mockReturnValue(true);
        await runAiReview(d, createAiReviewState());
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.text).toContain('180s');
    });

    it('refuses to run a second time while in flight', async () => {
        const d = mkDeps();
        const state = createAiReviewState();
        state.inFlight = true;
        await runAiReview(d, state);
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('info');
        expect(toast?.text).toContain('already in progress');
        expect(executeAiReview).not.toHaveBeenCalled();
    });

    it('happy path — broadcasts aiReviewResult + saves into state', async () => {
        const d = mkDeps();
        const fakeResult: any = {
            summary: { total: 3, error: 1, warning: 1, info: 1 },
            failures: [],
            meta: { durationMs: 200, totalTokens: 1234 },
            findings: [],
        };
        (executeAiReview as any).mockResolvedValue(fakeResult);

        const state = createAiReviewState();
        await runAiReview(d, state);

        expect(executeAiReview).toHaveBeenCalledTimes(1);
        const config = (executeAiReview as any).mock.calls[0][0];
        expect(config.apiKey).toBe('sk-or-test');
        expect(config.model).toBe('openrouter/free');
        expect(config.provider).toBe('openrouter');

        const result = d.broadcasts.find(m => m.type === 'aiReviewResult');
        expect(result?.result).toBe(fakeResult);
        expect(state.lastResult).toBe(fakeResult);
        expect(state.inFlight, 'inFlight cleared after completion').toBe(false);
    });

    it('forwards onProgress to aiReviewProgress broadcasts', async () => {
        const d = mkDeps();
        (executeAiReview as any).mockImplementation(async (_cfg: any, _graphs: any, _cacheKey: any, opts: any) => {
            opts.onProgress('Reviewing batch 1…', 1, 3);
            opts.onProgress('Reviewing batch 2…', 2, 3);
            opts.onProgress('Done', 3, 3);
            return { summary: { total: 0, error: 0, warning: 0, info: 0 }, failures: [], meta: { durationMs: 50, totalTokens: 0 }, findings: [] };
        });

        await runAiReview(d, createAiReviewState());

        const progress = d.broadcasts.filter(m => m.type === 'aiReviewProgress');
        expect(progress).toHaveLength(3);
        expect(progress[1]).toEqual({ type: 'aiReviewProgress', message: 'Reviewing batch 2…', completed: 2, total: 3 });
    });

    it('LLM error → error toast; loading toggled off', async () => {
        const d = mkDeps();
        (executeAiReview as any).mockRejectedValue(new Error('rate limit'));
        await runAiReview(d, createAiReviewState());
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('rate limit');
        const loadings = d.broadcasts.filter(m => m.type === 'aiReviewLoading').map(m => m.loading);
        expect(loadings[loadings.length - 1]).toBe(false);
    });

    it('timeout error → distinct toast wording', async () => {
        const d = mkDeps();
        (executeAiReview as any).mockRejectedValue(new Error('aborted'));
        (isTimeoutError as any).mockReturnValue(true);
        await runAiReview(d, createAiReviewState());
        const toast = d.broadcasts.find(m => m.type === 'clientToast');
        expect(toast?.level).toBe('error');
        expect(toast?.text).toContain('timed out');
    });
});

describe('clearAiReview', () => {
    it('drops state.lastResult + broadcasts aiReviewCleared', () => {
        const d = mkDeps();
        const state = createAiReviewState();
        state.lastResult = { summary: { total: 1 } } as any;
        clearAiReview(d, state);
        expect(state.lastResult).toBeNull();
        expect(d.broadcasts).toEqual([{ type: 'aiReviewCleared' }]);
    });
});
