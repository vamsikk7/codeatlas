import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ExplorerSidebar from './ExplorerSidebar';

beforeEach(() => {
    vi.useFakeTimers();
    (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
    vi.useRealTimers();
    delete (window as any).vscodeApi;
});

/** Helper: dispatch an explorerData message to the window. */
function sendExplorerData(data: Partial<{
    services: any[];
    features: any[];
    apis: any[];
    files: any[];
    functions: any[];
}>) {
    act(() => {
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    type: 'explorerData',
                    services: [],
                    features: [],
                    apis: [],
                    files: [],
                    functions: [],
                    ...data,
                },
            }),
        );
    });
}

/** Generate N items for a given section. */
function makeItems(count: number, prefix = 'item') {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        label: `${prefix} ${i}`,
        subtitle: `sub-${prefix}-${i}`,
        action: { type: 'open', target: `${prefix}-${i}` },
    }));
}

describe('ExplorerSidebar', () => {
    // ------------------------------------------------------------------
    // 1. Toggle button is now in CommandBar, not ExplorerSidebar
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 2. Sidebar hidden when visible=false
    // ------------------------------------------------------------------
    it('sidebar is hidden when visible is false', () => {
        render(<ExplorerSidebar visible={false} onToggle={vi.fn()} />);
        expect(screen.queryByRole('navigation', { name: 'Explorer' })).toBeNull();
    });

    // ------------------------------------------------------------------
    // 3. Sidebar shown when visible=true
    // ------------------------------------------------------------------
    it('sidebar is shown when visible is true', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        expect(screen.getByRole('navigation', { name: 'Explorer' })).toBeDefined();
    });

    // ------------------------------------------------------------------
    // 4. onToggle called on toggle button click
    // ------------------------------------------------------------------
    // Toggle button test removed — toggle is now in CommandBar

    it('calls onToggle when close button is clicked', () => {
        const onToggle = vi.fn();
        render(<ExplorerSidebar visible={true} onToggle={onToggle} />);
        fireEvent.click(screen.getByLabelText('Close Explorer'));
        expect(onToggle).toHaveBeenCalledOnce();
    });

    // ------------------------------------------------------------------
    // 5. Five sections rendered
    // ------------------------------------------------------------------
    it('shows all 5 section titles when visible', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        expect(screen.getByText('Services')).toBeDefined();
        expect(screen.getByText('Feature Areas')).toBeDefined();
        expect(screen.getByText('APIs')).toBeDefined();
        expect(screen.getByText('Files')).toBeDefined();
        expect(screen.getByText('Functions')).toBeDefined();
    });

    // ------------------------------------------------------------------
    // 6. Section collapse/expand defaults
    // ------------------------------------------------------------------
    it('Services section is expanded by default (has a listbox)', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        // Services is defaultOpen, so its listbox should be present
        expect(screen.getByRole('listbox', { name: 'Services' })).toBeDefined();
    });

    it('Features section is collapsed by default', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        expect(screen.queryByRole('listbox', { name: 'Feature Areas' })).toBeNull();
    });

    it('APIs section is collapsed by default', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        expect(screen.queryByRole('listbox', { name: 'APIs' })).toBeNull();
    });

    // ------------------------------------------------------------------
    // 7. Section expands on click
    // ------------------------------------------------------------------
    it('section expands when its header is clicked', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        // Feature Areas is collapsed by default
        expect(screen.queryByRole('listbox', { name: 'Feature Areas' })).toBeNull();
        fireEvent.click(screen.getByText('Feature Areas'));
        expect(screen.getByRole('listbox', { name: 'Feature Areas' })).toBeDefined();
    });

    // ------------------------------------------------------------------
    // 8. Sends requestExplorerData on mount
    // ------------------------------------------------------------------
    it('sends requestExplorerData on mount', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({
            type: 'requestExplorerData',
        });
    });

    // ------------------------------------------------------------------
    // 9. Populates items from explorerData message
    // ------------------------------------------------------------------
    it('populates items when explorerData message is received', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 'svc-1', label: 'AuthService', action: { type: 'openService', id: 'svc-1' } },
                { id: 'svc-2', label: 'PaymentService', action: { type: 'openService', id: 'svc-2' } },
            ],
        });
        // Services is expanded by default
        expect(screen.getByText('AuthService')).toBeDefined();
        expect(screen.getByText('PaymentService')).toBeDefined();
    });

    // ------------------------------------------------------------------
    // 10. Filter input shown when section has >5 items
    // ------------------------------------------------------------------
    it('shows filter input when a section has more than 5 items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(6, 'svc') });
        expect(screen.getByPlaceholderText('Filter services...')).toBeDefined();
    });

    it('does not show filter input when a section has 5 or fewer items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(3, 'svc') });
        expect(screen.queryByPlaceholderText('Filter services...')).toBeNull();
    });

    // ------------------------------------------------------------------
    // 11. Filter narrows displayed items
    // ------------------------------------------------------------------
    it('filter narrows displayed items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(8, 'svc') });

        const filterInput = screen.getByPlaceholderText('Filter services...');
        fireEvent.change(filterInput, { target: { value: 'svc 3' } });

        // Advance timers past the 100ms debounce
        act(() => { vi.advanceTimersByTime(150); });

        expect(screen.getByText('svc 3')).toBeDefined();
        // Items that don't match should not be present
        expect(screen.queryByText('svc 0')).toBeNull();
        expect(screen.queryByText('svc 7')).toBeNull();
    });

    // ------------------------------------------------------------------
    // 12. Clicking an item sends its action via postMessage
    // ------------------------------------------------------------------
    it('clicking an item sends its action via postMessage', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 's1', label: 'MyService', action: { type: 'openService', id: 's1' } },
            ],
        });
        fireEvent.click(screen.getByText('MyService'));
        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({
            type: 'openService',
            id: 's1',
        });
    });

    // ------------------------------------------------------------------
    // 13. Diff badges render for added/modified/deleted items
    // ------------------------------------------------------------------
    it('renders "+" badge for added items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 's1', label: 'NewSvc', diff: 'added', action: { type: 'open' } },
            ],
        });
        const badge = screen.getByText('+');
        expect(badge).toBeDefined();
        expect(badge.getAttribute('data-diff')).toBe('added');
    });

    it('renders "~" badge for modified items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 's2', label: 'ChangedSvc', diff: 'modified', action: { type: 'open' } },
            ],
        });
        const badge = screen.getByText('~');
        expect(badge).toBeDefined();
        expect(badge.getAttribute('data-diff')).toBe('modified');
    });

    it('renders "-" badge for deleted items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 's3', label: 'RemovedSvc', diff: 'deleted', action: { type: 'open' } },
            ],
        });
        const badge = screen.getByText('-');
        expect(badge).toBeDefined();
        expect(badge.getAttribute('data-diff')).toBe('deleted');
    });

    it('does not render a badge for unchanged items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 's4', label: 'StableSvc', diff: 'unchanged', action: { type: 'open' } },
            ],
        });
        expect(screen.getByText('StableSvc')).toBeDefined();
        // No badge symbols should be present
        expect(screen.queryByLabelText('unchanged')).toBeNull();
    });

    // ------------------------------------------------------------------
    // 14. ArrowDown moves focus to next item
    // ------------------------------------------------------------------
    it('ArrowDown moves focus to next item', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(3, 'svc') });

        const section = screen.getByRole('listbox', { name: 'Services' }).closest('.ca-explorer-section')!;

        // Press ArrowDown twice
        fireEvent.keyDown(section, { key: 'ArrowDown' });
        fireEvent.keyDown(section, { key: 'ArrowDown' });

        // Second item (index 1) should have 'focused' class
        const items = screen.getAllByRole('option');
        expect(items[1].classList.contains('focused')).toBe(true);
    });

    // ------------------------------------------------------------------
    // 15. Enter on focused item sends action
    // ------------------------------------------------------------------
    it('Enter on focused item sends its action via postMessage', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({
            services: [
                { id: 's1', label: 'First', action: { type: 'openFirst' } },
                { id: 's2', label: 'Second', action: { type: 'openSecond' } },
            ],
        });

        const section = screen.getByRole('listbox', { name: 'Services' }).closest('.ca-explorer-section')!;

        // Focus first item
        fireEvent.keyDown(section, { key: 'ArrowDown' });
        // Focus second item
        fireEvent.keyDown(section, { key: 'ArrowDown' });
        // Press Enter
        fireEvent.keyDown(section, { key: 'Enter' });

        expect((window as any).vscodeApi.postMessage).toHaveBeenCalledWith({ type: 'openSecond' });
    });

    // ------------------------------------------------------------------
    // 16. Escape clears filter
    // ------------------------------------------------------------------
    it('Escape clears the filter', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(8, 'svc') });

        const filterInput = screen.getByPlaceholderText('Filter services...');
        fireEvent.change(filterInput, { target: { value: 'svc 2' } });
        act(() => { vi.advanceTimersByTime(150); });

        // Should be filtered: only 'svc 2' visible
        expect(screen.queryByText('svc 0')).toBeNull();

        // Press Escape on the section
        const section = screen.getByRole('listbox', { name: 'Services' }).closest('.ca-explorer-section')!;
        fireEvent.keyDown(section, { key: 'Escape' });

        // All items should be back (debounced filter is cleared immediately)
        expect(screen.getByText('svc 0')).toBeDefined();
        expect(screen.getByText('svc 7')).toBeDefined();
    });

    // ------------------------------------------------------------------
    // 17. ArrowUp moves focus to previous item
    // ------------------------------------------------------------------
    it('ArrowUp moves focus to previous item', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(3, 'svc') });

        const section = screen.getByRole('listbox', { name: 'Services' }).closest('.ca-explorer-section')!;

        // Move down twice, then up once (should be at index 0)
        fireEvent.keyDown(section, { key: 'ArrowDown' });
        fireEvent.keyDown(section, { key: 'ArrowDown' });
        fireEvent.keyDown(section, { key: 'ArrowUp' });

        const items = screen.getAllByRole('option');
        expect(items[0].classList.contains('focused')).toBe(true);
    });

    // ------------------------------------------------------------------
    // 18. Empty state
    // ------------------------------------------------------------------
    it('shows "No items" when section is open but has no items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: [] });
        // Services is defaultOpen
        expect(screen.getByText('No items')).toBeDefined();
    });

    it('shows "No matches" when filter eliminates all items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(8, 'svc') });

        const filterInput = screen.getByPlaceholderText('Filter services...');
        fireEvent.change(filterInput, { target: { value: 'nonexistent-query' } });
        act(() => { vi.advanceTimersByTime(150); });

        expect(screen.getByText('No matches')).toBeDefined();
    });

    // ------------------------------------------------------------------
    // 19. Section shows item count
    // ------------------------------------------------------------------
    it('section header shows the count of items', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        sendExplorerData({ services: makeItems(4, 'svc') });

        // The count badge should show "4"
        const countBadges = document.querySelectorAll('.ca-explorer-section-count');
        // Services section is the first one
        expect(countBadges[0].textContent).toBe('4');
    });

    // ------------------------------------------------------------------
    // 20. Explorer header title
    // ------------------------------------------------------------------
    it('shows "Explorer" header title in the sidebar', () => {
        render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
        expect(screen.getByText('Explorer')).toBeDefined();
    });

    // ------------------------------------------------------------------
    // UX-50g — per-repo grouping in multi-repo workspaces
    // ------------------------------------------------------------------
    describe('UX-50g — per-repo grouping', () => {
        const REPOS = [
            { repoId: 'r:api', name: 'api', rootPath: 'services/api' },
            { repoId: 'r:web', name: 'web', rootPath: 'apps/web' },
        ];

        it('does NOT render repo headers when repos prop is undefined (single-repo)', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} />);
            sendExplorerData({
                services: [
                    { id: 's:api', label: 'api', subtitle: 'express · 5 APIs', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                    { id: 's:web', label: 'web', subtitle: 'nextjs · 2 APIs', repoId: 'r:web', action: { type: 'openFeatureForService', serviceId: 's:web' } },
                ],
            });
            expect(screen.queryAllByTestId('ca-explorer-repo-header')).toHaveLength(0);
        });

        it('does NOT render repo headers when repos has only one entry', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} repos={[REPOS[0]]} />);
            sendExplorerData({
                services: [
                    { id: 's:api', label: 'api', subtitle: 'express', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                ],
            });
            expect(screen.queryAllByTestId('ca-explorer-repo-header')).toHaveLength(0);
        });

        it('renders one repo header per non-empty bucket when repos.length >= 2', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} repos={REPOS} />);
            sendExplorerData({
                services: [
                    { id: 's:api', label: 'api', subtitle: 'express', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                    { id: 's:web', label: 'web', subtitle: 'nextjs', repoId: 'r:web', action: { type: 'openFeatureForService', serviceId: 's:web' } },
                ],
            });
            const headers = screen.getAllByTestId('ca-explorer-repo-header');
            expect(headers).toHaveLength(2);
            expect(headers[0].textContent).toMatch(/^api/);
            expect(headers[1].textContent).toMatch(/^web/);
        });

        it('renders an Unassigned tail bucket when items lack a known repoId', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} repos={REPOS} />);
            sendExplorerData({
                services: [
                    { id: 's:api', label: 'api', subtitle: 'express', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                    { id: 's:lib', label: 'lib', subtitle: 'shared util', /* no repoId */ action: { type: 'openFeatureForService', serviceId: 's:lib' } },
                ],
            });
            const headers = screen.getAllByTestId('ca-explorer-repo-header');
            // api repo + Unassigned tail (web bucket is empty so it's omitted).
            expect(headers).toHaveLength(2);
            expect(headers[0].textContent).toMatch(/^api/);
            expect(headers[1].textContent).toMatch(/^Unassigned/);
        });

        it('group order follows repos[] (api before web) regardless of item order', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} repos={REPOS} />);
            sendExplorerData({
                services: [
                    // web before api in the items list.
                    { id: 's:web', label: 'web', subtitle: 'nextjs', repoId: 'r:web', action: { type: 'openFeatureForService', serviceId: 's:web' } },
                    { id: 's:api', label: 'api', subtitle: 'express', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                ],
            });
            const headers = screen.getAllByTestId('ca-explorer-repo-header');
            expect(headers[0].textContent).toMatch(/^api/);
            expect(headers[1].textContent).toMatch(/^web/);
        });

        it('flat fallback when none of the items carry a repoId (single-repo emit shape)', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} repos={REPOS} />);
            sendExplorerData({
                services: [
                    { id: 's:api', label: 'api', subtitle: 'express', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                    { id: 's:web', label: 'web', subtitle: 'nextjs', action: { type: 'openFeatureForService', serviceId: 's:web' } },
                ],
            });
            // No item carries repoId → grouping not applied → no headers.
            expect(screen.queryAllByTestId('ca-explorer-repo-header')).toHaveLength(0);
        });

        it('repo header carries item count next to the repo name', () => {
            render(<ExplorerSidebar visible={true} onToggle={vi.fn()} repos={REPOS} />);
            sendExplorerData({
                services: [
                    { id: 's:api', label: 'api', subtitle: 'express', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api' } },
                    { id: 's:web', label: 'web', subtitle: 'nextjs', repoId: 'r:web', action: { type: 'openFeatureForService', serviceId: 's:web' } },
                    { id: 's:api2', label: 'api2', subtitle: 'express', repoId: 'r:api', action: { type: 'openFeatureForService', serviceId: 's:api2' } },
                ],
            });
            const headers = screen.getAllByTestId('ca-explorer-repo-header');
            // api has 2 items, web has 1.
            expect(headers[0].textContent).toMatch(/· 2/);
            expect(headers[1].textContent).toMatch(/· 1/);
        });
    });
});
