/**
 * LlmConnectionTestButton.test.tsx — UX (2026-06-04)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import LlmConnectionTestButton from '../LlmConnectionTestButton';

describe('LlmConnectionTestButton', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts in idle state with the "Test Connection" button visible', () => {
        const postMessage = vi.fn();
        render(<LlmConnectionTestButton postMessage={postMessage} />);
        expect(screen.getByTestId('llm-test-idle-btn')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Test LLM connection/i })).toBeTruthy();
    });

    it('clicking Test Connection fires `testLlmConnection` and enters testing state', () => {
        const postMessage = vi.fn();
        render(<LlmConnectionTestButton postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'testLlmConnection' });
        expect(screen.getByTestId('llm-test-testing')).toBeTruthy();
        expect(screen.getByText(/Testing/)).toBeTruthy();
        // Cancel button must be visible from t=0.
        expect(screen.getByRole('button', { name: /Cancel connection test/i })).toBeTruthy();
    });

    it('Cancel returns to idle and fires onCancel', () => {
        const postMessage = vi.fn();
        const onCancel = vi.fn();
        render(<LlmConnectionTestButton postMessage={postMessage} onCancel={onCancel} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        fireEvent.click(screen.getByRole('button', { name: /Cancel connection test/i }));
        expect(onCancel).toHaveBeenCalled();
        expect(screen.getByTestId('llm-test-idle-btn')).toBeTruthy();
    });

    it('shows a green Connected chip with latency when a successful result arrives', () => {
        const postMessage = vi.fn();
        const { rerender } = render(<LlmConnectionTestButton postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        rerender(<LlmConnectionTestButton postMessage={postMessage} result={{ ok: true, message: 'Connected', latencyMs: 124 }} />);
        const ok = screen.getByTestId('llm-test-ok');
        expect(ok.textContent).toMatch(/Connected/);
        expect(ok.textContent).toMatch(/124 ms/);
        // "Test again" button replaces the idle button so the user can re-run.
        expect(screen.getByRole('button', { name: /Test connection again/i })).toBeTruthy();
    });

    it('shows a red Failed chip with the underlying error message when ok=false', () => {
        const postMessage = vi.fn();
        const { rerender } = render(<LlmConnectionTestButton postMessage={postMessage} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        rerender(<LlmConnectionTestButton postMessage={postMessage} result={{ ok: false, message: 'HTTP 401: invalid API key' }} />);
        const err = screen.getByTestId('llm-test-error');
        expect(err.textContent).toMatch(/HTTP 401: invalid API key/);
        expect(screen.getByRole('button', { name: /Retry connection test/i })).toBeTruthy();
    });

    it('flips to "Timed out" after the timeoutMs threshold when no result arrives', () => {
        const postMessage = vi.fn();
        render(<LlmConnectionTestButton postMessage={postMessage} timeoutMs={500} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        // Just before the threshold — still testing.
        act(() => { vi.advanceTimersByTime(499); });
        expect(screen.queryByTestId('llm-test-timeout')).toBeNull();
        // Cross the threshold — flip.
        act(() => { vi.advanceTimersByTime(2); });
        expect(screen.getByTestId('llm-test-timeout')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Retry connection test/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Dismiss timeout message/i })).toBeTruthy();
    });

    it('ignores a stale result that arrives after timeout', () => {
        const postMessage = vi.fn();
        const { rerender } = render(<LlmConnectionTestButton postMessage={postMessage} timeoutMs={500} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        act(() => { vi.advanceTimersByTime(501); });
        expect(screen.getByTestId('llm-test-timeout')).toBeTruthy();
        // Stale ok result arrives — should NOT overwrite the timeout state.
        rerender(<LlmConnectionTestButton postMessage={postMessage} timeoutMs={500} result={{ ok: true, message: 'Connected', latencyMs: 9999 }} />);
        expect(screen.getByTestId('llm-test-timeout')).toBeTruthy();
        expect(screen.queryByTestId('llm-test-ok')).toBeNull();
    });

    it('Retry from the timeout state re-fires the postMessage and re-enters testing', () => {
        const postMessage = vi.fn();
        render(<LlmConnectionTestButton postMessage={postMessage} timeoutMs={500} />);
        fireEvent.click(screen.getByTestId('llm-test-idle-btn'));
        act(() => { vi.advanceTimersByTime(501); });
        // Retry from the timeout chip — should fire postMessage again
        // and re-enter the testing state.
        fireEvent.click(screen.getByRole('button', { name: /Retry connection test/i }));
        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('llm-test-testing')).toBeTruthy();
    });
});
