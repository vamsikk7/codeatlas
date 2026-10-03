/**
 * ApiTestingView.test.tsx — Issue #601 Phase 1 UI smoke tests.
 */

import React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ApiTestingView, { type ApiTestingPayload } from '../ApiTestingView';

beforeAll(() => {
    if (typeof (window as any).PointerEvent === 'undefined') {
        (window as any).PointerEvent = class extends MouseEvent {};
    }
});

const PAYLOAD: ApiTestingPayload = {
    totalEndpoints: 3,
    collections: [
        {
            id: 'cluster:auth',
            label: 'auth',
            source: 'l2a-cluster',
            endpoints: [
                {
                    id: 'a1',
                    method: 'POST',
                    route: '/api/users/login',
                    handlerName: 'login',
                    filePath: 'src/auth.ts',
                    auth: 'required',
                    requestSchema: {
                        kind: 'json',
                        source: 'zod',
                        schema: {
                            type: 'object',
                            properties: {
                                email:    { type: 'string', format: 'email' },
                                password: { type: 'string' },
                            },
                            required: ['email', 'password'],
                        },
                    },
                    responseSchema: [
                        { status: 200, description: 'OK' },
                        { status: 401, description: 'Unauthorized' },
                    ],
                    middlewares: ['rateLimit'],
                },
                {
                    id: 'a2',
                    method: 'GET',
                    route: '/api/users/me',
                    handlerName: 'me',
                    filePath: 'src/auth.ts',
                },
            ],
        },
        {
            id: 'cluster:articles',
            label: 'articles',
            source: 'l2a-cluster',
            endpoints: [
                { id: 'a3', method: 'GET', route: '/api/articles', handlerName: 'list', filePath: 'src/articles.ts' },
            ],
        },
    ],
};

afterEach(() => cleanup());

