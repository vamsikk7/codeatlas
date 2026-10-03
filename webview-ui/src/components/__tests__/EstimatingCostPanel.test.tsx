/**
 * EstimatingCostPanel.test.tsx — UX-22 (2026-06-04)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import EstimatingCostPanel from '../EstimatingCostPanel';

describe('EstimatingCostPanel - UX-22', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the loading message + Cancel button from t=0', () => {
        render(<EstimatingCostPanel onCancel={() => {}} />);
        expect(screen.getByTestId('ai-review-cost-loading')).toBeTruthy();
        expect(screen.getByText(/Estimating cost/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy();
        // No timeout/error UI yet
        expect(screen.queryByTestId('ai-review-cost-timeout')).toBeNull();
    });

    it('Cancel click fires onCancel', () => {
        const onCancel = vi.fn();
        render(<EstimatingCostPanel onCancel={onCancel} />);
        fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
        expect(onCancel).toHaveBeenCalled();
    });

    it('flips to timed-out state after the default 15s threshold', () => {
        render(<EstimatingCostPanel onCancel={() => {}} />);
        // Just before timeout — still loading.
        act(() => { vi.advanceTimersByTime(14999); });
        expect(screen.queryByTestId('ai-review-cost-timeout')).toBeNull();
        // Cross the 15s threshold — flip.
        act(() => { vi.advanceTimersByTime(2); });
        expect(screen.getByTestId('ai-review-cost-timeout')).toBeTruthy();
        expect(screen.getByText(/timed out after 15s/i)).toBeTruthy();
    });

    it('honours the timeoutMs override', () => {
        render(<EstimatingCostPanel onCancel={() => {}} timeoutMs={1000} />);
        act(() => { vi.advanceTimersByTime(1001); });
        expect(screen.getByTestId('ai-review-cost-timeout')).toBeTruthy();
        expect(screen.getByText(/timed out after 1s/i)).toBeTruthy();
    });

    it('renders Retry + Cancel in the timed-out state when onRetry is supplied', () => {
        const onRetry = vi.fn();
        render(<EstimatingCostPanel onCancel={() => {}} onRetry={onRetry} timeoutMs={100} />);
        act(() => { vi.advanceTimersByTime(150); });
        fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
        expect(onRetry).toHaveBeenCalled();
        // Retry returns us to the loading state for the next attempt.
        expect(screen.getByTestId('ai-review-cost-loading')).toBeTruthy();
    });

    it('omits the Retry button when onRetry is not supplied', () => {
        render(<EstimatingCostPanel onCancel={() => {}} timeoutMs={100} />);
        act(() => { vi.advanceTimersByTime(150); });
        expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
        expect(screen.getByRole('button', { name: /Cancel/i })).toBeTruthy();
    });

    it('includes the endpoint label in the timeout message when provided', () => {
        render(
            <EstimatingCostPanel
                onCancel={() => {}}
                timeoutMs={100}
                endpointLabel="http://localhost:11434"
            />,
        );
        act(() => { vi.advanceTimersByTime(150); });
        expect(screen.getByText(/http:\/\/localhost:11434/)).toBeTruthy();
    });
});
