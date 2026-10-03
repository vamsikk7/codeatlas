/**
 * aiReviewHandlers.ts
 *
 * Issues #173, #174, #194: AI Review message handlers extracted from extension.ts.
 * Handles requestAiReview, clearAiReview, resolveAiReview, ignoreAiReview,
 * and reopenAiReview.
 *
 * Issue #531 (extension parity): also wires requestFullReview /
 * requestSpecificReview / cancelFullReview, plus the home-screen review
 * surfaces (guidelines, evidence gate, findings list/search/update).
 *
 * requestAiReview orchestrates an LLM-powered code review of the current diff,
 * broadcasting progress, results, and errors to all panels and browser clients.
 */

import * as vscode from 'vscode';
import type { HandlerContext, MessageHandler } from './handlerContext';
import { executeAiReview, clearReviewCache, isTimeoutError as isReviewTimeout } from '../core/llm/aiReviewEngine';
import { analytics } from '../analytics/mixpanelService';
import { sendOpenRouterRequest } from '../core/llm/openRouterClient';
import { computeBaselineRef } from '../core/llm/baselineRef';
import { estimateReviewCost, formatEstimate, isBudgetExceeded } from '../core/llm/reviewCostEstimator';
import type { ApiRecord } from '../core/graph/graphTypes';

/**
 * Module-level state for the active full / specific review. Mirrors the
 * standalone — only one run at a time; cancel aborts the in-flight LLM
 * fetch by triggering the controller's signal.
 */
let _currentRun: { controller: AbortController; kind: 'full' | 'specific'; startedAt: number } | null = null;

// JSON extraction + auto-repair lives in `src/core/llm/findingSchema.ts` (Issue #704).
// We delegate so both surfaces (extension handler + standalone server) share
// the same strict / relaxed two-pass parser instead of maintaining two
// hand-rolled copies that drift apart.
import { extractFindingsJson, extractProjectFindingsJson } from '../core/llm/findingSchema';

/**
 * Register all AI-review-related message handlers with the message router.
 *
 * @param register - Function to register a (messageType, handler, module) triple
 * @param ctx - Shared handler context
 */
