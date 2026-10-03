/**
 * AiReviewControlCard.tsx
 *
 * Home-page control panel for AI Review (#531). Surfaces three primary
 * actions and shows the current run's status inline:
 *   - Start full review (runs per-entry + project-level passes)
 *   - Cancel (abort signal, fired via WS message)
 *   - Specific review (free-form prompt → one-shot project-level pass)
 *
 * It also exposes a Findings button (count badge + open popover) so the user
 * can deep-link from the home screen straight into the layer that owns each
 * finding — see {@link AiReviewFindingsPopover}.
 *
 * Statuses are driven by the WS message stream the standalone broadcasts:
 *   - aiReviewStarted   → flip to running, capture kind + startedAt
 *   - aiReviewLoading   → keep the spinner visible while loading=true
 *   - aiReviewProgress  → progress text + (completed/total) chip
 *   - aiFindingAdded    → live-bump the count
 *   - aiReviewComplete  → switch to idle with final summary
 *   - aiReviewCancelled → flash a "cancelled" pill then go idle
 */

import React, { useEffect, useRef, useState } from 'react';
import { subscribe, getState } from './ai-review/aiReviewBus';
import { AiReviewFindingsPopover } from './AiReviewFindingsPopover';
import EstimatingCostPanel from './EstimatingCostPanel';
import { AiReviewSetupCard, hasAiReviewConsent } from './AiReviewSetupCard';
import type { LlmConfigPayload } from './llmConfig';

interface ProgressState {
    completed?: number;
    total?: number;
    message?: string;
}

interface AiReviewControlCardProps {
    /** Fired with a message envelope — passed straight to vscodeApi.postMessage. */
    postMessage: (msg: any) => void;
    /**
     * UX-22 follow-up (2026-06-04) — optional active LLM provider name
     * ('openrouter', 'openai', 'ollama', etc.) used to render a more
     * actionable timeout message in `EstimatingCostPanel` ("Check your
     * OpenAI endpoint" beats "Check your LLM endpoint").
     */
    llmProvider?: string;
    /** Optional LLM endpoint URL (when set in settings, often a localhost host:port). */
    llmEndpoint?: string;
    /** Optional model id — shown after the provider for extra context. */
    llmModel?: string;
    /**
     * 2026-06-09 — multi-repo scoping. When set, the review is scoped
     * to this sub-repo: `requestReviewCostEstimate` + `requestFullReview`
     * messages both carry `repoId: selectedRepoId`. Single-repo
     * workspaces (or the workspace-wide review path) leave this null.
     */
    selectedRepoId?: string;
    /** Display label for the scoped repo (used in the chip). Falls back to repoId. */
    selectedRepoLabel?: string;
    /**
     * 2026-06-10 — #813. When true (multi-repo workspaces), render the
     * scope picker chip INSIDE the card so the user doesn't have to
     * hunt for a banner above. Single-repo workspaces leave this false
     * and the chip stays hidden.
     */
    isMultiRepo?: boolean;
    /** Open the scope picker. Required when `isMultiRepo` is true. */
    onPickRepo?: () => void;
    /** Clear the current scope back to workspace-wide. */
    onClearRepo?: () => void;
    /**
     * #918 — first-run onboarding. When true (LLM not yet configured AND
     * consent not yet acknowledged), the first Start click opens a single
     * guided setup card instead of going straight to the cost estimate.
     * Defaults to false so existing callers (and tests) are unaffected.
     */
    needsSetup?: boolean;
    /** Apply the LLM config chosen in the setup card. Required when `needsSetup`. */
    onSetLlmConfig?: (config: LlmConfigPayload) => void;
}

type RunKind = 'full' | 'specific' | null;

/**
 * Issue 608-UI — pending review state captured between the user clicking
 * "Start review" and the cost-estimate modal resolving. We hold the launch
 * args here so the modal's "Continue" can post the actual `requestFullReview`
 * with the correct scope/mode, regardless of which Start button started this.
 */
interface PendingReviewLaunch {
    scope: 'all' | 'changed';
    mode: 'incremental' | 'full';
}

interface CostEstimate {
    entryPointCount: number;
    estimatedUSD: number;
    model: string;
    provider?: string;
    pricingIsEstimate: boolean;
    budgetCapUSD: number;
    willExceedCap: boolean;
    summary: string;
}

