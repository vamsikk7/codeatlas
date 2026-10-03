/**
 * ScopePicker.test.tsx — UX-50a (2026-06-06).
 *
 * Per-layer scope picker invariants:
 *   - Renders title, search input, items, footer count.
 *   - Search filters by label and subtitle.
 *   - Click → onPick(item) with the right item.
 *   - Escape → onCancel; overlay click → onCancel; Close button → onCancel.
 *   - Enter on first item → onPick(first item).
 *   - groupBy='repo': renders one section header per repo (matches `repos[]`
 *     order), each header carrying the repo name + item count, with an
 *     "Unassigned" tail bucket for items missing a known repoId.
 *   - groupBy=null: flat list.
 *   - Empty list → renders the emptyLabel.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ScopePicker, { type ScopePickerItem, type ScopePickerRepoMeta } from '../ScopePicker';

afterEach(() => cleanup());

const ITEMS: ScopePickerItem[] = [
    { id: 's:api', label: 'api', subtitle: '5 endpoints', repoId: 'r:api' },
    { id: 's:web', label: 'web', subtitle: '12 components', repoId: 'r:web' },
    { id: 's:lib', label: 'lib', subtitle: '3 utilities', /* repoId intentionally absent */ },
];

const REPOS: ScopePickerRepoMeta[] = [
    { repoId: 'r:api', repoName: 'api-service', rootPath: 'services/api' },
    { repoId: 'r:web', repoName: 'web-app', rootPath: 'apps/web' },
];

describe('ScopePicker — UX-50a', () => {
    it('renders title, search, items, and footer count', () => {
        render(
            <ScopePicker
                title="Pick a service"
                placeholder="Filter services…"
                items={ITEMS}
                groupBy={null}
                onPick={() => { /* noop */ }}
                onCancel={() => { /* noop */ }}
            />,
        );
        expect(screen.getByText('Pick a service')).toBeTruthy();
        expect(screen.getByPlaceholderText('Filter services…')).toBeTruthy();
        expect(screen.getAllByTestId('ca-scope-picker-item')).toHaveLength(3);
        expect(screen.getByTestId('ca-scope-picker').textContent ?? '').toMatch(/3 of 3/);
    });

    it('filters items by label and subtitle on type', () => {
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
            />,
        );
        fireEvent.change(screen.getByTestId('ca-scope-picker-search'), { target: { value: 'comp' } });
        const rows = screen.getAllByTestId('ca-scope-picker-item');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toMatch(/web/);
    });

    it('click on an item dispatches onPick with the matching record', () => {
        const onPick = vi.fn();
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={onPick} onCancel={() => { /* noop */ }}
            />,
        );
        fireEvent.click(screen.getAllByTestId('ca-scope-picker-item')[1]);
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick.mock.calls[0][0].id).toBe('s:web');
    });

    it('Escape key fires onCancel', () => {
        const onCancel = vi.fn();
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={onCancel}
            />,
        );
        const modal = screen.getByTestId('ca-scope-picker').querySelector('.ca-modal') as HTMLElement;
        fireEvent.keyDown(modal, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('Enter key picks the first item', () => {
        const onPick = vi.fn();
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={onPick} onCancel={() => { /* noop */ }}
            />,
        );
        const modal = screen.getByTestId('ca-scope-picker').querySelector('.ca-modal') as HTMLElement;
        fireEvent.keyDown(modal, { key: 'Enter' });
        expect(onPick).toHaveBeenCalledTimes(1);
        expect(onPick.mock.calls[0][0].id).toBe('s:api');
    });

    it('Close button fires onCancel', () => {
        const onCancel = vi.fn();
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={onCancel}
            />,
        );
        fireEvent.click(screen.getByTestId('ca-scope-picker-close'));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('flat list rendering: no group headers when groupBy=null', () => {
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
            />,
        );
        expect(screen.queryAllByTestId('ca-scope-picker-group-header')).toHaveLength(0);
    });

    it('grouped rendering: one header per repo + Unassigned tail bucket', () => {
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} repos={REPOS} groupBy="repo"
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
            />,
        );
        const headers = screen.getAllByTestId('ca-scope-picker-group-header');
        // 2 known repos + 1 unassigned bucket.
        expect(headers).toHaveLength(3);
        expect(headers[0].textContent).toMatch(/api-service/);
        expect(headers[1].textContent).toMatch(/web-app/);
        expect(headers[2].textContent).toMatch(/Unassigned/);
    });

    it('grouped rendering preserves repos[] order regardless of items[] order', () => {
        // Items shuffled — web first, then api, then lib (no repo).
        const shuffled: ScopePickerItem[] = [ITEMS[1], ITEMS[0], ITEMS[2]];
        render(
            <ScopePicker
                title="Pick a service" items={shuffled} repos={REPOS} groupBy="repo"
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
            />,
        );
        const headers = screen.getAllByTestId('ca-scope-picker-group-header');
        // Should follow REPOS order: api-service first, then web-app, then Unassigned.
        expect(headers[0].textContent).toMatch(/api-service/);
        expect(headers[1].textContent).toMatch(/web-app/);
    });

    it('empty list renders emptyLabel', () => {
        render(
            <ScopePicker
                title="Pick a service" items={[]} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
                emptyLabel="No services detected yet."
            />,
        );
        expect(screen.getByText('No services detected yet.')).toBeTruthy();
        expect(screen.queryAllByTestId('ca-scope-picker-item')).toHaveLength(0);
    });

    it('search with no match renders the no-match placeholder', () => {
        render(
            <ScopePicker
                title="Pick a service" items={ITEMS} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
            />,
        );
        fireEvent.change(screen.getByTestId('ca-scope-picker-search'), { target: { value: 'zzzz' } });
        expect(screen.getByText(/No items match/)).toBeTruthy();
    });

    it('renders diff badge when the item carries diff state', () => {
        const withDiff: ScopePickerItem[] = [
            { id: 's:api', label: 'api', subtitle: '5 endpoints', diff: 'modified' },
            { id: 's:web', label: 'web', subtitle: '12 components', diff: 'added' },
            { id: 's:lib', label: 'lib', subtitle: '3 utilities', diff: 'unchanged' },
        ];
        render(
            <ScopePicker
                title="Pick a service" items={withDiff} groupBy={null}
                onPick={() => { /* noop */ }} onCancel={() => { /* noop */ }}
            />,
        );
        const rows = screen.getAllByTestId('ca-scope-picker-item');
        // Modified row carries ~ badge; added row carries +; unchanged row carries nothing.
        expect(rows[0].querySelector('[data-diff="modified"]')?.textContent).toBe('~');
        expect(rows[1].querySelector('[data-diff="added"]')?.textContent).toBe('+');
        expect(rows[2].querySelector('[data-diff]')).toBeNull();
    });
});
