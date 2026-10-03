/**
 * AiReviewControlCard tests (#531).
 *
 * Covers the four states the home-page card transitions between:
 *   1. Idle → Start / Changed / Specific buttons visible
 *   2. Running → spinner pill + Cancel button + progress row
 *   3. Cancelled → CANCELLED pill flash, then back to Idle
 *   4. Done    → last-run summary line
 * Plus: Specific-review textarea round-trip + Findings count badge + popover toggle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AiReviewControlCard } from '../AiReviewControlCard';
import { setFindings, setCounts } from '../ai-review/aiReviewBus';
import type { AiReviewFinding } from '../ai-review/types';

function dispatch(msg: any) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

function makeFinding(overrides: Partial<AiReviewFinding> = {}): AiReviewFinding {
    return {
        id: `f_${Math.random().toString(36).slice(2, 6)}`,
        entryPointId: 'GET:/health',
        bindings: [{ graphId: 'file:src/health.ts', targetId: 'health', targetType: 'node', layer: 'file' }],
        severity: 'warning',
        category: 'code-quality',
        title: 'Missing health probe',
        body: 'Add /health endpoint.',
        status: 'open',
        model: 'test',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
        ...overrides,
    };
}

describe('AiReviewControlCard', () => {
    beforeEach(() => {
        setFindings([]);
        setCounts({ byGraph: {}, byEntryPoint: {}, bySeverity: { error: 0, warning: 0, info: 0 }, total: 0 });
    });
    afterEach(() => {
        setFindings([]);
    });

    it('renders Start + Changed + Specific buttons when idle', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        expect(screen.getByTestId('ai-review-start-btn')).toBeTruthy();
        expect(screen.getByTestId('ai-review-start-changed-btn')).toBeTruthy();
        expect(screen.getByTestId('ai-review-specific-btn')).toBeTruthy();
        expect(screen.queryByTestId('ai-review-cancel-btn')).toBeNull();
    });

    it('posts requestAiFindings on mount (#533)', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        expect(postMessage).toHaveBeenCalledWith({ type: 'requestAiFindings' });
    });

    // #606 + #608-UI — Start review and Changed-only now use a two-phase
    // launch: first asks the server for a cost estimate, then renders a
    // confirm modal. The actual `requestFullReview` only fires after the
    // user clicks Continue (or auto-confirms on a $0 estimate).
    it('posts requestReviewCostEstimate (scope=all) when Start clicked', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-btn'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'requestReviewCostEstimate', scope: 'all' });
        // Modal hasn't received the estimate yet — Start should NOT have
        // already fired the real review.
        const realLaunch = postMessage.mock.calls.find(([m]: [any]) => m?.type === 'requestFullReview');
        expect(realLaunch).toBeUndefined();
    });

    it('posts requestReviewCostEstimate (scope=changed) when Changed clicked', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-changed-btn'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'requestReviewCostEstimate', scope: 'changed' });
    });

    it('posts requestReviewCostEstimate when Full re-review clicked (#606 escape hatch)', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-force-full-btn'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'requestReviewCostEstimate', scope: 'all' });
    });

    // #608-UI — modal flow.
    it('shows the cost confirm modal when a non-zero estimate arrives', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-btn'));
        act(() => {
            dispatch({
                type: 'reviewCostEstimate',
                entryPointCount: 27,
                estimatedUSD: 0.45,
                model: 'gpt-4o-mini',
                provider: 'openrouter',
                pricingIsEstimate: false,
                budgetCapUSD: 1.0,
                willExceedCap: false,
                summary: 'gpt-4o-mini · 27 entry points · ~$0.45',
            });
        });
        expect(screen.getByTestId('ai-review-cost-modal')).toBeTruthy();
        expect(screen.getByTestId('ai-review-cost-entrypoints').textContent).toBe('27');
        expect(screen.getByTestId('ai-review-cost-usd').textContent).toContain('0.4500');
    });

    it('Continue fires the real requestFullReview with the captured scope/mode', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-changed-btn'));
        act(() => {
            dispatch({
                type: 'reviewCostEstimate',
                entryPointCount: 4, estimatedUSD: 0.06, model: 'gpt-4o-mini',
                pricingIsEstimate: false, budgetCapUSD: 1.0, willExceedCap: false,
                summary: 'gpt-4o-mini · 4 entry points · ~$0.06',
            });
        });
        fireEvent.click(screen.getByTestId('ai-review-cost-confirm-btn'));
        expect(postMessage).toHaveBeenCalledWith({
            type: 'requestFullReview', scope: 'changed', mode: 'incremental',
        });
        // Modal dismisses after Continue.
        expect(screen.queryByTestId('ai-review-cost-modal')).toBeNull();
    });

    it('Cancel dismisses the modal without firing requestFullReview', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-btn'));
        act(() => {
            dispatch({
                type: 'reviewCostEstimate',
                entryPointCount: 27, estimatedUSD: 0.45, model: 'gpt-4o-mini',
                pricingIsEstimate: false, budgetCapUSD: 1.0, willExceedCap: false,
                summary: 's',
            });
        });
        fireEvent.click(screen.getByTestId('ai-review-cost-cancel-btn'));
        const realLaunch = postMessage.mock.calls.find(([m]: [any]) => m?.type === 'requestFullReview');
        expect(realLaunch).toBeUndefined();
        expect(screen.queryByTestId('ai-review-cost-modal')).toBeNull();
    });

    it('auto-confirms a $0 estimate (Ollama / local — no modal shown)', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-btn'));
        act(() => {
            dispatch({
                type: 'reviewCostEstimate',
                entryPointCount: 27, estimatedUSD: 0, model: 'ollama/llama3',
                provider: 'ollama', pricingIsEstimate: false,
                budgetCapUSD: 1.0, willExceedCap: false,
                summary: 'ollama · 27 entry points · free',
            });
        });
        // No modal rendered on $0 — direct launch instead.
        expect(screen.queryByTestId('ai-review-cost-modal')).toBeNull();
        expect(postMessage).toHaveBeenCalledWith({
            type: 'requestFullReview', scope: 'all', mode: 'incremental',
        });
    });

    it('renders the willExceedCap warning when the estimate is over budget', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-start-btn'));
        act(() => {
            dispatch({
                type: 'reviewCostEstimate',
                entryPointCount: 500, estimatedUSD: 5.20, model: 'gpt-4o',
                provider: 'openrouter', pricingIsEstimate: false,
                budgetCapUSD: 1.0, willExceedCap: true,
                summary: 'gpt-4o · 500 entry points · ~$5.20',
            });
        });
        expect(screen.getByTestId('ai-review-cost-exceed-warn')).toBeTruthy();
    });

    it('flips to Cancel button + status pill on aiReviewStarted', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        act(() => { dispatch({ type: 'aiReviewStarted', kind: 'full', startedAt: Date.now() }); });
        expect(screen.getByTestId('ai-review-cancel-btn')).toBeTruthy();
        expect(screen.getByTestId('ai-review-status-pill').textContent).toContain('FULL REVIEW');
        expect(screen.queryByTestId('ai-review-start-btn')).toBeNull();
    });

    it('shows progress row with completed/total chip', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        act(() => {
            dispatch({ type: 'aiReviewStarted', kind: 'full' });
            dispatch({ type: 'aiReviewProgress', completed: 3, total: 10, message: 'Reviewing GET:/users' });
        });
        const row = screen.getByTestId('ai-review-progress-row');
        expect(row.textContent).toContain('Reviewing GET:/users');
        expect(row.textContent).toContain('3 / 10');
    });

    it('posts cancelFullReview when Cancel clicked', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        act(() => { dispatch({ type: 'aiReviewStarted', kind: 'full' }); });
        fireEvent.click(screen.getByTestId('ai-review-cancel-btn'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'cancelFullReview' });
    });

    it('shows CANCELLED pill on aiReviewCancelled and returns to idle controls', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        act(() => {
            dispatch({ type: 'aiReviewStarted', kind: 'full' });
            dispatch({ type: 'aiReviewCancelled', reason: 'user' });
        });
        expect(screen.getByText('CANCELLED')).toBeTruthy();
        expect(screen.getByTestId('ai-review-start-btn')).toBeTruthy();
    });

    it('shows last-run summary on aiReviewComplete', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        act(() => {
            dispatch({ type: 'aiReviewStarted', kind: 'full' });
            dispatch({
                type: 'aiReviewComplete',
                summary: { findingsCount: 4, projectFindings: 2, totalEntryPoints: 7, durationMs: 12300 },
                counts: { byGraph: {}, byEntryPoint: {}, bySeverity: { error: 0, warning: 0, info: 0 }, total: 6 },
            });
        });
        // Summary line: 6 findings · 7 entry points · 13s
        const summary = screen.getByText(/Last full review/);
        expect(summary.textContent).toContain('6 findings');
        expect(summary.textContent).toContain('7 entry points');
    });

    it('opens specific-review textarea and posts requestSpecificReview', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-specific-btn'));
        const textarea = screen.getByTestId('ai-review-specific-prompt') as HTMLTextAreaElement;
        fireEvent.change(textarea, { target: { value: 'Audit auth on every POST route' } });
        fireEvent.click(screen.getByTestId('ai-review-specific-run'));
        expect(postMessage).toHaveBeenCalledWith({
            type: 'requestSpecificReview',
            prompt: 'Audit auth on every POST route',
        });
    });

    it('disables findings button when count is 0', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        const btn = screen.getByTestId('ai-review-findings-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toContain('0');
    });

    // Issue #777: the severity-dot row renders each bucket's count
    // right next to a colored empty <span>, with no whitespace or
    // separator. DOM text becomes `Findings414235` for 41 total + 4
    // error + 2 warning + 35 info, which is unreadable in screen
    // readers and confuses automation. The rendered text must
    // distinguish the total from the per-severity counts.
    it('#777 findings chip text separates total from per-severity counts', () => {
        const postMessage = vi.fn();
        const findings: AiReviewFinding[] = [];
        for (let i = 0; i < 4; i++) findings.push(makeFinding({ severity: 'error' }));
        for (let i = 0; i < 2; i++) findings.push(makeFinding({ severity: 'warning' }));
        for (let i = 0; i < 35; i++) findings.push(makeFinding({ severity: 'info' }));
        setFindings(findings);
        setCounts({
            byGraph: {}, byEntryPoint: {},
            bySeverity: { error: 4, warning: 2, info: 35 },
            total: 41,
        });
        render(<AiReviewControlCard postMessage={postMessage} />);
        const btn = screen.getByTestId('ai-review-findings-btn') as HTMLButtonElement;
        // The concatenation bug produced "Findings414235" — a 6-digit
        // run. After the fix, the text contains the total + each
        // bucket separated visibly (whitespace, `·`, or aria-label).
        expect(btn.textContent).not.toMatch(/Findings\s*414235/);
        // Total chip still visible.
        expect(btn.textContent).toMatch(/41/);
    });

    it('shows finding count + opens popover when findings exist', () => {
        const postMessage = vi.fn();
        const findings = [makeFinding({ severity: 'error' }), makeFinding({ severity: 'warning' })];
        setFindings(findings);
        render(<AiReviewControlCard postMessage={postMessage} />);
        const btn = screen.getByTestId('ai-review-findings-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toContain('2');
        fireEvent.click(btn);
        expect(screen.getByTestId('ai-review-findings-popover')).toBeTruthy();
    });

    it('Clear button appears only when findings exist and opens an in-app modal (#537 + #778)', () => {
        const postMessage = vi.fn();
        // No findings → no clear button.
        const { rerender } = render(<AiReviewControlCard postMessage={postMessage} />);
        expect(screen.queryByTestId('ai-review-clear-btn')).toBeNull();

        // With findings, button shows.
        setFindings([makeFinding(), makeFinding({ severity: 'error' })]);
        rerender(<AiReviewControlCard postMessage={postMessage} />);
        const clear = screen.getByTestId('ai-review-clear-btn');
        expect(clear).toBeTruthy();

        // Issue #778: clicking 🗑 must NOT call browser confirm (blocks
        // Chrome MCP) — should open an in-app modal instead.
        const confirmSpy = vi.fn(() => true);
        const origConfirm = window.confirm;
        window.confirm = confirmSpy;
        try {
            fireEvent.click(clear);
            expect(confirmSpy).not.toHaveBeenCalled();
            // No clearFindings yet — modal is open, user hasn't confirmed.
            expect(postMessage).not.toHaveBeenCalledWith({ type: 'clearFindings' });
            // The modal must be in the DOM as a role=dialog.
            const dialog = screen.getByRole('dialog');
            expect(dialog).toBeTruthy();
            // Modal confirm posts clearFindings.
            const confirmBtn = screen.getByTestId('ai-review-clear-confirm-btn');
            fireEvent.click(confirmBtn);
            expect(postMessage).toHaveBeenCalledWith({ type: 'clearFindings' });
        } finally {
            window.confirm = origConfirm;
        }
    });

    it('Clear modal Cancel button does NOT post clearFindings (#778)', () => {
        const postMessage = vi.fn();
        setFindings([makeFinding()]);
        render(<AiReviewControlCard postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('ai-review-clear-btn'));
        // Modal opens.
        const cancelBtn = screen.getByTestId('ai-review-clear-cancel-btn');
        fireEvent.click(cancelBtn);
        expect(postMessage).not.toHaveBeenCalledWith({ type: 'clearFindings' });
        // Modal dismisses — role=dialog gone.
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('shows NOTHING CHANGED pill on aiReviewNoChange (#535)', () => {
        const postMessage = vi.fn();
        render(<AiReviewControlCard postMessage={postMessage} />);
        act(() => { dispatch({ type: 'aiReviewNoChange', previous: { findingsCount: 3 } }); });
        expect(screen.getByTestId('ai-review-nochange-pill').textContent).toContain('NOTHING CHANGED');
    });

    // UX-22 follow-up (2026-06-04): the cost-estimate timeout error
    // names the active LLM endpoint when one is configured, so the
    // user knows exactly which target is unreachable.
    describe('UX-22 follow-up: endpointLabel surfaces the active LLM target', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('passes a provider + model + endpoint label into the EstimatingCostPanel', async () => {
            const postMessage = vi.fn();
            render(
                <AiReviewControlCard
                    postMessage={postMessage}
                    llmProvider="openai"
                    llmModel="gpt-4o"
                    llmEndpoint="https://api.openai.com/v1"
                />,
            );
            // Click "Start review" to enter the cost-estimate flow.
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            // Verify the loading panel renders.
            expect(screen.getByTestId('ai-review-cost-loading')).toBeTruthy();
            // Advance past the 15s default timeout and assert the
            // timed-out message includes the endpoint label.
            act(() => { vi.advanceTimersByTime(15001); });
            const timeout = screen.getByTestId('ai-review-cost-timeout');
            expect(timeout.textContent).toMatch(/Openai \(gpt-4o\) at https:\/\/api\.openai\.com\/v1/);
        });

        it('falls back to a provider-only label when no endpoint/model is configured', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} llmProvider="openrouter" />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            act(() => { vi.advanceTimersByTime(15001); });
            const timeout = screen.getByTestId('ai-review-cost-timeout');
            expect(timeout.textContent).toMatch(/Openrouter/);
        });

        it('omits the endpoint phrase entirely when no LLM info is supplied', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            act(() => { vi.advanceTimersByTime(15001); });
            const timeout = screen.getByTestId('ai-review-cost-timeout');
            expect(timeout.textContent).toMatch(/timed out after 15s/);
            // Generic message, no parenthetical endpoint phrase.
            expect(timeout.textContent).not.toMatch(/\(/);
        });
    });

    // #918 — first-run onboarding. With needsSetup, the first Start click
    // opens the unified setup card instead of going straight to the cost
    // estimate; completing setup posts the config then fires the estimate.
    describe('#918 first-run setup gate (needsSetup)', () => {
        beforeEach(() => { localStorage.clear(); });

        it('first Start opens the unified setup card and defers the cost estimate', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} needsSetup onSetLlmConfig={vi.fn()} />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            // Setup card shown; cost estimate NOT yet requested.
            expect(screen.getByTestId('ai-review-setup-card')).toBeTruthy();
            const est = postMessage.mock.calls.find(([m]: [any]) => m?.type === 'requestReviewCostEstimate');
            expect(est).toBeUndefined();
        });

        it('completing setup posts the LLM config then fires the cost estimate', () => {
            const postMessage = vi.fn();
            const onSetLlmConfig = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} needsSetup onSetLlmConfig={onSetLlmConfig} />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            fireEvent.change(screen.getByTestId('ai-setup-api-key'), { target: { value: 'sk-test' } });
            fireEvent.click(screen.getByTestId('ai-setup-consent'));
            fireEvent.click(screen.getByTestId('ai-setup-submit'));
            // Config applied via the existing setLlmConfig path.
            expect(onSetLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openrouter', apiKey: 'sk-test' }));
            // Setup card dismissed; cost estimate now in-flight for the held launch.
            expect(screen.queryByTestId('ai-review-setup-card')).toBeNull();
            expect(postMessage).toHaveBeenCalledWith({ type: 'requestReviewCostEstimate', scope: 'all' });
        });

        it('once consent is recorded, Start skips the card (no re-prompt)', () => {
            localStorage.setItem('codeatlas:aiReviewConsent', '1');
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} needsSetup onSetLlmConfig={vi.fn()} />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            expect(screen.queryByTestId('ai-review-setup-card')).toBeNull();
            expect(postMessage).toHaveBeenCalledWith({ type: 'requestReviewCostEstimate', scope: 'all' });
        });

        it('without needsSetup (existing callers), Start goes straight to the estimate', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            expect(screen.queryByTestId('ai-review-setup-card')).toBeNull();
            expect(postMessage).toHaveBeenCalledWith({ type: 'requestReviewCostEstimate', scope: 'all' });
        });
    });

    // 2026-06-09 — Code Review (AI Review) multi-repo scoping.
    // User-reported: in serverless-examples the AI Review card had no
    // repo scope at all, so the review ran workspace-wide. Adding an
    // optional `selectedRepoId` prop: when set, the review messages
    // (`requestReviewCostEstimate`, `requestFullReview`) carry the
    // repoId so the extension scopes the review to that sub-repo.
    describe('Multi-repo scoping (selectedRepoId prop)', () => {
        it('Start review with selectedRepoId carries the repoId on requestReviewCostEstimate', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} selectedRepoId="aws-node-http-api-mongodb" selectedRepoLabel="mongodb sub-repo" />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            expect(postMessage).toHaveBeenCalledWith({
                type: 'requestReviewCostEstimate',
                scope: 'all',
                repoId: 'aws-node-http-api-mongodb',
            });
        });

        it('Start changed-only with selectedRepoId carries the repoId', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} selectedRepoId="api-svc" />);
            fireEvent.click(screen.getByTestId('ai-review-start-changed-btn'));
            expect(postMessage).toHaveBeenCalledWith({
                type: 'requestReviewCostEstimate',
                scope: 'changed',
                repoId: 'api-svc',
            });
        });

        it('Without selectedRepoId (single-repo / workspace mode), messages do NOT carry repoId', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} />);
            fireEvent.click(screen.getByTestId('ai-review-start-btn'));
            expect(postMessage).toHaveBeenCalledWith({
                type: 'requestReviewCostEstimate',
                scope: 'all',
            });
            // Verify no `repoId` field on the call.
            const call = postMessage.mock.calls.find(c => c[0]?.type === 'requestReviewCostEstimate');
            expect(call?.[0]).not.toHaveProperty('repoId');
        });

        it('renders the selectedRepoLabel as a chip near the action row when set', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} selectedRepoId="api" selectedRepoLabel="api · backend" />);
            const chip = screen.getByTestId('ai-review-repo-chip');
            expect(chip).toBeTruthy();
            expect(chip.textContent).toContain('api · backend');
        });

        it('does NOT render a repo chip when selectedRepoId is not set (single-repo workspace)', () => {
            const postMessage = vi.fn();
            render(<AiReviewControlCard postMessage={postMessage} />);
            expect(screen.queryByTestId('ai-review-repo-chip')).toBeNull();
        });
    });
});
