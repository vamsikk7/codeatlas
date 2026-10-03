/**
 * gitDiffHandlers.handlerHarness.test.ts — Issue 372 / ADR-025
 *
 * Pins that each git-diff entry point (commit, PR, branch) routes into
 * the correct ctx callback. The actual handlers in extension.ts do the
 * heavy lifting; these handlers are thin wrappers.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
    commands: { executeCommand: vi.fn() },
    authentication: { getSession: vi.fn(() => Promise.resolve(null)) },
    env: {
        machineId: 'test-machine',
        sessionId: 'test-session',
        appName: 'Visual Studio Code',
        uriScheme: 'vscode',
    },
    version: '1.0.0',
}));

import { makeHarness } from './handlerHarness';
import { registerGitDiffHandlers } from '../gitDiffHandlers';

function setupGitDiffHandlers() {
    const h = makeHarness();
    const handlers = new Map<string, (msg: any, panelId: string) => void>();
    const register = (type: string, fn: (msg: any, panelId: string) => void) => {
        handlers.set(type, fn);
    };
    registerGitDiffHandlers(register, h.ctx);
    return {
        h,
        dispatch(type: string, message: any = {}, panelId = 'test-panel') {
            const fn = handlers.get(type);
            if (!fn) throw new Error(`No handler registered for ${type}`);
            return fn(message, panelId);
        },
    };
}

describe('gitDiffHandlers — Issue 372 / ADR-025', () => {
    // UX-63 (2026-06-09) — every git-diff entry point now accepts an
    // optional `repoId` for multi-repo workspaces. When the SPA dispatches
    // the message without one (single-repo, or the workspace-wide diff),
    // the handler still passes `undefined` so the downstream ctx callback
    // sees the canonical 3-arg signature.
    it('commitSelected routes into ctx.handleCommitSelected with the right hashes', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('commitSelected', { baseHash: 'a'.repeat(40), headHash: 'b'.repeat(40) }, 'panel-1');
        expect(h.ctx.handleCommitSelected).toHaveBeenCalledWith('panel-1', 'a'.repeat(40), 'b'.repeat(40), undefined);
    });

    it('commitSelected threads `repoId` through when provided', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('commitSelected', { baseHash: 'a'.repeat(40), headHash: 'b'.repeat(40), repoId: 'api-svc' }, 'panel-1');
        expect(h.ctx.handleCommitSelected).toHaveBeenCalledWith('panel-1', 'a'.repeat(40), 'b'.repeat(40), 'api-svc');
    });

    it('prSelected routes into ctx.handlePrSelected with the right PR number', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('prSelected', { prNumber: 42 }, 'panel-1');
        expect(h.ctx.handlePrSelected).toHaveBeenCalledWith('panel-1', 42, undefined);
    });

    it('prSelected threads `repoId` through when provided', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('prSelected', { prNumber: 42, repoId: 'web-svc' }, 'panel-1');
        expect(h.ctx.handlePrSelected).toHaveBeenCalledWith('panel-1', 42, 'web-svc');
    });

    it('branchSelected routes into ctx.handleBranchSelected', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('branchSelected', { branchName: 'feature/foo' }, 'panel-1');
        expect(h.ctx.handleBranchSelected).toHaveBeenCalledWith('panel-1', 'feature/foo', undefined);
    });

    it('branchSelected threads `repoId` through when provided', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('branchSelected', { branchName: 'feature/foo', repoId: 'payments-svc' }, 'panel-1');
        expect(h.ctx.handleBranchSelected).toHaveBeenCalledWith('panel-1', 'feature/foo', 'payments-svc');
    });

    it('clearGitDiff calls ctx.handleClearGitDiff', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        dispatch('clearGitDiff');
        expect(h.ctx.handleClearGitDiff).toHaveBeenCalled();
    });

    it('connectGitHub delegates to ctx.performGitHubConnect', () => {
        const { h, dispatch } = setupGitDiffHandlers();
        // Handler is now a thin wrapper that delegates so the URI handler
        // and the WS message converge on the same flow with an in-flight guard.
        dispatch('connectGitHub');
        expect(h.ctx.performGitHubConnect).toHaveBeenCalledWith('ws_message');
    });
});
