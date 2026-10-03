/**
 * FailedRepoFallback.test.tsx — ADR-034 Phase E Pass 3 (#790).
 */

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import FailedRepoFallback from '../FailedRepoFallback';

describe('FailedRepoFallback', () => {
    it('renders the repo name in the title (full mode)', () => {
        render(<FailedRepoFallback repoName="auth-svc" />);
        expect(screen.getByText('Indexing failed for auth-svc')).toBeTruthy();
    });

    it('uses compact title when compact is true', () => {
        render(<FailedRepoFallback repoName="auth-svc" compact />);
        expect(screen.getByText('Indexing failed')).toBeTruthy();
        expect(screen.queryByText(/for auth-svc/)).toBeNull();
    });

    it('renders the error message when provided', () => {
        render(
            <FailedRepoFallback
                repoName="auth-svc"
                errorMessage="SyntaxError: unexpected token at line 42"
            />,
        );
        expect(screen.getByText(/SyntaxError: unexpected token/)).toBeTruthy();
    });

    it('truncates long error messages and exposes the full text via title', () => {
        const long = 'x'.repeat(500);
        render(<FailedRepoFallback repoName="r" errorMessage={long} />);
        const pre = screen.getByTitle(long);
        expect(pre.textContent!.length).toBeLessThan(long.length);
        expect(pre.textContent!.endsWith('…')).toBe(true);
    });

    it('omits the error block when no errorMessage is provided', () => {
        const { container } = render(<FailedRepoFallback repoName="r" />);
        expect(container.querySelector('pre')).toBeNull();
    });

    it('renders the Retry button only when onRetry is wired', () => {
        const { rerender } = render(<FailedRepoFallback repoName="r" />);
        expect(screen.queryByLabelText(/Retry indexing/)).toBeNull();

        const onRetry = vi.fn();
        rerender(<FailedRepoFallback repoName="r" onRetry={onRetry} />);
        expect(screen.getByLabelText('Retry indexing for r')).toBeTruthy();
    });

    it('Retry click fires onRetry and stops propagation', () => {
        const onRetry = vi.fn();
        const parentClick = vi.fn();
        render(
            <div onClick={parentClick}>
                <FailedRepoFallback repoName="r" onRetry={onRetry} />
            </div>,
        );
        fireEvent.click(screen.getByLabelText('Retry indexing for r'));
        expect(onRetry).toHaveBeenCalled();
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('View-logs button is hidden when onOpenLogs is omitted', () => {
        render(<FailedRepoFallback repoName="r" onRetry={() => {}} />);
        expect(screen.queryByLabelText(/output channel/i)).toBeNull();
    });

    it('View-logs click fires onOpenLogs', () => {
        const onOpenLogs = vi.fn();
        render(<FailedRepoFallback repoName="r" onOpenLogs={onOpenLogs} />);
        fireEvent.click(screen.getByLabelText('Open extension output channel'));
        expect(onOpenLogs).toHaveBeenCalled();
    });

    it('hides the action row entirely when both handlers are omitted', () => {
        const { container } = render(<FailedRepoFallback repoName="r" />);
        expect(container.querySelector('button')).toBeNull();
    });

    it('exposes the alert role for screen readers', () => {
        render(<FailedRepoFallback repoName="r" />);
        const alert = screen.getByRole('alert');
        expect(alert).toBeTruthy();
        expect(alert.getAttribute('aria-label')).toBe('Indexing failed for r');
    });
});
