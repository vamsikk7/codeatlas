/**
 * AuthTab.test.tsx — #745 OAuth2 tab (2026-06-06).
 *
 * TDD coverage for the OAuth2 form surface. Each grant flow gets a
 * happy-path emit test + a result-render test + an error-render test.
 * The component itself stays stateless about the round-trip — it
 * receives state via props from App.tsx and emits via callbacks.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AuthTab, { type AuthTabState } from '../AuthTab';

describe('AuthTab — client credentials', () => {
    it('renders the form when the user expands the client-credentials section', () => {
        render(<AuthTab onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        const summary = screen.getByText(/Client credentials/);
        fireEvent.click(summary);
        expect(screen.getByLabelText('Token endpoint')).toBeTruthy();
        expect(screen.getByLabelText('Client ID')).toBeTruthy();
        expect(screen.getByLabelText('Client secret')).toBeTruthy();
    });

    it('clicking Get token invokes onClientCredentials with the filled form values', () => {
        const spy = vi.fn();
        render(<AuthTab onClientCredentials={spy} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Client credentials/));
        fireEvent.change(screen.getByLabelText('Token endpoint'), { target: { value: 'https://auth.example.com/oauth/token' } });
        fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'svc-123' } });
        fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-xyz' } });
        fireEvent.change(screen.getByLabelText('Scope (optional)'), { target: { value: 'read write' } });
        fireEvent.click(screen.getByTestId('ca-auth-cc-submit'));
        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0][0];
        expect(args).toMatchObject({
            tokenEndpoint: 'https://auth.example.com/oauth/token',
            clientId: 'svc-123',
            clientSecret: 'secret-xyz',
            scope: 'read write',
        });
        expect(typeof args.requestId).toBe('string');
    });

    it('renders the access token + token type when the result arrives', () => {
        const state: AuthTabState = {
            clientCredentials: {
                status: 'ready',
                requestId: 'cc-1',
                token: { accessToken: 'aaa.bbb.ccc', tokenType: 'Bearer', expiresIn: 3600, raw: {} },
            },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Client credentials/));
        const result = screen.getByTestId('ca-auth-cc-result');
        expect(result.textContent ?? '').toMatch(/aaa\.bbb\.ccc/);
        expect(result.textContent ?? '').toMatch(/Bearer/);
        expect(result.textContent ?? '').toMatch(/3600/);
    });

    it('renders an error pill when the client-credentials call fails', () => {
        const state: AuthTabState = {
            clientCredentials: { status: 'error', requestId: 'cc-1', error: 'invalid_client' },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Client credentials/));
        expect(screen.getByTestId('ca-auth-cc-error').textContent).toMatch(/invalid_client/);
    });
});

describe('AuthTab — authorization URL builder', () => {
    it('renders the form when the user expands the authorize URL section', () => {
        render(<AuthTab onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        expect(screen.getByLabelText('Authorization endpoint')).toBeTruthy();
        expect(screen.getByLabelText('Client ID (authorize)')).toBeTruthy();
        expect(screen.getByLabelText('Redirect URI')).toBeTruthy();
    });

    it('clicking Build URL invokes onBuildAuthorizationUrl with the filled form + PKCE flag', () => {
        const spy = vi.fn();
        render(<AuthTab onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={spy} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        fireEvent.change(screen.getByLabelText('Authorization endpoint'), { target: { value: 'https://auth.example.com/authorize' } });
        fireEvent.change(screen.getByLabelText('Client ID (authorize)'), { target: { value: 'web-456' } });
        fireEvent.change(screen.getByLabelText('Redirect URI'), { target: { value: 'http://localhost:7742/callback' } });
        fireEvent.change(screen.getByLabelText('Scope (authorize)'), { target: { value: 'openid profile' } });
        fireEvent.click(screen.getByLabelText('Use PKCE (S256)'));
        fireEvent.click(screen.getByTestId('ca-auth-url-submit'));
        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0][0];
        expect(args).toMatchObject({
            authorizationEndpoint: 'https://auth.example.com/authorize',
            clientId: 'web-456',
            redirectUri: 'http://localhost:7742/callback',
            scope: 'openid profile',
            usePkce: true,
        });
    });

    it('renders the built URL + state when the result arrives', () => {
        const state: AuthTabState = {
            authorizeUrl: {
                status: 'ready',
                requestId: 'au-1',
                url: 'https://auth.example.com/authorize?response_type=code&client_id=web-456&redirect_uri=http%3A%2F%2Flocalhost%3A7742%2Fcallback&state=abcd',
                state: 'abcd',
                codeVerifier: 'pkce-verifier-here',
            },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        const result = screen.getByTestId('ca-auth-url-result');
        expect(result.textContent ?? '').toMatch(/https:\/\/auth\.example\.com\/authorize/);
        expect(result.textContent ?? '').toMatch(/state=abcd/);
        expect(result.textContent ?? '').toMatch(/pkce-verifier-here/);
    });

    it('renders an error pill when URL build fails', () => {
        const state: AuthTabState = {
            authorizeUrl: { status: 'error', requestId: 'au-1', error: 'invalid endpoint' },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        expect(screen.getByTestId('ca-auth-url-error').textContent).toMatch(/invalid endpoint/);
    });
});

describe('AuthTab — #604 callback receiver auto-fill', () => {
    it('auto-fills the Authorization code field when a successful callback arrives', () => {
        const state: AuthTabState = {
            callback: { ok: true, code: 'cb-code-xyz', state: 'abcd' },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        const codeInput = screen.getByLabelText('Authorization code') as HTMLInputElement;
        expect(codeInput.value).toBe('cb-code-xyz');
        const banner = screen.getByTestId('ca-auth-callback-banner');
        expect(banner.textContent ?? '').toMatch(/Received/);
    });

    it('shows an error banner when the callback delivered an error', () => {
        const state: AuthTabState = {
            callback: { ok: false, error: 'access_denied', errorDescription: 'user said no', state: 'abcd' },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        const banner = screen.getByTestId('ca-auth-callback-error');
        expect(banner.textContent ?? '').toMatch(/access_denied/);
        expect(banner.textContent ?? '').toMatch(/user said no/);
    });

    it('lets the user type over the auto-filled code (controlled input remains editable)', () => {
        const state: AuthTabState = {
            callback: { ok: true, code: 'auto-code', state: 'abcd' },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        const codeInput = screen.getByLabelText('Authorization code') as HTMLInputElement;
        expect(codeInput.value).toBe('auto-code');
        fireEvent.change(codeInput, { target: { value: 'user-typed-code' } });
        expect(codeInput.value).toBe('user-typed-code');
    });
});

describe('AuthTab — authorization code exchange', () => {
    it('clicking Exchange invokes onExchangeAuthorizationCode with the code + verifier from the matching authorize-URL result', () => {
        const spy = vi.fn();
        const state: AuthTabState = {
            authorizeUrl: {
                status: 'ready',
                requestId: 'au-1',
                url: 'https://auth.example.com/authorize?...',
                state: 'abcd',
                codeVerifier: 'pkce-verifier-2',
            },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={spy} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        fireEvent.change(screen.getByLabelText('Token endpoint (exchange)'), { target: { value: 'https://auth.example.com/oauth/token' } });
        fireEvent.change(screen.getByLabelText('Authorization code'), { target: { value: 'auth-code-xyz' } });
        fireEvent.click(screen.getByTestId('ca-auth-exchange-submit'));
        expect(spy).toHaveBeenCalledTimes(1);
        const args = spy.mock.calls[0][0];
        expect(args).toMatchObject({
            tokenEndpoint: 'https://auth.example.com/oauth/token',
            clientId: '',
            redirectUri: '',
            code: 'auth-code-xyz',
            codeVerifier: 'pkce-verifier-2',
        });
    });

    it('renders the exchange access token when result arrives', () => {
        const state: AuthTabState = {
            exchangeCode: {
                status: 'ready',
                requestId: 'ex-1',
                token: { accessToken: 'exchanged.access.token', tokenType: 'Bearer', expiresIn: 7200, raw: {} },
            },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        const result = screen.getByTestId('ca-auth-exchange-result');
        expect(result.textContent ?? '').toMatch(/exchanged\.access\.token/);
        expect(result.textContent ?? '').toMatch(/7200/);
    });

    it('renders an error pill when exchange fails', () => {
        const state: AuthTabState = {
            exchangeCode: { status: 'error', requestId: 'ex-1', error: 'invalid_grant' },
        };
        render(<AuthTab state={state} onClientCredentials={() => { /* noop */ }} onBuildAuthorizationUrl={() => { /* noop */ }} onExchangeAuthorizationCode={() => { /* noop */ }} />);
        fireEvent.click(screen.getByText(/Authorization URL/));
        expect(screen.getByTestId('ca-auth-exchange-error').textContent).toMatch(/invalid_grant/);
    });
});
