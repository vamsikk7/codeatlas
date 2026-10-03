/**
 * aiReview.ts — standalone AI Review entry point.
 *
 * Bypasses `src/handlers/aiReviewHandlers.ts` (which uses
 * `vscode.workspace.getConfiguration` directly) and instead delegates to the
 * pure-JS engine in `src/core/llm/aiReviewEngine.ts`. Wires up:
 *   - Working-vs-baseline diff via `buildWorkingDiffBundle`
 *   - LLM config from the standalone settings layer
 *   - API key from the standalone secrets store
 *   - Progress + result broadcasts over the standalone WS bridge
 *
 * INVARIANT: every error path emits a `clientToast` so the user sees the
 * failure reason. Network errors / missing keys / no-diff conditions are
 * surfaced (not swallowed).
 */

import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { WsBridge } from '../server/wsBridge';
import { buildWorkingDiffBundle, workingDiffersFromBaseline } from '../handlers/replayWorkingChanges';
import { executeAiReview, isTimeoutError } from '../core/llm/aiReviewEngine';
import type { OpenRouterConfig } from '../core/llm/openRouterClient';
import type { AiReviewResult } from '../core/llm/aiReviewTypes';
import type { SettingsResolver } from './settings';
import type { SecretsStore } from './secrets';
import { extractFindingsJson, extractProjectFindingsJson } from '../core/llm/findingSchema';

export interface AiReviewDeps {
    snapshotStore: SnapshotStore;
    wsBridge: WsBridge;
    settings: SettingsResolver;
    secrets: SecretsStore;
    log: (msg: string) => void;
    /** #534 — needed to compute the baseline ref (git rev-parse or fallback hash). */
    workspaceRoot?: string;
}

/** Per-session AI Review state. Mirrors what `aiReviewHandlers` keeps on the
 *  HandlerContext as `getAiReviewResult / setAiReviewResult`. */
export interface AiReviewState {
    lastResult: AiReviewResult | null;
    /** True while a review is in flight — prevents concurrent runs. */
    inFlight: boolean;
}

export function createAiReviewState(): AiReviewState {
    return { lastResult: null, inFlight: false };
}

/**
 * Module-level state for the active full / specific review.
 *
 * The webview's "Cancel" button posts a `cancelFullReview` message; that handler
 * calls `cancelCurrentReview()` which aborts the in-flight controller. Both the
 * per-entry reviewer and the project-level reviewer poll the abort signal
 * between LLM calls and exit early when set.
 *
 * Only one run is allowed at a time — the message handler checks `isReviewRunning`
 * before spawning a second one and emits an info toast instead.
 */
let _currentRun: { controller: AbortController; kind: 'full' | 'specific'; startedAt: number } | null = null;

export function isReviewRunning(): boolean {
    return _currentRun !== null;
}

export function cancelCurrentReview(): boolean {
    if (!_currentRun) return false;
    _currentRun.controller.abort();
    return true;
}

/**
 * Run an AI Review against the current working-vs-baseline diff.
 *
 * Broadcasts via the WS bridge:
 *   - `aiReviewLoading` (true / false)
 *   - `aiReviewProgress` (per-batch progress)
 *   - `aiReviewResult` on success
 *   - `clientToast` on user-facing errors
 */
