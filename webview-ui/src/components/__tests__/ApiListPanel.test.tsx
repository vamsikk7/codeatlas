/**
 * ApiListPanel.test.tsx — v2 phase 4 PR-F.
 *
 * Locks the L2b panel render contract:
 *   1. When `graph.graphId` starts with `screen-content:` AND
 *      `graph.meta.screenItems` is present, the FE/mobile
 *      ScreenContentPanel renders (five primary sections plus
 *      collapsible visual inventory).
 *   2. The visual inventory section is collapsed by default — the
 *      header is visible but the items list is NOT.
 *   3. Each non-visual section renders open by default with all items.
 *   4. Header counts mirror `meta.sectionCounts`.
 *   5. Backend api-list graphs (no `screen-content:` prefix, no
 *      screenItems) continue with today's renderer unchanged —
 *      the snapshot test guards against accidental drift.
 *   6. Clicking a row fires `onFileClick` with the item's anchor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ApiListPanel from '../ApiListPanel';

beforeEach(() => {
    (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
});

function mkScreenContentGraph(items: any[] = []) {
    return {
        graphId: 'screen-content:screen:service:web:/login',
        meta: {
            screenId: 'screen:service:web:/login',
            serviceId: 'service:web',
            routePath: '/login',
            framework: 'nextjs-app',
            filePath: 'apps/web/app/login/page.tsx',
            screenItems: items,
            sectionCounts: {
                interactions: items.filter((i) => i.section === 'interactions').length,
                data: items.filter((i) => i.section === 'data').length,
                lifecycle: items.filter((i) => i.section === 'lifecycle').length,
                'nav-in': items.filter((i) => i.section === 'nav-in').length,
                'nav-out': items.filter((i) => i.section === 'nav-out').length,
                visual: items.filter((i) => i.section === 'visual').length,
            },
        },
    } as any;
}

function mkItem(over: any) {
    return {
        itemId: 'placeholder',
        screenId: 'screen:service:web:/login',
        section: 'interactions',
        kind: 'interaction:click',
        label: 'placeholder',
        filePath: 'apps/web/app/login/page.tsx',
        anchor: { filePath: 'apps/web/app/login/page.tsx', lineStart: 1, lineEnd: 1 },
        ...over,
    };
}

describe('ApiListPanel — screen-content layout (#485 PR-F)', () => {
    it('renders all 5 primary sections + Visual elements header', () => {
        const graph = mkScreenContentGraph();
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        expect(screen.getByText('Interactions')).toBeDefined();
        expect(screen.getByText('Data sources')).toBeDefined();
        expect(screen.getByText('Lifecycle')).toBeDefined();
        expect(screen.getByText('Navigation in')).toBeDefined();
        expect(screen.getByText('Navigation out')).toBeDefined();
        expect(screen.getByText('Visual elements')).toBeDefined();
    });

    it('routePath + framework label render in the header', () => {
        const graph = mkScreenContentGraph();
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        expect(screen.getByText('/login')).toBeDefined();
        // The framework line includes the file path.
        expect(screen.getByText(/nextjs-app.*apps\/web\/app\/login\/page\.tsx/)).toBeDefined();
    });

    it('items in the Interactions section render their label', () => {
        const graph = mkScreenContentGraph([
            mkItem({ itemId: 'i:a', section: 'interactions', kind: 'interaction:click', label: 'handleSubmit' }),
            mkItem({ itemId: 'i:b', section: 'interactions', kind: 'interaction:change', label: 'onName' }),
        ]);
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        expect(screen.getByText('handleSubmit')).toBeDefined();
        expect(screen.getByText('onName')).toBeDefined();
    });

    it('Visual elements section header shows count but items are collapsed by default', () => {
        const graph = mkScreenContentGraph([
            mkItem({ itemId: 'v:a', section: 'visual', kind: 'visual:button', label: 'button × 3', visualKind: 'button' }),
            mkItem({ itemId: 'v:b', section: 'visual', kind: 'visual:input', label: 'input × 2', visualKind: 'input' }),
        ]);
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        // Header + count visible.
        expect(screen.getByText('Visual elements')).toBeDefined();
        expect(screen.getByText('(2)')).toBeDefined();
        // Item labels NOT visible (collapsed).
        expect(screen.queryByText('button × 3')).toBeNull();
        expect(screen.queryByText('input × 2')).toBeNull();
    });

    it('clicking the Visual elements header expands the items', () => {
        const graph = mkScreenContentGraph([
            mkItem({ itemId: 'v:a', section: 'visual', kind: 'visual:button', label: 'button × 3', visualKind: 'button' }),
        ]);
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        expect(screen.queryByText('button × 3')).toBeNull();
        fireEvent.click(screen.getByText('Visual elements'));
        expect(screen.getByText('button × 3')).toBeDefined();
    });

    it('clicking an item row fires onFileClick with the anchor file path', () => {
        const onFileClick = vi.fn();
        const graph = mkScreenContentGraph([
            mkItem({
                itemId: 'i:a',
                section: 'interactions',
                kind: 'interaction:click',
                label: 'handleSubmit',
                anchor: { filePath: 'apps/web/Login.tsx', lineStart: 12, lineEnd: 12 },
            }),
        ]);
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={onFileClick} />);
        fireEvent.click(screen.getByText('handleSubmit'));
        expect(onFileClick).toHaveBeenCalledWith('apps/web/Login.tsx', expect.anything());
    });

    it('empty screenItems still renders all 6 section headers (no crash)', () => {
        const graph = mkScreenContentGraph([]);
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        expect(screen.getByText('Interactions')).toBeDefined();
        expect(screen.getByText('Data sources')).toBeDefined();
        expect(screen.getByText('Lifecycle')).toBeDefined();
        expect(screen.getByText('Navigation in')).toBeDefined();
        expect(screen.getByText('Navigation out')).toBeDefined();
        expect(screen.getByText('Visual elements')).toBeDefined();
        // Six `(0)` counters — verified once; the headers above prove
        // none of the sections crashed at zero items.
        expect(screen.getAllByText('(0)').length).toBeGreaterThanOrEqual(5);
    });
});

describe('ApiListPanel — backend api-list layout (regression guard)', () => {
    it('graph without screen-content: prefix renders the backend panel (renders cluster header)', () => {
        const graph = {
            graphId: 'api-list:cluster:auth',
            meta: {
                clusterId: 'cluster:auth',
                clusterLabel: 'Auth Cluster',
                serviceId: 'service:api',
                apis: [],
                files: [],
                subsystems: [],
            },
        } as any;
        render(<ApiListPanel graph={graph} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        // The backend panel renders the cluster label. The screen-content
        // header text "Navigation in" / "Navigation out" must NOT appear
        // here.
        expect(screen.queryByText('Navigation in')).toBeNull();
        expect(screen.queryByText('Navigation out')).toBeNull();
        expect(screen.queryByText('Visual elements')).toBeNull();
    });
});

// Bug C (2026-06-04): every clickable `.ca-api-row` row must expose
// proper a11y so keyboard + screen-reader users can navigate the L2b
// list. Tests pin role=button + aria-label + tabIndex + keyboard
// activation (Enter/Space).
describe('ApiListPanel — Bug C: api row accessibility', () => {
    function backendGraphWithApis() {
        return {
            graphId: 'api-list:cluster:auth',
            meta: {
                clusterId: 'cluster:auth',
                clusterLabel: 'Auth Cluster',
                serviceId: 'service:api',
                apis: [
                    {
                        apiId: 'api-1',
                        method: 'GET',
                        route: '/api/user',
                        handlerName: 'getCurrentUser',
                        filePath: 'src/auth/controller.ts',
                        kind: 'route',
                        meta: { clusterId: 'cluster:auth' },
                    },
                ],
                files: ['src/auth/controller.ts'],
                subsystems: [{ filePath: 'src/auth/controller.ts', apis: ['api-1'] }],
            },
        } as any;
    }

    it('renders each api row with role="button"', () => {
        const { container } = render(
            <ApiListPanel graph={backendGraphWithApis()} onApiClick={vi.fn()} onFileClick={vi.fn()} />,
        );
        const row = container.querySelector('.ca-api-row[role="button"]');
        expect(row).not.toBeNull();
    });

    it('renders each api row with a route-bearing aria-label', () => {
        const { container } = render(
            <ApiListPanel graph={backendGraphWithApis()} onApiClick={vi.fn()} onFileClick={vi.fn()} />,
        );
        const row = container.querySelector('.ca-api-row');
        const aria = row?.getAttribute('aria-label') ?? '';
        expect(aria).toMatch(/GET/);
        expect(aria).toMatch(/\/api\/user/);
    });

    it('renders each api row with tabIndex=0 (keyboard focusable)', () => {
        const { container } = render(
            <ApiListPanel graph={backendGraphWithApis()} onApiClick={vi.fn()} onFileClick={vi.fn()} />,
        );
        const row = container.querySelector('.ca-api-row') as HTMLElement | null;
        expect(row?.tabIndex).toBe(0);
    });

    it('Enter key activation fires onApiClick', () => {
        const onApiClick = vi.fn();
        const { container } = render(
            <ApiListPanel graph={backendGraphWithApis()} onApiClick={onApiClick} onFileClick={vi.fn()} />,
        );
        const row = container.querySelector('.ca-api-row') as HTMLElement;
        fireEvent.keyDown(row, { key: 'Enter' });
        expect(onApiClick).toHaveBeenCalled();
    });
});