export function registerAiReviewHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'AiReviewHandlers';
    // #547: extension-only handlers (those that need `vscode.workspace.getConfiguration`
    // or the extension's in-memory `aiReviewResult` slot) are only registered
    // when an `ExtensionContext` is present. On the standalone server those
    // messages are handled by `src/standalone/aiReview.ts` via the
    // messageHandler switch — registering them here would either crash on
    // missing `vscode.*` APIs or stomp the standalone's own implementation.
    const isExtension = !!ctx.context;

    /** Broadcast a message to all webview panels and connected browser clients. */
    function broadcast(msg: any): void {
        ctx.platform.broadcast(msg);
    }

    // ── requestAiReview (extension-only — relies on getGitDiffState + vscode.* + setAiReviewResult) ──
    if (isExtension) register('requestAiReview', (message) => {
        const reviewLoadingOn = { type: 'aiReviewLoading' as const, loading: true, progress: 'Preparing review...' };
        broadcast(reviewLoadingOn);
        analytics.track('ai_review_requested');
        const startedAt = Date.now();

        (async () => {
            try {
                // Determine diff source
                const gitDiffState = ctx.getGitDiffState!((message as any)?.repoId);
                const diffedGraphs = gitDiffState?.diffedGraphs;
                if (!diffedGraphs || Object.keys(diffedGraphs).length === 0) {
                    analytics.track('ai_review_no_diff');
                    analytics.notification('ai_review_no_diff', 'warning');
                    broadcast({
                        type: 'showNotification' as const,
                        level: 'warning' as const,
                        message: 'No diff data available. Compare commits, a PR, or a branch first.',
                    });
                    return;
                }

                // Read LLM config
                const freshCfg = vscode.workspace.getConfiguration('codeatlas');
                const reviewProvider = freshCfg.get<string>('llmProvider') ?? 'openrouter';
                const keyOptional = reviewProvider === 'ollama' || reviewProvider === 'custom';
                const storedKey = await ctx.platform.getSecret('codeatlas.openRouterApiKey') ?? '';
                if (!storedKey && !keyOptional) {
                    analytics.track('ai_review_no_api_key', { provider: reviewProvider });
                    analytics.notification('ai_review_no_api_key', 'warning', { provider: reviewProvider });
                    broadcast({
                        type: 'showNotification' as const,
                        level: 'warning' as const,
                        message: 'No API key configured. Run "CodeAtlas: Set LLM API Key" or switch to Ollama.',
                    });
                    return;
                }

                const isLocal = reviewProvider === 'ollama' || reviewProvider === 'custom';
                const reviewConfig = {
                    apiKey: storedKey,
                    model: freshCfg.get<string>('llmModel') ?? 'openrouter/free',
                    timeoutMs: isLocal ? 120_000 : 30_000,
                    provider: reviewProvider,
                    endpoint: freshCfg.get<string>('llmEndpoint') ?? '',
                    responseFormat: 'json_object' as const,
                    allowCustomEndpointAuth: true, // #885 — user-configured endpoint = consent
                };

                const cacheKey = gitDiffState ? `${gitDiffState.baseHash}:${gitDiffState.headHash}` : undefined;
                const result = await executeAiReview(reviewConfig, diffedGraphs, cacheKey, {
                    onProgress: (msg: string, completed: number, total: number) => {
                        broadcast({
                            type: 'aiReviewLoading' as const,
                            loading: true,
                            progress: `[${completed}/${total}] ${msg}`,
                        });
                    },
                });

                ctx.setAiReviewResult!(result);
                ctx.log(`[AiReview] Done: ${result.summary.total} findings (${result.summary.error}E/${result.summary.warning}W/${result.summary.info}I), ${result.failures.length} failed batches, ${result.meta.durationMs}ms, ${result.meta.totalTokens} tokens`);

                analytics.track('ai_review_completed', {
                    provider: reviewProvider,
                    model: reviewConfig.model,
                    findings_total: result.summary.total,
                    findings_error: result.summary.error,
                    findings_warning: result.summary.warning,
                    findings_info: result.summary.info,
                    failed_batches: result.failures.length,
                    duration_ms: result.meta.durationMs,
                    total_tokens: result.meta.totalTokens,
                    elapsed_ms: Date.now() - startedAt,
                });

                broadcast({ type: 'aiReviewResult' as const, result });

                // Notify based on result state
                if (result.summary.total === 0 && result.failures.length === 0) {
                    broadcast({
                        type: 'showNotification' as const,
                        level: 'info' as const,
                        message: 'AI Review complete — no issues found.',
                    });
                } else if (result.summary.total > 0 && result.failures.length === 0) {
                    broadcast({
                        type: 'showNotification' as const,
                        level: 'info' as const,
                        message: `AI Review complete — ${result.summary.total} finding${result.summary.total > 1 ? 's' : ''} (${result.summary.error}E/${result.summary.warning}W/${result.summary.info}I).`,
                    });
                }
                if (result.failures.length > 0) {
                    const timeoutCount = result.failures.filter(f => f.isTimeout).length;
                    const failMsg = timeoutCount > 0
                        ? `AI Review: ${result.failures.length} batch(es) failed (${timeoutCount} timed out). Try a faster model or smaller diff.`
                        : `AI Review: ${result.failures.length} batch(es) failed. Some layers may have incomplete reviews.`;
                    broadcast({
                        type: 'showNotification' as const,
                        level: 'warning' as const,
                        message: failMsg,
                    });
                }
            } catch (err: any) {
                ctx.log(`[AiReview] Error: ${err?.message ?? err}`);
                // Classify the error for a targeted notification
                const timeout = isReviewTimeout(err);
                analytics.track('ai_review_failed', {
                    is_timeout: timeout,
                    error: (err?.message ?? 'unknown error').slice(0, 200),
                    elapsed_ms: Date.now() - startedAt,
                });
                const userMsg = timeout
                    ? 'AI Review timed out. Try a faster model, a smaller diff, or increase the timeout for local models.'
                    : `AI Review failed: ${(err?.message ?? 'unknown error').slice(0, 100)}`;
                broadcast({
                    type: 'showNotification' as const,
                    level: 'error' as const,
                    message: userMsg,
                });
            } finally {
                broadcast({ type: 'aiReviewLoading' as const, loading: false });
            }
        })();
    }, MODULE);

    // ── clearAiReview (extension-only — uses setAiReviewResult) ────────────
    if (isExtension) register('clearAiReview', () => {
        try {
            ctx.setAiReviewResult!(null);
            clearReviewCache();
            analytics.track('ai_review_cleared');
            broadcast({ type: 'aiReviewCleared' as const });
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] clearAiReview error: ${msg}`);
            ctx.notifyBrowser('error', `clearAiReview failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);

    // ── resolveAiReview / ignoreAiReview / reopenAiReview (extension-only —
    //    older paradigm that mutates `ctx.getAiReviewResult()`; the newer
    //    `updateAiFindingStatus` covers the same intent cross-runtime) ─────
    if (isExtension) {
        register('resolveAiReview', (message) => {
            analytics.track('ai_review_finding_resolved', { review_id: message.reviewId });
            handleReviewStatusChange(ctx, message, 'resolved', MODULE);
        }, MODULE);
        register('ignoreAiReview', (message) => {
            analytics.track('ai_review_finding_ignored', { review_id: message.reviewId });
            handleReviewStatusChange(ctx, message, 'ignored', MODULE);
        }, MODULE);
        register('reopenAiReview', (message) => {
            analytics.track('ai_review_finding_reopened', { review_id: message.reviewId });
            handleReviewStatusChange(ctx, message, 'open', MODULE);
        }, MODULE);
    }

    // ── #531 Full-review orchestrator (cross-runtime as of #547 round 5 —
    //    runExtensionFullReview now reads settings via ctx.platform.getSetting
    //    so it works on both backends). Standalone's `runFullReview` from
    //    `src/standalone/aiReview.ts` is now unused for this message. ──────
    register('requestFullReview', (message) => {
        if (_currentRun) {
            broadcast({ type: 'clientToast' as const, level: 'info', text: 'A review is already in progress. Cancel it first.' });
            return;
        }
        // #606 — `mode` defaults to 'incremental'. The UI exposes a "Full
        // re-review" menu item that sends `mode: 'full'` so the user can
        // force a fresh pass over every entry point (e.g. after editing
        // guidelines or recovering from a bad prior run).
        const mode = message.mode === 'full' ? 'full' : 'incremental';
        // ADR-034 Phase G follow-up — when the typed PickedScope picker
        // emits 'workspace' or 'repo', the webview sets a flat scope='all'
        // alongside `workspaceScope: { kind, repoId? }`. The kind=repo case
        // narrows the upcoming fan-out to that repo's store via
        // `planWorkspaceReview`; the kind=workspace case fans out across
        // every changed repo. Full wiring to `planWorkspaceReview` is a
        // follow-up; logged below so multi-repo users see their selection.
        const workspaceScope = (message as any).workspaceScope as
            | { kind: 'workspace' | 'repo'; repoId?: string } | undefined;
        if (workspaceScope) {
            ctx.log(`[ai-review] requestFullReview workspaceScope=${workspaceScope.kind}${workspaceScope.repoId ? ' repo=' + workspaceScope.repoId : ''}`);
        }
        void runExtensionFullReview(ctx, broadcast, {
            kind: (message.scope as any) ?? 'all',
            clusterId: message.clusterId,
            entryPointId: message.entryPointId,
            workspaceScope,
        }, { mode });
    }, MODULE);

    // ── Issue 608: pre-flight cost estimate. UI shows a confirm modal so
    //    the user sees how much a Start Review will cost BEFORE we burn
    //    LLM credits. Computed locally (no LLM call) — purely from the
    //    apiIndex size + the model's pricing.
    register('requestReviewCostEstimate', (message) => {
        try {
            const apis = Object.values(ctx.snapshotStore.getWorking().apiIndex ?? {}) as any[];
            const scope = (message?.scope ?? 'all') as string;
            const inScope = scope === 'changed'
                ? apis.filter((a) => a.diff && a.diff !== 'unchanged')
                : apis;
            const model = ctx.platform?.getSetting?.<string>('llmModel', 'openrouter/free') ?? 'openrouter/free';
            const provider = ctx.platform?.getSetting?.<string>('llmProvider', 'openrouter');
            const budgetCap = Number(ctx.platform?.getSetting?.<number>('aiReview.maxBudgetUSD', 1.0) ?? 1.0);
            const e = estimateReviewCost({ entryPointCount: inScope.length, model, provider });
            broadcast({
                type: 'reviewCostEstimate' as const,
                entryPointCount: e.entryPointCount,
                estimatedUSD: e.estimatedUSD,
                model: e.model,
                provider,
                pricingIsEstimate: e.pricingIsEstimate,
                budgetCapUSD: budgetCap,
                willExceedCap: budgetCap > 0 && e.estimatedUSD > budgetCap,
                summary: formatEstimate(e),
            });
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Cost estimate failed: ${err?.message ?? err}` });
        }
    }, MODULE);

    // ── #531 Specific (free-form) review (cross-runtime as of round 5) ────
    register('requestSpecificReview', (message) => {
        if (_currentRun) {
            broadcast({ type: 'clientToast' as const, level: 'info', text: 'A review is already in progress. Cancel it first.' });
            return;
        }
        void runExtensionSpecificReview(ctx, broadcast, String(message.prompt ?? ''));
    }, MODULE);

    // ── #531 Cancel any in-flight full / specific review (cross-runtime as
    //    of round 5 — `_currentRun` is module-local to this file and the
    //    request/cancel pair always share the same scope). ────────────────
    const cancelHandler: MessageHandler = () => {
        if (!_currentRun) {
            broadcast({ type: 'clientToast' as const, level: 'info', text: 'No AI Review is currently running.' });
            return;
        }
        _currentRun.controller.abort();
    };
    register('cancelFullReview', cancelHandler, MODULE);
    register('cancelAiReview', cancelHandler, MODULE);

    // Issue (post-#608-UI): when a webview client connects mid-review (page
    // reload, second tab, etc.) it needs to learn about the in-flight run
    // so the Start / Changed / Specific / Guidelines buttons stay disabled
    // and only Cancel renders. The new client posts `requestAiReviewStatus`
    // in its on-mount effect; we reply with `aiReviewStarted` +
    // `aiReviewLoading: true` if a run is active, otherwise emit a
    // negative-acknowledgement so the UI can flip back to idle without
    // ambiguity.
    register('requestAiReviewStatus', () => {
        if (_currentRun) {
            broadcast({
                type: 'aiReviewStarted' as const,
                kind: _currentRun.kind,
                startedAt: _currentRun.startedAt,
            });
            broadcast({ type: 'aiReviewLoading' as const, loading: true, progress: 'Review in progress…' });
        } else {
            broadcast({ type: 'aiReviewLoading' as const, loading: false });
        }
    }, MODULE);

    // ── #505 review guidelines (workspace-wide; per-repo via #813 below) ──
    register('requestReviewGuidelines', (message) => {
        try {
            // #813 (2026-06-10) — pass `repoId` in multi-repo workspaces
            // to fetch the per-repo guidelines instead of the workspace-
            // wide row. Unscoped requests retain pre-#813 semantics.
            const scope = typeof (message as any)?.repoId === 'string' ? (message as any).repoId : undefined;
            const guidelines = ctx.snapshotStore.getReviewGuidelines(scope);
            broadcast({ type: 'reviewGuidelines' as const, guidelines });
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Guidelines load failed: ${err?.message ?? err}` });
        }
    }, MODULE);
    register('saveReviewGuidelines', (message) => {
        try {
            const text = String(message.text ?? '');
            const scope = typeof (message as any)?.repoId === 'string' ? (message as any).repoId : undefined;
            const saved = ctx.snapshotStore.setReviewGuidelines(text, scope);
            broadcast({ type: 'reviewGuidelinesUpdated' as const, guidelines: saved });
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Guidelines save failed: ${err?.message ?? err}` });
        }
    }, MODULE);

    // ── #513 evidence-gate toggle (cross-runtime via ctx.platform.getSetting) ──
    //    Extension routes through `vscode.workspace.getConfiguration` /
    //    `.update(..., ConfigurationTarget.Workspace)`. Standalone routes
    //    through its `SettingsResolver` (env override → file → default).
    //    Both produce the same `evidenceGate { enabled }` broadcast.
    register('requestEvidenceGate', () => {
        const enabled = ctx.platform.getSetting<boolean>('evidenceGateEnabled', true);
        broadcast({ type: 'evidenceGate' as const, enabled: enabled !== false });
    }, MODULE);
    register('setEvidenceGate', (message) => {
        void (async () => {
            try {
                const enabled = !!message.enabled;
                await ctx.platform.setSetting('evidenceGateEnabled', enabled);
                broadcast({ type: 'evidenceGate' as const, enabled });
            } catch (err: any) {
                broadcast({ type: 'clientToast' as const, level: 'error', text: `Toggle failed: ${err?.message ?? err}` });
            }
        })();
    }, MODULE);

    // ── #501 per-entity findings (popover, marker click) ───────────────────
    //    Cross-runtime: snapshotStore.listAiReviewFindingsForEntity is the
    //    same on both backends. Previously standalone-only.
    register('requestAiFindingsForNode', (message) => {
        try {
            const items = ctx.snapshotStore.listAiReviewFindingsForEntity(
                String(message.graphId ?? ''),
                String(message.nodeId ?? ''),
            );
            broadcast({ type: 'aiFindingsForNode' as const, graphId: message.graphId, nodeId: message.nodeId, items });
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Findings for node failed: ${err?.message ?? err}` });
        }
    }, MODULE);

    // ── #501 findings list / search / status update ────────────────────────
    register('requestAiFindings', (message) => {
        try {
            const filter: any = {
                graphId: message.graphId,
                severity: message.severity,
                status: message.status ?? 'open',
                limit: typeof message.limit === 'number' ? message.limit : 500,
            };
            // #547 parity: standalone callers pass entryPointId to narrow
            // findings to a single API row. Pass through when present.
            if (message.entryPointId) filter.entryPointId = String(message.entryPointId);
            const items = ctx.snapshotStore.listAiReviewFindings(filter);
            const counts = ctx.snapshotStore.getAiReviewFindingCounts();
            broadcast({ type: 'aiFindings' as const, items, counts });
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Findings list failed: ${err?.message ?? err}` });
        }
    }, MODULE);
    register('searchAiFindings', (message) => {
        void (async () => {
            try {
                const { searchFindings } = await import('../mcp/aiFindingsSearch');
                const result = searchFindings(ctx.snapshotStore, String(message.query ?? ''), Number(message.limit) || 20);
                broadcast({ type: 'aiFindingsSearchResult' as const, result });
            } catch (err: any) {
                broadcast({ type: 'clientToast' as const, level: 'error', text: `Findings search failed: ${err?.message ?? err}` });
            }
        })();
    }, MODULE);
    register('updateAiFindingStatus', (message) => {
        try {
            // Issue 613: pass through optional `actor` + `note` for the audit trail.
            const updated = ctx.snapshotStore.updateAiReviewFindingStatus(
                String(message.findingId ?? ''),
                message.status,
                { actor: typeof message.actor === 'string' ? message.actor : undefined, note: typeof message.note === 'string' ? message.note : undefined },
            );
            if (updated) {
                const counts = ctx.snapshotStore.getAiReviewFindingCounts();
                broadcast({ type: 'aiFindingUpdated' as const, finding: updated, counts });
            }
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Update failed: ${err?.message ?? err}` });
        }
    }, MODULE);

    // ── #537 Clear findings (optionally scoped) ───────────────────────────
    register('clearFindings', (message) => {
        try {
            const scope = message.scope && (message.scope.entryPointId || message.scope.graphId)
                ? { entryPointId: message.scope.entryPointId, graphId: message.scope.graphId }
                : undefined;
            const removed = ctx.snapshotStore.clearAiReviewFindings(scope);
            try { (ctx.snapshotStore as any).clearAiReviewSignature?.(); } catch { /* #535 may not be wired yet */ }
            broadcast({ type: 'aiFindingsCleared' as const, count: removed, scope: message.scope ?? null });
            const counts = ctx.snapshotStore.getAiReviewFindingCounts();
            const items = ctx.snapshotStore.listAiReviewFindings({ status: 'open' } as any);
            broadcast({ type: 'aiFindings' as const, items, counts });
            broadcast({ type: 'clientToast' as const, level: 'info', text: `Cleared ${removed} finding${removed === 1 ? '' : 's'}.` });
        } catch (err: any) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Clear failed: ${err?.message ?? err}` });
        }
    }, MODULE);
}

/**
 * Extension-side full review. Mirrors `runFullReview` in the standalone
 * but pulls config from `vscode.workspace.getConfiguration` and secrets
 * from the extension context. Emits the same WS event stream the home
 * page's AiReviewControlCard subscribes to.
 */
async function runExtensionFullReview(
    ctxIn: HandlerContext,
    broadcast: (msg: any) => void,
    scope: {
        kind: 'all' | 'changed' | 'cluster' | 'entry';
        clusterId?: string;
        entryPointId?: string;
        /** ADR-034 Phase G — workspace-aware narrowing.
         *  - kind='repo': run the review body against that repo's
         *    SnapshotStore instead of the workspace primary. Findings +
         *    cursors land in the right per-repo store automatically.
         *  - kind='workspace': iterate every registered repo and fan out
         *    via N sequential kind='repo' invocations. Budget is per-repo
         *    (truly-shared aggregate-cap would need a refactor — tracked
         *    in ISSUES.md). Emits an `aiReviewWorkspaceComplete` broadcast
         *    when every repo's review has settled.
         */
        workspaceScope?: { kind: 'workspace' | 'repo'; repoId?: string };
    },
    opts: { mode: 'incremental' | 'full' } = { mode: 'incremental' },
): Promise<void> {
    // ADR-034 Phase G — workspace fan-out. Iterate every registered repo
    // and run an independent kind='repo' review against each. Sequential
    // so per-repo progress broadcasts arrive in deterministic order and
    // the user can cancel mid-fan-out via the existing cancelAiReview
    // path (the active recursive call's AbortController is the live one).
    if (scope.workspaceScope?.kind === 'workspace' && ctxIn.aggregatorStore) {
        const rows = [...ctxIn.aggregatorStore.listRepos()]
            .sort((a, b) => a.rootPath.localeCompare(b.rootPath));
        if (rows.length === 0) {
            broadcast({ type: 'clientToast' as const, level: 'warning', text: 'Workspace review: no repos registered. Aborting.' });
            return;
        }
        ctxIn.log(`[ai-review] workspace fan-out: ${rows.length} repos (sequential)`);
        broadcast({
            type: 'clientToast' as const,
            level: 'info',
            text: `Workspace review: fanning out across ${rows.length} repo${rows.length === 1 ? '' : 's'} sequentially. Budget cap applies per-repo.`,
        });
        const tFanout = Date.now();
        const perRepoResults: Array<{
            repoId: string; name: string; durationMs: number;
            status: 'ok' | 'failed'; error?: string;
        }> = [];
        for (const row of rows) {
            const tRepo = Date.now();
            try {
                await runExtensionFullReview(
                    ctxIn,
                    broadcast,
                    {
                        kind: scope.kind,
                        clusterId: scope.clusterId,
                        entryPointId: scope.entryPointId,
                        workspaceScope: { kind: 'repo', repoId: row.repoId },
                    },
                    opts,
                );
                perRepoResults.push({
                    repoId: row.repoId,
                    name: row.name,
                    durationMs: Date.now() - tRepo,
                    status: 'ok',
                });
            } catch (err: any) {
                const msg = err?.message ?? String(err);
                ctxIn.log(`[ai-review] workspace fan-out: repo ${row.name} failed: ${msg}`);
                perRepoResults.push({
                    repoId: row.repoId,
                    name: row.name,
                    durationMs: Date.now() - tRepo,
                    status: 'failed',
                    error: msg,
                });
            }
        }
        broadcast({
            type: 'aiReviewWorkspaceComplete' as const,
            durationMs: Date.now() - tFanout,
            repoCount: rows.length,
            repos: perRepoResults,
        });
        return;
    }

    // kind='repo' — resolve the per-repo store via the registry +
    // aggregator, then shadow `ctx` with a shallow clone whose
    // `snapshotStore` points at that store. Every downstream read
    // (cursor table, findings, signature, baselineRef, entry-point
    // apiIndex) routes to the right repo without further refactor.
    // Falls back to the primary store on any resolution failure.
    let ctx: HandlerContext = ctxIn;
    if (scope.workspaceScope?.kind === 'repo' && scope.workspaceScope.repoId
        && ctxIn.repoStoreRegistry && ctxIn.aggregatorStore) {
        try {
            const rows = ctxIn.aggregatorStore.listRepos();
            const row = rows.find((r) => r.repoId === scope.workspaceScope!.repoId);
            if (row) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const pathMod = require('path');
                const repoRoot = row.rootPath
                    ? pathMod.resolve(ctxIn.workspaceRoot, row.rootPath)
                    : ctxIn.workspaceRoot;
                const perRepoStore = ctxIn.repoStoreRegistry.getRepoStore(repoRoot);
                if (perRepoStore && typeof (perRepoStore as any).getWorking === 'function') {
                    ctx = { ...ctxIn, snapshotStore: perRepoStore as any };
                    ctxIn.log(`[ai-review] repo-scope review narrowed to '${row.name}' (${row.rootPath || '<root>'})`);
                }
            }
        } catch (err: any) {
            ctxIn.log(`[ai-review] repo-scope narrowing failed (${err?.message ?? err}); falling back to primary store`);
        }
    }

    const controller = new AbortController();
    _currentRun = { controller, kind: 'full', startedAt: Date.now() };
    try {
        // #547 round 5: settings via ctx.platform.getSetting so this path
        // runs unchanged on the standalone server too. Same `codeatlas.*`
        // keys, same default fallbacks — only the resolver differs.
        const provider = ctx.platform.getSetting<string>('llmProvider', 'openrouter') ?? 'openrouter';
        const endpoint = ctx.platform.getSetting<string>('llmEndpoint') || undefined;
        const keyOptional = provider === 'ollama' || provider === 'custom';
        const apiKey = (await ctx.platform.getSecret('codeatlas.openRouterApiKey')) ?? '';
        if (!apiKey && !keyOptional) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Full review needs an API key for provider "${provider}". Run "CodeAtlas: Set LLM API Key" or switch to ollama/custom.` });
            return;
        }
        if (provider === 'custom' && !endpoint) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: 'Provider "custom" needs codeatlas.llmEndpoint set.' });
            return;
        }
        const isLocal = provider === 'ollama' || provider === 'custom';
        const model = ctx.platform.getSetting<string>('llmModel', 'openrouter/free') ?? 'openrouter/free';
        const llmCfg = { apiKey, model, timeoutMs: isLocal ? 180_000 : 30_000, provider, endpoint, allowCustomEndpointAuth: true /* #885 — user-configured endpoint = consent */ };
        const gateEnabled = ctx.platform.getSetting<boolean>('evidenceGateEnabled', true) !== false;

        // #534 — provenance ref for every finding in this run.
        const baselineRef = computeBaselineRef({ workspaceRoot: ctx.workspaceRoot, snapshotStore: ctx.snapshotStore });
        ctx.log(`[ai-review] baselineRef=${baselineRef.kind}:${baselineRef.ref}`);

        // #535 — dedup: skip LLM if (guidelines, baseline) match the last
        // successful full run AND there are findings already loaded.
        const guidelinesHash = ctx.snapshotStore.getReviewGuidelines().hash || '';
        if (scope.kind === 'all') {
            const prevSig = ctx.snapshotStore.getAiReviewSignature();
            if (prevSig
                && prevSig.guidelinesHash === guidelinesHash
                && prevSig.baselineKind === baselineRef.kind
                && prevSig.baselineRef === baselineRef.ref
                && prevSig.findingsCount > 0) {
                const counts = ctx.snapshotStore.getAiReviewFindingCounts();
                const items = ctx.snapshotStore.listAiReviewFindings({ status: 'open' } as any);
                broadcast({ type: 'aiReviewNoChange' as const, previous: prevSig, baselineRef, guidelinesHash });
                broadcast({ type: 'aiFindings' as const, items, counts });
                broadcast({ type: 'clientToast' as const, level: 'info', text: `Nothing changed since last review — ${prevSig.findingsCount} finding${prevSig.findingsCount === 1 ? '' : 's'} already loaded.` });
                return;
            }
        }

        // #536 — mark prior open findings stale if either guidelines or baseline
        // drifted. Runs ONLY when we got past the #535 dedup short-circuit, so a
        // "nothing changed" call doesn't downgrade its own findings.
        const staleIds = ctx.snapshotStore.markStaleFindings({
            currentGuidelinesHash: guidelinesHash,
            currentBaselineRef: baselineRef.ref,
        });
        if (staleIds.length > 0) {
            broadcast({ type: 'aiFindingsStale' as const, findingIds: staleIds });
            ctx.log(`[ai-review] marked ${staleIds.length} prior finding${staleIds.length === 1 ? '' : 's'} as stale`);
        }

        broadcast({ type: 'aiReviewStarted' as const, kind: 'full', scope: scope.kind, startedAt: _currentRun.startedAt, baselineRef });
        broadcast({ type: 'aiReviewLoading' as const, loading: true, progress: `Starting ${opts.mode} review… (evidence gate ${gateEnabled ? 'ON' : 'OFF'})` });

        // #606 — incremental review. Compute the per-entry delta against the
        // cursor table; the LLM only sees entries whose handler digest or
        // guidelines hash changed since their last review. Entries that
        // disappeared from `apiIndex` (route renamed, file deleted) have
        // their findings and cursors dropped before we start. Full mode
        // bypasses the delta and reviews every in-scope entry.
        //
        // The gate applies only to broad scopes ('all' / 'changed'). When
        // the user explicitly targets a single cluster or entry, the click
        // is interpreted as "review this now" — incremental skipping would
        // be confusing UX, so we always run the LLM on those.
        const { computeReviewDelta, computeEntryPointHandlerHash, entryPointKey } = await import('../core/llm/reviewDelta');
        let restrictToEntryPoints: Set<string> | undefined;
        let restrictToApiIds: Set<string> | undefined;
        let reusedCount = 0;
        const incrementalApplies = opts.mode === 'incremental' && (scope.kind === 'all' || scope.kind === 'changed');
        if (incrementalApplies) {
            const cursors = ctx.snapshotStore.getAiReviewEntryCursors();
            const scopeFilter = scope.kind === 'changed'
                ? (a: any) => a.diff && a.diff !== 'unchanged'
                : scope.kind === 'cluster' && scope.clusterId
                    ? (a: any) => (a.meta as any)?.clusterId === scope.clusterId
                    : scope.kind === 'entry' && scope.entryPointId
                        ? (a: any) => entryPointKey(a) === scope.entryPointId
                        : undefined;
            const delta = computeReviewDelta({
                snapshot: ctx.snapshotStore.getWorking() as any,
                cursors,
                guidelinesHash,
                scopeFilter,
            });
            reusedCount = delta.reused.length;
            // #606-SYNTHETIC — split cleanup. Cursors always drop when their
            // api vanishes; findings only drop when no live api still claims
            // the same entry_point_id (protects synthetic keys where one
            // call site disappears but siblings remain).
            for (const epid of delta.deletedFindings) {
                try { ctx.snapshotStore.clearAiReviewFindings({ entryPointId: epid }); } catch { /* swallow */ }
            }
            if (delta.deletedCursors.length > 0) {
                ctx.snapshotStore.clearAiReviewEntryCursorsByApiId(delta.deletedCursors);
                ctx.log(`[ai-review] incremental: dropped ${delta.deletedCursors.length} cursor${delta.deletedCursors.length === 1 ? '' : 's'}` +
                        (delta.deletedFindings.length > 0 ? ` + ${delta.deletedFindings.length} finding-set${delta.deletedFindings.length === 1 ? '' : 's'} for vanished entry points` : ''));
            }
            if (delta.changed.length === 0 && delta.deletedCursors.length === 0 && reusedCount > 0) {
                // Nothing actually changed — re-emit the current findings and
                // short-circuit. Mirrors the #535 "nothing changed" toast but
                // now driven by per-entry state instead of the global signature.
                const counts2 = ctx.snapshotStore.getAiReviewFindingCounts();
                const items2 = ctx.snapshotStore.listAiReviewFindings({ status: 'open' } as any);
                broadcast({ type: 'aiFindings' as const, items: items2, counts: counts2 });
                broadcast({ type: 'aiReviewComplete' as const, summary: { totalEntryPoints: reusedCount, reviewed: 0, reused: reusedCount, failed: 0, findingsCount: 0, projectFindings: 0, durationMs: 0, kind: 'full', mode: 'incremental' }, counts: counts2 });
                broadcast({ type: 'clientToast' as const, level: 'info', text: `Nothing changed since last review — ${reusedCount} entry point${reusedCount === 1 ? '' : 's'} reused.` });
                return;
            }
            // perEntryReviewer filters by entry_point_id (method:route);
            // synthetic keys collide. We also build an apiId set so the
            // cursor-stamp loop can target the exact records that ran.
            restrictToEntryPoints = new Set(delta.changed.map((a) => entryPointKey(a)));
            restrictToApiIds = new Set(delta.changed.map((a) => a.apiId));
            ctx.log(`[ai-review] incremental: ${delta.changed.length} changed / ${reusedCount} reused / ${delta.deletedCursors.length} cursor${delta.deletedCursors.length === 1 ? '' : 's'} dropped`);
        }

        const { runPerEntryReview } = await import('../core/llm/perEntryReviewer');
        const { runProjectLevelReview } = await import('../core/llm/projectLevelReviewer');

        // Issue 608 — mid-review budget guard. Every LLM call accumulates
        // token usage into runningSpend; when it crosses `maxBudgetUSD` we
        // abort the controller and surface a toast. Findings already
        // persisted are kept.
        const budgetCap = Number(ctx.platform.getSetting<number>('aiReview.maxBudgetUSD', 1.0) ?? 1.0);
        const { resolveModelPricing } = await import('../core/llm/reviewCostEstimator');
        const pricing = resolveModelPricing(model, provider);
        let runningSpend = 0;
        let budgetTripped = false;
        // Shared cost-tracking inner helper. Issued from both the per-entry
        // and project-level callLlm closures below so a single budget cap
        // applies across both reviewer paths.
        const callRawLlm = async ({ system, user }: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
            const resp = await sendOpenRouterRequest(
                llmCfg,
                [{ role: 'system', content: system }, { role: 'user', content: user }],
                opts?.signal ?? controller.signal,
            );
            // Track running cost. Some providers omit `usage`; in that case
            // we fall back to a rough estimate (prompt + completion length
            // approximated as 4 chars/token).
            const inTok = resp?.usage?.prompt_tokens ?? Math.ceil((system.length + user.length) / 4);
            const outTok = resp?.usage?.completion_tokens ?? Math.ceil(String(resp?.text ?? '').length / 4);
            const callSpend = (inTok / 1000) * pricing.inputPer1k + (outTok / 1000) * pricing.outputPer1k;
            runningSpend += callSpend;
            if (!budgetTripped && isBudgetExceeded(runningSpend, budgetCap)) {
                budgetTripped = true;
                ctx.log(`[ai-review] budget cap reached (${runningSpend.toFixed(4)} / ${budgetCap}) — aborting`);
                broadcast({ type: 'clientToast' as const, level: 'warning', text: `Budget cap $${budgetCap.toFixed(2)} reached after ~$${runningSpend.toFixed(2)}. Review halted; ${'partial findings preserved'}.` });
                controller.abort();
            }
            return String(resp?.text ?? '{}');
        };
        // Per-entry reviewer: relaxed strict + repair (#704 — Zod schema + auto-repair for LLM output 🟠 Tier A 2026-05-26) over the
        // `RawLlmFinding` shape.
        const callLlm = async (prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
            const text = await callRawLlm(prompt, opts);
            return extractFindingsJson(text);
        };
        // Project-level reviewer: same parsing pipeline but the
        // `ProjectRawFinding` shape (required `filePath`, flatter evidence).
        const callLlmProject = async (prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
            const text = await callRawLlm(prompt, opts);
            return extractProjectFindingsJson(text);
        };

        // #606 / #606-SYNTHETIC — track which ApiRecords actually completed
        // without an error so we only stamp cursors for those. Keyed by
        // apiId so multiple call sites with the same `method:route`
        // (NETWORK useMutation across files, SCREEN, JOB) each get an
        // independent cursor row. Failed/aborted entries are left
        // untouched so the next incremental review re-tries them.
        const reviewedApis: ApiRecord[] = [];
        const summary = await runPerEntryReview({
            store: ctx.snapshotStore,
            scope,
            model,
            llmCall: callLlm,
            evidenceGate: gateEnabled,
            signal: controller.signal,
            baselineRef,
            restrictToEntryPoints,
            callbacks: {
                onEntryStart: (epId, idx, total) => {
                    const suffix = reusedCount > 0 ? ` (${reusedCount} reused from last run)` : '';
                    broadcast({ type: 'aiReviewProgress' as const, message: `Reviewing ${epId}${suffix}`, completed: idx, total });
                },
                onEntryDone: (epId, findings, drops, api) => {
                    // #606-SYNTHETIC: only stamp the cursor when this api is
                    // in the incremental scope (or unconditionally on a full
                    // re-review where `restrictToApiIds` is undefined).
                    if (api && (!restrictToApiIds || restrictToApiIds.has(api.apiId))) {
                        reviewedApis.push(api);
                    }
                    if (findings.length > 0) broadcast({ type: 'aiFindingAdded' as const, entryPointId: epId, findings, drops });
                    else if (drops) broadcast({ type: 'aiEntryDropped' as const, entryPointId: epId, drops });
                },
                onEntryError: (epId, err) => ctx.log(`[full-review] ${epId}: ${err.message}`),
            },
        });

        // Stamp cursors per-apiId on the working snapshot so the next
        // incremental review can compare each call site independently.
        if (reviewedApis.length > 0) {
            const workingForCursor = ctx.snapshotStore.getWorking() as any;
            const now = Date.now();
            for (const api of reviewedApis) {
                ctx.snapshotStore.upsertAiReviewEntryCursor({
                    apiId: api.apiId,
                    entryPointId: entryPointKey(api),
                    handlerHash: computeEntryPointHandlerHash(api, workingForCursor),
                    guidelinesHash,
                    baselineKind: baselineRef.kind,
                    baselineRef: baselineRef.ref,
                    reviewedAt: now,
                });
            }
        }

        if (controller.signal.aborted) {
            broadcast({ type: 'aiReviewCancelled' as const, reason: 'user' });
            broadcast({ type: 'clientToast' as const, level: 'warning', text: 'AI Review cancelled.' });
            return;
        }

        let projectFindings = 0;
        if (scope.kind === 'all' || scope.kind === 'changed') {
            broadcast({ type: 'aiReviewProgress' as const, message: 'Reviewing project-level files…', completed: summary.totalEntryPoints, total: summary.totalEntryPoints + 1 });
            const projectResult = await runProjectLevelReview({
                store: ctx.snapshotStore,
                model,
                llmCall: callLlmProject,
                evidenceGate: gateEnabled,
                signal: controller.signal,
                baselineRef,
                onFinding: (f) => broadcast({ type: 'aiFindingAdded' as const, entryPointId: f.entryPointId, findings: [f] }),
            });
            projectFindings = projectResult.findingsCount;
        }

        if (controller.signal.aborted) {
            broadcast({ type: 'aiReviewCancelled' as const, reason: 'user' });
            broadcast({ type: 'clientToast' as const, level: 'warning', text: 'AI Review cancelled.' });
            return;
        }

        const counts = ctx.snapshotStore.getAiReviewFindingCounts();
        broadcast({ type: 'aiReviewComplete' as const, summary: { ...summary, projectFindings }, counts });
        const total = summary.findingsCount + projectFindings;
        // #535 — persist the signature for dedup. Cancel / error paths skip
        // this since they didn't reach `aiReviewComplete`.
        if (scope.kind === 'all') {
            ctx.snapshotStore.setAiReviewSignature({
                guidelinesHash,
                baselineKind: baselineRef.kind,
                baselineRef: baselineRef.ref,
                findingsCount: counts.total,
            });
        }
        broadcast({ type: 'clientToast' as const, level: 'info', text: `Full review done — ${total} findings across ${summary.reviewed}/${summary.totalEntryPoints} entry points + project-level scan.` });
    } catch (err: any) {
        if (controller.signal.aborted) {
            broadcast({ type: 'aiReviewCancelled' as const, reason: 'user' });
            broadcast({ type: 'clientToast' as const, level: 'warning', text: 'AI Review cancelled.' });
        } else {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Full review failed: ${(err?.message ?? err).slice(0, 200)}` });
            // Issue 609: also emit the classified error envelope so the UI
            // can render the failure-mode banner with a remediation hint
            // and a "View raw response" debug link.
            broadcastClassifiedReviewError(broadcast, err);
        }
    } finally {
        _currentRun = null;
        broadcast({ type: 'aiReviewLoading' as const, loading: false });
    }
}

/**
 * Issue 609: classify a thrown error from the review pipeline into a
 * `aiReviewError` envelope. `LlmError` instances carry their kind + raw
 * body; everything else falls back to `unknown`.
 */
function broadcastClassifiedReviewError(broadcast: (msg: any) => void, err: any): void {
    const isLlmError = err && typeof err === 'object' && err.name === 'LlmError' && typeof err.kind === 'string';
    if (isLlmError) {
        broadcast({
            type: 'aiReviewError' as const,
            kind: err.kind,
            message: String(err.message ?? '').slice(0, 400),
            rawResponse: typeof err.rawBody === 'string' ? err.rawBody.slice(0, 4000) : undefined,
            provider: err.provider,
            status: err.status,
        });
    } else {
        broadcast({
            type: 'aiReviewError' as const,
            kind: 'unknown' as const,
            message: String(err?.message ?? err ?? 'unknown error').slice(0, 400),
        });
    }
}

/**
 * Extension-side specific (free-form) review. The user's prompt is appended
 * to every project-level LLM call as `[USER-REQUESTED REVIEW FOCUS]…[END]`.
 */
async function runExtensionSpecificReview(
    ctx: HandlerContext,
    broadcast: (msg: any) => void,
    rawPrompt: string,
): Promise<void> {
    const trimmed = (rawPrompt ?? '').trim();
    if (!trimmed) {
        broadcast({ type: 'clientToast' as const, level: 'warning', text: 'Specific review needs a prompt — describe what to review.' });
        return;
    }
    if (trimmed.length > 4000) {
        broadcast({ type: 'clientToast' as const, level: 'warning', text: 'Specific review prompt too long (max 4 000 chars).' });
        return;
    }
    const controller = new AbortController();
    _currentRun = { controller, kind: 'specific', startedAt: Date.now() };
    try {
        // #547 round 5: settings via ctx.platform.getSetting (cross-runtime).
        const provider = ctx.platform.getSetting<string>('llmProvider', 'openrouter') ?? 'openrouter';
        const endpoint = ctx.platform.getSetting<string>('llmEndpoint') || undefined;
        const keyOptional = provider === 'ollama' || provider === 'custom';
        const apiKey = (await ctx.platform.getSecret('codeatlas.openRouterApiKey')) ?? '';
        if (!apiKey && !keyOptional) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Specific review needs an API key for provider "${provider}".` });
            return;
        }
        if (provider === 'custom' && !endpoint) {
            broadcast({ type: 'clientToast' as const, level: 'error', text: 'Provider "custom" needs codeatlas.llmEndpoint set.' });
            return;
        }
        const isLocal = provider === 'ollama' || provider === 'custom';
        const model = ctx.platform.getSetting<string>('llmModel', 'openrouter/free') ?? 'openrouter/free';
        const llmCfg = { apiKey, model, timeoutMs: isLocal ? 180_000 : 30_000, provider, endpoint, allowCustomEndpointAuth: true /* #885 — user-configured endpoint = consent */ };
        const gateEnabled = ctx.platform.getSetting<boolean>('evidenceGateEnabled', true) !== false;

        // #534 — provenance ref for this specific-review run.
        const baselineRef = computeBaselineRef({ workspaceRoot: ctx.workspaceRoot, snapshotStore: ctx.snapshotStore });
        ctx.log(`[ai-review:specific] baselineRef=${baselineRef.kind}:${baselineRef.ref}`);

        broadcast({ type: 'aiReviewStarted' as const, kind: 'specific', prompt: trimmed.slice(0, 200), startedAt: _currentRun.startedAt, baselineRef });
        broadcast({ type: 'aiReviewLoading' as const, loading: true, progress: 'Running specific review…' });

        const { runProjectLevelReview } = await import('../core/llm/projectLevelReviewer');

        const callLlm = async ({ system, user }: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
            const userPlusPrompt = `${user}\n\n[USER-REQUESTED REVIEW FOCUS]\n${trimmed}\n[END]`;
            const resp = await sendOpenRouterRequest(
                llmCfg,
                [{ role: 'system', content: system }, { role: 'user', content: userPlusPrompt }],
                opts?.signal ?? controller.signal,
            );
            // Specific review drives `runProjectLevelReview` only, so we use
            // the project-level extractor (required `filePath`, flatter
            // evidence shape — see `findingSchema.ts`).
            return extractProjectFindingsJson(String(resp?.text ?? '{}'));
        };

        broadcast({ type: 'aiReviewProgress' as const, message: 'Scanning project-level files…', completed: 0, total: 1 });
        const result = await runProjectLevelReview({
            store: ctx.snapshotStore,
            model,
            llmCall: callLlm,
            evidenceGate: gateEnabled,
            signal: controller.signal,
            baselineRef,
            onFinding: (f) => broadcast({ type: 'aiFindingAdded' as const, entryPointId: f.entryPointId, findings: [f] }),
        });

        if (controller.signal.aborted) {
            broadcast({ type: 'aiReviewCancelled' as const, reason: 'user' });
            broadcast({ type: 'clientToast' as const, level: 'warning', text: 'Specific review cancelled.' });
            return;
        }

        const counts = ctx.snapshotStore.getAiReviewFindingCounts();
        broadcast({
            type: 'aiReviewComplete' as const,
            summary: {
                totalEntryPoints: result.files.length,
                reviewed: result.files.length,
                failed: 0,
                findingsCount: 0,
                projectFindings: result.findingsCount,
                durationMs: result.durationMs,
                kind: 'specific',
            },
            counts,
        });
        broadcast({ type: 'clientToast' as const, level: 'info', text: `Specific review done — ${result.findingsCount} findings across ${result.files.length} files.` });
    } catch (err: any) {
        if (controller.signal.aborted) {
            broadcast({ type: 'aiReviewCancelled' as const, reason: 'user' });
            broadcast({ type: 'clientToast' as const, level: 'warning', text: 'Specific review cancelled.' });
        } else {
            broadcast({ type: 'clientToast' as const, level: 'error', text: `Specific review failed: ${(err?.message ?? err).slice(0, 200)}` });
            broadcastClassifiedReviewError(broadcast, err);
        }
    } finally {
        _currentRun = null;
        broadcast({ type: 'aiReviewLoading' as const, loading: false });
    }
}

/**
 * Shared logic for resolveAiReview, ignoreAiReview, reopenAiReview.
 * Updates the review item status in the cached result and re-broadcasts.
 */
function handleReviewStatusChange(
    ctx: HandlerContext,
    message: any,
    newStatus: 'open' | 'resolved' | 'ignored',
    module: string,
): void {
    try {
        const aiReviewResult = ctx.getAiReviewResult!();
        if (aiReviewResult) {
            const reviewId = message.reviewId;
            // Update in items array
            const item = aiReviewResult.items.find(r => r.id === reviewId);
            if (item) {
                item.status = newStatus;
                // Update in byGraph index
                const graphItems = aiReviewResult.byGraph[item.graphId];
                if (graphItems) {
                    const gi = graphItems.find(r => r.id === reviewId);
                    if (gi) gi.status = newStatus;
                }
                // Re-broadcast updated result to all panels
                const updatedMsg = { type: 'aiReviewResult' as const, result: aiReviewResult };
                ctx.platform.broadcast(updatedMsg);
            }
        }
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        ctx.log(`[${module}] ${newStatus}AiReview error: ${msg}`);
        ctx.notifyBrowser('error', `${newStatus}AiReview failed: ${msg.slice(0, 150)}`);
    }
}
