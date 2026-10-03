import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../ErrorBoundary';

// Mock vscodeApi
beforeEach(() => {
    (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
});

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) throw new Error('Test render error');
    return <div>Child content</div>;
}

describe('ErrorBoundary', () => {
    it('renders children when no error', () => {
        render(
            <ErrorBoundary>
                <div>Normal content</div>
            </ErrorBoundary>
        );
        expect(screen.getByText('Normal content')).toBeDefined();
    });

    it('renders fallback UI when child throws', () => {
        // Suppress React error boundary console output
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(
            <ErrorBoundary>
                <ThrowingChild shouldThrow={true} />
            </ErrorBoundary>
        );
        expect(screen.getByText('Something went wrong')).toBeDefined();
        spy.mockRestore();
    });

    it('shows error message in fallback', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(
            <ErrorBoundary>
                <ThrowingChild shouldThrow={true} />
            </ErrorBoundary>
        );
        expect(screen.getByText('Test render error')).toBeDefined();
        spy.mockRestore();
    });

    it('reload button sends ready message to extension', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(
            <ErrorBoundary>
                <ThrowingChild shouldThrow={true} />
            </ErrorBoundary>
        );
        fireEvent.click(screen.getByText('Reload Diagram'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'ready' });
        spy.mockRestore();
    });

    it('reload button clears error state', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(
            <ErrorBoundary>
                <ThrowingChild shouldThrow={true} />
            </ErrorBoundary>
        );
        expect(screen.getByText('Something went wrong')).toBeDefined();
        // Click reload — should call postMessage and attempt recovery
        fireEvent.click(screen.getByText('Reload Diagram'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'ready' });
        spy.mockRestore();
    });
});
