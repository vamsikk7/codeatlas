/**
 * oauth2.test.ts — Issue #604 OAuth2 helpers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    clientCredentialsGrant,
    buildAuthorizationUrl,
    authorizationCodeGrant,
    refreshGrant,
    generatePkcePair,
} from '../oauth2';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    (global as any).fetch = fetchMock;
});

function tokenResponse(body: Record<string, unknown>, init: { status?: number } = {}) {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        statusText: init.status && init.status >= 400 ? 'Bad Request' : 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
    });
}

describe('clientCredentialsGrant', () => {
    it('exchanges client credentials for an access token', async () => {
        fetchMock.mockResolvedValueOnce(tokenResponse({
            access_token: 'tk',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read write',
        }));
        const out = await clientCredentialsGrant({
            tokenEndpoint: 'https://issuer/token',
            clientId: 'c1',
            clientSecret: 's1',
            scope: 'read write',
        });
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.token.accessToken).toBe('tk');
            expect(out.token.expiresIn).toBe(3600);
            expect(out.token.scope).toBe('read write');
        }
        const call = fetchMock.mock.calls[0];
        expect(call[0]).toBe('https://issuer/token');
        const body = (call[1] as { body: string }).body;
        const parsed = new URLSearchParams(body);
        expect(parsed.get('grant_type')).toBe('client_credentials');
        expect(parsed.get('client_id')).toBe('c1');
        expect(parsed.get('client_secret')).toBe('s1');
    });

    it('forwards `audience` (Auth0 / Okta convention)', async () => {
        fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'tk', token_type: 'Bearer' }));
        await clientCredentialsGrant({
            tokenEndpoint: 'https://issuer/token',
            clientId: 'c1', clientSecret: 's1',
            audience: 'https://api.example.com',
        });
        const body = new URLSearchParams((fetchMock.mock.calls[0][1] as { body: string }).body);
        expect(body.get('audience')).toBe('https://api.example.com');
    });

    it('returns ok:false on HTTP 4xx', async () => {
        fetchMock.mockResolvedValueOnce(tokenResponse({
            error: 'invalid_client',
            error_description: 'bad creds',
        }, { status: 401 }));
        const out = await clientCredentialsGrant({
            tokenEndpoint: 'https://issuer/token', clientId: 'c1', clientSecret: 's1',
        });
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.error.error).toBe('invalid_client');
            expect(out.error.status).toBe(401);
        }
    });

    it('rejects non-https token endpoint via clean error', async () => {
        const out = await clientCredentialsGrant({
            tokenEndpoint: 'not-a-url', clientId: 'c1', clientSecret: 's1',
        });
        expect(out.ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('buildAuthorizationUrl', () => {
    it('assembles the URL with default response_type=code + generated state', () => {
        const { url, state } = buildAuthorizationUrl({
            authorizationEndpoint: 'https://issuer/auth',
            clientId: 'c1',
            redirectUri: 'http://localhost/callback',
            scope: 'openid email',
        });
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://issuer/auth');
        expect(parsed.searchParams.get('response_type')).toBe('code');
        expect(parsed.searchParams.get('client_id')).toBe('c1');
        expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost/callback');
        expect(parsed.searchParams.get('scope')).toBe('openid email');
        expect(parsed.searchParams.get('state')).toBe(state);
        expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    });

    it('attaches PKCE challenge when provided', () => {
        const { url } = buildAuthorizationUrl({
            authorizationEndpoint: 'https://issuer/auth',
            clientId: 'c1',
            redirectUri: 'http://localhost/callback',
            pkce: { codeChallenge: 'abc123', codeChallengeMethod: 'S256' },
        });
        const parsed = new URL(url);
        expect(parsed.searchParams.get('code_challenge')).toBe('abc123');
        expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('passes through `extra` params (audience, prompt, login_hint)', () => {
        const { url } = buildAuthorizationUrl({
            authorizationEndpoint: 'https://issuer/auth',
            clientId: 'c1',
            redirectUri: 'http://localhost/callback',
            extra: { audience: 'aud', prompt: 'consent', login_hint: 'a@b.com' },
        });
        const parsed = new URL(url);
        expect(parsed.searchParams.get('audience')).toBe('aud');
        expect(parsed.searchParams.get('prompt')).toBe('consent');
        expect(parsed.searchParams.get('login_hint')).toBe('a@b.com');
    });

    it('reuses the caller-supplied state', () => {
        const { url, state } = buildAuthorizationUrl({
            authorizationEndpoint: 'https://issuer/auth',
            clientId: 'c1', redirectUri: 'http://x', state: 'fixed-state',
        });
        expect(state).toBe('fixed-state');
        const parsed = new URL(url);
        expect(parsed.searchParams.get('state')).toBe('fixed-state');
    });
});

describe('authorizationCodeGrant', () => {
    it('exchanges code + redirect_uri + (optional) PKCE verifier', async () => {
        fetchMock.mockResolvedValueOnce(tokenResponse({
            access_token: 'tk', token_type: 'Bearer',
            refresh_token: 'rf', id_token: 'idt',
        }));
        const out = await authorizationCodeGrant({
            tokenEndpoint: 'https://issuer/token',
            clientId: 'c1', clientSecret: 's1',
            code: 'CODE', redirectUri: 'http://localhost/callback',
            codeVerifier: 'verifier-x',
        });
        expect(out.ok).toBe(true);
        if (out.ok) {
            expect(out.token.refreshToken).toBe('rf');
            expect(out.token.idToken).toBe('idt');
        }
        const body = new URLSearchParams((fetchMock.mock.calls[0][1] as { body: string }).body);
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('CODE');
        expect(body.get('code_verifier')).toBe('verifier-x');
    });
});

describe('refreshGrant', () => {
    it('exchanges a refresh token for a new access token', async () => {
        fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'tk2', token_type: 'Bearer', expires_in: 600 }));
        const out = await refreshGrant({
            tokenEndpoint: 'https://issuer/token',
            clientId: 'c1', refreshToken: 'rf',
        });
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.token.accessToken).toBe('tk2');
        const body = new URLSearchParams((fetchMock.mock.calls[0][1] as { body: string }).body);
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('rf');
    });
});

describe('generatePkcePair', () => {
    it('produces a verifier + S256 challenge pair', async () => {
        const pair = await generatePkcePair();
        expect(pair.codeChallengeMethod).toBe('S256');
        expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
        expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    });

    it('produces different verifiers each call', async () => {
        const a = await generatePkcePair();
        const b = await generatePkcePair();
        expect(a.codeVerifier).not.toBe(b.codeVerifier);
        expect(a.codeChallenge).not.toBe(b.codeChallenge);
    });
});