export async function runAiReview(deps: AiReviewDeps, state: AiReviewState): Promise<void> {
    if (state.inFlight) {
        broadcastToast(deps.wsBridge, 'info', 'AI Review already in progress…');
        return;
    }
    state.inFlight = true;
    deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: true, progress: 'Preparing review…' });

    try {
        // 1. Resolve diff — working vs baseline. Mirrors the extension's
        //    "Review Working Changes" entry point.
        const baseline = deps.snapshotStore.getBaseline();
        const working = deps.snapshotStore.getWorking();
        if (!workingDiffersFromBaseline(baseline, working)) {
            broadcastToast(deps.wsBridge, 'warning', 'No working changes to review. Edit a file first.');
            return;
        }
        const diffedGraphs = buildWorkingDiffBundle(baseline, working);

        // 2. Resolve LLM config from the standalone settings layer.
        //    Supported providers: 'openrouter' (default), 'openai', 'anthropic',
        //    'ollama' (local), 'custom' (any URL set via llmEndpoint).
        //    Local providers don't need an API key.
        const provider = deps.settings.get<string>('codeatlas.llmProvider') || 'openrouter';
        const endpoint = deps.settings.get<string>('codeatlas.llmEndpoint') || undefined;
        const keyOptional = provider === 'ollama' || provider === 'custom';
        const apiKey = (await deps.secrets.get('codeatlas.openRouterApiKey')) ?? '';
        if (!apiKey && !keyOptional) {
            const human = provider === 'anthropic' ? 'ANTHROPIC_API_KEY'
                : provider === 'openai' ? 'OPENAI_API_KEY'
                : 'OPENROUTER_API_KEY';
            broadcastToast(
                deps.wsBridge,
                'error',
                `AI Review needs an API key for provider "${provider}". Set ${human} (or OPENROUTER_API_KEY) env var, or switch to ollama / custom for a local model.`,
            );
            return;
        }
        // `custom` has no default base URL — without an explicit endpoint the
        // client would fall back to OpenRouter and 401 with no key.
        if (provider === 'custom' && !endpoint) {
            broadcastToast(
                deps.wsBridge,
                'error',
                'AI Review provider "custom" needs codeatlas.llmEndpoint set (e.g. http://localhost:8080/v1/chat/completions).',
            );
            return;
        }
        // Local LLMs may need extended timeout for cold start + inference.
        const isLocal = provider === 'ollama' || provider === 'custom';
        const timeoutMs = isLocal ? 180_000 : 30_000;
        const cfg: OpenRouterConfig = {
            apiKey,
            model: deps.settings.get<string>('codeatlas.llmModel') || 'openrouter/free',
            timeoutMs,
            provider,
            endpoint,
            // #885 — the endpoint comes from the user's own `codeatlas.llmEndpoint`
            // setting (deliberate config = consent), so the key may attach even when
            // it's a custom non-built-in host.
            allowCustomEndpointAuth: true,
        };

        // 3. Run the review with progress broadcasts. Engine fires
        //    onProgress(message, completed, total) per-batch.
        deps.log('[ai-review] starting…');
        const result = await executeAiReview(cfg, diffedGraphs, undefined, {
            onProgress: (message, completed, total) => {
                deps.wsBridge.broadcast({ type: 'aiReviewProgress', message, completed, total });
            },
        });

        state.lastResult = result;
        deps.wsBridge.broadcast({ type: 'aiReviewResult', result });
        deps.log(`[ai-review] done — ${result.summary.total} findings in ${result.meta.durationMs}ms`);
    } catch (err: any) {
        const message = err?.message ?? String(err);
        if (isTimeoutError(err)) {
            // `timeoutMs` was scoped to the try block; recompute the wall-clock
            // value so the toast matches the limit that actually fired.
            const provider = deps.settings.get<string>('codeatlas.llmProvider') || 'openrouter';
            const wasLocal = provider === 'ollama' || provider === 'custom';
            const seconds = wasLocal ? 180 : 30;
            broadcastToast(deps.wsBridge, 'error', `AI Review timed out after ${seconds}s — check your LLM endpoint / model.`);
        } else {
            broadcastToast(deps.wsBridge, 'error', `AI Review failed: ${message.slice(0, 200)}`);
        }
        deps.log(`[ai-review] error: ${message}`);
    } finally {
        state.inFlight = false;
        deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: false });
    }
}

/**
 * Clear the current AI Review result. Matches the extension's `clearAiReview`
 * message handler.
 */
export function clearAiReview(deps: AiReviewDeps, state: AiReviewState): void {
    state.lastResult = null;
    deps.wsBridge.broadcast({ type: 'aiReviewCleared' });
}