describe('ApiTestingView', () => {
    it('renders header + total endpoint count', () => {
        render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.getByText(/3 endpoints/)).toBeTruthy();
        expect(screen.getByText(/API Testing/)).toBeTruthy();
    });

    it('renders one section per collection with endpoint count', () => {
        render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.getByText('auth')).toBeTruthy();
        expect(screen.getByText('articles')).toBeTruthy();
        // Auth has 2 endpoints; articles has 1
        const counts = screen.getAllByText(/^[0-9]+$/);
        const values = counts.map(n => n.textContent).filter(Boolean);
        expect(values).toContain('2');
        expect(values).toContain('1');
    });

    it('auto-selects the first endpoint and shows its preview', () => {
        render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.getAllByText('/api/users/login').length).toBeGreaterThan(0);
        // Both the schema panel + the Try-it body editor render "Request body".
        expect(screen.getAllByText(/Request body/).length).toBeGreaterThan(0);
        expect(screen.getAllByText('email').length).toBeGreaterThan(0);
        expect(screen.getAllByText('password').length).toBeGreaterThan(0);
    });

    it('switches preview to a different endpoint on click', () => {
        const { container } = render(<ApiTestingView payload={PAYLOAD} />);
        const articlesEndpoint = Array.from(container.querySelectorAll('.ca-api-testing-endpoint'))
            .find(b => b.textContent?.includes('/api/articles')) as HTMLElement | undefined;
        expect(articlesEndpoint).toBeDefined();
        fireEvent.click(articlesEndpoint!);
        expect(screen.getByText('list')).toBeTruthy(); // handler name in preview
    });

    it('collapses + expands a collection on header click', () => {
        const { container } = render(<ApiTestingView payload={PAYLOAD} />);
        const articlesHeader = Array.from(container.querySelectorAll('.ca-api-testing-collection-header'))
            .find(h => h.textContent?.includes('articles')) as HTMLElement | undefined;
        expect(articlesHeader).toBeDefined();
        // Collapse → the articles endpoint should disappear from the DOM.
        fireEvent.click(articlesHeader!);
        const remaining = Array.from(container.querySelectorAll('.ca-api-testing-endpoint'))
            .find(b => b.textContent?.includes('/api/articles'));
        expect(remaining).toBeUndefined();
        // Expand again
        fireEvent.click(articlesHeader!);
        const re = Array.from(container.querySelectorAll('.ca-api-testing-endpoint'))
            .find(b => b.textContent?.includes('/api/articles'));
        expect(re).toBeDefined();
    });

    it('invokes onOpenSource when the file basename is clicked', () => {
        const onOpenSource = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onOpenSource={onOpenSource} />);
        const fileBtn = screen.getByText('auth.ts');
        fireEvent.click(fileBtn);
        expect(onOpenSource).toHaveBeenCalledWith('src/auth.ts');
    });

    it('shows empty state when the payload has zero collections', () => {
        render(<ApiTestingView payload={{ totalEndpoints: 0, collections: [] }} />);
        expect(screen.getByText(/No endpoints detected yet/)).toBeTruthy();
    });

    // ── Phase 2 (#602) — Send + Response UI ─────────────────────────

    it('renders Send button + Try-it panel for the selected endpoint', () => {
        render(<ApiTestingView payload={PAYLOAD} />);
        const sendBtn = screen.getByRole('button', { name: /Send request/i });
        expect(sendBtn).toBeTruthy();
        expect(screen.getByText(/Environment variables/)).toBeTruthy();
        expect(screen.getByText(/Bearer token/)).toBeTruthy();
    });

    it('emits onSendRequest with the resolved URL + headers + body when Send is clicked', () => {
        const onSendRequest = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onSendRequest={onSendRequest} />);
        const sendBtn = screen.getByRole('button', { name: /Send request/i });
        fireEvent.click(sendBtn);
        expect(onSendRequest).toHaveBeenCalled();
        const arg = onSendRequest.mock.calls[0][0];
        expect(arg.requestId).toBe('req:a1');
        expect(arg.method).toBe('POST');
        // Default env carries `base=http://localhost:3000` → URL resolves
        // to the absolute form before flight.
        expect(arg.url).toBe('http://localhost:3000/api/users/login');
        // POST + JSON body → seeded skeleton from the request schema.
        expect(arg.body).toContain('"email"');
        expect(arg.body).toContain('"password"');
    });

    it('renders the response viewer when a matching response arrives', () => {
        const responses = {
            'req:a1': {
                durationMs: 42,
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
                body: '{"token":"abc"}',
                truncated: false,
            },
        };
        render(<ApiTestingView payload={PAYLOAD} responses={responses} />);
        expect(screen.getByText(/200 OK/)).toBeTruthy();
        expect(screen.getByText(/42 ms/)).toBeTruthy();
        // Body is pretty-printed JSON.
        expect(screen.getByText(/"token"/)).toBeTruthy();
    });

    it('surfaces error responses with a distinct treatment', () => {
        const responses = {
            'req:a1': {
                durationMs: 10,
                status: 0,
                statusText: '',
                headers: {},
                body: '',
                truncated: false,
                error: 'ECONNREFUSED',
            },
        };
        render(<ApiTestingView payload={PAYLOAD} responses={responses} />);
        expect(screen.getByText(/failed/)).toBeTruthy();
        expect(screen.getByText('ECONNREFUSED')).toBeTruthy();
    });
});

