/**
 * SavedViewsToolbar.test.tsx — #750 saved-views UI (2026-06-06).
 *
 * Single component hosting:
 *   - `💾 Save view` button → opens an inline name input → emits onSave
 *   - dropdown of saved views → emits onApply on click
 *   - per-row × button → emits onDelete
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SavedViewsToolbar, { type SavedFilterView } from '../SavedViewsToolbar';

const VIEWS: SavedFilterView[] = [
    { id: 'auth-only', name: 'Auth only', route: '/apis/cluster:auth', filters: { search: 'login' }, createdAt: 1 },
    { id: 'kmap-recent', name: 'KMap recent', route: '/map', filters: {}, createdAt: 2 },
];

describe('SavedViewsToolbar — Save view button', () => {
    it('renders the Save button', () => {
        render(<SavedViewsToolbar views={[]} onSave={() => { /* noop */ }} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-saved-views-save-btn')).toBeTruthy();
    });

    it('clicking Save reveals the name input', () => {
        render(<SavedViewsToolbar views={[]} onSave={() => { /* noop */ }} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        expect(screen.queryByTestId('ca-saved-views-name-input')).toBeNull();
        fireEvent.click(screen.getByTestId('ca-saved-views-save-btn'));
        expect(screen.getByTestId('ca-saved-views-name-input')).toBeTruthy();
    });

    it('typing a name and confirming invokes onSave with the trimmed name', () => {
        const spy = vi.fn();
        render(<SavedViewsToolbar views={[]} onSave={spy} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-saved-views-save-btn'));
        fireEvent.change(screen.getByTestId('ca-saved-views-name-input'), { target: { value: '  My view  ' } });
        fireEvent.click(screen.getByTestId('ca-saved-views-save-confirm'));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe('My view');
    });

    it('Save Confirm is disabled when the name is empty or whitespace', () => {
        const spy = vi.fn();
        render(<SavedViewsToolbar views={[]} onSave={spy} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-saved-views-save-btn'));
        const confirm = screen.getByTestId('ca-saved-views-save-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('ca-saved-views-name-input'), { target: { value: '   ' } });
        expect(confirm.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('ca-saved-views-name-input'), { target: { value: 'ok' } });
        expect(confirm.disabled).toBe(false);
    });

    it('Cancel closes the input without firing onSave', () => {
        const spy = vi.fn();
        render(<SavedViewsToolbar views={[]} onSave={spy} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-saved-views-save-btn'));
        fireEvent.click(screen.getByTestId('ca-saved-views-save-cancel'));
        expect(screen.queryByTestId('ca-saved-views-name-input')).toBeNull();
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('SavedViewsToolbar — Views dropdown', () => {
    it('does not render the dropdown trigger when views are empty', () => {
        render(<SavedViewsToolbar views={[]} onSave={() => { /* noop */ }} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        expect(screen.queryByTestId('ca-saved-views-dropdown-btn')).toBeNull();
    });

    it('renders the dropdown trigger with a count when views exist', () => {
        render(<SavedViewsToolbar views={VIEWS} onSave={() => { /* noop */ }} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        const trigger = screen.getByTestId('ca-saved-views-dropdown-btn');
        expect(trigger.textContent ?? '').toMatch(/2/);
    });

    it('clicking the dropdown trigger lists every view', () => {
        render(<SavedViewsToolbar views={VIEWS} onSave={() => { /* noop */ }} onApply={() => { /* noop */ }} onDelete={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-saved-views-dropdown-btn'));
        expect(screen.getByTestId('ca-saved-views-row-auth-only')).toBeTruthy();
        expect(screen.getByTestId('ca-saved-views-row-kmap-recent')).toBeTruthy();
    });

    it('clicking a row invokes onApply with the view id', () => {
        const spy = vi.fn();
        render(<SavedViewsToolbar views={VIEWS} onSave={() => { /* noop */ }} onApply={spy} onDelete={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-saved-views-dropdown-btn'));
        fireEvent.click(screen.getByTestId('ca-saved-views-row-auth-only'));
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe('auth-only');
    });

    it('clicking the per-row × invokes onDelete and stops propagation', () => {
        const onApply = vi.fn();
        const onDelete = vi.fn();
        render(<SavedViewsToolbar views={VIEWS} onSave={() => { /* noop */ }} onApply={onApply} onDelete={onDelete} />);
        fireEvent.click(screen.getByTestId('ca-saved-views-dropdown-btn'));
        fireEvent.click(screen.getByTestId('ca-saved-views-delete-auth-only'));
        expect(onDelete).toHaveBeenCalledWith('auth-only');
        expect(onApply).not.toHaveBeenCalled();
    });
});
