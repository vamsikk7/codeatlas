/**
 * AiReviewErrorBanner.test.tsx — Issue 609
 *
 * Verifies the banner renders the right copy + remediation hint per error
 * kind, exposes the raw response via a disclosure, and routes dismiss
 * through the supplied callback.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AiReviewErrorBanner from '../AiReviewErrorBanner';

describe('AiReviewErrorBanner (Issue 609)', () => {
    it('renders nothing when error is null', () => {
        const { container } = render(<AiReviewErrorBanner error={null} onDismiss={() => {}} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders auth-error copy with kind tag', () => {
        render(<AiReviewErrorBanner
            error={{ kind: 'auth', message: '401 unauthorized', status: 401, provider: 'openrouter' }}
            onDismiss={() => {}}
        />);
        expect(screen.getByText(/LLM rejected the API key/)).toBeDefined();
        expect(screen.getByTestId('ai-review-error-kind').textContent).toMatch(/auth/);
        expect(screen.getByTestId('ai-review-error-kind').textContent).toMatch(/401/);
        expect(screen.getByTestId('ai-review-error-kind').textContent).toMatch(/openrouter/);
    });

    it('renders rate-limit copy', () => {
        render(<AiReviewErrorBanner error={{ kind: 'rate-limit', message: '429' }} onDismiss={() => {}} />);
        expect(screen.getByText(/LLM is rate-limited/)).toBeDefined();
    });

    it('renders network copy', () => {
        render(<AiReviewErrorBanner error={{ kind: 'network', message: 'ECONNREFUSED' }} onDismiss={() => {}} />);
        expect(screen.getByText(/Could not reach the LLM endpoint/)).toBeDefined();
    });

    it('renders evidence-gate-too-strict copy', () => {
        render(<AiReviewErrorBanner error={{ kind: 'evidence-gate-too-strict', message: '0 findings kept' }} onDismiss={() => {}} />);
        expect(screen.getByText(/Every finding was dropped by the evidence gate/)).toBeDefined();
    });

    it('renders unknown copy as fallback', () => {
        render(<AiReviewErrorBanner error={{ kind: 'unknown', message: 'wat' }} onDismiss={() => {}} />);
        expect(screen.getByText(/AI Review failed/)).toBeDefined();
    });

    it('toggles raw response when "View raw response" clicked', () => {
        render(<AiReviewErrorBanner
            error={{ kind: 'schema-invalid', message: 'bad JSON', rawResponse: '{ broken: true' }}
            onDismiss={() => {}}
        />);
        // Initially hidden
        expect(screen.queryByTestId('ai-review-error-raw')).toBeNull();
        fireEvent.click(screen.getByTestId('ai-review-error-view-raw'));
        // Now visible
        expect(screen.getByTestId('ai-review-error-raw').textContent).toContain('broken: true');
        // Toggle off
        fireEvent.click(screen.getByTestId('ai-review-error-view-raw'));
        expect(screen.queryByTestId('ai-review-error-raw')).toBeNull();
    });

    it('does not render "View raw response" button when no raw body', () => {
        render(<AiReviewErrorBanner error={{ kind: 'network', message: 'no body' }} onDismiss={() => {}} />);
        expect(screen.queryByTestId('ai-review-error-view-raw')).toBeNull();
    });

    it('invokes onDismiss when × clicked', () => {
        const onDismiss = vi.fn();
        render(<AiReviewErrorBanner error={{ kind: 'auth', message: 'no key' }} onDismiss={onDismiss} />);
        fireEvent.click(screen.getByLabelText('Dismiss error'));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });
});
