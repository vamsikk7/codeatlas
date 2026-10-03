/**
 * includeRowTarget.test.tsx — BUG-EXP-24.
 *
 * Django `path('api/', include('app.authentication.urls'))` repeated for
 * several apps produced multiple `INCLUDE /api/` rows that were visually
 * IDENTICAL (same method + route + file) in `showFile` mode — the included
 * module (the one distinguishing field, in `handlerName`) wasn't shown. The
 * row must surface the include target so the rows are distinguishable.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ApiRow } from '../ApiListPanel';

const noop = () => {};

function includeApi(id: string, module: string) {
    return { apiId: id, method: 'INCLUDE', route: '/api/', handlerName: module, filePath: 'conduit/urls.py' } as any;
}

describe('BUG-EXP-24 — INCLUDE rows show their target module', () => {
    it('renders the included module target for same-route INCLUDE rows (showFile)', () => {
        render(
            <>
                <ApiRow api={includeApi('a', 'conduit.apps.authentication.urls')} onApiClick={noop} showFile />
                <ApiRow api={includeApi('b', 'conduit.apps.profiles.urls')} onApiClick={noop} showFile />
                <ApiRow api={includeApi('c', 'conduit.apps.articles.urls')} onApiClick={noop} showFile />
            </>,
        );
        // Each row must surface its distinguishing module leaf.
        expect(screen.getByText(/authentication/)).toBeTruthy();
        expect(screen.getByText(/profiles/)).toBeTruthy();
        expect(screen.getByText(/articles/)).toBeTruthy();
    });
});
