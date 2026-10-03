/**
 * HomePage.tsx
 *
 * Modern card-based dashboard for browser mode.
 * Icon grid layout with hover descriptions, stats, init progress.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import PersonaSelector from './PersonaSelector';
import { OssInterestBanner } from './OssInterestBanner';
import { usePersona, type Persona } from '../state/personaStore';
import { formatAppVersion, type WorkspaceInfo } from '../App';
import type { LlmConfigPayload } from './llmConfig';
import { ReviewGuidelinesCard } from './ReviewGuidelinesCard';
import { AiReviewControlCard } from './AiReviewControlCard';
import { PrWatcherCard } from './PrWatcherCard';
import { ModelExplainer } from './OnboardingHints';
import { INIT_PHASES, phaseStepStatuses, estimateEtaSeconds } from './initProgressPhases';
import { hasAiReviewConsent } from './AiReviewSetupCard';
import AiReviewErrorBanner from './AiReviewErrorBanner';
import LlmConnectionTestButton, { type LlmConnectionTestResult } from './LlmConnectionTestButton';
import ScopePicker from './ScopePicker';
import { RegressionScopePanel, type RegressionScopeData } from './RegressionScopePanel';

interface InitProgress {
    phase: string;
    progress: number;
    message: string;
}

interface CommandCard {
    icon: string;
    title: string;
    description: string;
    /** UX-50h (2026-06-06) — receives the click event so cards backed by
     *  a scope picker can read Shift/Cmd to force a repick (bypassing the
     *  localStorage memoized last-pick). The event is optional so existing
     *  no-arg `() => …` actions still typecheck. */
    action: (e?: React.MouseEvent) => void;
    primary?: boolean;
    disabled?: boolean;
    /**
     * Issue #733 — optional small badge rendered inside the card.
     * Used by the Domains card to toggle LLM refinement without
     * leaving the home page. `on` controls the active styling.
     */
    badge?: {
        label: string;
        on: boolean;
        onClick: () => void;
        title?: string;
    };
}

interface HomePageProps {
    isBrowserMode: boolean;
    onNavigateDiagram?: () => void;
    wsInfo?: WorkspaceInfo | null;
    currentTheme?: 'dark' | 'light';
    onSetLlmConfig?: (config: LlmConfigPayload) => void;
    /**
     * Server-assigned WebSocket client id (received via the `clientId`
     * message). Threaded into deep links like the connect-github URI so
     * the extension can route results back to THIS tab specifically.
     */
    clientId?: string | null;
    /** Issue 609 — classified AI Review error to surface as a banner. */
    aiReviewError?: import('./AiReviewErrorBanner').AiReviewErrorState | null;
    onDismissAiReviewError?: () => void;
    /** Issue #707 — open the Path Finder modal directly. The card needs
     *  a side-channel into App.tsx state (postMessage round-trips through
     *  the server, which has nothing to do for this purely client-side
     *  modal). */
    onOpenPathFinder?: () => void;
    /** UX-50 — repo registry. Passed from App.tsx so HomePage's scope
     *  pickers can group by repo when the workspace is multi-repo. Null /
     *  single-entry list → pickers render flat. */
    repos?: Array<{ repoId: string; name: string; rootPath: string }>;
    /** UX-72 (2026-06-09) — multi-repo init progress counts pushed by the
     *  extension after every workspace cascade. Null in single-repo
     *  workspaces or before first broadcast. */
    multiRepoInitStats?: {
        total: number;
        ready: number;
        parsing: number;
        failed: number;
        stale: number;
        failures: Array<{ repoId: string; name?: string; rootPath?: string; errorMessage?: string }>;
    } | null;
}

// ─── Command definitions ─────────────────────────────────────────────────