describe('ApiTestingView — #744 Generate body', () => {
    it('renders the ✨ Generate body button only when onGenerateRequestBody is wired', () => {
        // No prop → button absent.
        const { unmount } = render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.queryByTestId('ca-generate-body-btn')).toBeNull();
        unmount();
        // Wired → button present (selected endpoint is POST /api/users/login,
        // which is body-capable).
        render(<ApiTestingView payload={PAYLOAD} onGenerateRequestBody={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-generate-body-btn')).toBeTruthy();
    });

    it('clicking ✨ Generate body invokes the callback with the selected endpoint id', () => {
        const spy = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onGenerateRequestBody={spy} />);
        fireEvent.click(screen.getByTestId('ca-generate-body-btn'));
        expect(spy).toHaveBeenCalledTimes(1);
        const [apiId, requestId] = spy.mock.calls[0];
        expect(apiId).toBe('a1');
        expect(requestId).toMatch(/^gen-body-a1-\d+$/);
    });

    it('shows a loading label while the proposal is in-flight', () => {
        const proposals = { a1: { status: 'loading' as const, requestId: 'gen-body-a1-1' } };
        render(<ApiTestingView payload={PAYLOAD} onGenerateRequestBody={() => { /* noop */ }} bodyProposals={proposals} />);
        const btn = screen.getByTestId('ca-generate-body-btn') as HTMLButtonElement;
        expect(btn.textContent ?? '').toMatch(/Generating/);
        expect(btn.disabled).toBe(true);
    });

    it('renders the proposal panel + dropped-field count when a result arrives', () => {
        const proposals = {
            a1: {
                status: 'ready' as const,
                requestId: 'gen-body-a1-1',
                body: { email: 'user@example.com', password: 'pw1234' },
                evidence: { email: 'req.body.email', password: 'req.body.password' },
                dropped: 2,
            },
        };
        render(<ApiTestingView payload={PAYLOAD} onGenerateRequestBody={() => { /* noop */ }} bodyProposals={proposals} />);
        const proposal = screen.getByTestId('ca-generate-body-proposal');
        expect(proposal).toBeTruthy();
        expect(proposal.textContent ?? '').toMatch(/2 fields dropped/);
        expect(proposal.textContent ?? '').toMatch(/user@example\.com/);
    });

    it('Apply replaces the body editor draft with the proposal JSON', () => {
        const proposals = {
            a1: {
                status: 'ready' as const,
                requestId: 'gen-body-a1-1',
                body: { email: 'ai@example.com', password: 'gen-pw' },
                evidence: {},
                dropped: 0,
            },
        };
        render(<ApiTestingView payload={PAYLOAD} onGenerateRequestBody={() => { /* noop */ }} bodyProposals={proposals} />);
        // The body draft pre-fills from the schema skeleton with empty
        // strings; after Apply it should match the proposal JSON.
        const beforeEditor = screen.getByLabelText('Request body') as HTMLTextAreaElement | HTMLInputElement;
        expect(beforeEditor.value).not.toMatch(/ai@example\.com/);
        fireEvent.click(screen.getByTestId('ca-generate-body-apply'));
        const afterEditor = screen.getByLabelText('Request body') as HTMLTextAreaElement | HTMLInputElement;
        expect(afterEditor.value).toMatch(/ai@example\.com/);
        expect(afterEditor.value).toMatch(/gen-pw/);
    });

    it('renders the error pill when the proposal fails', () => {
        const proposals = {
            a1: { status: 'error' as const, requestId: 'gen-body-a1-1', error: 'No API key configured.' },
        };
        render(<ApiTestingView payload={PAYLOAD} onGenerateRequestBody={() => { /* noop */ }} bodyProposals={proposals} />);
        const err = screen.getByTestId('ca-generate-body-error');
        expect(err.textContent).toMatch(/No API key configured/);
    });
});

