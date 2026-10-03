/**
 * PrWatcherCard.test.tsx — #851 (2026-06-12)
 *
 * PR watcher home-page card: requests status on mount, hides until a
 * watcher-capable status arrives, renders prerequisites warnings + poll
 * results, and round-trips the toggle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { PrWatcherCard, type PrWatcherStatusWire } from '../PrWatcherCard';

function status(over: Partial<PrWatcherStatusWire> = {}): PrWatcherStatusWire {
    return {
        enabled: false,
        repoSlug: 'acme/widgets',
        tokenPresent: true,
        llmKeyPresent: true,
        intervalMs: 300_000,
        lastPollAt: null,
        lastResult: null,
        lastError: null,
        reviewedCount: 0,
        polling: false,
        ...over,
    };
}

function pushStatus(s: PrWatcherStatusWire | null) {
    act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'prWatcherStatus', status: s } }));
    });
}

describe('PrWatcherCard (#851)', () => {
    let postMessage: ReturnType<typeof vi.fn>;
    beforeEach(() => { postMessage = vi.fn(); });

    it('requests status on mount and stays hidden until a status arrives', () => {
        render(<PrWatcherCard postMessage={postMessage} />);
        expect(postMessage).toHaveBeenCalledWith({ type: 'getPrWatcherStatus' });
        expect(screen.queryByTestId('pr-watcher-card')).toBeNull();
    });

    it('renders the card with repo slug once a status lands; null status keeps it hidden', () => {
        render(<PrWatcherCard postMessage={postMessage} />);
        pushStatus(status());
        expect(screen.getByTestId('pr-watcher-card')).toBeDefined();
        expect(screen.getByText('acme/widgets')).toBeDefined();
        pushStatus(null);
        expect(screen.queryByTestId('pr-watcher-card')).toBeNull();
    });

    it('toggle posts setPrWatcherEnabled with the flipped value', () => {
        render(<PrWatcherCard postMessage={postMessage} />);
        pushStatus(status({ enabled: false }));
        fireEvent.click(screen.getByTestId('pr-watcher-toggle'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'setPrWatcherEnabled', enabled: true });
        pushStatus(status({ enabled: true }));
        expect(screen.getByTestId('pr-watcher-toggle').textContent).toBe('On');
        fireEvent.click(screen.getByTestId('pr-watcher-toggle'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'setPrWatcherEnabled', enabled: false });
    });

    it('surfaces missing prerequisites as warnings', () => {
        render(<PrWatcherCard postMessage={postMessage} />);
        pushStatus(status({ repoSlug: null }));
        expect(screen.getByTestId('pr-watcher-warning').textContent).toContain('GitHub remote');
        pushStatus(status({ tokenPresent: false }));
        expect(screen.getByTestId('pr-watcher-warning').textContent).toContain('token');
        pushStatus(status({ llmKeyPresent: false }));
        expect(screen.getByTestId('pr-watcher-warning').textContent).toContain('LLM');
    });

    it('shows last poll result + watching/polling pill when enabled', () => {
        render(<PrWatcherCard postMessage={postMessage} />);
        pushStatus(status({ enabled: true, lastResult: '2 open PRs · reviewed #12', reviewedCount: 3 }));
        expect(screen.getByTestId('pr-watcher-result').textContent).toContain('reviewed #12');
        expect(screen.getByText('watching')).toBeDefined();
        expect(screen.getByText(/3 PR heads reviewed/)).toBeDefined();
        pushStatus(status({ enabled: true, polling: true }));
        expect(screen.getByText('polling…')).toBeDefined();
    });

    it('renders watcher errors when prerequisites are fine', () => {
        render(<PrWatcherCard postMessage={postMessage} />);
        pushStatus(status({ lastError: 'GitHub PR list failed (403)' }));
        expect(screen.getByTestId('pr-watcher-error').textContent).toContain('403');
    });
});