/**
 * Run a per-entry-point review across L1–L5 (#498/#511). Streams progress +
 * per-entry findings over the WS bridge. The MVP wraps the same OpenRouter
 * client AI Review uses; the prompt comes from `perEntryReviewer.buildPromptContext`.
 *
 * Errors per entry-point are captured and surfaced as toasts; the run
 * continues so a partial result is always landed on disk.
 */
export async function runFullReview(
    deps: AiReviewDeps,
    scope: { kind: 'all' | 'changed' | 'cluster' | 'entry'; clusterId?: string; entryPointId?: string },
): Promise<void> {
    if (_currentRun) {
        broadcastToast(deps.wsBridge, 'info', 'A review is already in progress. Cancel it first.');
        return;
    }
    const controller = new AbortController();
    _currentRun = { controller, kind: 'full', startedAt: Date.now() };
    const { runPerEntryReview, runSingleCallReview } = await import('../core/llm/perEntryReviewer');
    // #856 — benchmark mode: condense all changed entry points into ONE LLM
    // call so context value can be compared at equal call budget vs a raw
    // diff review. Off by default; env CODEATLAS_REVIEW_SINGLE_CALL=1.
    const singleCall = deps.settings.get<boolean>('codeatlas.reviewSingleCall') === true;
    const { sendOpenRouterRequest } = await import('../core/llm/openRouterClient');
    const provider = deps.settings.get<string>('codeatlas.llmProvider') || 'openrouter';
    const endpoint = deps.settings.get<string>('codeatlas.llmEndpoint') || undefined;
    const keyOptional = provider === 'ollama' || provider === 'custom';
    const apiKey = (await deps.secrets.get('codeatlas.openRouterApiKey')) ?? '';
    if (!apiKey && !keyOptional) {
        broadcastToast(deps.wsBridge, 'error', `Full review needs an API key for provider "${provider}". Set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) or switch to ollama/custom.`);
        return;
    }
    if (provider === 'custom' && !endpoint) {
        broadcastToast(deps.wsBridge, 'error', 'Provider "custom" needs codeatlas.llmEndpoint set.');
        return;
    }
    const isLocal = provider === 'ollama' || provider === 'custom';
    const model = deps.settings.get<string>('codeatlas.llmModel') || 'openrouter/free';
    // #849 — per-call timeout override (`codeatlas.llmTimeoutMs`, env
    // CODEATLAS_LLM_TIMEOUT_MS). Local reasoning models (e.g. gemma-12B via
    // ollama) can need far more than the 180s default on big review prompts.
    const timeoutOverride = Number(deps.settings.get<number>('codeatlas.llmTimeoutMs')) || 0;
    // #939 — reasoning effort for reasoning-capable remote models (deepseek-v4-flash).
    const reasoningEffort = (deps.settings.get<string>('codeatlas.llmReasoningEffort') || process.env.CODEATLAS_LLM_REASONING_EFFORT || '').trim() || undefined;
    const cfg = { apiKey, model, timeoutMs: timeoutOverride > 0 ? timeoutOverride : (isLocal ? 180_000 : 30_000), provider, endpoint, allowCustomEndpointAuth: true /* #885 — user-configured endpoint = consent */, reasoningEffort };

    // #513 toggle — webview debug switch (next to "Edit" on the guidelines
    // card). When false, the evidence gate is bypassed and every finding is
    // kept so the user can see the un-filtered model output.
    const evidenceGate = deps.settings.get<boolean>('codeatlas.evidenceGateEnabled');
    const gateEnabled = evidenceGate !== false;  // default true

    // #534 — capture once so every finding in this run shares the same ref.
    const { computeBaselineRef } = await import('../core/llm/baselineRef');
    const baselineRef = computeBaselineRef({ workspaceRoot: deps.workspaceRoot ?? process.cwd(), snapshotStore: deps.snapshotStore });
    deps.log(`[ai-review] baselineRef=${baselineRef.kind}:${baselineRef.ref}`);

    // #535 — dedup: if guidelines + baseline match the last successful run AND
    // findings already exist, skip the LLM and re-broadcast existing findings.
    const guidelinesHash = deps.snapshotStore.getReviewGuidelines().hash || '';
    if (scope.kind === 'all') {
        const prevSig = deps.snapshotStore.getAiReviewSignature();
        if (prevSig
            && prevSig.guidelinesHash === guidelinesHash
            && prevSig.baselineKind === baselineRef.kind
            && prevSig.baselineRef === baselineRef.ref
            && prevSig.findingsCount > 0) {
            const counts = deps.snapshotStore.getAiReviewFindingCounts();
            const items = deps.snapshotStore.listAiReviewFindings({ status: 'open' } as any);
            deps.wsBridge.broadcast({ type: 'aiReviewNoChange', previous: prevSig, baselineRef, guidelinesHash });
            deps.wsBridge.broadcast({ type: 'aiFindings', items, counts });
            broadcastToast(deps.wsBridge, 'info', `Nothing changed since last review — ${prevSig.findingsCount} finding${prevSig.findingsCount === 1 ? '' : 's'} already loaded.`);
            _currentRun = null;
            deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: false });
            return;
        }
    }

    // #536 — mark prior open findings stale if either guidelines or baseline
    // drifted. Runs ONLY when we got past the #535 dedup short-circuit, so a
    // "nothing changed" call doesn't downgrade its own findings.
    const staleIds = deps.snapshotStore.markStaleFindings({
        currentGuidelinesHash: guidelinesHash,
        currentBaselineRef: baselineRef.ref,
    });
    if (staleIds.length > 0) {
        deps.wsBridge.broadcast({ type: 'aiFindingsStale', findingIds: staleIds });
        deps.log(`[ai-review] marked ${staleIds.length} prior finding${staleIds.length === 1 ? '' : 's'} as stale`);
    }

    deps.wsBridge.broadcast({
        type: 'aiReviewStarted',
        kind: 'full',
        scope: scope.kind,
        startedAt: _currentRun.startedAt,
        baselineRef,
    });
    deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: true, progress: `Starting full review… (evidence gate ${gateEnabled ? 'ON' : 'OFF — debug'})` });

    // Shared LLM-call adapter — used by per-entry + project-level reviewers.
    // Forwards the abort signal so a `cancelFullReview` aborts the in-flight
    // fetch immediately instead of waiting for it to finish.
    let rawCaptureIdx = 0;
    // #849 — per-run token accounting. Accumulated across every LLM call in
    // this run (per-entry + project-level) and reported in the
    // `aiReviewComplete` summary so benchmark runners can meter both arms.
    const tokensUsed = {
        prompt: 0, completion: 0, calls: 0,
        // #869 — dry-run input meter: exact prompt chars + per-pass breakdown.
        chars: 0,
        byPass: { entry: { prompt: 0, chars: 0, calls: 0 }, project: { prompt: 0, chars: 0, calls: 0 } },
    };
    // #869 — input-token estimate with no model: OpenAI ~chars/4 rule of thumb
    // (CODEATLAS_CHARS_PER_TOKEN to refine for a specific tokenizer).
    const CHARS_PER_TOKEN = Number(process.env.CODEATLAS_CHARS_PER_TOKEN) || 4;
    const DRY_RUN = process.env.CODEATLAS_REVIEW_DRY_RUN === '1';
    const callRawLlm = async (
        { system, user }: { system: string; user: string },
        opts?: { signal?: AbortSignal },
        pass: 'entry' | 'project' = 'entry',
    ) => {
        if (DRY_RUN) {
            // #869 — count the input we WOULD send; make NO endpoint call; return empty findings.
            const chars = system.length + user.length;
            const t = Math.ceil(chars / CHARS_PER_TOKEN);
            tokensUsed.calls += 1; tokensUsed.prompt += t; tokensUsed.chars += chars;
            tokensUsed.byPass[pass].prompt += t; tokensUsed.byPass[pass].chars += chars; tokensUsed.byPass[pass].calls += 1;
            // Eval capture: dump the EXACT input (system + user) we would send so an
            // oracle reviewer can review from ONLY this context — measuring whether
            // CodeAtlas's input is sufficient to find the golden bugs.
            const dumpFile = process.env.CODEATLAS_DRY_DUMP_FILE;
            if (dumpFile) {
                try {
                    // #940 — self-tag each call with repo/pr (from env, set per-PR by the
                    // benchmark runner) so a consolidated all-calls.json can be replayed to
                    // any model without re-running the CodeAtlas pipeline.
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    require('fs').appendFileSync(dumpFile, JSON.stringify({ repo: process.env.CODEATLAS_DRY_REPO || '', pr: process.env.CODEATLAS_DRY_PR || '', pass, chars, tokens: t, system, user }) + '\n');
                } catch { /* dump is best-effort */ }
            }
            return '{"findings":[]}';
        }
        const resp = await sendOpenRouterRequest(
            cfg,
            [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            opts?.signal ?? controller.signal,
        );
        const rawText = String(resp?.text ?? '{}');
        tokensUsed.calls += 1;
        tokensUsed.prompt += resp?.usage?.prompt_tokens ?? 0;
        tokensUsed.completion += resp?.usage?.completion_tokens ?? 0;
        // Diagnostic: dump the first 3 raw model outputs for debugging.
        if (process.env.CODEATLAS_DEBUG_REVIEW === '1' && rawCaptureIdx < 3) {
            try {
                require('fs').writeFileSync(`/tmp/raw-model-${rawCaptureIdx}.txt`, rawText);
                rawCaptureIdx += 1;
            } catch { /* noop */ }
        }
        return rawText;
    };
    // Per-entry reviewer: relaxed strict + repair (#704 — Zod schema + auto-repair for LLM output 🟠 Tier A 2026-05-26) over the
    // `RawLlmFinding` shape.
    const callLlm = async (prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
        return extractFindingsJson(await callRawLlm(prompt, opts, 'entry'));
    };
    // Project-level reviewer: same parsing pipeline but the
    // `ProjectRawFinding` shape (required `filePath`, flatter evidence).
    const callLlmProject = async (prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
        return extractProjectFindingsJson(await callRawLlm(prompt, opts, 'project'));
    };

    try {
        const reviewCallbacks = {
            onEntryStart: (epId: string, idx: number, total: number) => {
                deps.wsBridge.broadcast({ type: 'aiReviewProgress', message: `Reviewing ${epId}`, completed: idx, total });
            },
            onEntryDone: (epId: string, findings: any[], drops?: any) => {
                if (findings.length > 0) deps.wsBridge.broadcast({ type: 'aiFindingAdded', entryPointId: epId, findings, drops });
                else if (drops) deps.wsBridge.broadcast({ type: 'aiEntryDropped', entryPointId: epId, drops });
            },
            onEntryError: (epId: string, err: Error) => {
                deps.log(`[full-review] ${epId}: ${err.message}`);
            },
        };
        // #856 — condensed single-call mode (benchmark). One LLM call over all
        // changed entry points; skips the project-level pass so the run is
        // exactly one call — directly comparable to a raw diff review.
        const summary = singleCall
            ? await runSingleCallReview({
                store: deps.snapshotStore, scope, model, llmCall: callLlm,
                evidenceGate: gateEnabled, signal: controller.signal, baselineRef,
                callbacks: reviewCallbacks,
            })
            : await runPerEntryReview({
                store: deps.snapshotStore,
                scope,
                model,
                llmCall: callLlm,
                evidenceGate: gateEnabled,
                signal: controller.signal,
                baselineRef,
                // #855 — local providers (ollama/custom) serve ONE request at a
                // time; firing the default 4 concurrent entry reviews queues them
                // on a single model instance, and the tail requests blow past the
                // timeout ("fetch failed"). Serialize for local models so every
                // entry actually gets reviewed. Remote APIs keep the default 4.
                concurrency: isLocal ? 1 : undefined,
                callbacks: reviewCallbacks,
            });

        if (controller.signal.aborted) {
            deps.wsBridge.broadcast({ type: 'aiReviewCancelled', reason: 'user' });
            broadcastToast(deps.wsBridge, 'warning', 'AI Review cancelled.');
            return;
        }

        // #515 — project-level pass runs after per-entry. Catches cross-cutting
        // concerns (auth config, error handlers, secrets) that no single entry
        // point owns. Only runs on full / changed scopes — narrow scopes
        // (single cluster / single entry) skip it to keep latency tight.
        let projectFindings = 0;
        if (!singleCall && (scope.kind === 'all' || scope.kind === 'changed')) {
            deps.wsBridge.broadcast({ type: 'aiReviewProgress', message: 'Reviewing changed + cross-cutting files…', completed: summary.totalEntryPoints, total: summary.totalEntryPoints + 1 });
            const { runProjectLevelReview } = await import('../core/llm/projectLevelReviewer');
            const projectResult = await runProjectLevelReview({
                store: deps.snapshotStore,
                model,
                llmCall: callLlmProject,
                evidenceGate: gateEnabled,
                signal: controller.signal,
                baselineRef,
                onFinding: (f) => deps.wsBridge.broadcast({ type: 'aiFindingAdded', entryPointId: f.entryPointId, findings: [f] }),
            });
            projectFindings = projectResult.findingsCount;
            deps.log(`[project-review] reviewed ${projectResult.files.length} files (${projectResult.changedReviewed ?? 0} changed + ${projectResult.infraReviewed ?? 0} infra) across ${projectResult.batches ?? 0} batch(es), ${projectFindings} findings, ${projectResult.durationMs}ms${projectResult.overflow ? ` · ⚠ ${projectResult.overflow} changed files not reviewed (file cap or batch ceiling — raise CODEATLAS_REVIEW_CHANGED_FILE_CAP / CODEATLAS_REVIEW_PROJECT_BATCHES)` : ''}`);
        }

        if (controller.signal.aborted) {
            deps.wsBridge.broadcast({ type: 'aiReviewCancelled', reason: 'user' });
            broadcastToast(deps.wsBridge, 'warning', 'AI Review cancelled.');
            return;
        }

        // #948–#953 — finalize: apply the shared FP filter + dedup to the persisted
        // OPEN findings so the EXTENSION review converges with the PR-watcher / CLI
        // path (parity by construction). off-diff applies only to a diff-scoped
        // ('changed') run; for 'all'/'cluster'/'entry' the changed-set is empty
        // (off-diff no-op) while dedup + test-nit demotion still apply.
        try {
            const { finalizeFindingsInStore, changedFilesFromStoreHashes } = await import('../core/llm/reviewFilters');
            const changedSet = scope.kind === 'changed' ? changedFilesFromStoreHashes(deps.snapshotStore) : new Set<string>();
            const fin = finalizeFindingsInStore(deps.snapshotStore, changedSet);
            if (fin.ignored > 0) {
                deps.log(`[full-review] #948–#953 FP filter ignored ${fin.ignored} finding(s) (off-diff ${fin.byReason['off-diff']}, test-nit ${fin.byReason['test-nit']}, dup ${fin.byReason.duplicate})`);
                // Re-broadcast the now-filtered open set so the UI drops the FPs it
                // was streamed via aiFindingAdded during the passes.
                deps.wsBridge.broadcast({ type: 'aiFindings', findings: deps.snapshotStore.listAiReviewFindings({ status: 'open' }) });
            }
        } catch (e: any) {
            deps.log(`[full-review] FP filter skipped: ${e?.message ?? e}`);
        }

        const counts = deps.snapshotStore.getAiReviewFindingCounts();
        deps.wsBridge.broadcast({ type: 'aiReviewComplete', summary: { ...summary, projectFindings, tokensUsed, model }, counts });
        const totalFindings = summary.findingsCount + projectFindings;
        // #535 — only `scope=all` runs are dedup'd. Narrower scopes (cluster /
        // entry) are user-intent override of "review just this slice" so we
        // don't want a stale narrow run to gate a future full review.
        if (scope.kind === 'all') {
            deps.snapshotStore.setAiReviewSignature({
                guidelinesHash,
                baselineKind: baselineRef.kind,
                baselineRef: baselineRef.ref,
                findingsCount: counts.total,
            });
        }
        // #897 — state the honest denominator: budget-skipped entries were NOT reviewed.
        const skippedNote = summary.skipped ? ` · ⚠ ${summary.skipped} entr${summary.skipped === 1 ? 'y' : 'ies'} skipped (corpus budget — raise CODEATLAS_REVIEW_CORPUS_BUDGET)` : '';
        broadcastToast(deps.wsBridge, 'info', `Full review done — ${totalFindings} findings across ${summary.reviewed}/${summary.totalEntryPoints} entry points + project-level scan.${skippedNote}`);
    } catch (err: any) {
        if (controller.signal.aborted) {
            deps.wsBridge.broadcast({ type: 'aiReviewCancelled', reason: 'user' });
            broadcastToast(deps.wsBridge, 'warning', 'AI Review cancelled.');
        } else {
            broadcastToast(deps.wsBridge, 'error', `Full review failed: ${(err?.message ?? err).slice(0, 200)}`);
        }
    } finally {
        _currentRun = null;
        deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: false });
    }
}