describe('ApiTestingView — #744 Generate chain', () => {
    it('renders the ✨ Generate chain button only when onGenerateChain is wired', () => {
        const { unmount } = render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.queryByTestId('ca-api-testing-generate-chain-btn')).toBeNull();
        unmount();
        render(<ApiTestingView payload={PAYLOAD} onGenerateChain={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-api-testing-generate-chain-btn')).toBeTruthy();
    });

    it('clicking ✨ Generate chain invokes the callback with a requestId', () => {
        const spy = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onGenerateChain={spy} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-generate-chain-btn'));
        expect(spy).toHaveBeenCalledTimes(1);
        const [requestId] = spy.mock.calls[0];
        expect(requestId).toMatch(/^gen-chain-\d+$/);
    });

    it('renders the chain proposal summary when status is ready', () => {
        const chainProposal = {
            status: 'ready' as const,
            requestId: 'gen-chain-1',
            chain: {
                name: 'smoke login → fetch user',
                steps: [
                    { id: 's1', method: 'POST', url: '/api/users/login' },
                    { id: 's2', method: 'GET', url: '/api/user' },
                ],
            },
            droppedExtracts: 1,
        };
        render(<ApiTestingView payload={PAYLOAD} onGenerateChain={() => { /* noop */ }} chainProposal={chainProposal} />);
        const summary = screen.getByTestId('ca-api-testing-chain-proposal');
        expect(summary).toBeTruthy();
        expect(summary.textContent ?? '').toMatch(/smoke login/);
        expect(summary.textContent ?? '').toMatch(/2 steps/);
        expect(summary.textContent ?? '').toMatch(/1 dropped/);
    });

    it('renders an error pill when chain composition fails', () => {
        render(<ApiTestingView payload={PAYLOAD} onGenerateChain={() => { /* noop */ }} chainProposal={{ status: 'error', requestId: 'gen-chain-1', error: 'rate limit' }} />);
        const err = screen.getByTestId('ca-api-testing-chain-error');
        expect(err.textContent).toMatch(/rate limit/);
    });
});

describe('ApiTestingView — #744 Generate test cases', () => {
    it('renders the ✨ Generate test cases button only when onGenerateTestCases is wired', () => {
        const { unmount } = render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.queryByTestId('ca-generate-test-cases-btn')).toBeNull();
        unmount();
        render(<ApiTestingView payload={PAYLOAD} onGenerateTestCases={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-generate-test-cases-btn')).toBeTruthy();
    });

    it('clicking ✨ Generate test cases invokes the callback with the apiId', () => {
        const spy = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onGenerateTestCases={spy} />);
        fireEvent.click(screen.getByTestId('ca-generate-test-cases-btn'));
        expect(spy).toHaveBeenCalledTimes(1);
        const [apiId, requestId] = spy.mock.calls[0];
        expect(apiId).toBe('a1');
        expect(requestId).toMatch(/^gen-tests-a1-\d+$/);
    });

    it('shows a loading label while the test-case proposal is in-flight', () => {
        const proposals = { a1: { status: 'loading' as const, requestId: 'gen-tests-a1-1' } };
        render(<ApiTestingView payload={PAYLOAD} onGenerateTestCases={() => { /* noop */ }} testCasesProposals={proposals} />);
        const btn = screen.getByTestId('ca-generate-test-cases-btn') as HTMLButtonElement;
        expect(btn.textContent ?? '').toMatch(/Generating/);
        expect(btn.disabled).toBe(true);
    });

    it('renders cases with names + dropped count when result arrives', () => {
        const proposals = {
            a1: {
                status: 'ready' as const,
                requestId: 'gen-tests-a1-1',
                cases: [
                    { name: 'happy path login', assertions: [{ kind: 'status_equals', value: 200 }], evidence: ['if (!user) return 401'] },
                    { name: 'missing email', assertions: [{ kind: 'status_equals', value: 400 }], evidence: ['required: true'] },
                ],
                dropped: 2,
            },
        };
        render(<ApiTestingView payload={PAYLOAD} onGenerateTestCases={() => { /* noop */ }} testCasesProposals={proposals} />);
        const region = screen.getByTestId('ca-generate-test-cases-proposal');
        expect(region.textContent ?? '').toMatch(/happy path login/);
        expect(region.textContent ?? '').toMatch(/missing email/);
        expect(region.textContent ?? '').toMatch(/dropped 2 cases/);
    });

    it('renders an error pill when test-case generation fails', () => {
        const proposals = {
            a1: { status: 'error' as const, requestId: 'gen-tests-a1-1', error: 'timeout' },
        };
        render(<ApiTestingView payload={PAYLOAD} onGenerateTestCases={() => { /* noop */ }} testCasesProposals={proposals} />);
        const err = screen.getByTestId('ca-generate-test-cases-error');
        expect(err.textContent).toMatch(/timeout/);
    });
});

describe('ApiTestingView — #604 Exporter', () => {
    it('renders the 📤 Export button only when onExportApiCollection is wired', () => {
        const { unmount } = render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.queryByTestId('ca-api-testing-export-btn')).toBeNull();
        unmount();
        render(<ApiTestingView payload={PAYLOAD} onExportApiCollection={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-api-testing-export-btn')).toBeTruthy();
    });

    it('clicking 📤 Export opens the format picker', () => {
        render(<ApiTestingView payload={PAYLOAD} onExportApiCollection={() => { /* noop */ }} />);
        expect(screen.queryByTestId('ca-api-testing-export-format-postman')).toBeNull();
        fireEvent.click(screen.getByTestId('ca-api-testing-export-btn'));
        expect(screen.getByTestId('ca-api-testing-export-format-postman')).toBeTruthy();
        expect(screen.getByTestId('ca-api-testing-export-format-hoppscotch')).toBeTruthy();
        expect(screen.getByTestId('ca-api-testing-export-format-insomnia')).toBeTruthy();
    });

    it('picking a format invokes onExportApiCollection with the format + a requestId', () => {
        const spy = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onExportApiCollection={spy} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-export-btn'));
        fireEvent.click(screen.getByTestId('ca-api-testing-export-format-postman'));
        expect(spy).toHaveBeenCalledTimes(1);
        const [format, requestId] = spy.mock.calls[0];
        expect(format).toBe('postman');
        expect(requestId).toMatch(/^export-\d+$/);
    });

    it('closes the format picker after a pick', () => {
        const spy = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onExportApiCollection={spy} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-export-btn'));
        fireEvent.click(screen.getByTestId('ca-api-testing-export-format-insomnia'));
        expect(screen.queryByTestId('ca-api-testing-export-format-postman')).toBeNull();
    });
});

describe('ApiTestingView — #745 Importer', () => {
    it('renders the 📥 Import button only when onImportApiCollection is wired', () => {
        const { unmount } = render(<ApiTestingView payload={PAYLOAD} />);
        expect(screen.queryByTestId('ca-api-testing-import-btn')).toBeNull();
        unmount();
        render(<ApiTestingView payload={PAYLOAD} onImportApiCollection={() => { /* noop */ }} />);
        expect(screen.getByTestId('ca-api-testing-import-btn')).toBeTruthy();
    });

    it('clicking 📥 Import opens the import modal', () => {
        render(<ApiTestingView payload={PAYLOAD} onImportApiCollection={() => { /* noop */ }} />);
        expect(screen.queryByTestId('ca-api-testing-import-modal')).toBeNull();
        fireEvent.click(screen.getByTestId('ca-api-testing-import-btn'));
        expect(screen.getByTestId('ca-api-testing-import-modal')).toBeTruthy();
    });

    it('Submit posts the spec text + a requestId to the callback', () => {
        const spy = vi.fn();
        render(<ApiTestingView payload={PAYLOAD} onImportApiCollection={spy} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-import-btn'));
        const ta = screen.getByTestId('ca-api-testing-import-spec') as HTMLTextAreaElement;
        fireEvent.change(ta, { target: { value: '{"openapi": "3.0.0"}' } });
        fireEvent.click(screen.getByTestId('ca-api-testing-import-submit'));
        expect(spy).toHaveBeenCalledTimes(1);
        const [specText, requestId] = spy.mock.calls[0];
        expect(specText).toBe('{"openapi": "3.0.0"}');
        expect(requestId).toMatch(/^import-\d+$/);
    });

    it('Submit is disabled while a spec is empty', () => {
        render(<ApiTestingView payload={PAYLOAD} onImportApiCollection={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-import-btn'));
        const btn = screen.getByTestId('ca-api-testing-import-submit') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it('renders an error banner when import fails', () => {
        const importState = { status: 'error' as const, requestId: 'import-1', error: 'Spec format not recognised.' };
        render(<ApiTestingView payload={PAYLOAD} onImportApiCollection={() => { /* noop */ }} importState={importState} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-import-btn'));
        const err = screen.getByTestId('ca-api-testing-import-error');
        expect(err.textContent).toMatch(/Spec format not recognised/);
    });

    it('closes the modal when import succeeds', () => {
        const { rerender } = render(<ApiTestingView payload={PAYLOAD} onImportApiCollection={() => { /* noop */ }} />);
        fireEvent.click(screen.getByTestId('ca-api-testing-import-btn'));
        expect(screen.getByTestId('ca-api-testing-import-modal')).toBeTruthy();
        rerender(
            <ApiTestingView
                payload={PAYLOAD}
                onImportApiCollection={() => { /* noop */ }}
                importState={{ status: 'ready', requestId: 'import-1', format: 'openapi', importedCount: 4 }}
            />,
        );
        expect(screen.queryByTestId('ca-api-testing-import-modal')).toBeNull();
    });
});

