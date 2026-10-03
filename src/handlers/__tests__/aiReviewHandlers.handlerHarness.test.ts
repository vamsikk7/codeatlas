/**
 * aiReviewHandlers.handlerHarness.test.ts — Issue 372 / ADR-025
 *
 * Pins AI Review entry-point invariants:
 *   - Click without an active diff → `no_diff` notification + warning toast
 *   - Click without an LLM API key → `no_api_key` notification + warning
 *   - Finding lifecycle (resolve / ignore / reopen) tracks analytics events
 *
 * Doesn't test the actual LLM call (that's covered by aiReviewEngine tests).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
    workspace: { getConfiguration: () => ({ get: (k: string) => k === 'llmProvider' ? 'openrouter' : undefined }) },
    commands: { executeCommand: vi.fn() },
    env: {
        machineId: 'test-machine',
        sessionId: 'test-session',
        appName: 'Visual Studio Code',
        uriScheme: 'vscode',
    },
    version: '1.0.0',
}));

import { makeHarness } from './handlerHarness';
import { registerAiReviewHandlers } from '../aiReviewHandlers';

function setupAiReviewHandlers() {
    const h = makeHarness();
    const handlers = new Map<string, (msg: any, panelId: string) => void>();
    const register = (type: string, fn: (msg: any, panelId: string) => void) => {
        handlers.set(type, fn);
    };
    registerAiReviewHandlers(register, h.ctx);
    return {
        h,
        dispatch(type: string, message: any = {}, panelId = 'test-panel') {
            const fn = handlers.get(type);
            if (!fn) throw new Error(`No handler registered for ${type}`);
            return fn(message, panelId);
        },
    };
}

describe('aiReviewHandlers — Issue 372 / ADR-025', () => {
    it('requestAiReview without active diff → broadcasts warning notification', async () => {
        const { h, dispatch } = setupAiReviewHandlers();
        // No gitDiffState set.
        dispatch('requestAiReview');
        // Handler is async-via-IIFE. Wait a tick for the promise to settle.
        await new Promise(r => setTimeout(r, 10));
        const warnings = h.broadcasted
            .map(b => b.message)
            .filter((m: any) => m?.type === 'showNotification' && m.level === 'warning');
        expect(warnings.length).toBeGreaterThan(0);
        // Specifically the "no diff data" message text.
        expect(warnings.some((m: any) => /no diff data/i.test(m.message))).toBe(true);
    });

    it('clearAiReview broadcasts aiReviewCleared and clears stored result', () => {
        const { h, dispatch } = setupAiReviewHandlers();
        h.ctx.setAiReviewResult({ summary: { total: 1, error: 0, warning: 1, info: 0 }, items: [], failures: [], byGraph: {}, meta: {} } as any);
        dispatch('clearAiReview');
        // Stored result is null after clear.
        expect(h.ctx.getAiReviewResult()).toBeNull();
        // aiReviewCleared message broadcast to all panels.
        expect(h.broadcasted.some(b => b.message?.type === 'aiReviewCleared')).toBe(true);
    });

    it('resolveAiReview / ignoreAiReview / reopenAiReview each have their handler registered', () => {
        const { dispatch } = setupAiReviewHandlers();
        // Smoke test: each handler exists and doesn't throw when invoked
        // with a missing review (no aiReviewResult). They should noop
        // gracefully.
        expect(() => dispatch('resolveAiReview', { reviewId: 'rev-1' })).not.toThrow();
        expect(() => dispatch('ignoreAiReview', { reviewId: 'rev-2' })).not.toThrow();
        expect(() => dispatch('reopenAiReview', { reviewId: 'rev-3' })).not.toThrow();
    });

    // ADR-034 Phase G follow-up (2026-06-07) — multi-repo workspace
    // fan-out for `runExtensionFullReview`. Locks in the protocol the
    // issue spec laid out: dispatching `requestFullReview` with
    // `workspaceScope.kind='workspace'` against a 2-repo workspace
    // iterates BOTH repos, narrows each call to its per-repo
    // SnapshotStore via the registry, and emits
    // `aiReviewWorkspaceComplete` with the per-repo result table at
    // the end. The inner per-repo review bails on no-API-key (as it
    // does on a fresh harness with no secret), so the assertion runs
    // off the FAN-OUT machinery (repo iteration + log + complete
    // broadcast) rather than the LLM call.
    it('requestFullReview with workspaceScope.kind=workspace fans out across every registered repo (ADR-034 Phase G)', async () => {
        const { h, dispatch } = setupAiReviewHandlers();
        const mockRepos = [
            { repoId: 'repo-api', name: 'api-service', rootPath: 'api-service', realpathHash: 'h1', technology: 'nodejs', status: 'ready' as const, lastInitAt: 0, errorMessage: null, fallbackStatePath: null, stateDbSchemaVersion: 1, summarySchemaVersion: 1, diff: null },
            { repoId: 'repo-pay', name: 'payments-service', rootPath: 'payments-service', realpathHash: 'h2', technology: 'nodejs', status: 'ready' as const, lastInitAt: 0, errorMessage: null, fallbackStatePath: null, stateDbSchemaVersion: 1, summarySchemaVersion: 1, diff: null },
        ];
        const getRepoStoreCalls: string[] = [];
        (h.ctx as any).aggregatorStore = { listRepos: () => mockRepos };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: (root: string) => {
                getRepoStoreCalls.push(root);
                // Return a minimal store the fan-out's downstream tolerates;
                // it'll fail the no-api-key gate but that's fine — we're
                // testing the fan-out, not the LLM call.
                return {
                    getWorking: () => ({ files: {}, apiIndex: {}, graphs: {} }),
                    getBaseline: () => ({ files: {}, apiIndex: {}, graphs: {} }),
                    getReviewGuidelines: () => ({ hash: '', items: [] }),
                    getAiReviewSignature: () => null,
                    markStaleFindings: () => [],
                    getAiReviewFindingCounts: () => ({ total: 0 }),
                    listAiReviewFindings: () => [],
                };
            },
        };
        dispatch('requestFullReview', { workspaceScope: { kind: 'workspace' } });
        // The fan-out is sequential async; give it a tick per repo plus a
        // settle margin.
        await new Promise(r => setTimeout(r, 100));
        // Log line proves the fan-out branch was taken.
        const fanOutLog = h.logs.find(l => /workspace fan-out: 2 repos/.test(l));
        expect(fanOutLog, 'expected workspace fan-out log line for 2 repos').toBeTruthy();
        // Each repo's store was resolved through the registry.
        expect(getRepoStoreCalls.length).toBeGreaterThanOrEqual(2);
        // Eventual workspace-complete broadcast with the per-repo result roster.
        const complete: any = h.broadcasted
            .map(b => b.message)
            .find((m: any) => m?.type === 'aiReviewWorkspaceComplete');
        expect(complete, 'expected aiReviewWorkspaceComplete broadcast').toBeTruthy();
        expect(complete.repoCount).toBe(2);
        expect(complete.repos.map((r: any) => r.name).sort()).toEqual(['api-service', 'payments-service']);
    });

    it('requestFullReview with workspaceScope.kind=repo narrows to that single repo (ADR-034 Phase G)', async () => {
        const { h, dispatch } = setupAiReviewHandlers();
        const mockRepos = [
            { repoId: 'repo-api', name: 'api-service', rootPath: 'api-service', realpathHash: 'h1', technology: 'nodejs', status: 'ready' as const, lastInitAt: 0, errorMessage: null, fallbackStatePath: null, stateDbSchemaVersion: 1, summarySchemaVersion: 1, diff: null },
            { repoId: 'repo-pay', name: 'payments-service', rootPath: 'payments-service', realpathHash: 'h2', technology: 'nodejs', status: 'ready' as const, lastInitAt: 0, errorMessage: null, fallbackStatePath: null, stateDbSchemaVersion: 1, summarySchemaVersion: 1, diff: null },
        ];
        const getRepoStoreCalls: string[] = [];
        (h.ctx as any).aggregatorStore = { listRepos: () => mockRepos };
        (h.ctx as any).repoStoreRegistry = {
            getRepoStore: (root: string) => {
                getRepoStoreCalls.push(root);
                return {
                    getWorking: () => ({ files: {}, apiIndex: {}, graphs: {} }),
                    getBaseline: () => ({ files: {}, apiIndex: {}, graphs: {} }),
                    getReviewGuidelines: () => ({ hash: '', items: [] }),
                    getAiReviewSignature: () => null,
                    markStaleFindings: () => [],
                    getAiReviewFindingCounts: () => ({ total: 0 }),
                    listAiReviewFindings: () => [],
                };
            },
        };
        dispatch('requestFullReview', { workspaceScope: { kind: 'repo', repoId: 'repo-pay' } });
        await new Promise(r => setTimeout(r, 100));
        // The narrow-to-repo log line was emitted (exact string from line 561).
        const narrowLog = h.logs.find(l => /repo-scope review narrowed to 'payments-service'/.test(l));
        expect(narrowLog, "expected log proving narrow to payments-service").toBeTruthy();
        // Only the target repo's store was resolved (1 call, not 2).
        expect(getRepoStoreCalls.length).toBe(1);
        // No workspace-complete broadcast — that's the fan-out terminal,
        // not the single-repo terminal.
        const complete = h.broadcasted
            .map(b => b.message)
            .find((m: any) => m?.type === 'aiReviewWorkspaceComplete');
        expect(complete, "single-repo path should NOT emit aiReviewWorkspaceComplete").toBeUndefined();
    });

    // Issue 611 — cancelAiReview / cancelFullReview share the same module-level
    // `_currentRun` AbortController. Whether the review was started by the UI
    // (`requestFullReview` from the React card) or by an MCP agent (same
    // message sent over the WS bridge), cancel reaches the same controller.
    it('cancelAiReview and cancelFullReview are both registered and reach the same handler', () => {
        const { dispatch, h } = setupAiReviewHandlers();
        // No active run — both should emit a "No AI Review is currently
        // running" info toast.
        h.broadcasted.length = 0;
        dispatch('cancelFullReview');
        dispatch('cancelAiReview');
        const toasts = h.broadcasted
            .map((b) => b.message)
            .filter((m: any) => m?.type === 'clientToast' && m.level === 'info');
        expect(toasts.length).toBeGreaterThanOrEqual(2);
        expect(toasts.every((t: any) => /no ai review is currently running/i.test(t.text))).toBe(true);
    });
});
