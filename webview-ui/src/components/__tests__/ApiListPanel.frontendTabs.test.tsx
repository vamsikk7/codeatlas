/**
 * ApiListPanel.frontendTabs.test.tsx — BUG-FE-BACKEND-FILTERS.
 *
 * The workspace-scope L2b list (`api-list:workspace`) for a FRONTEND/mobile
 * repo must NOT show HTTP-verb method tabs (GET / POST / PUT / PATCH / DELETE)
 * — those are meaningless for screens / network calls / data fetches. Instead
 * the tab set adapts to the entry-point KINDS actually present in the scope
 * (SCREEN / NETWORK / NAV_ROUTE / DATA_FETCH / LIFECYCLE …), rendered with
 * friendly labels.
 *
 * It also pins the L3 drill-in: clicking a SCREEN row opens its sequence
 * (render flow, L3) via `onApiClick`, not the file (L4) via `onFileClick`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ApiListPanel from '../ApiListPanel';

beforeAll(() => {
    if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
        class R { observe() {} unobserve() {} disconnect() {} }
        (window as any).ResizeObserver = R;
        (global as any).ResizeObserver = R;
    }
});
beforeEach(() => { (window as any).vscodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }; });

function rec(over: any) {
    return {
        apiId: over.apiId ?? `${over.method}:${over.route}`,
        method: over.method,
        route: over.route,
        handlerName: over.handlerName ?? 'Handler',
        filePath: over.filePath ?? 'apps/web/app/page.tsx',
        ...over,
    };
}

// A frontend workspace scope: screens + network + nav in dedicated buckets,
// plus non-HTTP-verb entry-point records (DATA_FETCH / LIFECYCLE) in `apis`.
function frontendWorkspaceGraph() {
    return {
        graphId: 'api-list:workspace',
        meta: {
            clusterId: 'workspace',
            clusterLabel: 'All Workspace APIs',
            category: 'frontend',
            apis: [
                rec({ method: 'DATA_FETCH', route: '/api/user', handlerName: 'getServerSideProps', filePath: 'apps/web/app/user/page.tsx' }),
                rec({ method: 'LIFECYCLE', route: 'useEffect', handlerName: 'onMount', filePath: 'apps/web/app/user/page.tsx' }),
            ],
            screens: [
                rec({ method: 'SCREEN', route: '/login', handlerName: 'LoginPage', filePath: 'apps/web/app/login/page.tsx' }),
            ],
            navRoutes: [
                rec({ method: 'NAV_ROUTE', route: '/dashboard', handlerName: 'router.push', filePath: 'apps/web/app/login/page.tsx' }),
            ],
            networkCalls: [
                rec({ method: 'NETWORK', route: '/api/orders', handlerName: 'useQuery', filePath: 'apps/web/app/orders/page.tsx' }),
            ],
            files: ['apps/web/app/login/page.tsx', 'apps/web/app/user/page.tsx', 'apps/web/app/orders/page.tsx'],
        },
    } as any;
}

function methodTabTexts(): string[] {
    return screen.getAllByRole('button')
        .filter((b) => b.className.includes('ca-method-tab'))
        .map((b) => (b.textContent || '').replace(/\d+$/, '').trim());
}

describe('ApiListPanel — frontend workspace tabs (BUG-FE-BACKEND-FILTERS)', () => {
    it('does NOT render HTTP-verb tabs for a frontend scope', () => {
        render(<ApiListPanel graph={frontendWorkspaceGraph()} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        const tabs = methodTabTexts();
        // GET/POST/PUT/PATCH/DELETE are backend verbs — none of them are present
        // in a frontend scope, so no such tab should render.
        for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(tabs).not.toContain(verb);
        }
    });

    it('renders category-appropriate tabs for the entry-point kinds present', () => {
        render(<ApiListPanel graph={frontendWorkspaceGraph()} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        const tabs = methodTabTexts();
        // ALL + the kinds present across apis + screens/nav/network buckets.
        expect(tabs).toContain('ALL');
        // friendly labels: SCREEN, NET (NETWORK), NAV (NAV_ROUTE), DATA_FETCH, LIFECYCLE
        expect(tabs.join(' ')).toMatch(/SCREEN/);
        expect(tabs.join(' ')).toMatch(/NET\b/);
    });

    it('still renders HTTP-verb tabs for a backend scope (regression guard)', () => {
        const backend = {
            graphId: 'api-list:workspace',
            meta: {
                clusterId: 'workspace',
                apis: [
                    rec({ method: 'GET', route: '/users', filePath: 'src/users.ts' }),
                    rec({ method: 'POST', route: '/users', filePath: 'src/users.ts' }),
                ],
                files: ['src/users.ts'],
            },
        } as any;
        render(<ApiListPanel graph={backend} onApiClick={vi.fn()} onFileClick={vi.fn()} />);
        const tabs = methodTabTexts();
        expect(tabs).toContain('GET');
        expect(tabs).toContain('POST');
    });

    it('clicking a SCREEN row opens its sequence (L3) via onApiClick, not the file', () => {
        const onApiClick = vi.fn();
        const onFileClick = vi.fn();
        render(<ApiListPanel graph={frontendWorkspaceGraph()} onApiClick={onApiClick} onFileClick={onFileClick} />);
        // The Screens / Pages section row carries the screen route.
        fireEvent.click(screen.getByText('/login'));
        expect(onApiClick).toHaveBeenCalled();
        const arg = onApiClick.mock.calls[0][0];
        expect(arg.method).toBe('SCREEN');
    });
});
