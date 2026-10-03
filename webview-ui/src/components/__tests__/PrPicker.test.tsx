import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PrPicker from '../PrPicker';
import type { PrListItem } from '../PrPicker';

const samplePrs: PrListItem[] = [
    { number: 142, title: 'fix: login validation', author: 'alice', branch: 'fix/login', updatedAt: '2026-04-18T02:00:00Z', isDraft: false },
    { number: 139, title: 'feat: add payment processing', author: 'bob', branch: 'feature/payments', updatedAt: '2026-04-17T10:00:00Z', isDraft: false },
    { number: 137, title: 'chore: update dependencies', author: 'alice', branch: 'chore/deps', updatedAt: '2026-04-15T08:00:00Z', isDraft: true },
];

describe('PrPicker', () => {
    it('renders PR list with items', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByText('#142')).toBeDefined();
        expect(screen.getByText('fix: login validation')).toBeDefined();
        expect(screen.getByText('#139')).toBeDefined();
    });

    it('shows DRAFT label on draft PRs', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByText('DRAFT')).toBeDefined();
    });

    it('search filters PR list', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={vi.fn()} onCancel={vi.fn()} />);
        const searchInput = screen.getByPlaceholderText(/Search PRs/);
        fireEvent.change(searchInput, { target: { value: 'payment' } });
        // Only payment PR should be visible
        expect(screen.queryByText('#142')).toBeNull();
        expect(screen.getByText('#139')).toBeDefined();
    });

    it('calls onSelect when PR item is clicked', () => {
        const onSelect = vi.fn();
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={onSelect} onCancel={vi.fn()} />);
        fireEvent.click(screen.getByText('#142'));
        expect(onSelect).toHaveBeenCalledWith(142);
    });

    it('shows manual number input on toggle', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={vi.fn()} onCancel={vi.fn()} />);
        fireEvent.click(screen.getByText('Enter PR number manually'));
        expect(screen.getByPlaceholderText('123')).toBeDefined();
        expect(screen.getByText('Back to list')).toBeDefined();
    });

    it('validates non-numeric input in manual mode', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={vi.fn()} onCancel={vi.fn()} />);
        fireEvent.click(screen.getByText('Enter PR number manually'));
        const input = screen.getByPlaceholderText('123');
        fireEvent.change(input, { target: { value: 'abc' } });
        fireEvent.click(screen.getByText('Compare'));
        expect(screen.getByText('Enter a numeric PR number')).toBeDefined();
    });

    it('shows auth warning when not connected', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} gitHubConnected={false} onSelect={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByText(/Not connected to GitHub/)).toBeDefined();
    });

    it('hides auth warning when connected', () => {
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} gitHubConnected={true} onSelect={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.queryByText(/Not connected to GitHub/)).toBeNull();
    });

    it('shows manual input mode when no PRs', () => {
        render(<PrPicker owner="org" repo="repo" prs={[]} onSelect={vi.fn()} onCancel={vi.fn()} />);
        // When no PRs available, starts in manual number input mode
        expect(screen.getByPlaceholderText('123')).toBeDefined();
    });

    it('calls onCancel when Cancel is clicked', () => {
        const onCancel = vi.fn();
        render(<PrPicker owner="org" repo="repo" prs={samplePrs} onSelect={vi.fn()} onCancel={onCancel} />);
        fireEvent.click(screen.getByText('Cancel'));
        expect(onCancel).toHaveBeenCalledOnce();
    });
});
