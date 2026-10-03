/**
 * gitDiffHandlers.ts
 *
 * Issues #173, #174, #194: Git diff message handlers extracted from extension.ts.
 * Handles requestGitDiff, commitSelected, prSelected, requestBranchDiff,
 * branchSelected, clearGitDiff, and connectGitHub.
 *
 * Most heavy lifting is still in the top-level functions in extension.ts
 * (handleRequestGitDiff, handleCommitSelected, etc.). These handlers are
 * thin wrappers that delegate via ctx callbacks with consistent error handling.
 */

import * as vscode from 'vscode';
import type { HandlerContext, MessageHandler } from './handlerContext';
import { withErrorHandling } from './handlerContext';
import { analytics } from '../analytics/mixpanelService';

/**
 * Register all git-diff-related message handlers with the message router.
 *
 * @param register - Function to register a (messageType, handler, module) triple
 * @param ctx - Shared handler context
 */
export function registerGitDiffHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'GitDiffHandlers';
    // #547: every handler here delegates to `ctx.handle*GitDiff*` callbacks
    // that are wired in extension.ts (they reach into VS Code's
    // SourceControlProvider + extension-only state slots). Standalone runs
    // its own git diff implementation in `src/standalone/gitDiff.ts` via the
    // messageHandler switch. Skip registration off-extension so we don't
    // null-deref through the (now-optional) callbacks.
    if (!ctx.context) return;

    // ── requestGitDiff ─────────────────────────────────────────────────────
    register('requestGitDiff', (message, sourcePanelId) => {
        analytics.track('git_diff_picker_opened', { source: 'commit' });
        withErrorHandling(ctx, 'requestGitDiff', async () => {
            // UX-63b — forward optional `repoId` to per-repo branch.
            await ctx.handleRequestGitDiff!(sourcePanelId, (message as any).repoId);
        });
    }, MODULE);

    // ── commitSelected ─────────────────────────────────────────────────────
    register('commitSelected', (message, sourcePanelId) => {
        analytics.track('git_diff_started', {
            mode: 'commit',
            base_hash: String(message.baseHash ?? '').slice(0, 7),
            head_hash: String(message.headHash ?? '').slice(0, 7),
        });
        withErrorHandling(ctx, 'commitSelected', async () => {
            await ctx.handleCommitSelected!(sourcePanelId, message.baseHash, message.headHash, (message as any).repoId);
        });
    }, MODULE);

    // ── prSelected ─────────────────────────────────────────────────────────
    register('prSelected', (message, sourcePanelId) => {
        analytics.track('git_diff_started', { mode: 'pr', pr_number: message.prNumber });
        withErrorHandling(ctx, 'prSelected', async () => {
            // UX-63d — forward optional `repoId` to per-repo branch.
            await ctx.handlePrSelected!(sourcePanelId, message.prNumber, (message as any).repoId);
        });
    }, MODULE);

    // ── requestBranchDiff ──────────────────────────────────────────────────
    register('requestBranchDiff', (message, sourcePanelId) => {
        analytics.track('git_diff_picker_opened', { source: 'branch' });
        withErrorHandling(ctx, 'requestBranchDiff', async () => {
            // UX-63c — forward optional `repoId` to per-repo branch.
            await ctx.handleRequestBranchDiff!(sourcePanelId, (message as any).repoId);
        });
    }, MODULE);

    // ── branchSelected ─────────────────────────────────────────────────────
    register('branchSelected', (message, sourcePanelId) => {
        analytics.track('git_diff_started', { mode: 'branch', branch_name: String(message.branchName ?? '').slice(0, 80) });
        withErrorHandling(ctx, 'branchSelected', async () => {
            await ctx.handleBranchSelected!(sourcePanelId, message.branchName, (message as any).repoId);
        });
    }, MODULE);

    // ── clearGitDiff ───────────────────────────────────────────────────────
    register('clearGitDiff', () => {
        try {
            analytics.track('git_diff_cleared');
            ctx.handleClearGitDiff!();
        } catch (err: any) {
            const message = err?.message ?? String(err);
            ctx.log(`[${MODULE}] clearGitDiff error: ${message}`);
            ctx.notifyBrowser('error', `clearGitDiff failed: ${message.slice(0, 150)}`);
        }
    }, MODULE);

    // ── connectGitHub ──────────────────────────────────────────────────────
    // Browser sends this message as a fallback when the URI-scheme redirect
    // (`${editorUriScheme}://${extensionId}/connect-github`) fails to fire —
    // e.g., the user's OS doesn't have a handler registered for that scheme.
    // The URI handler is the primary path because opening the deep link
    // focuses the editor before the auth dialog appears. Both paths converge
    // on `performGitHubConnect`, which is idempotent (in-flight guard).
    register('connectGitHub', () => {
        void ctx.performGitHubConnect!('ws_message');
    }, MODULE);
}