export function AiReviewControlCard({ postMessage, llmProvider, llmEndpoint, llmModel, selectedRepoId, selectedRepoLabel, isMultiRepo, onPickRepo, onClearRepo, needsSetup, onSetLlmConfig }: AiReviewControlCardProps): React.ReactElement {
    // UX-22 follow-up: build a single human-readable label for the active
    // LLM target so the cost-estimate timeout error names exactly what's
    // unreachable. Format examples:
    //   "OpenAI (gpt-4o)"
    //   "Ollama at http://localhost:11434"
    //   "OpenRouter"  // fallback when no model/endpoint is set
    const endpointLabel = (() => {
        const provider = (llmProvider ?? '').trim();
        const endpoint = (llmEndpoint ?? '').trim();
        const model = (llmModel ?? '').trim();
        if (!provider && !endpoint) return undefined;
        const providerPretty = provider
            ? provider.charAt(0).toUpperCase() + provider.slice(1)
            : 'LLM';
        if (endpoint && model) return `${providerPretty} (${model}) at ${endpoint}`;
        if (endpoint) return `${providerPretty} at ${endpoint}`;
        if (model) return `${providerPretty} (${model})`;
        return providerPretty;
    })();
    const [running, setRunning] = useState(false);
    const [kind, setKind] = useState<RunKind>(null);
    const [progress, setProgress] = useState<ProgressState>({});
    const [lastCompletedAt, setLastCompletedAt] = useState<number | null>(null);
    const [lastSummary, setLastSummary] = useState<{ findings: number; entryPoints: number; reviewed: number; skipped: number; durationMs: number; kind: RunKind } | null>(null);
    const [cancelledFlash, setCancelledFlash] = useState(false);
    const [noChangeFlash, setNoChangeFlash] = useState(false);
    const [specificOpen, setSpecificOpen] = useState(false);
    const [specificPrompt, setSpecificPrompt] = useState('');
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [counts, setCounts] = useState(getState().counts);
    // Issue 608-UI — cost-estimate confirm modal state. `pendingLaunch` is
    // non-null while we're awaiting (or showing) the modal; `costEstimate`
    // is the server's reply that populates the modal body.
    const [pendingLaunch, setPendingLaunch] = useState<PendingReviewLaunch | null>(null);
    const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
    // #918 — first-run unified setup card. Non-null pendingLaunch + setupOpen
    // means "user clicked Start before setup; hold the intended launch and
    // collect provider/key/consent, then proceed to the cost estimate."
    const [setupOpen, setSetupOpen] = useState(false);
    // Issue #778: in-app modal state for the 🗑 Clear button. Was a
    // blocking browser `confirm()` which jams Chrome MCP automation
    // and renders as an OS-style dialog that doesn't match the rest
    // of the UI. The modal stays open until the user clicks Confirm
    // or Cancel inside it.
    const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);
    const findingsBtnRef = useRef<HTMLButtonElement | null>(null);

    useEffect(() => {
        return subscribe((s) => setCounts(s.counts));
    }, []);

    // #533 — load persisted findings on mount so a freshly-opened tab
    // shows the correct count + popover content without needing the user
    // to open a layer view first. Server replies with `aiFindings`; the
    // bus listener above picks it up.
    //
    // Also (post-#608-UI fix): request the current in-flight review
    // status. If a run is active on the server (e.g. another tab kicked
    // it off, or this tab reloaded mid-review) the reply emits
    // `aiReviewStarted` + `aiReviewLoading: true` so the local `running`
    // state matches and the Cancel-only UI renders correctly.
    // MOUNT-ONLY. The parent passes `postMessage` as an inline arrow
    // (`postMessage={(m) => vscodeApi.postMessage(m)}`), so its identity changes
    // every render. Depending on it here re-fired the effect on every render —
    // each `aiFindings`/`aiReviewLoading` reply re-rendered the card, which
    // re-fired the effect, which re-requested… a tight request/broadcast loop
    // (thousands of `requestAiFindings` per second, flooding the WsBridge log).
    // We only need to prime findings + in-flight status once, on mount.
    const primeRef = useRef(postMessage);
    primeRef.current = postMessage;
    useEffect(() => {
        try { primeRef.current({ type: 'requestAiFindings' }); } catch { /* noop */ }
        try { primeRef.current({ type: 'requestAiReviewStatus' }); } catch { /* noop */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const msg = event.data;
            switch (msg?.type) {
                case 'aiReviewStarted': {
                    setRunning(true);
                    setKind(msg.kind === 'specific' ? 'specific' : 'full');
                    setLastSummary(null);
                    setProgress({ message: 'Starting…' });
                    setCancelledFlash(false);
                    break;
                }
                case 'aiReviewLoading': {
                    if (msg.loading) {
                        setRunning(true);
                        if (msg.progress) setProgress((p) => ({ ...p, message: msg.progress }));
                    } else {
                        setRunning(false);
                    }
                    break;
                }
                case 'aiReviewProgress': {
                    setProgress({
                        completed: typeof msg.completed === 'number' ? msg.completed : undefined,
                        total: typeof msg.total === 'number' ? msg.total : undefined,
                        message: msg.message ?? undefined,
                    });
                    break;
                }
                case 'aiReviewComplete': {
                    const summary = msg.summary ?? {};
                    const totalFindings = (summary.findingsCount ?? 0) + (summary.projectFindings ?? 0);
                    setLastSummary({
                        findings: totalFindings,
                        entryPoints: summary.totalEntryPoints ?? 0,
                        // #916 — capture the denominator: entries actually reviewed + budget-skipped.
                        reviewed: summary.reviewed ?? summary.totalEntryPoints ?? 0,
                        skipped: summary.skipped ?? 0,
                        durationMs: summary.durationMs ?? 0,
                        kind: summary.kind === 'specific' ? 'specific' : kind ?? 'full',
                    });
                    setLastCompletedAt(Date.now());
                    setRunning(false);
                    break;
                }
                case 'aiReviewCancelled': {
                    setCancelledFlash(true);
                    setRunning(false);
                    setTimeout(() => setCancelledFlash(false), 4000);
                    break;
                }
                case 'aiReviewNoChange': {
                    // #535 — dedup hit. Server already re-broadcast findings,
                    // we just need to flip a pill so the user sees feedback.
                    setNoChangeFlash(true);
                    setRunning(false);
                    setTimeout(() => setNoChangeFlash(false), 5000);
                    break;
                }
                case 'reviewCostEstimate': {
                    // Issue 608-UI — server replied with the pre-flight cost
                    // estimate. Populate the modal so the user can confirm or
                    // cancel before any LLM credits are burned.
                    setCostEstimate({
                        entryPointCount: Number(msg.entryPointCount ?? 0),
                        estimatedUSD: Number(msg.estimatedUSD ?? 0),
                        model: String(msg.model ?? ''),
                        provider: msg.provider ? String(msg.provider) : undefined,
                        pricingIsEstimate: !!msg.pricingIsEstimate,
                        budgetCapUSD: Number(msg.budgetCapUSD ?? 0),
                        willExceedCap: !!msg.willExceedCap,
                        summary: String(msg.summary ?? ''),
                    });
                    break;
                }
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [kind]);

    /**
     * Issue 608-UI — two-phase launch. Phase 1: capture the user's intent
     * (scope + mode) and ask the server for a cost estimate. The estimate
     * arrives asynchronously and populates `costEstimate`, which renders the
     * modal. Phase 2 runs inside the modal's Continue handler — the actual
     * `requestFullReview` only fires after the user assents.
     *
     * Skipping the modal: when the estimate is $0 (Ollama / local custom),
     * the modal is irrelevant — we auto-confirm so the user doesn't get
     * paywall friction on a free run. Skipping is purely a UX shortcut; the
     * mid-review budget guard in the orchestrator still owns hard safety.
     */
    const fireCostEstimate = (launch: PendingReviewLaunch) => {
        // 2026-06-09 — multi-repo scoping. When `selectedRepoId` is set
        // the cost estimate (and the downstream `requestFullReview`)
        // both carry `repoId` so the extension scopes the review to
        // that sub-repo. Single-repo workspaces / workspace-wide
        // reviews omit the field.
        const msg: Record<string, unknown> = { type: 'requestReviewCostEstimate', scope: launch.scope };
        if (selectedRepoId) msg.repoId = selectedRepoId;
        postMessage(msg);
    };

    const beginLaunch = (launch: PendingReviewLaunch) => {
        setPendingLaunch(launch);
        setCostEstimate(null);
        // #918 — first-run gate. If the LLM isn't set up yet and the user
        // hasn't acknowledged consent, hold the intended launch and open the
        // unified setup card. The cost estimate fires once setup completes.
        if (needsSetup && !hasAiReviewConsent()) {
            setSetupOpen(true);
            return;
        }
        fireCostEstimate(launch);
    };

    const handleSetupComplete = () => {
        setSetupOpen(false);
        if (pendingLaunch) fireCostEstimate(pendingLaunch);
    };
    const handleSetupCancel = () => {
        setSetupOpen(false);
        setPendingLaunch(null);
    };

    const handleStartFull = () => {
        // #606 — default to incremental: only entry points whose handler
        // source or guidelines hash changed since the last review are sent
        // to the LLM. Per-entry cursors track what's already been reviewed.
        beginLaunch({ scope: 'all', mode: 'incremental' });
    };
    const handleStartChanged = () => {
        beginLaunch({ scope: 'changed', mode: 'incremental' });
    };
    const handleStartForceFull = () => {
        // #606 — escape hatch: ignore cursors and re-review every entry
        // point. Used after a bad prior run or when guidelines drift
        // wasn't detected (e.g. semantic-only edits the hash missed).
        beginLaunch({ scope: 'all', mode: 'full' });
    };

    const handleConfirmLaunch = () => {
        if (!pendingLaunch) return;
        const reviewMsg: Record<string, unknown> = {
            type: 'requestFullReview',
            scope: pendingLaunch.scope,
            mode: pendingLaunch.mode,
        };
        if (selectedRepoId) reviewMsg.repoId = selectedRepoId;
        postMessage(reviewMsg);
        setPendingLaunch(null);
        setCostEstimate(null);
    };
    const handleCancelLaunch = () => {
        setPendingLaunch(null);
        setCostEstimate(null);
    };

    // Issue 608-UI — auto-confirm $0 runs (Ollama / local). The modal would
    // be pointless and add a click for a free review. Fires once when the
    // cost estimate arrives and matches the auto-confirm criteria.
    useEffect(() => {
        if (!pendingLaunch || !costEstimate) return;
        const isFree = costEstimate.estimatedUSD === 0 && !costEstimate.willExceedCap;
        if (isFree) {
            const autoMsg: Record<string, unknown> = {
                type: 'requestFullReview',
                scope: pendingLaunch.scope,
                mode: pendingLaunch.mode,
            };
            if (selectedRepoId) autoMsg.repoId = selectedRepoId;
            postMessage(autoMsg);
            setPendingLaunch(null);
            setCostEstimate(null);
        }
    }, [pendingLaunch, costEstimate, postMessage]);
    const handleCancel = () => {
        postMessage({ type: 'cancelFullReview' });
    };
    const handleSubmitSpecific = () => {
        const text = specificPrompt.trim();
        if (!text) return;
        postMessage({ type: 'requestSpecificReview', prompt: text });
        setSpecificOpen(false);
        setSpecificPrompt('');
    };
    const handleClear = () => {
        // Issue #778: open the in-app confirm modal instead of
        // blocking on `window.confirm`. The post happens in
        // `handleClearConfirmed` when the modal's Confirm fires.
        const total = counts?.total ?? 0;
        if (total === 0) return;
        setShowClearConfirm(true);
    };
    const handleClearConfirmed = () => {
        setShowClearConfirm(false);
        postMessage({ type: 'clearFindings' });
    };
    const handleClearCancelled = () => {
        setShowClearConfirm(false);
    };
    const handleSpecificKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Escape') { e.preventDefault(); setSpecificOpen(false); }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); handleSubmitSpecific(); }
    };

    const totalFindings = counts?.total ?? 0;
    const sevDots = counts?.bySeverity ?? { error: 0, warning: 0, info: 0 };

    return (
        <section
            className="ca-aireview-card"
            data-testid="ai-review-control-card"
            style={{
                background: 'var(--ca-surface, #131316)',
                border: '1px solid var(--ca-border, #232429)',
                borderRadius: '8px',
                padding: '18px',
                marginTop: '16px',
            }}
        >
            {isMultiRepo && onPickRepo && (
                <div
                    data-testid="ai-review-inline-scope"
                    style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}
                >
                    <button
                        type="button"
                        data-testid="ai-review-pick-repo-btn"
                        onClick={onPickRepo}
                        style={{
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '4px 10px',
                            borderRadius: 6,
                            background: selectedRepoId
                                ? 'rgba(96, 165, 250, 0.18)'
                                : 'rgba(248, 113, 113, 0.12)',
                            color: 'var(--ca-text)',
                            border: selectedRepoId
                                ? '1px solid rgba(96, 165, 250, 0.5)'
                                : '1px dashed rgba(248, 113, 113, 0.6)',
                            cursor: 'pointer',
                        }}
                        title={selectedRepoId
                            ? `Click to change the repo this Code Review is scoped to.`
                            : `Click to pick which sub-repo to review. Without a pick the review runs workspace-wide.`}
                    >
                        {selectedRepoId
                            ? `🎯 Scope: ${selectedRepoLabel ?? selectedRepoId} · click to change`
                            : `⚠ Pick a repo to scope the review (else workspace-wide)`}
                    </button>
                    {selectedRepoId && onClearRepo && (
                        <button
                            type="button"
                            data-testid="ai-review-clear-repo-btn"
                            onClick={onClearRepo}
                            style={{
                                fontSize: 10,
                                padding: '4px 8px',
                                borderRadius: 6,
                                background: 'transparent',
                                color: 'var(--ca-text-muted)',
                                border: '1px solid var(--ca-border)',
                                cursor: 'pointer',
                            }}
                            title="Clear the repo scope so the review runs workspace-wide."
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
                    <span aria-hidden>🛡️</span>
                    <span>Code Review</span>
                    {running && (
                        <span
                            data-testid="ai-review-status-pill"
                            style={{
                                fontSize: 10, fontWeight: 700, padding: '2px 8px',
                                background: 'rgba(108,114,203,0.18)', color: 'var(--ca-accent, #6c72cb)',
                                borderRadius: 4, display: 'inline-flex', alignItems: 'center', gap: 6,
                            }}
                        >
                            <span className="ca-aireview-spinner" style={{
                                width: 8, height: 8, borderRadius: '50%',
                                border: '2px solid currentColor', borderTopColor: 'transparent',
                                display: 'inline-block', animation: 'ca-spin 0.8s linear infinite',
                            }} />
                            {kind === 'specific' ? 'SPECIFIC' : 'FULL'} REVIEW
                        </span>
                    )}
                    {!running && cancelledFlash && (
                        <span style={{
                            fontSize: 10, fontWeight: 700, padding: '2px 8px',
                            background: 'rgba(245,158,11,0.18)', color: 'var(--ca-warning, #f59e0b)',
                            borderRadius: 4,
                        }}>CANCELLED</span>
                    )}
                    {!running && noChangeFlash && (
                        <span
                            data-testid="ai-review-nochange-pill"
                            title="Same guidelines + same baseline as the last successful review — no LLM call was made."
                            style={{
                                fontSize: 10, fontWeight: 700, padding: '2px 8px',
                                background: 'rgba(16,185,129,0.18)', color: 'var(--ca-success, #10b981)',
                                borderRadius: 4,
                            }}
                        >NOTHING CHANGED</span>
                    )}
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {totalFindings > 0 && (
                    <button
                        type="button"
                        data-testid="ai-review-clear-btn"
                        onClick={handleClear}
                        title={`Clear ${totalFindings} finding${totalFindings === 1 ? '' : 's'}`}
                        style={{
                            background: 'transparent',
                            color: 'var(--ca-text-dim, #9ca0a8)',
                            border: '1px solid var(--ca-border, #232429)',
                            padding: '6px 10px', fontSize: 12, fontWeight: 500,
                            borderRadius: 6, cursor: 'pointer',
                        }}
                    >
                        🗑 Clear
                    </button>
                )}
                <button
                    ref={findingsBtnRef}
                    type="button"
                    data-testid="ai-review-findings-btn"
                    onClick={() => setPopoverOpen((o) => !o)}
                    aria-expanded={popoverOpen}
                    aria-haspopup="dialog"
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: '8px',
                        background: 'var(--ca-bg, #0a0a0b)',
                        color: 'var(--ca-text, #ececef)',
                        border: '1px solid var(--ca-border, #232429)',
                        padding: '6px 10px', fontSize: 12, fontWeight: 500,
                        borderRadius: 6, cursor: totalFindings > 0 ? 'pointer' : 'default',
                        opacity: totalFindings > 0 ? 1 : 0.6,
                    }}
                    disabled={totalFindings === 0}
                    title={totalFindings > 0 ? 'Open findings popover' : 'No findings yet'}
                >
                    <span aria-hidden>🔎</span>
                    <span>Findings</span>
                    <span style={{
                        fontSize: 11, fontWeight: 700, padding: '1px 7px',
                        background: totalFindings > 0 ? 'var(--ca-accent, #6c72cb)' : 'var(--ca-border, #232429)',
                        color: totalFindings > 0 ? 'white' : 'var(--ca-text-dim, #9ca0a8)',
                        borderRadius: 10,
                    }}>{totalFindings}</span>
                    {totalFindings > 0 && (
                        // Issue #777: separate the total from the
                        // per-severity counts with a visible `·` and add
                        // an `aria-label` to each bucket so screen
                        // readers + DOM scrapes can tell them apart
                        // (was a 6-digit run like `414235`).
                        <span style={{ display: 'inline-flex', gap: 4, marginLeft: 4 }}>
                            <span aria-hidden style={{ fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)' }}>·</span>
                            {sevDots.error > 0 && (<span aria-label={`${sevDots.error} errors`} title={`${sevDots.error} errors`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11 }}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />{sevDots.error}
                            </span>)}
                            {sevDots.warning > 0 && (<span aria-label={`${sevDots.warning} warnings`} title={`${sevDots.warning} warnings`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11 }}>
                                {sevDots.error > 0 && <span aria-hidden style={{ color: 'var(--ca-text-dim, #9ca0a8)' }}>·</span>}
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#f59e0b' }} />{sevDots.warning}
                            </span>)}
                            {sevDots.info > 0 && (<span aria-label={`${sevDots.info} info`} title={`${sevDots.info} info`} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11 }}>
                                {(sevDots.error > 0 || sevDots.warning > 0) && <span aria-hidden style={{ color: 'var(--ca-text-dim, #9ca0a8)' }}>·</span>}
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} />{sevDots.info}
                            </span>)}
                        </span>
                    )}
                </button>
                </div>
            </header>

            {/* Action row */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {selectedRepoId && (
                    <span
                        data-testid="ai-review-repo-chip"
                        title="The review is scoped to this sub-repo. Click `Change` on the home page to re-scope."
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: 'rgba(96, 165, 250, 0.12)',
                            color: 'var(--ca-text)',
                            border: '1px solid rgba(96, 165, 250, 0.4)',
                            maxWidth: 180,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <span style={{ opacity: 0.7, fontSize: 9 }}>scope</span>
                        <span>{selectedRepoLabel ?? selectedRepoId}</span>
                    </span>
                )}
                {!running ? (
                    <>
                        <button
                            type="button"
                            data-testid="ai-review-start-btn"
                            onClick={handleStartFull}
                            style={primaryBtnStyle()}
                        >
                            ▶ Start review
                        </button>
                        <button
                            type="button"
                            data-testid="ai-review-start-changed-btn"
                            onClick={handleStartChanged}
                            title="Review only the entry points whose files differ from baseline"
                            style={ghostBtnStyle()}
                        >
                            ▶ Changed only
                        </button>
                        <button
                            type="button"
                            data-testid="ai-review-force-full-btn"
                            onClick={handleStartForceFull}
                            title="Issue 606: ignore the per-entry review cursor and re-review every entry point from scratch. Use after editing the prompt template, swapping models, or if a prior run produced bad findings."
                            style={ghostBtnStyle()}
                        >
                            ↻ Full re-review
                        </button>
                        <button
                            type="button"
                            data-testid="ai-review-specific-btn"
                            onClick={() => setSpecificOpen((o) => !o)}
                            aria-expanded={specificOpen}
                            style={ghostBtnStyle()}
                        >
                            ✍ Specific review…
                        </button>
                    </>
                ) : (
                    <button
                        type="button"
                        data-testid="ai-review-cancel-btn"
                        onClick={handleCancel}
                        style={cancelBtnStyle()}
                    >
                        ✕ Cancel
                    </button>
                )}
            </div>

            {/* Specific-review input */}
            {specificOpen && !running && (
                <div style={{ marginTop: 12 }}>
                    <textarea
                        data-testid="ai-review-specific-prompt"
                        value={specificPrompt}
                        onChange={(e) => setSpecificPrompt(e.target.value)}
                        onKeyDown={handleSpecificKeyDown}
                        autoFocus
                        rows={3}
                        maxLength={4000}
                        placeholder='What should the reviewer focus on? e.g. "Check auth on every POST/PUT route" or "Audit input validation in the payment flow"'
                        style={{
                            width: '100%', boxSizing: 'border-box',
                            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                            fontSize: 12, lineHeight: 1.55,
                            color: 'var(--ca-text, #ececef)',
                            background: 'var(--ca-bg, #0a0a0b)',
                            border: '1px solid var(--ca-border, #232429)',
                            borderRadius: 6, padding: '10px 12px',
                            minHeight: 64, maxHeight: 240, resize: 'vertical',
                            outline: 'none',
                        }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)' }}>
                        <span>{specificPrompt.length} / 4 000 · ⌘+Enter to run · Esc to cancel</span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button type="button" onClick={() => { setSpecificOpen(false); setSpecificPrompt(''); }} style={ghostBtnStyle()}>Close</button>
                            <button
                                type="button"
                                data-testid="ai-review-specific-run"
                                onClick={handleSubmitSpecific}
                                disabled={specificPrompt.trim().length === 0}
                                style={{ ...primaryBtnStyle(), opacity: specificPrompt.trim() ? 1 : 0.5, cursor: specificPrompt.trim() ? 'pointer' : 'not-allowed' }}
                            >
                                Run review
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Status / progress row */}
            {running && (
                <div
                    data-testid="ai-review-progress-row"
                    style={{
                        marginTop: 12, padding: '10px 12px',
                        background: 'var(--ca-bg, #0a0a0b)',
                        border: '1px solid var(--ca-border, #232429)',
                        borderRadius: 6,
                        fontSize: 12, color: 'var(--ca-text, #ececef)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    }}
                >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {progress.message ?? 'Working…'}
                    </span>
                    {typeof progress.completed === 'number' && typeof progress.total === 'number' && progress.total > 0 && (
                        <span style={{
                            fontSize: 11, fontWeight: 700, padding: '2px 7px',
                            background: 'rgba(108,114,203,0.18)', color: 'var(--ca-accent, #6c72cb)',
                            borderRadius: 10,
                        }}>{progress.completed} / {progress.total}</span>
                    )}
                </div>
            )}

            {/* Last-run summary (after completion, before next run) */}
            {!running && lastSummary && lastCompletedAt && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--ca-text-dim, #9ca0a8)' }} data-testid="ai-review-last-summary">
                    {/* #916 — a clean result is SCOPED to what was reviewed, never a bare "0 findings". */}
                    Last {lastSummary.kind === 'specific' ? 'specific' : 'full'} review · {lastSummary.findings === 0
                        ? `no issues in the ${lastSummary.reviewed} reviewed`
                        : `${lastSummary.findings} findings`}
                    {lastSummary.kind === 'full' ? ` · reviewed ${lastSummary.reviewed}/${lastSummary.entryPoints} entry points` : ''}
                    {lastSummary.skipped > 0 ? ` · ⚠ ${lastSummary.skipped} skipped` : ''}
                    {' '}· {Math.max(1, Math.round(lastSummary.durationMs / 1000))}s
                </div>
            )}

            {/* Issue #758: incremental short-circuit hint. When the
                previous run returned 0 entry points reviewed AND 0
                findings emitted in a non-changed scope, the orchestrator
                short-circuited because every cursor was already stamped
                from a prior full run. Surface a friendly hint so the
                button doesn't look broken. */}
            {!running && lastSummary && lastCompletedAt
                && lastSummary.entryPoints === 0
                && lastSummary.findings === 0
                && lastSummary.kind !== 'specific' && (
                <div style={{ marginTop: 6, padding: '6px 10px', fontSize: 11, background: 'var(--ca-info-bg, rgba(96,165,250,0.08))', border: '1px solid var(--ca-info-border, rgba(96,165,250,0.25))', borderRadius: 4, color: 'var(--ca-info-text, #bfdbfe)' }}>
                    All entry points already reviewed in a prior run. Use <strong>↻ Full re-review</strong> to clear cursors and run a fresh full pass, or <strong>▶ Changed only</strong> to scope to the working diff.
                </div>
            )}

            {/* Findings popover, anchored to the Findings button */}
            <AiReviewFindingsPopover
                open={popoverOpen}
                onClose={() => setPopoverOpen(false)}
                anchorRef={findingsBtnRef}
            />

            {/* Issue 608-UI — pre-flight cost confirm modal. Renders only when
                the user clicked Start, the server replied with an estimate,
                and the estimate is non-zero. Zero-cost runs (Ollama/local)
                auto-skip via the effect above. */}
            {pendingLaunch && costEstimate && costEstimate.estimatedUSD > 0 && (
                <CostConfirmModal
                    estimate={costEstimate}
                    launch={pendingLaunch}
                    onConfirm={handleConfirmLaunch}
                    onCancel={handleCancelLaunch}
                />
            )}

            {/* Loading state while the estimate is in-flight. UX-22 (2026-06-04):
                wraps `EstimatingCostPanel` which adds a Cancel button from t=0
                and flips to a timed-out error state with Retry after 15s so the
                user is never stuck on a silent spinner when the LLM endpoint is
                slow or unreachable. */}
            {/* #918 — first-run unified setup card. While it's open the launch
                is held; the estimating spinner below is suppressed (both gate
                on pendingLaunch) until setup completes and fires the estimate. */}
            {setupOpen && (
                <AiReviewSetupCard
                    initialProvider={llmProvider}
                    initialModel={llmModel}
                    onSetLlmConfig={(cfg) => onSetLlmConfig?.(cfg)}
                    onComplete={handleSetupComplete}
                    onCancel={handleSetupCancel}
                />
            )}

            {pendingLaunch && !costEstimate && !setupOpen && (
                <EstimatingCostPanel
                    onCancel={handleCancelLaunch}
                    onRetry={() => {
                        // Re-issue the same cost-estimate request for the
                        // pending launch — keeps scope + mode + repoId intact.
                        const retryMsg: Record<string, unknown> = {
                            type: 'requestReviewCostEstimate',
                            scope: pendingLaunch.scope,
                            mode: pendingLaunch.mode,
                        };
                        if (selectedRepoId) retryMsg.repoId = selectedRepoId;
                        postMessage(retryMsg);
                    }}
                    endpointLabel={endpointLabel}
                />
            )}

            {/* Issue #778 — in-app clear-findings confirm modal. Replaces
                the old `window.confirm` blocking dialog which jammed
                Chrome MCP automation and didn't match the UI. */}
            {showClearConfirm && (
                <ClearFindingsModal
                    total={counts?.total ?? 0}
                    onConfirm={handleClearConfirmed}
                    onCancel={handleClearCancelled}
                />
            )}

            {/* Inline keyframes for the status pill spinner. Scoped via a unique
                style tag — kept inline so the card has no external CSS dep. */}
            <style>{`@keyframes ca-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </section>
    );
}

/**
 * Issue #778 — replaces `window.confirm` for clearing AI Review findings.
 * Matches the visual language of `CostConfirmModal` so the UX is consistent.
 */
function ClearFindingsModal({
    total,
    onConfirm,
    onCancel,
}: {
    total: number;
    onConfirm: () => void;
    onCancel: () => void;
}): JSX.Element {
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-clear-modal-title"
            data-testid="ai-review-clear-modal"
            style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 1000,
            }}
            onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
            <div
                style={{
                    background: 'var(--ca-bg, #0a0a0b)',
                    border: '1px solid var(--ca-border, #232429)',
                    borderRadius: 8,
                    padding: '20px 24px',
                    minWidth: 360, maxWidth: 480,
                    color: 'var(--ca-text, #ececef)',
                    boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
                }}
            >
                <h3
                    id="ai-clear-modal-title"
                    style={{ margin: 0, fontSize: 14, fontWeight: 600 }}
                >Clear all findings?</h3>
                <p style={{ marginTop: 10, marginBottom: 18, fontSize: 12, color: 'var(--ca-text-dim, #9ca0a8)' }}>
                    Clear {total} AI Review finding{total === 1 ? '' : 's'}? This cannot be undone.
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        data-testid="ai-review-clear-cancel-btn"
                        onClick={onCancel}
                        style={ghostBtnStyle()}
                    >Cancel</button>
                    <button
                        type="button"
                        data-testid="ai-review-clear-confirm-btn"
                        onClick={onConfirm}
                        style={primaryBtnStyle()}
                    >Clear findings</button>
                </div>
            </div>
        </div>
    );
}

/**
 * Issue 608-UI — pre-flight cost confirm modal. Renders the estimate body
 * with a Cancel / Continue choice. Tagged with `data-testid` so unit tests
 * can drive it. Inline styles match the rest of the card (no external CSS).
 */
function CostConfirmModal({
    estimate,
    launch,
    onConfirm,
    onCancel,
}: {
    estimate: CostEstimate;
    launch: PendingReviewLaunch;
    onConfirm: () => void;
    onCancel: () => void;
}): React.ReactElement {
    const scopeLabel = launch.scope === 'changed' ? 'changed entry points' : 'every entry point';
    const modeLabel = launch.mode === 'full' ? 'force-full re-review' : 'incremental';
    return (
        <div
            data-testid="ai-review-cost-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm AI Review cost"
            style={{
                position: 'fixed', inset: 0,
                background: 'rgba(0,0,0,0.55)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 2000,
            }}
            onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
        >
            <div
                style={{
                    background: 'var(--ca-surface, #131316)',
                    border: '1px solid var(--ca-border, #232429)',
                    borderRadius: 10,
                    padding: 20,
                    minWidth: 360, maxWidth: 440,
                    color: 'var(--ca-text, #ececef)',
                    boxShadow: '0 12px 36px rgba(0,0,0,0.45)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span aria-hidden style={{ fontSize: 18 }}>💸</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>Confirm review cost</span>
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 14 }}>
                    <div data-testid="ai-review-cost-summary" style={{ marginBottom: 8 }}>{estimate.summary}</div>
                    <table style={{ width: '100%', fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)', borderCollapse: 'collapse' }}>
                        <tbody>
                            <tr>
                                <td style={{ padding: '3px 0', width: 110 }}>Scope</td>
                                <td>{scopeLabel} · <span style={{ opacity: 0.8 }}>{modeLabel}</span></td>
                            </tr>
                            <tr>
                                <td style={{ padding: '3px 0' }}>Entry points</td>
                                <td data-testid="ai-review-cost-entrypoints">{estimate.entryPointCount}</td>
                            </tr>
                            <tr>
                                <td style={{ padding: '3px 0' }}>Model</td>
                                <td>{estimate.model}{estimate.provider ? ` · ${estimate.provider}` : ''}</td>
                            </tr>
                            <tr>
                                <td style={{ padding: '3px 0' }}>Estimated cost</td>
                                <td data-testid="ai-review-cost-usd" style={{ color: estimate.willExceedCap ? 'var(--ca-warning, #f59e0b)' : undefined }}>
                                    ${estimate.estimatedUSD.toFixed(4)}
                                    {estimate.pricingIsEstimate && (
                                        <span style={{ marginLeft: 6, opacity: 0.7, fontSize: 10 }}>(estimate)</span>
                                    )}
                                </td>
                            </tr>
                            {estimate.budgetCapUSD > 0 && (
                                <tr>
                                    <td style={{ padding: '3px 0' }}>Budget cap</td>
                                    <td>${estimate.budgetCapUSD.toFixed(2)}</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                    {estimate.willExceedCap && (
                        <div
                            data-testid="ai-review-cost-exceed-warn"
                            style={{
                                marginTop: 10, padding: '8px 10px',
                                background: 'rgba(245,158,11,0.12)',
                                color: 'var(--ca-warning, #f59e0b)',
                                borderRadius: 6, fontSize: 11,
                            }}
                        >
                            ⚠ Estimate exceeds the configured budget cap of ${estimate.budgetCapUSD.toFixed(2)}. The
                            mid-review guard will abort the run when ~${estimate.budgetCapUSD.toFixed(2)} is spent;
                            any findings already kept will persist.
                        </div>
                    )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                        type="button"
                        data-testid="ai-review-cost-cancel-btn"
                        onClick={onCancel}
                        style={ghostBtnStyle()}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-testid="ai-review-cost-confirm-btn"
                        onClick={onConfirm}
                        style={primaryBtnStyle()}
                    >
                        Continue
                    </button>
                </div>
            </div>
        </div>
    );
}

function primaryBtnStyle(): React.CSSProperties {
    return {
        background: 'var(--ca-accent, #6c72cb)', color: 'white',
        padding: '7px 14px', fontSize: 12, fontWeight: 600,
        borderRadius: 6, border: 'none', cursor: 'pointer',
    };
}
function cancelBtnStyle(): React.CSSProperties {
    return {
        background: 'var(--ca-bg, #0a0a0b)',
        color: 'var(--ca-warning, #f59e0b)',
        padding: '7px 14px', fontSize: 12, fontWeight: 600,
        borderRadius: 6,
        border: '1px solid var(--ca-warning, #f59e0b)',
        cursor: 'pointer',
    };
}
function ghostBtnStyle(): React.CSSProperties {
    return {
        background: 'transparent', color: 'var(--ca-text, #ececef)',
        padding: '7px 12px', fontSize: 12, fontWeight: 500,
        borderRadius: 6,
        border: '1px solid var(--ca-border, #232429)',
        cursor: 'pointer',
    };
}
