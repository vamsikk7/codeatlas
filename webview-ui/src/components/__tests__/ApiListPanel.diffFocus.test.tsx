/**
 * ApiListPanel.diffFocus.test.tsx — the L2b api-list Changed / +/−/~ filter
 * COMPOSES with the existing method tabs + search: the changed rows shown are
 * the intersection of (change filter) AND (method tab) AND (search text).
 * Also covers the bar gate + hiding the normal sections under a filter.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import ApiListPanel from '../ApiListPanel';

beforeAll(() => {
    if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
        class R { observe() {} unobserve() {} disconnect() {} }
        (window as any).ResizeObserver = R;
        (global as any).ResizeObserver = R;
    }
});
beforeEach(() => { (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }; });

function api(apiId: string, method: string, route: string, diff?: string) {
    return { apiId, method, route, handlerName: apiId, filePath: `src/${apiId}.ts`, diff };
}
function backendGraph() {
    return {
        graphId: 'api-list:cluster:x',
        meta: {
            apis: [
                api('o1', 'POST', '/orders/create', 'added'),
                api('o2', 'GET', '/orders/list', 'added'),
                api('u1', 'POST', '/users/create', 'unchanged'),
                api('u2', 'GET', '/users/me', 'modified'),
            ],
            files: ['src/o1.ts', 'src/o2.ts', 'src/u1.ts', 'src/u2.ts'],
        },
    } as any;
}
const renderPanel = () => render(<ApiListPanel graph={backendGraph()} onApiClick={() => {}} onFileClick={() => {}} />);
function methodTab(name: string): HTMLElement {
    const btn = screen.getAllByRole('button').find(
        (b) => b.className.includes('ca-method-tab') && new RegExp(`^${name}`).test(b.textContent || ''));
    if (!btn) throw new Error(`method tab ${name} not found`);
    return btn;
}
// search is debounced 200ms — advance past it.
function typeSearch(text: string) {
    const input = screen.getByPlaceholderText(/Filter by route or handler/);
    fireEvent.change(input, { target: { value: text } });
    act(() => { vi.advanceTimersByTime(250); });
}

describe('ApiListPanel diff-focus bar', () => {
    it('shows the bar + counts across ALL apis (2 added + 1 modified = 3 changed of 4)', () => {
        renderPanel();
        const bar = screen.getByTestId('diff-focus-bar');
        expect(within(bar).getByText('All 4')).toBeTruthy();
        expect(within(bar).getByText(/Changed 3/)).toBeTruthy();
        expect(within(bar).getByText('+2')).toBeTruthy();
        expect(within(bar).getByText('~1')).toBeTruthy();
    });

    it('Changed filter hides the normal file-grouped section (only Changes group shows)', () => {
        renderPanel();
        // the unchanged POST /users/create is visible under All
        expect(screen.queryByText('/users/create')).toBeTruthy();
        fireEvent.click(within(screen.getByTestId('diff-focus-bar')).getByRole('button', { name: /Changed/ }));
        expect(screen.queryByText('/users/create')).toBeNull();     // unchanged — hidden
        expect(screen.getByText('/orders/create')).toBeTruthy();    // added — shown
        expect(screen.getByText('/users/me')).toBeTruthy();         // modified — shown
    });
});

describe('composes with method tabs (Changed AND POST)', () => {
    it('shows only rows that are BOTH changed AND POST', () => {
        renderPanel();
        fireEvent.click(methodTab('POST'));
        // bar now counts POST-only: 1 changed (POST /orders/create added)
        const bar = screen.getByTestId('diff-focus-bar');
        expect(within(bar).getByText(/Changed 1/)).toBeTruthy();
        fireEvent.click(within(bar).getByRole('button', { name: /Changed/ }));
        expect(screen.getByText('/orders/create')).toBeTruthy();  // POST + added ✓
        expect(screen.queryByText('/orders/list')).toBeNull();    // GET + added → method-filtered out
        expect(screen.queryByText('/users/me')).toBeNull();       // GET + modified → method-filtered out
        expect(screen.queryByText('/users/create')).toBeNull();   // POST + unchanged → change-filtered out
    });
});

describe('composes with search (Changed AND text)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    // restore real timers after each so other suites aren't affected
    it('shows only rows that are BOTH changed AND match the search text', () => {
        renderPanel();
        typeSearch('users');
        const bar = screen.getByTestId('diff-focus-bar');
        // /users/* : create(unchanged) + me(modified) → 1 changed
        expect(within(bar).getByText(/Changed 1/)).toBeTruthy();
        fireEvent.click(within(bar).getByRole('button', { name: /Changed/ }));
        expect(screen.getByText('/users/me')).toBeTruthy();       // users + modified ✓
        expect(screen.queryByText('/orders/create')).toBeNull();  // orders → search-filtered out
        expect(screen.queryByText('/users/create')).toBeNull();   // users but unchanged → change-filtered out
        vi.useRealTimers();
    });
});