function useCommands(
    postMessage: (msg: any) => void,
    runCommand: (cmd: string, label?: string) => void,
    isInitializing: boolean,
    retryInit: () => void,
    currentTheme?: 'dark' | 'light',
    hasGitRemote?: boolean,
    gitHubConnected?: boolean,
    gitHubUser?: { login: string; avatar_url: string; html_url: string },
    editorUriScheme?: string,
    extensionId?: string,
    clientId?: string | null,
    // Issue #733 — domain LLM toggle state + setter. Off by default;
    // the heuristic deterministic system always runs underneath.
    domainLlmEnabled?: boolean,
    onToggleDomainLlm?: () => void,
    onOpenPathFinder?: () => void,
    // UX-50 — opens a per-layer scope picker for Feature Areas / API List
    // / Flow Chart. Single-item workspaces dispatch directly without the
    // modal; empty workspaces fall back to the legacy command.
    // UX-50h — forceRepick=true bypasses the localStorage last-pick memo.
    openScopePicker?: (
        mode: 'features' | 'apis' | 'flow' | 'system-design' | 'map' | 'domain' | 'tour'
            // UX-63 (2026-06-09) — per-repo diff/replay picker modes.
            | 'replay-working' | 'compare-commits' | 'branch-diff' | 'pr-diff'
            | 'replay-pr' | 'replay-branch' | 'timeline-replay'
            // UX-68 (2026-06-09) — per-repo API Testing scope.
            | 'api-testing'
            // UX-69 (2026-06-09) — per-repo Health drill-in.
            | 'health'
            // 2026-06-09 — Sequence card uses the two-step picker
            // (multi-repo: pick repo → pick API; single-repo: pick API).
            | 'sequence'
            // #912 — per-repo Impact (two-step) + Export (single-step).
            | 'impact' | 'export',
        forceRepick?: boolean,
    ) => void,
    isMultiRepo?: boolean,
): { diagrams: CommandCard[]; git: CommandCard[]; tools: CommandCard[] } {
    /**
     * Connect-GitHub click: open the editor's deep link first, which makes
     * the OS focus the editor before VS Code's auth dialog appears (so the
     * user actually sees it instead of it being hidden behind the browser).
     * The `?cid=` query carries our WebSocket client id so the extension
     * can route the success/failure response back to THIS exact tab. If
     * the URI scheme isn't known (older extension version that didn't
     * send these fields), fall back to the WS message — the user has to
     * switch to the editor manually, but at least the auth still kicks off.
     */
    const handleConnectGitHub = () => {
        if (editorUriScheme && extensionId) {
            const cid = clientId ? `?cid=${encodeURIComponent(clientId)}` : '';
            const deepLink = `${editorUriScheme}://${extensionId}/connect-github${cid}`;
            // window.location.assign is more reliable than window.open for
            // custom schemes — Chrome blocks window.open without a user
            // gesture, but assign within a click handler is allowed.
            window.location.href = deepLink;
        } else {
            postMessage({ type: 'connectGitHub' });
        }
    };
    // 3.3.2: auth is no longer required to use any feature. Cards link
    // directly to their target instead of routing through a sign-in nudge.
    return {
        diagrams: [
            // Order (UX, 2026-07-21): the per-layer L1→L5 drill leads; the
            // whole-codebase overviews (Knowledge Map, Domains) sit LAST since
            // users reach for a specific layer first and the overviews are the
            // "zoom all the way out" fallback.
            { icon: '🏗', title: 'System Design', description: isMultiRepo ? 'L1: Pick a repo to see its system design' : 'L1: Services, databases, infra topology', action: (e) => openScopePicker ? openScopePicker('system-design', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'openMicroserviceDiagram' }), disabled: isInitializing },
            // UX-50 — Feature Areas / API List / Flow Chart now drive
            // a per-layer scope picker. Single-item workspaces skip the
            // modal (see openScopePicker); empty workspaces fall back to
            // the legacy workspace-wide / command-bar behaviour. When the
            // picker callback isn't wired (host integration not yet
            // updated), fall back to the prior action so we never break
            // the card.
            // UX-50h — Shift/Cmd-click bypasses the localStorage
            // memoized last-pick and forces the picker to reopen. The
            // hint is in the card's title attribute (via `description`).
            // (2026-07-21) Feature Areas card removed from home — the L2a view is
            // still reached by drilling from L1 / the Knowledge Map.
            { icon: '⚡', title: 'API List', description: 'L2b: One feature’s endpoints in detail — search, filters, schemas', action: (e) => openScopePicker ? openScopePicker('apis', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.openApiExplorer', 'API Explorer'), disabled: isInitializing },
            { icon: '📋', title: 'Sequence', description: isMultiRepo ? 'L3: Pick a repo, then pick an API to see its call flow' : 'L3: Pick an API to see its call flow', action: (e) => openScopePicker ? openScopePicker('sequence', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.searchApiExplorer', 'Sequence'), disabled: isInitializing },
            { icon: '🔀', title: 'Flow Chart', description: 'L5: Pick a function to see its control flow', action: (e) => openScopePicker ? openScopePicker('flow', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.openFunctionFlow', 'Flow'), disabled: isInitializing },
            // Issue #702 / #736 — guided onboarding tour: depth-first
            // walkthrough of the codebase, prev/next/jump controls.
            { icon: '🎓', title: 'Tour', description: isMultiRepo ? 'Pick a repo to start its guided walkthrough.' : 'Guided walkthrough of entry points by call-graph importance (~30 min reading session).', action: (e) => openScopePicker ? openScopePicker('tour', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'requestTour', mode: 'codebase' }), disabled: isInitializing },
            // Issue #601 Phase 1 — API Testing surface (read-only).
            { icon: '🧪', title: 'API Testing', description: isMultiRepo ? 'Pick a repo to test its endpoints' : 'Read-only request browser of every endpoint your codebase exposes', action: (e) => (isMultiRepo && openScopePicker) ? openScopePicker('api-testing', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'requestRoute', route: 'api-testing' }), disabled: isInitializing },
            // Whole-codebase overviews last (2026-07-21) — the "zoom all the way
            // out" views after the per-layer drill.
            // Issue #700 — Knowledge Map: single-canvas unified diagram.
            { icon: '🗺', title: 'Knowledge Map', description: isMultiRepo ? 'L2: Pick a repo to see its knowledge map' : 'Unified view of services + clusters + APIs + infra on one canvas', action: (e) => openScopePicker ? openScopePicker('map', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'openMapDiagram' }), disabled: isInitializing },
            // Issue #701 + #733 — Domains card: business-intent clusters keyed
            // by verb-action ("Authenticate users", "Process payments") rather
            // than module structure. Heuristic always runs; the 🧠 chip toggles
            // optional LLM refinement on top (off by default) without leaving
            // home — chip sends `setDomainLlmRefinement`, server confirms via
            // `domainLlmRefinementState`.
            {
                icon: '🧭',
                title: 'Domains',
                description: isMultiRepo
                    ? 'Pick a repo to see its business-intent clusters. 🧠 toggles LLM refinement.'
                    : 'Business-intent clusters by verb-action. Deterministic heuristic always runs; the 🧠 chip toggles optional LLM refinement on top (off by default).',
                action: (e) => openScopePicker
                    ? openScopePicker('domain', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey))
                    : postMessage({ type: 'openDomainDiagram' }),
                disabled: isInitializing,
                badge: onToggleDomainLlm ? {
                    label: domainLlmEnabled ? '🧠 LLM on' : '🧠 LLM off',
                    on: domainLlmEnabled === true,
                    onClick: onToggleDomainLlm,
                    title: domainLlmEnabled
                        ? 'LLM refinement is ON — heuristic output enhanced by LLM rename / merge / confidence calibration.'
                        : 'LLM refinement is OFF — only the deterministic heuristic runs. Click to enable enhanced naming.',
                } : undefined,
            },
        ],
        git: [
            // Order (2026-07-21): the static Compare Commits / Branch Diff / PR
            // Diff cards were removed — the replay variants below cover the same
            // ground with a richer, animated walkthrough (Timeline Replay ⊇
            // Compare Commits; Replay Branch ⊇ Branch Diff; Replay PR ⊇ PR Diff).
            // Sequence: Timeline Replay, then Working Changes → PR → Branch, then
            // the GitHub connection cards.
            { icon: '⏯', title: 'Timeline Replay', description: isMultiRepo ? 'Pick a repo to replay its commit timeline' : 'Replay commits as a cinematic code walkthrough', action: (e) => openScopePicker ? openScopePicker('timeline-replay', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.timelineReplay', 'Timeline Replay') },
            { icon: '▶', title: 'Replay Working Changes', description: isMultiRepo ? 'Pick a repo to replay its working changes' : 'Replay uncommitted changes vs baseline', action: (e) => openScopePicker ? openScopePicker('replay-working', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'replayWorkingDiff' }) },
            { icon: '▶', title: 'Replay PR', description: isMultiRepo ? 'Pick a repo to replay its PR' : 'Pick a PR and auto-replay its changes layer by layer', action: (e) => openScopePicker ? openScopePicker('replay-pr', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'requestPrDiffReplay' }) },
            { icon: '▶', title: 'Replay Branch', description: isMultiRepo ? 'Pick a repo to replay its branch diff' : 'Replay branch changes as a guided walkthrough', action: (e) => openScopePicker ? openScopePicker('replay-branch', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : postMessage({ type: 'requestBranchDiffReplay' }) },
            ...(hasGitRemote && !gitHubConnected ? [
                { icon: '🔗', title: 'Connect GitHub', description: 'Sign in for PR access to private repos. Editor will be focused for authorization.', action: handleConnectGitHub },
            ] : []),
            ...(hasGitRemote && gitHubConnected && gitHubUser ? [
                { icon: '✓', title: `GitHub: @${gitHubUser.login}`, description: 'Connected — click to view profile on github.com', action: () => window.open(gitHubUser.html_url, '_blank') },
            ] : []),
            ...(hasGitRemote && gitHubConnected && !gitHubUser ? [
                { icon: '✓', title: 'GitHub: Connected', description: 'Authenticated (profile details unavailable)', action: () => {} },
            ] : []),
        ],
        tools: [
            // Re-initialise + Re-sync surface first — they're the "fix it"
            // controls users reach for when state looks wrong. Health Report
            // depends on a populated snapshot, so it follows the rebuild
            // controls rather than leading the section.
            { icon: '▶', title: 'Re-initialize', description: 'Scan workspace and build all diagrams', action: retryInit, disabled: isInitializing },
            { icon: '🔄', title: 'Re-sync', description: 'Full rebuild + reset baseline', action: () => runCommand('codeatlas.resyncEverything', 'Re-sync') },
            { icon: '💊', title: 'Health Report', description: isMultiRepo ? 'Pick a repo to drill into its health' : 'Dead code, god files, coupling, cycles', action: (e) => (isMultiRepo && openScopePicker) ? openScopePicker('health', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.showHealthReport', 'Health Report'), disabled: isInitializing },
            { icon: '🎯', title: 'Impact Analysis', description: isMultiRepo ? 'Pick a repo, then a function — blast radius scoped to that repo' : 'Blast radius for selected file/function', action: (e) => (isMultiRepo && openScopePicker) ? openScopePicker('impact', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.analyzeImpact', 'Impact') },
            // Issue #707 — Path Finder: BFS the call graph between two
            // functions. Self-contained modal; no diagram side-effects.
            { icon: '🧭', title: 'Path Finder', description: isMultiRepo ? 'BFS between two functions — toggle scope inside the modal to widen workspace-wide' : 'BFS the call graph between two functions', action: () => onOpenPathFinder?.(), disabled: isInitializing },
            { icon: '📄', title: 'Export Docs', description: isMultiRepo ? 'Pick a repo to export its Markdown + Mermaid architecture docs' : 'Markdown + Mermaid architecture export', action: (e) => (isMultiRepo && openScopePicker) ? openScopePicker('export', !!(e?.shiftKey || e?.metaKey || e?.ctrlKey)) : runCommand('codeatlas.exportArchitectureDocs', 'Export') },
            { icon: '📊', title: 'Load Coverage', description: 'Import LCOV/Istanbul test coverage (workspace-wide by design)', action: () => runCommand('codeatlas.loadCoverage', 'Coverage') },
            { icon: '🔍', title: 'Search', description: 'Find across all diagram layers (use the in-modal scope toggle to limit to a repo)', action: () => runCommand('codeatlas.search', 'Search') },
            { icon: currentTheme === 'dark' ? '☀' : '☾', title: currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode', description: 'Toggle light/dark theme', action: () => postMessage({ type: 'toggleTheme' }) },
        ],
    };
}

// ─── Card Component ──────────────────────────────────────────────────────

function Card({ card }: { card: CommandCard }) {
    return (
        <button
            className={`ca-card${card.primary ? ' ca-card-primary' : ''}${card.disabled ? ' ca-card-disabled' : ''}`}
            onClick={(e) => card.action(e)}
            disabled={card.disabled}
            title={card.description}
            style={card.badge ? { position: 'relative' } : undefined}
        >
            <span className="ca-card-icon">{card.icon}</span>
            <span className="ca-card-title">{card.title}</span>
            {card.badge && (
                // Issue #733 — inline toggle chip. Click stops propagation
                // so the card's main action doesn't fire; the chip toggles
                // independently via its own onClick.
                <span
                    role="switch"
                    aria-checked={card.badge.on}
                    onClick={(e) => {
                        e.stopPropagation();
                        card.badge!.onClick();
                    }}
                    title={card.badge.title ?? card.badge.label}
                    style={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        padding: '2px 6px',
                        fontSize: 9,
                        fontWeight: 600,
                        borderRadius: 4,
                        border: '1px solid var(--ca-border)',
                        background: card.badge.on
                            ? 'var(--ca-toggle-on-bg, rgba(91,141,239,0.18))'
                            : 'transparent',
                        color: card.badge.on
                            ? 'var(--ca-accent)'
                            : 'var(--ca-text-muted)',
                        cursor: 'pointer',
                        userSelect: 'none' as const,
                    }}
                >
                    {card.badge.label}
                </span>
            )}
        </button>
    );
}

/**
 * Issue #706 — diagram-card filter by persona.
 *
 * Match by card title (string match, not message-type, so the filter
 * tracks the renamed cards from #700/#701/#702 without churn). Keys
 * chosen for readability — the title is the user-facing label.
 *
 *   - Junior: high-level + L2b API List (the three operational layers
 *             a junior dev needs day-to-day; sequence + flow diagrams
 *             come later in their learning curve).
 *   - PM:     high-level only — no API list, no sequence, no flow.
 *   - Power:  unfiltered.
 */
// Auth gate (browser view) — when SIGNED OUT, only workspace-setup + theme cards
// stay active; every diagram / git / analysis-tool card is disabled and re-routes
// to sign-in. Mirrors the server-side allow-list in `src/lib/browserAuthGate.ts`
// (the server is authoritative; this is the matching UX). Titles here map to the
// allowed commands there: initialize/resync/rebuild + theme.
const SIGNED_OUT_ALLOWED_CARDS: ReadonlySet<string> = new Set([
    'Re-initialize', 'Re-sync', 'Light Mode', 'Dark Mode',
]);
function gateCardsWhenSignedOut(cards: CommandCard[], authGated: boolean, onGated: () => void): CommandCard[] {
    if (!authGated) return cards;
    return cards.map((c) => SIGNED_OUT_ALLOWED_CARDS.has(c.title) ? c : { ...c, disabled: true, action: onGated });
}

function filterDiagramsByPersona(cards: CommandCard[], persona: Persona): CommandCard[] {
    if (persona === 'power') return cards;
    const HIGH_LEVEL_TITLES = new Set([
        'Knowledge Map', 'Domains', 'System Design', 'Tour',
    ]);
    const JUNIOR_EXTRA = new Set(['API List']);
    return cards.filter(c => {
        if (HIGH_LEVEL_TITLES.has(c.title)) return true;
        if (persona === 'junior' && JUNIOR_EXTRA.has(c.title)) return true;
        return false;
    });
}

function CardGrid({ cards }: { cards: CommandCard[] }) {
    return (
        <div className="ca-card-grid">
            {cards.map((c, i) => <Card key={i} card={c} />)}
        </div>
    );
}

// ─── Section Divider ─────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
    return (
        <div className="ca-section-divider">
            <span className="ca-section-label">{label}</span>
            <span className="ca-section-line" />
        </div>
    );
}

// ─── LLM Config Defaults ────────────────────────────────────────────────

const LLM_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'ollama', 'custom'] as const;

const LLM_MODEL_PLACEHOLDERS: Record<string, string> = {
    openrouter: 'openrouter/free',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-20250514',
    ollama: 'llama3',
    custom: 'model-name',
};

const LLM_ENDPOINT_DEFAULTS: Record<string, string> = {
    ollama: 'http://localhost:11434/v1/chat/completions',
    custom: 'http://localhost:8080/v1/chat/completions',
};

const PROVIDER_LABELS: Record<string, string> = {
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama (local)',
    custom: 'Custom endpoint',
};

// ─── LLM Config Section ────────────────────────────────────────────────

function LlmConfigSection({ wsInfo, onSetLlmConfig }: { wsInfo: WorkspaceInfo | null; onSetLlmConfig: (config: LlmConfigPayload) => void }) {
    const currentProvider = wsInfo?.llmProvider ?? 'openrouter';
    const currentModel = wsInfo?.llmModel ?? '';
    const currentEndpoint = wsInfo?.llmEndpoint ?? '';
    const isConfigured = currentProvider === 'ollama' || currentProvider === 'custom' || currentModel !== '';

    const [editing, setEditing] = useState(false);
    const [provider, setProvider] = useState(currentProvider);
    const [model, setModel] = useState(currentModel);
    const [endpoint, setEndpoint] = useState(currentEndpoint || LLM_ENDPOINT_DEFAULTS[currentProvider] || '');
    const [apiKey, setApiKey] = useState('');

    // Test-Connection result handshake. The extension host probes the
    // configured LLM endpoint when it receives `testLlmConnection`, then
    // broadcasts `llmConnectionTestResult { ok, message, latencyMs? }`.
    // The button component renders the result; we just stash it here.
    const [testResult, setTestResult] = useState<LlmConnectionTestResult | null>(null);
    useEffect(() => {
        const handler = (e: MessageEvent) => {
            const msg = (e.data ?? {}) as { type?: string };
            if (msg.type === 'llmConnectionTestResult') {
                const m = msg as unknown as LlmConnectionTestResult & { type: string };
                setTestResult({ ok: !!m.ok, message: m.message ?? '', latencyMs: m.latencyMs });
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);
    // Clear the stale result so it doesn't auto-apply to the next test run.
    const handleTestCancel = () => setTestResult(null);

    // Sync form state when wsInfo updates (e.g. after save)
    useEffect(() => {
        if (!editing) {
            setProvider(currentProvider);
            setModel(currentModel);
            setEndpoint(currentEndpoint || LLM_ENDPOINT_DEFAULTS[currentProvider] || '');
        }
    }, [currentProvider, currentModel, currentEndpoint, editing]);

    const handleProviderChange = (p: string) => {
        setProvider(p);
        setEndpoint(LLM_ENDPOINT_DEFAULTS[p] ?? '');
        setModel('');
        setApiKey('');
    };

    const handleSave = () => {
        const payload: LlmConfigPayload = { provider };
        if (apiKey.trim()) payload.apiKey = apiKey.trim();
        if (model.trim()) payload.model = model.trim();
        if (provider === 'ollama' || provider === 'custom') {
            payload.endpoint = endpoint.trim() || LLM_ENDPOINT_DEFAULTS[provider] || '';
        }
        onSetLlmConfig(payload);
        setEditing(false);
        setApiKey('');
    };

    if (!editing) {
        return (
            <div className="ca-llm-status" data-testid="llm-status">
                <div className="ca-llm-card">
                    <table className="ca-llm-table">
                        <tbody>
                            <tr>
                                <td className="ca-llm-table-label">Provider</td>
                                <td className="ca-llm-table-value">{PROVIDER_LABELS[currentProvider] ?? currentProvider}</td>
                            </tr>
                            <tr>
                                <td className="ca-llm-table-label">Model</td>
                                <td className="ca-llm-table-value">{currentModel || <span className="ca-llm-table-empty">not set</span>}</td>
                            </tr>
                            {(currentProvider === 'ollama' || currentProvider === 'custom') && (
                                <tr>
                                    <td className="ca-llm-table-label">Endpoint</td>
                                    <td className="ca-llm-table-value ca-llm-endpoint">{currentEndpoint || LLM_ENDPOINT_DEFAULTS[currentProvider] || <span className="ca-llm-table-empty">not set</span>}</td>
                                </tr>
                            )}
                            <tr>
                                <td className="ca-llm-table-label">API Key</td>
                                <td className="ca-llm-table-value">{(currentProvider === 'ollama') ? <span className="ca-llm-table-empty">not required</span> : <span className="ca-llm-table-dot">{'*'.repeat(8)}</span>}</td>
                            </tr>
                        </tbody>
                    </table>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <button className="ca-llm-btn" onClick={() => setEditing(true)} aria-label="Edit LLM configuration">
                            {isConfigured ? 'Update' : 'Configure'}
                        </button>
                        {/* UX (2026-06-04): Test Connection — verify the
                            configured LLM endpoint is actually reachable
                            BEFORE clicking Start review and tripping the
                            15s cost-estimate timeout (UX-22). */}
                        <LlmConnectionTestButton
                            postMessage={(m) => (window as any).vscodeApi?.postMessage(m)}
                            result={testResult}
                            onCancel={handleTestCancel}
                        />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="ca-llm-form" data-testid="llm-config-form">
            <label className="ca-llm-field">
                <span className="ca-llm-field-label">Provider</span>
                <select
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="ca-llm-select"
                    aria-label="LLM provider"
                >
                    {LLM_PROVIDERS.map(p => (
                        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                    ))}
                </select>
            </label>

            {(provider === 'ollama' || provider === 'custom') && (
                <label className="ca-llm-field">
                    <span className="ca-llm-field-label">Endpoint URL</span>
                    <input
                        type="text"
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                        placeholder={LLM_ENDPOINT_DEFAULTS[provider] ?? 'http://localhost:8080/v1/chat/completions'}
                        className="ca-llm-input"
                        aria-label="LLM endpoint URL"
                    />
                </label>
            )}

            <label className="ca-llm-field">
                <span className="ca-llm-field-label">
                    API Key{provider === 'ollama' ? ' (optional)' : provider === 'custom' ? ' (if required)' : ''}
                </span>
                <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={provider === 'ollama' ? 'Not required' : 'API key...'}
                    className="ca-llm-input"
                    aria-label="API key input"
                />
            </label>

            <label className="ca-llm-field">
                <span className="ca-llm-field-label">Model</span>
                <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={LLM_MODEL_PLACEHOLDERS[provider] ?? 'model-name'}
                    className="ca-llm-input"
                    aria-label="Model name"
                />
            </label>

            <div className="ca-llm-actions">
                <button className="ca-llm-btn ca-llm-btn-primary" onClick={handleSave} aria-label="Save LLM configuration">Save</button>
                <button className="ca-llm-btn" onClick={() => { setEditing(false); setApiKey(''); }} aria-label="Cancel LLM configuration">Cancel</button>
            </div>
        </div>
    );
}

// ─── Main Component ──────────────────────────────────────────────────────

export default function HomePage({ isBrowserMode, onNavigateDiagram, wsInfo: wsInfoProp, currentTheme, onSetLlmConfig, clientId, aiReviewError, onDismissAiReviewError, onOpenPathFinder, repos, multiRepoInitStats }: HomePageProps) {
    const wsInfo = wsInfoProp ?? null;
    // Issue #706 — persona drives visibility of advanced controls.
    const persona: Persona = usePersona();
    const [connected, setConnected] = useState(() => {
        if (!isBrowserMode) return true; // VS Code webview — always "connected"
        return (window as any).vscodeApi?.getConnectionState?.() === 'connected';
    });
    const [initProgress, setInitProgress] = useState<InitProgress | null>(null);
    const [initFailed, setInitFailed] = useState(false);
    const [reviewGuidelines, setReviewGuidelines] = useState<{ text: string; hash: string; updatedAt: number } | null>(null);
    const [evidenceGateEnabled, setEvidenceGateEnabled] = useState<boolean>(true);
    // Issue #733 — domain LLM refinement toggle. Off by default per the
    // "deterministic-system is the core, LLM is complementary" design rule.
    const [domainLlmEnabled, setDomainLlmEnabled] = useState<boolean>(false);
    // Track AI Review in-flight state so sibling cards (ReviewGuidelinesCard,
    // future LlmConfigSection lockouts) can disable mutating controls while
    // a review is running. `aiReviewRunning` mirrors AiReviewControlCard's
    // local `running` state but lives at the HomePage level so it's
    // shareable. Single-source: any `aiReviewLoading` or `aiReviewStarted`
    // / `aiReviewComplete` / `aiReviewCancelled` event updates it.
    const [aiReviewRunning, setAiReviewRunning] = useState<boolean>(false);
    // UX-50 — per-layer scope picker. `pickerMode` is null when no picker
    // is open; one of 'features' / 'apis' / 'flow' otherwise. Items per
    // picker come from `explorerData` (services / clusters / functions).
    type PickerMode = 'features' | 'apis' | 'flow' | 'system-design' | 'map' | 'domain' | 'tour'
        // UX-63 (2026-06-09) — per-repo diff/replay picker modes. Each maps
        // to the matching `parseHash` route via `dispatchPick` setting the
        // hash; App.tsx's hashchange listener forwards `repoId` to the
        // corresponding message handler.
        | 'replay-working' | 'compare-commits' | 'branch-diff' | 'pr-diff'
        | 'replay-pr' | 'replay-branch' | 'timeline-replay'
        // UX-68 (2026-06-09) — per-repo API Testing scope.
        | 'api-testing'
        // UX-69 (2026-06-09) — per-repo Health drill-in.
        | 'health'
        // 2026-06-09 — L3 sequence picker. Step 1 picks the sub-repo,
        // step 2 picks an exposed API. Single-repo workspaces skip step 1.
        | 'sequence'
        // #912 — per-repo Impact (two-step: repo → function/file) + Export
        // (single-step: repo → architecture.md download). Both post their
        // message directly via synthAction (NOT hash-driven — they're actions,
        // not navigable views).
        | 'impact' | 'export';
    const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
    // #827 — regression-scope composition. Requested once on mount (and
    // again on every workspace cascade refresh via `regressionScopeData`
    // re-broadcast); the banner renders only when changes exist.
    const [regressionScope, setRegressionScope] = useState<RegressionScopeData | null>(null);
    const [regressionPanelOpen, setRegressionPanelOpen] = useState(false);
    // 2026-06-09 — two-step picker for `apis` / `flow` / `sequence` in
    // multi-repo. Step 1 picks the sub-repo, step 2 picks the entity
    // (cluster / function / API) WITHIN that repo. When `pickerEntityFilterRepo`
    // is non-null the picker is at step 2 and items are filtered by
    // `item.repoId === pickerEntityFilterRepo`. Null = single-repo / step 1.
    const [pickerEntityFilterRepo, setPickerEntityFilterRepo] = useState<string | null>(null);
    // 2026-06-09 — AI Review repo scope. Picked via a dedicated button
    // next to the AiReviewControlCard in multi-repo workspaces; threaded
    // into the card so `requestReviewCostEstimate` / `requestFullReview`
    // carry `repoId`. Null in single-repo workspaces (workspace-wide).
    const [aiReviewRepoId, setAiReviewRepoId] = useState<string | null>(null);
    const [aiReviewRepoLabel, setAiReviewRepoLabel] = useState<string | null>(null);
    const [aiReviewPickerOpen, setAiReviewPickerOpen] = useState(false);
    const [pickerData, setPickerData] = useState<{
        services: Array<{ id: string; label: string; subtitle?: string; diff?: string; repoId?: string; action?: any }>;
        features: Array<{ id: string; label: string; subtitle?: string; diff?: string; repoId?: string; action?: any }>;
        functions: Array<{ id: string; label: string; subtitle?: string; diff?: string; repoId?: string; action?: any }>;
        // 2026-06-09 — apis slice for the Sequence card (L3).
        apis: Array<{ id: string; label: string; subtitle?: string; diff?: string; repoId?: string; action?: any }>;
    }>({ services: [], features: [], functions: [], apis: [] });
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'workspaceInfo') {
                if (msg.initialized) { setInitProgress(null); setInitFailed(false); }
            }
            // UX-50 — capture explorerData so the picker has fresh items
            // to dispatch from. ExplorerSidebar also listens; both are
            // idempotent.
            if (msg.type === 'explorerData') {
                setPickerData({
                    services: msg.services ?? [],
                    features: msg.features ?? [],
                    functions: msg.functions ?? [],
                    apis: msg.apis ?? [],
                });
            }
            if (msg.type === 'initProgress') {
                // Mirror App.tsx's terminal-phase guard (Issue: progress bar
                // stuck at 100% with "Ready — N files…" after resync). The
                // orchestrator's final emit is `phase: 'complete', progress: 1.0`;
                // App-level cleared its copy but HomePage's local listener
                // kept setting it, so `isInitializing` stayed true forever.
                if (msg.phase === 'complete') {
                    setInitProgress(null);
                    setInitFailed(false);
                    // Resync/init resets the baseline (working === baseline), so
                    // the regression scope is now empty — but the host only sends
                    // it on request. Re-request here so the banner clears
                    // immediately, instead of lingering with a stale change set
                    // until a manual refresh remounts this component (the counts
                    // above already clear via the graph refresh).
                    (window as any).vscodeApi?.postMessage?.({ type: 'requestRegressionScope' });
                } else {
                    setInitProgress({ phase: msg.phase, progress: msg.progress, message: msg.message });
                    setInitFailed(false);
                }
            }
            // #505 — review guidelines responses
            if (msg.type === 'reviewGuidelines' || msg.type === 'reviewGuidelinesUpdated') {
                if (msg.guidelines) setReviewGuidelines(msg.guidelines);
            }
            // #513 — evidence-gate state from server
            if (msg.type === 'evidenceGate') {
                setEvidenceGateEnabled(msg.enabled !== false);
            }
            // Issue #733 — initial value of the domain LLM toggle, plus
            // updates after the user toggles it (server confirms the
            // setting was written successfully).
            if (msg.type === 'domainLlmRefinementState') {
                setDomainLlmEnabled(msg.enabled === true);
            }
            // AI Review running-state — shared across sibling cards. The
            // backend emits aiReviewStarted/aiReviewLoading on start +
            // aiReviewComplete/aiReviewCancelled/aiReviewLoading(false) on
            // end. Mirror those into a single flag here.
            if (msg.type === 'aiReviewStarted') setAiReviewRunning(true);
            if (msg.type === 'aiReviewLoading') setAiReviewRunning(!!msg.loading);
            if (msg.type === 'aiReviewComplete' || msg.type === 'aiReviewCancelled') setAiReviewRunning(false);
            // #827 — regression-scope result. Null scope or empty change
            // set hides the banner (clean workspace).
            if (msg.type === 'regressionScopeData') {
                setRegressionScope(msg.scope ?? null);
            }
        };
        const handleWsStatus = (event: Event) => {
            setConnected((event as CustomEvent).detail === 'connected');
        };
        window.addEventListener('message', handleMessage);
        window.addEventListener('ws-status', handleWsStatus);
        // UX-50 — request explorer data on mount so the scope pickers
        // have items to show. ExplorerSidebar also requests this; the
        // server treats both as idempotent.
        (window as any).vscodeApi?.postMessage?.({ type: 'requestExplorerData' });
        // #827 — one cheap composition pass on mount; short-circuits to an
        // empty scope when working === baseline.
        (window as any).vscodeApi?.postMessage?.({ type: 'requestRegressionScope' });
        return () => {
            window.removeEventListener('message', handleMessage);
            window.removeEventListener('ws-status', handleWsStatus);
        };
    }, []);

    const postMessage = useCallback((msg: any) => {
        (window as any).vscodeApi?.postMessage(msg);
        // UX-50 (2026-06-06) — extended allowlist: the scope-picker
        // dispatches openApiListForCluster / openFunctionFlow /
        // openSequenceForApi / openFileDiagram directly, but those
        // messages were not previously in the home-transition list,
        // so the incoming navigateTo response was silently dropped by
        // App.tsx's `showHomeRef.current` guard (Issue 136). Flipping
        // showHome=false synchronously here matches the existing
        // pattern for openFeatureForService and unblocks the picker.
        if ([
            'openMicroserviceDiagram', 'openFeatureDiagram', 'openFeatureForService',
            'openMapDiagram', 'openDomainDiagram', 'requestTour',
            'openApiListForCluster', 'openFunctionFlow',
            'openSequenceForApi', 'openFileDiagram',
            'requestRoute',
        ].includes(msg.type)) {
            onNavigateDiagram?.();
        }
    }, [onNavigateDiagram]);

    const DIAGRAM_COMMANDS = new Set([
        'codeatlas.showHealthReport', 'codeatlas.openApiExplorer',
        'codeatlas.openFunctionFlow', 'codeatlas.searchApiExplorer',
    ]);

    const runCommand = useCallback((command: string, _label?: string) => {
        postMessage({ type: 'runCommand', command });
        if (command === 'codeatlas.initializeWorkspaceVisuals') {
            setInitProgress({ phase: 'starting', progress: 0, message: 'Starting initialization...' });
            setInitFailed(false);
        }
        if (DIAGRAM_COMMANDS.has(command)) {
            onNavigateDiagram?.();
        }
    }, [postMessage, onNavigateDiagram]);

    const retryInit = useCallback(() => {
        runCommand('codeatlas.initializeWorkspaceVisuals');
    }, [runCommand]);

    // UX-50 — open a per-layer scope picker. Three behaviours:
    //   1. Empty items → legacy fallback (cold-init case).
    //   2. Single item → dispatch directly (zero-click for single-repo +
    //      single-cluster workspaces).
    //   3. Otherwise → show the picker modal.
    //
    // 2026-06-09 — UX-50h (the `localStorage` last-pick memo) was
    // removed. User-reported: in 132-repo `serverless-examples`, the
    // picker was showing on first click of each diagram card but NOT
    // on subsequent clicks of the same card — because the memo silently
    // dispatched the previously-picked repo without re-opening the
    // picker. Across modes the behaviour felt random ("showing up some
    // time and not showing up other times") since users couldn't tell
    // which modes were memoed. The Shift-click bypass was invisible to
    // them. Removing the memo gives the consistent behaviour the card's
    // own description promises ("Pick a repo to see its ..."). Fast
    // re-access remains available via the URL hash deep-link
    // (`#/system-design/<repo>` etc) — that's the documented stable form.

    // Internal helper; the card's onClick reads the keyboard modifier and
    // passes it through so a Shift-click always reopens the picker.
    // 2026-06-09 pivot — system-design and map modes use the same
    // services slice (one entry per sub-repo in multi-repo mode) and
    // synth a per-repo route action client-side so each pick shows
    // ONE repo's diagram (same shape as single-repo mode).
    const synthAction = (mode: PickerMode, item: { id: string; action?: any; repoId?: string }) => {
        const repo = item.id.replace(/^service:/, '');
        if (mode === 'system-design') return { type: 'requestRoute', route: 'system-design', param: repo };
        if (mode === 'map') return { type: 'requestRoute', route: 'map', param: repo };
        if (mode === 'domain') return { type: 'requestRoute', route: 'domain', param: repo };
        if (mode === 'tour') return { type: 'requestTour', mode: 'codebase', repoId: repo };
        // #912 — single-step export: the picked item IS the repo. Post the
        // real per-repo architecture export (App.tsx downloads the result).
        if (mode === 'export') return { type: 'requestArchitectureExport', repoId: item.repoId ?? repo };
        // #912 — two-step impact: at dispatch the item is a function (step 2),
        // carrying its file path + repoId. Analyze that file's blast radius
        // scoped to the picked sub-repo.
        if (mode === 'impact') {
            const filePath = (item as any).action?.filePath;
            if (!filePath) return null;
            return { type: 'requestImpact', filePath, repoId: (item as any).repoId };
        }
        return item.action;
    };
    // 2026-06-09 — Tour doesn't broadcast a `navigateTo` (it pushes
    // `tourSteps` to a custom listener), so the SPA's hash-from-graphId
    // path never fires. Set the hash here so refresh / back / share-link
    // all preserve the per-repo scope the user picked.
    const dispatchPick = (mode: PickerMode, item: { id: string; action?: any; repoId?: string }) => {
        // Hash-driven routes: SPA sets the hash; App.tsx's hashchange
        // listener fires the actual message with `repoId` derived from
        // the URL. Single source of truth = the URL, so refresh / back /
        // share-link all behave consistently.
        const HASH_DRIVEN: PickerMode[] = ['tour', 'replay-working', 'compare-commits', 'branch-diff', 'pr-diff', 'replay-pr', 'replay-branch', 'timeline-replay', 'api-testing', 'health'];
        if (HASH_DRIVEN.includes(mode)) {
            const repo = item.id.replace(/^service:/, '');
            onNavigateDiagram?.();
            window.location.hash = `#/${mode}/${repo}`;
            return;
        }
        const a = synthAction(mode, item);
        if (a) postMessage(a);
    };
    const openScopePickerEx = useCallback((mode: PickerMode, forceRepick: boolean) => {
        // All repo-pickers (including UX-63 diff/replay) draw from the
        // services slice (one item per sub-repo); apis/flow keep their
        // own slices.
        // #912 — 'export' is a single-step repo pick (architecture.md for the
        // chosen sub-repo), so it draws from the services slice like other REPO_MODES.
        const REPO_MODES: PickerMode[] = ['features', 'system-design', 'map', 'domain', 'tour', 'replay-working', 'compare-commits', 'branch-diff', 'pr-diff', 'replay-pr', 'replay-branch', 'timeline-replay', 'api-testing', 'health', 'export'];
        // 2026-06-09 — TWO-STEP modes (multi-repo only): pick repo at
        // step 1, then pick entity at step 2 filtered by the picked
        // repoId. In single-repo workspaces these still go straight to
        // entity-picker (skip step 1).
        // #912 — 'impact' is two-step: repo → function (whose file's blast radius we analyze).
        const TWO_STEP_MODES: PickerMode[] = ['apis', 'flow', 'sequence', 'impact'];
        const isMultiRepoNow = !!(repos && repos.length >= 2);
        const isTwoStep = TWO_STEP_MODES.includes(mode) && isMultiRepoNow;
        // Reset the entity filter every time a fresh picker is opened.
        setPickerEntityFilterRepo(null);
        // For two-step in multi-repo: step 1 draws from the SERVICES
        // slice (the sub-repo list). Step 2 (set when user picks a repo)
        // is handled in the `onPick` branch below.
        const items = isTwoStep
            ? pickerData.services
            : REPO_MODES.includes(mode) ? pickerData.services
                : mode === 'apis' ? pickerData.features
                    : mode === 'sequence' ? pickerData.apis
                        : pickerData.functions;
        if (items.length === 0) {
            if (mode === 'features') postMessage({ type: 'openFeatureDiagram', serviceId: '' });
            else if (mode === 'apis') runCommand('codeatlas.openApiExplorer', 'API Explorer');
            else if (mode === 'system-design') postMessage({ type: 'openMicroserviceDiagram' });
            else if (mode === 'map') postMessage({ type: 'openMapDiagram' });
            else if (mode === 'domain') postMessage({ type: 'openDomainDiagram' });
            else if (mode === 'tour') postMessage({ type: 'requestTour', mode: 'codebase' });
            // UX-63 — empty workspace (cold init) falls back to the
            // legacy workspace-level message. The user gets the
            // same behaviour as before until per-repo data lands.
            else if (mode === 'replay-working') postMessage({ type: 'replayWorkingDiff' });
            else if (mode === 'compare-commits') postMessage({ type: 'requestGitDiff' });
            else if (mode === 'branch-diff') postMessage({ type: 'requestBranchDiff' });
            else if (mode === 'pr-diff') runCommand('codeatlas.openPrDiff', 'PR Diff');
            else if (mode === 'replay-pr') postMessage({ type: 'requestPrDiffReplay' });
            else if (mode === 'replay-branch') postMessage({ type: 'requestBranchDiffReplay' });
            else if (mode === 'timeline-replay') runCommand('codeatlas.timelineReplay', 'Timeline Replay');
            else if (mode === 'api-testing') postMessage({ type: 'requestRoute', route: 'api-testing' });
            else if (mode === 'health') runCommand('codeatlas.showHealthReport', 'Health Report');
            else if (mode === 'sequence') runCommand('codeatlas.searchApiExplorer', 'Sequence');
            // #912 — empty workspace: fall back to the workspace-wide commands.
            else if (mode === 'impact') runCommand('codeatlas.analyzeImpact', 'Impact');
            else if (mode === 'export') postMessage({ type: 'requestArchitectureExport' });
            else runCommand('codeatlas.openFunctionFlow', 'Flow');
            return;
        }
        if (items.length === 1) {
            dispatchPick(mode, items[0]);
            return;
        }
        // 2026-06-09 — UX-50h memo shortcut removed. The picker always
        // opens for multi-item slices so the behaviour is consistent
        // across diagram cards regardless of prior pick history.
        // `forceRepick` is kept in the signature for back-compat with
        // existing card actions that pass shift/cmd/ctrl modifier state,
        // but it's now a no-op (every click is effectively a repick).
        void forceRepick;
        setPickerMode(mode);
    }, [pickerData, postMessage, runCommand]);

    const openScopePicker = useCallback((mode: PickerMode, forceRepick: boolean = false) => {
        openScopePickerEx(mode, forceRepick);
    }, [openScopePickerEx]);

    useEffect(() => {
        if (!initProgress) return;
        // Stall watchdog. Reset whenever EITHER the progress fraction OR the
        // phase/message advances — a large workspace (e.g. polar: 3.3k files)
        // can sit at a coarse % like "Scanning…" for a while while still
        // emitting message updates, and that must NOT be flagged "stuck".
        // Only a genuinely frozen init (no progress AND no message change for
        // the whole window) trips the banner. Window widened 60s → 120s so
        // slow-but-progressing cold inits on big multi-repos don't false-fail.
        const timer = setTimeout(() => {
            if (initProgress && initProgress.progress < 0.95) setInitFailed(true);
        }, 120000);
        return () => clearTimeout(timer);
    }, [initProgress?.progress, initProgress?.phase, initProgress?.message]);

    const isInitializing = initProgress !== null && !initFailed;
    // #918 — capture the wall-clock start of init so we can extrapolate a
    // rough ETA. Set once when progress first appears; cleared when it ends.
    const initStartRef = useRef<number | null>(null);
    useEffect(() => {
        if (initProgress && initStartRef.current === null) initStartRef.current = Date.now();
        if (!initProgress) initStartRef.current = null;
    }, [initProgress]);
    const initEtaSeconds = (isInitializing && initProgress && initStartRef.current !== null)
        ? estimateEtaSeconds(initProgress.progress, Date.now() - initStartRef.current)
        : null;
    const initStepStatuses = isInitializing && initProgress
        ? phaseStepStatuses(initProgress.phase)
        : null;
    // #918 — first-run AI-review gate. The unified setup card shows on the
    // first Start click only when the LLM isn't configured yet AND consent
    // hasn't been acknowledged. Local providers (ollama/custom) or a set model
    // count as configured; the AiReviewControlCard also re-checks consent at
    // click time so a stale `true` here never re-prompts after setup.
    const aiReviewLlmConfigured = (wsInfo?.llmProvider === 'ollama')
        || (wsInfo?.llmProvider === 'custom')
        || ((wsInfo?.llmModel ?? '') !== '');
    const aiReviewNeedsSetup = !aiReviewLlmConfigured && !hasAiReviewConsent();
    // Issue #733 — toggling the chip writes the setting + asks the
    // server to re-run the (heuristic + LLM) Domain pass. The badge
    // doesn't optimistically flip — it waits for the
    // `domainLlmRefinementState` echo so the UI matches the
    // persisted state.
    const handleToggleDomainLlm = useCallback(() => {
        postMessage({ type: 'setDomainLlmRefinement', enabled: !domainLlmEnabled });
    }, [postMessage, domainLlmEnabled]);
    const isMultiRepoWorkspace = (repos?.length ?? 0) >= 2;
    const commands = useCommands(
        postMessage, runCommand, isInitializing, retryInit, currentTheme,
        wsInfo?.hasGitRemote, wsInfo?.gitHubConnected, wsInfo?.gitHubUser,
        wsInfo?.editorUriScheme, wsInfo?.extensionId, clientId,
        domainLlmEnabled, handleToggleDomainLlm, onOpenPathFinder,
        openScopePicker, isMultiRepoWorkspace,
    );

    // Auth gate: in the browser view, a signed-out user may only initialize /
    // re-sync (+ sign in + toggle theme). Everything else is disabled and prompts
    // sign-in. The server enforces this authoritatively; this is the UX.
    //
    // `authResolved` gates the FLICKER, not the user: before the WS handshake
    // completes `wsInfo` is undefined (auth UNKNOWN). Treating unknown as
    // signed-out flashed the gate banner + "Sign in" on first paint for a
    // signed-in user, then flipped to the user chip once workspaceInfo landed.
    // We show neither the gate nor the sign-in/out chip until auth is known.
    const authResolved = wsInfo != null;
    const authGated = isBrowserMode && authResolved && !wsInfo?.isAuthenticated;
    const promptSignIn = useCallback(() => runCommand('codeatlas.login', 'Sign in'), [runCommand]);

    // #544 — support button mailto. Pre-fills subject + body so the user
    // can drop straight into the message without copying diagnostics by hand.
    const supportMailto = (() => {
        const subject = encodeURIComponent('CodeAtlas — issue / feedback');
        const lines = [
            formatAppVersion(wsInfoProp?.mcpServerVersion),
            `Mode: ${isBrowserMode ? 'standalone / browser' : 'VS Code extension'}`,
            `Workspace: ${wsInfo?.name ?? '(not loaded)'}`,
            `Counts: files=${wsInfo?.fileCount ?? '—'} apis=${wsInfo?.apiCount ?? '—'} services=${wsInfo?.serviceCount ?? '—'} clusters=${wsInfo?.clusterCount ?? '—'}`,
            '',
            'Describe the issue or feedback:',
            '',
            '',
            '---',
            '(Optional) Steps to reproduce, expected vs actual, any screenshots — paste below.',
        ];
        const body = encodeURIComponent(lines.join('\n'));
        return `mailto:vamsi.iiita+codeatlas@gmail.com?subject=${subject}&body=${body}`;
    })();

    return (
        <div className="ca-home">
            {/* Header */}
            <div className="ca-home-header">
                <h1 className="ca-home-title">
                    <span className="ca-home-logo">◈</span> CodeAtlas
                    <span
                        className="ca-home-version"
                        title={wsInfoProp?.mcpServerVersion
                            ? `Served by @codeatlas/mcp v${wsInfoProp.mcpServerVersion}`
                            : `CodeAtlas extension version ${__CODEATLAS_VERSION__}${__CODEATLAS_BUILD__ ? ` build ${__CODEATLAS_BUILD__}` : ''}`}
                    >
                        {wsInfoProp?.mcpServerVersion
                            ? `MCP v${wsInfoProp.mcpServerVersion}`
                            : `v${__CODEATLAS_VERSION__}${__CODEATLAS_BUILD__ ? `.${__CODEATLAS_BUILD__}` : ''}`}
                    </span>
                    {/* #544 — Support button next to the version stamp. Tertiary
                        styling so it doesn't compete with primary actions; gentle
                        hover lift, Claude-style. */}
                    <a
                        href={supportMailto}
                        data-testid="ca-home-support-btn"
                        title="Email the maintainer with a bug report or feedback"
                        className="ca-home-support-btn"
                    >🛟 Get support</a>
                </h1>
                <p className="ca-home-subtitle">
                    {wsInfo?.name ? `${wsInfo.name} — ` : ''}Architecture Visualization
                </p>
                {/* Issue #706 — persona selector. Sits in the header so
                    it's reachable from any view but doesn't compete with
                    diagram cards. */}
                <div style={{ marginTop: 6, display: 'inline-flex' }}>
                    <PersonaSelector />
                </div>
                {isBrowserMode && (
                    <div className={`ca-home-status ${connected ? 'connected' : 'disconnected'}`} role="status" aria-live="polite">
                        <span className="ca-home-status-dot" aria-hidden="true" />
                        <span>{connected ? 'Connected to CodeAtlas server' : 'Server connection lost — auto-reconnecting…'}</span>
                        {!connected && (
                            <button className="ca-home-reconnect-btn" onClick={() => window.location.reload()}>Reload</button>
                        )}
                    </div>
                )}
                {/* Sign-in / signed-in user chip (browser view). Re-surfaced so
                    users can log in and see their account; opens the dashboard
                    /auth flow via the host `codeatlas.login` command. Hidden until
                    auth is resolved so we never flash "Sign in" at a signed-in
                    user (or vice-versa) on first paint. */}
                {isBrowserMode && authResolved && (
                    <div style={{ marginTop: 8 }}>
                        {wsInfo?.isAuthenticated ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                <span
                                    data-testid="ca-home-user-chip"
                                    title={wsInfo.userEmail}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid rgba(139,92,246,0.30)', background: 'rgba(139,92,246,0.07)' }}
                                >
                                    👤 {wsInfo.userFirstName || wsInfo.userEmail || 'Signed in'}
                                </span>
                                <button
                                    data-testid="ca-home-signout-btn"
                                    onClick={() => runCommand('codeatlas.logout', 'Sign out')}
                                    style={{ fontSize: 11, padding: '2px 9px', borderRadius: 999, border: '1px solid rgba(148,163,184,0.35)', background: 'transparent', cursor: 'pointer', color: 'inherit', opacity: 0.75 }}
                                >
                                    Sign out
                                </button>
                            </span>
                        ) : (
                            <button
                                data-testid="ca-home-signin-btn"
                                onClick={() => runCommand('codeatlas.login', 'Sign in')}
                                style={{ fontSize: 12, padding: '3px 12px', borderRadius: 999, border: '1px solid rgba(139,92,246,0.35)', background: 'rgba(139,92,246,0.10)', cursor: 'pointer', color: 'inherit' }}
                            >
                                Sign in
                            </button>
                        )}
                    </div>
                )}
                {/* Auth gate — signed-out browser users must sign in to view
                    diagrams / use tools; only initialize + re-sync stay available. */}
                {authGated && (
                    <div
                        data-testid="ca-home-auth-gate"
                        style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(139,92,246,0.30)', background: 'rgba(139,92,246,0.07)', fontSize: 12, maxWidth: 620, lineHeight: 1.5 }}
                    >
                        🔒 <strong>Sign in to view your diagrams and use the tools.</strong> You can still initialize / re-sync your workspace while signed out.
                        <button
                            data-testid="ca-home-gate-signin"
                            onClick={promptSignIn}
                            style={{ marginLeft: 8, fontSize: 12, padding: '2px 10px', borderRadius: 999, border: '1px solid rgba(139,92,246,0.35)', background: 'rgba(139,92,246,0.12)', cursor: 'pointer', color: 'inherit' }}
                        >
                            Sign in
                        </button>
                    </div>
                )}
                {/* Open-source-interest banner — browser view only (MCP build has
                    no editor notification). Registration + login live on the dashboard. */}
                {isBrowserMode && <OssInterestBanner />}
            </div>

            {/* Init Progress — #918: named phase breadcrumb + rough ETA, not a bare bar. */}
            {isInitializing && (
                <div className="ca-home-init-progress">
                    <div className="ca-home-init-header">
                        <span className="ca-home-spinner" />
                        <span className="ca-home-init-phase">{initProgress.message}</span>
                    </div>
                    {initStepStatuses && (
                        <div className="ca-home-init-steps" data-testid="ca-init-phase-steps" aria-label="Initialization phases">
                            {INIT_PHASES.map((p, i) => {
                                const status = initStepStatuses[i];
                                return (
                                    <span
                                        key={p.label}
                                        className={`ca-home-init-step ca-home-init-step-${status}`}
                                        data-status={status}
                                        aria-current={status === 'active' ? 'step' : undefined}
                                    >
                                        {status === 'done' ? '✓ ' : ''}{p.label}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                    <div className="ca-home-progress-bar">
                        <div className="ca-home-progress-fill" style={{ width: `${Math.max(5, initProgress.progress * 100)}%` }} />
                    </div>
                    <div className="ca-home-init-footer">
                        <span className="ca-home-init-pct">{Math.round(initProgress.progress * 100)}%</span>
                        {initEtaSeconds !== null && (
                            <span className="ca-home-init-eta" data-testid="ca-init-eta">~{initEtaSeconds}s remaining</span>
                        )}
                    </div>
                </div>
            )}

            {/* UX-72 (2026-06-09) — multi-repo init progress banner. Renders
                whenever the extension has broadcast per-repo `ready`/`parsing`/
                `failed`/`stale` counts for the workspace cascade. Hidden in
                single-repo workspaces (total <= 1) and once everything is
                green (no failed/parsing/stale and no failures), so the
                home page stays clean on the happy path. */}
            {multiRepoInitStats && multiRepoInitStats.total > 1
                && (multiRepoInitStats.failed > 0 || multiRepoInitStats.parsing > 0 || multiRepoInitStats.stale > 0)
                && (
                <div
                    role="status"
                    aria-live="polite"
                    style={{
                        margin: '12px 24px',
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: '1px solid var(--ca-border)',
                        background: multiRepoInitStats.failed > 0
                            ? 'rgba(239, 68, 68, 0.08)'
                            : 'rgba(234, 179, 8, 0.08)',
                        fontSize: 13,
                        color: 'var(--ca-text)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                    }}
                    data-testid="ca-multirepo-init-banner"
                >
                    <span>
                        <strong>Workspace init:</strong>{' '}
                        {multiRepoInitStats.ready}/{multiRepoInitStats.total} ready
                        {multiRepoInitStats.parsing > 0 && <> · {multiRepoInitStats.parsing} parsing</>}
                        {multiRepoInitStats.failed > 0 && <> · <span style={{ color: 'var(--ca-danger)' }}>{multiRepoInitStats.failed} failed</span></>}
                        {multiRepoInitStats.stale > 0 && <> · {multiRepoInitStats.stale} stale</>}
                    </span>
                    {multiRepoInitStats.failures.length > 0 && (
                        <span
                            title={multiRepoInitStats.failures
                                .slice(0, 10)
                                .map(f => `${f.name ?? f.rootPath ?? f.repoId}: ${f.errorMessage ?? 'unknown error'}`)
                                .join('\n')}
                            style={{
                                fontSize: 11,
                                color: 'var(--ca-text-muted)',
                                cursor: 'help',
                                textDecoration: 'underline dotted',
                            }}
                        >
                            hover for details
                        </span>
                    )}
                </div>
            )}
            {/* #827 — regression-scope banner. Only renders when the
                working snapshot differs from the baseline; clicking opens
                the full panel (tests to run + untested blast radius). */}
            {(regressionScope?.changedEntities?.length ?? 0) > 0 && (
                <button
                    type="button"
                    data-testid="ca-regression-scope-banner"
                    onClick={() => setRegressionPanelOpen(true)}
                    style={{
                        margin: '12px 24px',
                        padding: '10px 14px',
                        borderRadius: 8,
                        border: '1px solid var(--ca-border)',
                        background: 'rgba(59, 130, 246, 0.08)',
                        fontSize: 13,
                        color: 'var(--ca-text)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 12,
                        cursor: 'pointer',
                        textAlign: 'left',
                        width: 'calc(100% - 48px)',
                    }}
                >
                    <span>
                        🧪 <strong>Regression scope:</strong>{' '}
                        {regressionScope!.changedEntities.length} changed ·{' '}
                        {regressionScope!.testsToRun.length} test file{regressionScope!.testsToRun.length === 1 ? '' : 's'} to run
                        {regressionScope!.untestedBlastRadius.length > 0 && (
                            <> · <span style={{ color: '#eab308' }}>{regressionScope!.untestedBlastRadius.length} untested in blast radius</span></>
                        )}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ca-text-muted)' }}>view →</span>
                </button>
            )}
            {regressionPanelOpen && regressionScope && (
                <RegressionScopePanel
                    scope={regressionScope}
                    onClose={() => setRegressionPanelOpen(false)}
                    onOpenFile={(filePath) => postMessage({ type: 'openSource', filePath })}
                />
            )}
            {initFailed && (
                <div className="ca-home-init-failed" role="alert">
                    <span className="ca-home-init-failed-icon" aria-hidden>⚠</span>
                    <span className="ca-home-init-failed-text">
                        Initialization seems stuck or failed.
                    </span>
                    <button
                        type="button"
                        className="ca-home-init-failed-retry"
                        onClick={retryInit}
                    >
                        Retry
                    </button>
                </div>
            )}

            {/* #919 — one-time model explainer (layers = canvas, overlays = lens,
                anchors = join key). Dismissable; remembered in localStorage. */}
            <ModelExplainer />

            {/* #917 — extraction GAP banner: a known HTTP framework was detected
                but yielded 0 routes. Surfaces under-detection so a thin diagram
                doesn't silently read as "nothing here". */}
            {wsInfo?.initialized && wsInfo.extractionConfidence && wsInfo.extractionConfidence.gaps.length > 0 && (
                <div
                    className="ca-home-gap-banner"
                    role="status"
                    data-testid="extraction-gap-banner"
                    style={{
                        margin: '0 0 12px', padding: '8px 12px', fontSize: 12, borderRadius: 6,
                        background: 'var(--ca-warn-bg, rgba(217,119,6,0.10))',
                        border: '1px solid var(--ca-warn-border, rgba(217,119,6,0.35))',
                        color: 'var(--ca-warn-text, #fbbf24)',
                    }}
                >
                    ⚠ Detected {wsInfo.extractionConfidence.gaps.length === 1 ? 'a known framework' : `${wsInfo.extractionConfidence.gaps.length} services with known frameworks`} but found <strong>0 routes</strong>:{' '}
                    {wsInfo.extractionConfidence.gaps.slice(0, 4).map(g => `${g.service} (${g.technology})`).join(', ')}
                    {wsInfo.extractionConfidence.gaps.length > 4 ? ` +${wsInfo.extractionConfidence.gaps.length - 4} more` : ''}
                    {' '}— possible detection gap, not necessarily an empty API.
                </div>
            )}

            {/* #917 — extraction confidence chip: entry-point total + framework breadth. */}
            {wsInfo?.initialized && wsInfo.extractionConfidence && wsInfo.extractionConfidence.frameworkCount > 0 && (
                <div
                    data-testid="extraction-confidence-chip"
                    style={{ margin: '0 0 10px', fontSize: 11, color: 'var(--ca-text-dim, #9ca0a8)' }}
                >
                    {wsInfo.extractionConfidence.totalEntryPoints} entry point{wsInfo.extractionConfidence.totalEntryPoints === 1 ? '' : 's'} across {wsInfo.extractionConfidence.frameworkCount} framework{wsInfo.extractionConfidence.frameworkCount === 1 ? '' : 's'}
                </div>
            )}

            {/* Stats — workspace coverage at a glance. One flat row, equal
                weight per cell: source counts and diagram counts are part of
                the same overview. */}
            <div className="ca-home-stats">
                {/* Issue UX-11 (2026-06-03) — stat cards are now buttons
                    that navigate to the matching layer. A new dev's instinct
                    "click 27 APIs to see the list" finally works.
                    Issue UX-12 — stats whose matching diagram is hidden
                    by the current persona are filtered out so we never
                    surface a stat that leads nowhere. */}
                {([
                    {
                        value: wsInfo?.initialized ? wsInfo.fileCount : (isInitializing ? '...' : '—'),
                        label: wsInfo?.fileCount === 1 ? 'File' : 'Files',
                        action: () => runCommand('codeatlas.openMapDiagram', 'Knowledge Map'),
                        always: true,
                    },
                    {
                        value: wsInfo?.initialized ? wsInfo.apiCount : (isInitializing ? '...' : '—'),
                        label: wsInfo?.apiCount === 1 ? 'API' : 'APIs',
                        action: () => runCommand('codeatlas.openApiExplorer', 'API List'),
                        // API List card is hidden on PM persona.
                        hideOnPersonae: ['pm'] as const,
                        // UX-59 (2026-06-06) — the home counter includes
                        // every entry point (routes, middleware, signals,
                        // jobs, seeds). The L1 service-node body line
                        // shows only HTTP-reachable routes. Tooltip
                        // surfaces the distinction so a "26 vs 27" drift
                        // between L1 and home doesn't look like a bug.
                        title: 'All entry points: HTTP routes, middleware, background jobs, signals, model hooks, etc. The L1 system-design diagram shows only HTTP-reachable routes per service.',
                    },
                    {
                        value: wsInfo?.initialized ? wsInfo.serviceCount : (isInitializing ? '...' : '—'),
                        label: wsInfo?.serviceCount === 1 ? 'Service' : 'Services',
                        action: () => postMessage({ type: 'openMicroserviceDiagram' }),
                        always: true,
                    },
                    {
                        value: wsInfo?.initialized ? wsInfo.clusterCount : (isInitializing ? '...' : '—'),
                        label: wsInfo?.clusterCount === 1 ? 'Feature' : 'Features',
                        action: () => postMessage({ type: 'openFeatureDiagram', serviceId: '' }),
                        always: true,
                    },
                    // v2 phase 3 #484 — render the Screens chip only when
                    // the workspace has at least one FE/mobile screen, to
                    // avoid cluttering backend-only repos with a "0
                    // Screens" stat that carries no signal.
                    ...((wsInfo?.screenCount ?? 0) > 0
                        ? [{
                            value: wsInfo?.initialized ? (wsInfo.screenCount ?? 0) : (isInitializing ? '...' : '—'),
                            label: wsInfo?.screenCount === 1 ? 'Screen' : 'Screens',
                            action: () => postMessage({ type: 'openFeatureDiagram', serviceId: '' }),
                            always: true,
                        }]
                        : []),
                    {
                        value: wsInfo?.initialized ? (wsInfo.fileGraphCount ?? 0) : (isInitializing ? '...' : '—'),
                        label: 'File diagrams',
                        action: () => runCommand('codeatlas.openApiExplorer', 'File diagrams'),
                        // File-level diagrams are code-level; PM hides them.
                        hideOnPersonae: ['pm'] as const,
                    },
                    {
                        value: wsInfo?.initialized ? (wsInfo.flowGraphCount ?? 0) : (isInitializing ? '...' : '—'),
                        label: 'Function diagrams',
                        action: () => runCommand('codeatlas.openFunctionFlow', 'Function diagrams'),
                        // Flow chart hidden on Junior + PM personae.
                        hideOnPersonae: ['junior', 'pm'] as const,
                    },
                    {
                        value: wsInfo?.initialized ? (wsInfo.sequenceGraphCount ?? 0) : (isInitializing ? '...' : '—'),
                        label: 'Sequence diagrams',
                        action: () => runCommand('codeatlas.searchApiExplorer', 'Sequence diagrams'),
                        // Sequence diagram hidden on Junior + PM personae.
                        hideOnPersonae: ['junior', 'pm'] as const,
                    },
                ] as Array<{
                    value: any;
                    label: string;
                    action?: () => void;
                    always?: boolean;
                    hideOnPersonae?: ReadonlyArray<string>;
                    title?: string;
                }>)
                    .filter(s => s.always || !s.hideOnPersonae?.includes(persona))
                    .map((s, i) => (
                        <button
                            type="button"
                            className="ca-home-stat ca-home-stat-clickable"
                            key={i}
                            onClick={s.action}
                            disabled={!s.action || isInitializing || s.value === '—'}
                            // UX-59 (2026-06-06) — per-stat tooltip wins
                            // over the default "Open X" so callers can
                            // disambiguate counts that look inconsistent
                            // with other surfaces (e.g. L1 vs home APIs).
                            title={s.title ?? (s.action ? `Open ${s.label}` : undefined)}
                            aria-label={`${s.value} ${s.label} — open`}
                        >
                            <span className="ca-home-stat-value">{s.value}</span>
                            <span className="ca-home-stat-label">{s.label}</span>
                        </button>
                    ))}
            </div>

            {/* #543 — two-column layout: dashboard on the left, AI on the right.
                Wraps to single column under 1024px so narrow viewports stay
                vertical. The grid is the only layout change; section contents
                are unchanged. */}
            <div
                className="ca-home-grid"
                style={{
                    display: 'grid',
                    /* Left column gets ~60% of the space, vertical rule, then
                       right AI column with a 380–520px cap so AI surfaces stay
                       readable on ultra-wide displays without dominating the
                       dashboard. */
                    gridTemplateColumns: 'minmax(0, 1.4fr) 1px minmax(380px, 520px)',
                    gap: 32,
                    alignItems: 'stretch',
                }}
            >
                <div className="ca-home-grid-main">
                    <SectionLabel label="Diagrams" />
                    {/* Issue #706 — PM persona keeps only the high-level
                        diagrams (Knowledge Map / Domains / System Design /
                        Feature Areas / Tour). Junior persona keeps the
                        same plus L2b (API List). Power persona shows all. */}
                    <CardGrid cards={gateCardsWhenSignedOut(filterDiagramsByPersona(commands.diagrams, persona), authGated, promptSignIn)} />

                    <SectionLabel label="Git & Diff" />
                    <CardGrid cards={gateCardsWhenSignedOut(commands.git, authGated, promptSignIn)} />

                    {/* Issue #706 — Tools section hidden for Junior persona
                        (Re-init / Re-sync / Impact / Export / Coverage etc.
                        are advanced controls). PM + Power see the full set. */}
                    {persona !== 'junior' && (
                        <>
                            <SectionLabel label="Tools" />
                            <CardGrid cards={gateCardsWhenSignedOut(commands.tools, authGated, promptSignIn)} />
                        </>
                    )}
                </div>

                {/* Vertical separator between the dashboard and the AI column.
                    Subtle, full-height, with a soft gradient that fades at the
                    edges so it feels intentional, not a hard wall. */}
                <div className="ca-home-grid-rule" aria-hidden="true" />

                <div
                    className="ca-home-grid-side"
                    style={{ position: 'sticky', top: 12 }}
                >
                    {/* #531 — start / cancel / specific-review controls + status + findings
                        popover. First in the right column so it's the first AI control
                        the user sees. */}
                    <SectionLabel label="Code Review" />
                    {/* Issue 609 — failure-mode banner above the Code Review controls. */}
                    {aiReviewError && (
                        <AiReviewErrorBanner
                            error={aiReviewError}
                            onDismiss={() => onDismissAiReviewError?.()}
                        />
                    )}
                    <div style={{ position: 'relative' }}>
                        {/* 2026-06-10 — #813. Repo scope picker chip moved
                            INSIDE the Code Review card so it's discoverable
                            without a separate banner above. The card calls
                            back into HomePage's picker state via the new
                            onPickRepo / onClearRepo props. */}
                        <AiReviewControlCard
                            postMessage={postMessage}
                            llmProvider={wsInfo?.llmProvider}
                            llmModel={wsInfo?.llmModel}
                            llmEndpoint={wsInfo?.llmEndpoint}
                            selectedRepoId={aiReviewRepoId ?? undefined}
                            selectedRepoLabel={aiReviewRepoLabel ?? undefined}
                            isMultiRepo={(repos?.length ?? 0) >= 2}
                            onPickRepo={() => setAiReviewPickerOpen(true)}
                            onClearRepo={() => { setAiReviewRepoId(null); setAiReviewRepoLabel(null); }}
                            needsSetup={aiReviewNeedsSetup}
                            onSetLlmConfig={onSetLlmConfig}
                        />
                    </div>
                    {/* #851 / ADR-045 — PR watcher: auto-review open GitHub
                        PRs on this repo. Renders only when the backend
                        reports a watcher (status !== null). */}
                    <PrWatcherCard postMessage={postMessage} />
                    <ReviewGuidelinesCard
                        guidelines={reviewGuidelines}
                        onRequest={() => {
                            // #813 — in multi-repo, guidelines are scoped per
                            // sub-repo. When a repo is picked, request +
                            // save scoped to that repoId; else workspace-wide.
                            const payload = aiReviewRepoId ? { type: 'requestReviewGuidelines', repoId: aiReviewRepoId } : { type: 'requestReviewGuidelines' };
                            postMessage(payload);
                            postMessage({ type: 'requestEvidenceGate' });
                        }}
                        onSave={(text) => postMessage(
                            aiReviewRepoId
                                ? { type: 'saveReviewGuidelines', text, repoId: aiReviewRepoId }
                                : { type: 'saveReviewGuidelines', text },
                        )}
                        evidenceGateEnabled={evidenceGateEnabled}
                        onToggleEvidenceGate={(enabled) => postMessage({ type: 'setEvidenceGate', enabled })}
                        disabled={aiReviewRunning}
                        scopeRepoLabel={aiReviewRepoLabel ?? undefined}
                    />

                    {/* Issue #706 — LLM provider/model/endpoint setup is a
                        power-user concern. Hide for Junior + PM personas. */}
                    {persona === 'power' && isBrowserMode && onSetLlmConfig && (
                        <>
                            <SectionLabel label="AI Configuration" />
                            <LlmConfigSection wsInfo={wsInfo} onSetLlmConfig={onSetLlmConfig} />
                        </>
                    )}
                </div>
            </div>

            {/* Inlined styles for the home grid: vertical separator + narrow
                viewport fallback. Kept inline so the home page has no extra
                external CSS dependency for these rules. */}
            <style>{`
                .ca-home-grid-rule {
                    width: 1px;
                    background: linear-gradient(180deg,
                        transparent 0%,
                        var(--ca-border) 10%,
                        var(--ca-border) 90%,
                        transparent 100%);
                    opacity: 0.6;
                    align-self: stretch;
                    min-height: 200px;
                }
                @media (max-width: 1023px) {
                    .ca-home-grid {
                        grid-template-columns: 1fr !important;
                    }
                    .ca-home-grid-rule {
                        display: none;
                    }
                    .ca-home-grid-side {
                        position: static !important;
                    }
                }
            `}</style>

            {/* UX-50 — per-layer scope picker overlay. The component
                self-positions via `ca-modal-overlay` (fixed inset 0). */}
            {pickerMode !== null && (
                <ScopePicker
                    title={(() => {
                        // 2026-06-09 — title is a function of (mode, step).
                        // Step 1 of two-step modes ALWAYS reads "Pick a repo first…"
                        // so the user knows what they're doing. Step 2 reads the
                        // entity-specific prompt.
                        const isMultiRepoNow = !!(repos && repos.length >= 2);
                        const TWO_STEP_MODES: PickerMode[] = ['apis', 'flow', 'sequence'];
                        if (pickerMode && TWO_STEP_MODES.includes(pickerMode) && isMultiRepoNow && !pickerEntityFilterRepo) {
                            if (pickerMode === 'apis') return 'Pick a repo to scope the API list picker';
                            if (pickerMode === 'flow') return 'Pick a repo to scope the function picker';
                            if (pickerMode === 'sequence') return 'Pick a repo to scope the sequence picker';
                        }
                        if (pickerMode === 'apis') return 'Pick a feature cluster';
                        if (pickerMode === 'flow') return 'Pick a function';
                        if (pickerMode === 'sequence') return 'Pick an API to see its sequence';
                        if (pickerMode === 'features') return 'Pick a service / repo';
                        if (pickerMode === 'system-design') return 'Pick a repo to view its system design';
                        if (pickerMode === 'map') return 'Pick a repo to view its knowledge map';
                        if (pickerMode === 'domain') return 'Pick a repo to view its domain map';
                        if (pickerMode === 'tour') return 'Pick a repo to start its tour';
                        if (pickerMode === 'api-testing') return 'Pick a repo to test its endpoints';
                        if (pickerMode === 'health') return 'Pick a repo to drill into its health';
                        if (pickerMode === 'replay-working') return 'Pick a repo to replay its working changes';
                        if (pickerMode === 'compare-commits') return 'Pick a repo to compare its commits';
                        if (pickerMode === 'branch-diff') return 'Pick a repo to diff its branches';
                        if (pickerMode === 'pr-diff') return 'Pick a repo to view its PR diff';
                        if (pickerMode === 'replay-pr') return 'Pick a repo to replay its PR';
                        if (pickerMode === 'replay-branch') return 'Pick a repo to replay its branch diff';
                        if (pickerMode === 'timeline-replay') return 'Pick a repo to replay its commit timeline';
                        return 'Pick an item';
                    })()}
                    placeholder={pickerMode === 'features'
                        ? 'Filter services…'
                        : pickerMode === 'apis'
                            ? 'Filter clusters…'
                            : pickerMode === 'flow'
                                ? 'Filter functions…'
                                : 'Filter repos…'}
                    items={(() => {
                        // 2026-06-09 — two-step picker for `apis` / `flow`
                        // / `sequence` in multi-repo. Step 1 (no filter):
                        // show the sub-repo list. Step 2 (filter set):
                        // show entity items whose `repoId` matches the
                        // picked repo.
                        const isMultiRepoNow = !!(repos && repos.length >= 2);
                        const TWO_STEP_MODES: PickerMode[] = ['apis', 'flow', 'sequence', 'impact'];
                        const isTwoStep = pickerMode && TWO_STEP_MODES.includes(pickerMode) && isMultiRepoNow;
                        if (isTwoStep && pickerEntityFilterRepo) {
                            // Step 2 — filter entity slice by repoId. 'impact' picks
                            // a function (→ its file's blast radius), same slice as flow.
                            const slice = pickerMode === 'apis' ? pickerData.features
                                : pickerMode === 'sequence' ? pickerData.apis
                                    : pickerData.functions;
                            return slice.filter(it => it.repoId === pickerEntityFilterRepo);
                        }
                        if (isTwoStep) {
                            // Step 1 — sub-repo list.
                            return pickerData.services;
                        }
                        return pickerMode === 'apis'
                            ? pickerData.features
                            : pickerMode === 'flow'
                                ? pickerData.functions
                                : pickerMode === 'sequence'
                                    ? pickerData.apis
                                    : pickerData.services;
                    })()}
                    repos={(repos && repos.length >= 2)
                        ? repos.map(r => ({ repoId: r.repoId, repoName: r.name, rootPath: r.rootPath }))
                        : undefined}
                    groupBy={(repos && repos.length >= 2) ? 'repo' : null}
                    onPick={(item) => {
                        // 2026-06-09 — two-step picker handler. When the
                        // mode is a TWO_STEP one AND the user is at step
                        // 1 (no entity filter yet), DON'T dispatch — just
                        // promote the pick to the entity filter so the
                        // picker re-renders with the matching slice.
                        const isMultiRepoNow = !!(repos && repos.length >= 2);
                        const TWO_STEP_MODES: PickerMode[] = ['apis', 'flow', 'sequence', 'impact'];
                        const isTwoStep = pickerMode && TWO_STEP_MODES.includes(pickerMode) && isMultiRepoNow;
                        if (isTwoStep && !pickerEntityFilterRepo) {
                            // 2026-06-09 — extension stamps `repoId` on every
                            // explorer item as the realpath hash (e.g.
                            // `cf718f6967f9d8bd`). The entity slices
                            // (features / functions / apis) carry the same
                            // hash so we match directly. Falls back to the
                            // bare id stripped of `service:` for synthetic
                            // test fixtures that mirror the old shape.
                            const repoId = item.repoId ?? item.id.replace(/^service:/, '');
                            setPickerEntityFilterRepo(repoId);
                            return;
                        }
                        if (pickerMode) {
                            dispatchPick(pickerMode, item);
                        } else if (item.action) {
                            postMessage(item.action);
                        }
                        setPickerMode(null);
                        setPickerEntityFilterRepo(null);
                    }}
                    onCancel={() => {
                        setPickerMode(null);
                        setPickerEntityFilterRepo(null);
                    }}
                    emptyLabel={pickerMode === 'features'
                        ? 'No services detected yet.'
                        : pickerMode === 'apis'
                            ? 'No feature clusters detected yet.'
                            : pickerMode === 'flow'
                                ? 'No functions detected yet.'
                                : 'No repos detected yet.'}
                />
            )}

            {/* 2026-06-09 — AI Review repo scope picker. Separate
                instance so it doesn't fight with the diagram-card picker
                above. Opens via the "Pick repo" button next to the
                Code Review card. */}
            {aiReviewPickerOpen && (
                <ScopePicker
                    title="Pick a repo to scope the Code Review"
                    placeholder="Filter repos…"
                    items={pickerData.services}
                    repos={(repos && repos.length >= 2)
                        ? repos.map(r => ({ repoId: r.repoId, repoName: r.name, rootPath: r.rootPath }))
                        : undefined}
                    groupBy={(repos && repos.length >= 2) ? 'repo' : null}
                    onPick={(item) => {
                        const repoId = item.id.replace(/^service:/, '');
                        setAiReviewRepoId(repoId);
                        setAiReviewRepoLabel(item.label || repoId);
                        setAiReviewPickerOpen(false);
                    }}
                    onCancel={() => setAiReviewPickerOpen(false)}
                    emptyLabel="No repos detected yet."
                />
            )}

        </div>
    );
}