/**
 * Run a one-shot specific review against a free-form user prompt.
 *
 * The prompt is treated as additional user-supplied review guidelines for a
 * single LLM call. We assemble a corpus from the workspace's project-level
 * files (auth, config, middleware — same selection heuristic as
 * `runProjectLevelReview`) so the evidence gate has a body to verify against.
 *
 * Findings get bound to `microservice:workspace` + any concrete files they
 * quote. The popover on the home page can deep-link via those graphIds.
 */
export async function runSpecificReview(deps: AiReviewDeps, prompt: string): Promise<void> {
    if (_currentRun) {
        broadcastToast(deps.wsBridge, 'info', 'A review is already in progress. Cancel it first.');
        return;
    }
    const trimmed = (prompt ?? '').trim();
    if (!trimmed) {
        broadcastToast(deps.wsBridge, 'warning', 'Specific review needs a prompt — describe what to review.');
        return;
    }
    if (trimmed.length > 4000) {
        broadcastToast(deps.wsBridge, 'warning', 'Specific review prompt too long (max 4 000 chars).');
        return;
    }

    const controller = new AbortController();
    _currentRun = { controller, kind: 'specific', startedAt: Date.now() };

    const provider = deps.settings.get<string>('codeatlas.llmProvider') || 'openrouter';
    const endpoint = deps.settings.get<string>('codeatlas.llmEndpoint') || undefined;
    const keyOptional = provider === 'ollama' || provider === 'custom';
    const apiKey = (await deps.secrets.get('codeatlas.openRouterApiKey')) ?? '';
    if (!apiKey && !keyOptional) {
        _currentRun = null;
        broadcastToast(deps.wsBridge, 'error', `Specific review needs an API key for provider "${provider}".`);
        return;
    }
    if (provider === 'custom' && !endpoint) {
        _currentRun = null;
        broadcastToast(deps.wsBridge, 'error', 'Provider "custom" needs codeatlas.llmEndpoint set.');
        return;
    }
    const isLocal = provider === 'ollama' || provider === 'custom';
    const model = deps.settings.get<string>('codeatlas.llmModel') || 'openrouter/free';
    // #849 — per-call timeout override (`codeatlas.llmTimeoutMs`, env
    // CODEATLAS_LLM_TIMEOUT_MS). Local reasoning models (e.g. gemma-12B via
    // ollama) can need far more than the 180s default on big review prompts.
    const timeoutOverride = Number(deps.settings.get<number>('codeatlas.llmTimeoutMs')) || 0;
    const cfg = { apiKey, model, timeoutMs: timeoutOverride > 0 ? timeoutOverride : (isLocal ? 180_000 : 30_000), provider, endpoint, allowCustomEndpointAuth: true /* #885 — user-configured endpoint = consent */ };
    const evidenceGate = deps.settings.get<boolean>('codeatlas.evidenceGateEnabled');
    const gateEnabled = evidenceGate !== false;

    // #534 — capture baseline ref for this run.
    const { computeBaselineRef } = await import('../core/llm/baselineRef');
    const baselineRef = computeBaselineRef({ workspaceRoot: deps.workspaceRoot ?? process.cwd(), snapshotStore: deps.snapshotStore });
    deps.log(`[ai-review:specific] baselineRef=${baselineRef.kind}:${baselineRef.ref}`);

    deps.wsBridge.broadcast({
        type: 'aiReviewStarted',
        kind: 'specific',
        prompt: trimmed.slice(0, 200),
        startedAt: _currentRun.startedAt,
        baselineRef,
    });
    deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: true, progress: `Running specific review…` });

    const { sendOpenRouterRequest } = await import('../core/llm/openRouterClient');
    const { runProjectLevelReview } = await import('../core/llm/projectLevelReviewer');

    const callLlm = async ({ system, user }: { system: string; user: string }, opts?: { signal?: AbortSignal }) => {
        const userPlusPrompt = `${user}\n\n[USER-REQUESTED REVIEW FOCUS]\n${trimmed}\n[END]`;
        const resp = await sendOpenRouterRequest(
            cfg,
            [
                { role: 'system', content: system },
                { role: 'user', content: userPlusPrompt },
            ],
            opts?.signal ?? controller.signal,
        );
        // Specific review only drives `runProjectLevelReview`, so we use the
        // project-level extractor (required `filePath`, flatter evidence —
        // see `findingSchema.ts`).
        return extractProjectFindingsJson(String(resp?.text ?? '{}'));
    };

    try {
        deps.wsBridge.broadcast({ type: 'aiReviewProgress', message: 'Scanning project-level files…', completed: 0, total: 1 });
        const result = await runProjectLevelReview({
            store: deps.snapshotStore,
            model,
            llmCall: callLlm,
            evidenceGate: gateEnabled,
            signal: controller.signal,
            baselineRef,
            onFinding: (f) => deps.wsBridge.broadcast({ type: 'aiFindingAdded', entryPointId: f.entryPointId, findings: [f] }),
        });

        if (controller.signal.aborted) {
            deps.wsBridge.broadcast({ type: 'aiReviewCancelled', reason: 'user' });
            broadcastToast(deps.wsBridge, 'warning', 'Specific review cancelled.');
            return;
        }

        const counts = deps.snapshotStore.getAiReviewFindingCounts();
        deps.wsBridge.broadcast({
            type: 'aiReviewComplete',
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
        broadcastToast(deps.wsBridge, 'info', `Specific review done — ${result.findingsCount} findings across ${result.files.length} files.`);
    } catch (err: any) {
        if (controller.signal.aborted) {
            deps.wsBridge.broadcast({ type: 'aiReviewCancelled', reason: 'user' });
            broadcastToast(deps.wsBridge, 'warning', 'Specific review cancelled.');
        } else {
            broadcastToast(deps.wsBridge, 'error', `Specific review failed: ${(err?.message ?? err).slice(0, 200)}`);
        }
    } finally {
        _currentRun = null;
        deps.wsBridge.broadcast({ type: 'aiReviewLoading', loading: false });
    }
}

function broadcastToast(wsBridge: WsBridge, level: 'info' | 'warning' | 'error', text: string): void {
    wsBridge.broadcast({ type: 'clientToast', level, text });
}

// Re-export the `extractFindingsJson` symbol so the existing test at
// `src/standalone/__tests__/extractFindingsJson.test.ts` (which imports
// from this module) keeps working unchanged. The actual implementation
// lives in `core/llm/findingSchema.ts` per Issue #704.
export { extractFindingsJson };
