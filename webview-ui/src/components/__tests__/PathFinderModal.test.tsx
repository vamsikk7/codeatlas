/**
 * PathFinderModal.test.tsx — Issue #707 UI smoke tests.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import PathFinderModal, { type FunctionItem } from '../PathFinderModal';

beforeAll(() => {
    if (typeof (window as any).PointerEvent === 'undefined') {
        (window as any).PointerEvent = class extends MouseEvent {};
    }
});

const FUNCTIONS: FunctionItem[] = [
    { id: 'src/auth/login.ts:loginHandler', label: 'loginHandler', subtitle: 'login.ts' },
    { id: 'src/auth/login.ts:verifyToken', label: 'verifyToken', subtitle: 'login.ts' },
    { id: 'src/users/service.ts:createUser', label: 'createUser', subtitle: 'service.ts' },
];

describe('PathFinderModal', () => {
    it('renders the picker panes + Find Path button starts disabled', () => {
        render(
            <PathFinderModal
                functions={FUNCTIONS}
                initialResult={null}
                postMessage={() => {}}
                onOpenFlow={() => {}}
                onCancel={() => {}}
            />,
        );
        expect(screen.getByText('Find Call Path')).toBeTruthy();
        const findBtn = screen.getByRole('button', { name: 'Find Path' }) as HTMLButtonElement;
        expect(findBtn.disabled).toBe(true);
        cleanup();
    });

    it('emits findCallPath message after both functions are picked', () => {
        const posted: any[] = [];
        render(
            <PathFinderModal
                functions={FUNCTIONS}
                initialResult={null}
                postMessage={(msg) => posted.push(msg)}
                onOpenFlow={() => {}}
                onCancel={() => {}}
            />,
        );
        const items = screen.getAllByRole('option');
        // Click first match in From → first match in To. The From picker is
        // rendered first, so the first 3 options belong to it; pick the
        // 1st item, then the 3rd-visible-option (1st of the To listbox).
        fireEvent.click(items[0]); // pick from = loginHandler
        // After selection, the From input is replaced with the chip; only
        // the To picker's list remains visible.
        const remaining = screen.getAllByRole('option');
        fireEvent.click(remaining.find(el => el.textContent?.includes('createUser'))!);
        const findBtn = screen.getByRole('button', { name: 'Find Path' });
        fireEvent.click(findBtn);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
            type: 'findCallPath',
            fromFile: 'src/auth/login.ts',
            fromFn: 'loginHandler',
            toFile: 'src/users/service.ts',
            toFn: 'createUser',
            maxDepth: 8,
        });
        cleanup();
    });

    it('renders the result path when a result arrives', () => {
        const result = {
            fromKey: 'src/auth/login.ts:loginHandler',
            toKey: 'src/users/service.ts:createUser',
            path: [
                { from: 'src/auth/login.ts:loginHandler', to: 'src/users/service.ts:createUser', toFile: 'src/users/service.ts', toFunction: 'createUser', kind: 'calls' as const },
            ],
            visited: 4,
            truncated: false,
        };
        const onOpenFlow = vi.fn();
        const { container } = render(
            <PathFinderModal
                functions={[]}  // empty so the picker lists don't shadow the result panel
                initialResult={result}
                postMessage={() => {}}
                onOpenFlow={onOpenFlow}
                onCancel={() => {}}
            />,
        );
        expect(screen.getByText('1 hop')).toBeTruthy();
        const stepBtn = container.querySelector('.ca-pf-step-btn') as HTMLElement | null;
        expect(stepBtn).not.toBeNull();
        fireEvent.click(stepBtn!);
        expect(onOpenFlow).toHaveBeenCalledWith('src/users/service.ts', 'createUser');
        cleanup();
    });

    it('shows the no-path banner when path is empty', () => {
        const result = {
            fromKey: 'src/auth/login.ts:loginHandler',
            toKey: 'src/users/service.ts:createUser',
            path: [],
            visited: 12,
            truncated: false,
        };
        render(
            <PathFinderModal
                functions={FUNCTIONS}
                initialResult={result}
                postMessage={() => {}}
                onOpenFlow={() => {}}
                onCancel={() => {}}
            />,
        );
        expect(screen.getByText(/No call path found/i)).toBeTruthy();
        cleanup();
    });

    // UX-73 (2026-06-10) — per-scope toggle. When `scope` is set the
    // modal renders an "in this repo" checkbox that defaults ON and
    // filters the candidate functions by `repoId === scope`. Users
    // inside a sub-repo expect path finds to stay scoped; widening
    // workspace-wide is an opt-in via the toggle.
    it('UX-73: scope toggle filters function pickers by repoId when scope is set', () => {
        const fnsWithRepo: FunctionItem[] = [
            { id: 'svc-a/src/login.ts:loginHandler', label: 'loginHandler', subtitle: 'login.ts', repoId: 'svc-a' },
            { id: 'svc-a/src/login.ts:verifyToken', label: 'verifyToken', subtitle: 'login.ts', repoId: 'svc-a' },
            { id: 'svc-b/src/users.ts:createUser', label: 'createUser', subtitle: 'users.ts', repoId: 'svc-b' },
        ];
        render(
            <PathFinderModal
                functions={fnsWithRepo}
                initialResult={null}
                postMessage={() => {}}
                onOpenFlow={() => {}}
                onCancel={() => {}}
                scope="svc-a"
                scopeLabel="api-service"
            />,
        );
        // Checkbox renders + defaults ON when scope is set.
        const toggle = screen.getByTestId('ca-pf-scope-toggle') as HTMLLabelElement;
        const cb = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
        expect(cb.checked).toBe(true);
        // Filtered list: svc-a entries shown, svc-b entry hidden.
        const items = screen.getAllByRole('option');
        const labels = items.map(i => i.textContent ?? '');
        expect(labels.some(l => l.includes('loginHandler'))).toBe(true);
        expect(labels.some(l => l.includes('verifyToken'))).toBe(true);
        expect(labels.some(l => l.includes('createUser'))).toBe(false);
        // Toggle OFF widens the search to all repos.
        act(() => { fireEvent.click(cb); });
        const widened = screen.getAllByRole('option').map(i => i.textContent ?? '');
        expect(widened.some(l => l.includes('createUser')), 'svc-b function must appear after toggling off').toBe(true);
        cleanup();
    });

    it('UX-73: no scope prop → no toggle rendered, all functions visible', () => {
        const fnsWithRepo: FunctionItem[] = [
            { id: 'svc-a/login.ts:foo', label: 'foo', repoId: 'svc-a' },
            { id: 'svc-b/users.ts:bar', label: 'bar', repoId: 'svc-b' },
        ];
        render(
            <PathFinderModal
                functions={fnsWithRepo}
                initialResult={null}
                postMessage={() => {}}
                onOpenFlow={() => {}}
                onCancel={() => {}}
            />,
        );
        expect(screen.queryByTestId('ca-pf-scope-toggle')).toBeNull();
        const labels = screen.getAllByRole('option').map(i => i.textContent ?? '');
        expect(labels.some(l => l.includes('foo'))).toBe(true);
        expect(labels.some(l => l.includes('bar'))).toBe(true);
        cleanup();
    });

    it('invokes onCancel when the close button is clicked', () => {
        const onCancel = vi.fn();
        render(
            <PathFinderModal
                functions={FUNCTIONS}
                initialResult={null}
                postMessage={() => {}}
                onOpenFlow={() => {}}
                onCancel={onCancel}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onCancel).toHaveBeenCalled();
        cleanup();
    });
});
