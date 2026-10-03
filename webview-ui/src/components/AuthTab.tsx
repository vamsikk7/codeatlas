/**
 * AuthTab.tsx — #745 OAuth2 surface (2026-06-06).
 *
 * Three collapsible sections, each backed by an already-shipped backend:
 *   1. Client credentials  → `clientCredentialsGrant`
 *   2. Authorization URL   → `buildAuthorizationUrl` (+ optional PKCE)
 *   3. Authorization code  → `authorizationCodeGrant`
 *
 * The component is stateless about the round-trip — it emits the form
 * values via callbacks and reads in-flight / result / error state from
 * a single `state` prop. App.tsx manages the WS message round-trip.
 */
import { useEffect, useState } from 'react';

export interface OAuthToken {
    accessToken: string;
    tokenType: string;
    expiresIn?: number;
    refreshToken?: string;
    scope?: string;
    idToken?: string;
    raw: Record<string, unknown>;
}

export interface ClientCredentialsState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    token?: OAuthToken;
    error?: string;
}

export interface AuthorizeUrlState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    url?: string;
    state?: string;
    /** PKCE code verifier surfaced so the user can pair it with the
     *  subsequent code-exchange call. */
    codeVerifier?: string;
    error?: string;
}

export interface ExchangeCodeState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    token?: OAuthToken;
    error?: string;
}

export interface AuthTabState {
    clientCredentials?: ClientCredentialsState;
    authorizeUrl?: AuthorizeUrlState;
    exchangeCode?: ExchangeCodeState;
    /** #604 (2026-06-06) — captured OAuth2 callback. Set by wsBridge's
     *  /oauth2/callback handler via the `oauth2CallbackReceived`
     *  broadcast. AuthTab reads this to auto-fill the exchange-code
     *  form's `code` field. The user still has to click "Exchange code"
     *  to fire the token round-trip. */
    callback?:
        | { ok: true; code: string; state?: string }
        | { ok: false; error: string; errorDescription?: string; state?: string };
}

export interface ClientCredentialsArgs {
    requestId: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
    audience?: string;
}

export interface BuildAuthorizationUrlArgs {
    requestId: string;
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    scope?: string;
    usePkce: boolean;
}

export interface ExchangeAuthorizationCodeArgs {
    requestId: string;
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    code: string;
    codeVerifier?: string;
}

export interface AuthTabProps {
    state?: AuthTabState;
    onClientCredentials: (args: ClientCredentialsArgs) => void;
    onBuildAuthorizationUrl: (args: BuildAuthorizationUrlArgs) => void;
    onExchangeAuthorizationCode: (args: ExchangeAuthorizationCodeArgs) => void;
}

export default function AuthTab({ state, onClientCredentials, onBuildAuthorizationUrl, onExchangeAuthorizationCode }: AuthTabProps) {
    // Client credentials form
    const [ccEndpoint, setCcEndpoint] = useState('');
    const [ccClientId, setCcClientId] = useState('');
    const [ccClientSecret, setCcClientSecret] = useState('');
    const [ccScope, setCcScope] = useState('');
    const [ccAudience, setCcAudience] = useState('');

    // Authorize URL form
    const [authEndpoint, setAuthEndpoint] = useState('');
    const [authClientId, setAuthClientId] = useState('');
    const [authRedirectUri, setAuthRedirectUri] = useState('');
    const [authScope, setAuthScope] = useState('');
    const [authUsePkce, setAuthUsePkce] = useState(false);

    // Exchange code form
    const [exTokenEndpoint, setExTokenEndpoint] = useState('');
    const [exClientId, setExClientId] = useState('');
    const [exClientSecret, setExClientSecret] = useState('');
    const [exRedirectUri, setExRedirectUri] = useState('');
    const [exCode, setExCode] = useState('');
    // #604 (2026-06-06) — when the callback receiver delivers a code,
    // auto-fill the `exCode` field. Keyed on `state + code` so the same
    // callback re-arriving doesn't clobber the user's later typing —
    // only a NEW callback (different state or code) re-fills.
    const callback = state?.callback;
    const callbackKey = callback?.ok ? `${callback.state ?? ''}:${callback.code}` : null;
    const [lastAutoFilledFrom, setLastAutoFilledFrom] = useState<string | null>(null);
    useEffect(() => {
        if (callbackKey && callbackKey !== lastAutoFilledFrom && callback?.ok) {
            setExCode(callback.code);
            setLastAutoFilledFrom(callbackKey);
        }
    }, [callbackKey, callback, lastAutoFilledFrom]);

    const cc = state?.clientCredentials;
    const au = state?.authorizeUrl;
    const ex = state?.exchangeCode;

    return (
        <div className="ca-api-testing-auth-tab" role="region" aria-label="OAuth2">
            {/* ── 1. Client credentials ─────────────────────────────── */}
            <details className="ca-api-testing-details">
                <summary>Client credentials (machine-to-machine)</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Token endpoint</span>
                        <input
                            className="ca-api-testing-input"
                            type="url"
                            value={ccEndpoint}
                            onChange={(e) => setCcEndpoint(e.target.value)}
                            placeholder="https://auth.example.com/oauth/token"
                            aria-label="Token endpoint"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Client ID</span>
                        <input
                            className="ca-api-testing-input"
                            type="text"
                            value={ccClientId}
                            onChange={(e) => setCcClientId(e.target.value)}
                            aria-label="Client ID"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Client secret</span>
                        <input
                            className="ca-api-testing-input"
                            type="password"
                            value={ccClientSecret}
                            onChange={(e) => setCcClientSecret(e.target.value)}
                            aria-label="Client secret"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Scope (optional)</span>
                        <input
                            className="ca-api-testing-input"
                            type="text"
                            value={ccScope}
                            onChange={(e) => setCcScope(e.target.value)}
                            placeholder="read write"
                            aria-label="Scope (optional)"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Audience (optional)</span>
                        <input
                            className="ca-api-testing-input"
                            type="text"
                            value={ccAudience}
                            onChange={(e) => setCcAudience(e.target.value)}
                            placeholder="https://api.example.com"
                            aria-label="Audience (optional)"
                            spellCheck={false}
                        />
                    </label>
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => onClientCredentials({
                            requestId: `cc-${Date.now()}`,
                            tokenEndpoint: ccEndpoint,
                            clientId: ccClientId,
                            clientSecret: ccClientSecret,
                            scope: ccScope || undefined,
                            audience: ccAudience || undefined,
                        })}
                        disabled={cc?.status === 'loading' || !ccEndpoint || !ccClientId}
                        data-testid="ca-auth-cc-submit"
                    >
                        {cc?.status === 'loading' ? '⏳ Requesting…' : '🔑 Get token'}
                    </button>
                    {cc?.status === 'error' && (
                        <div role="alert" data-testid="ca-auth-cc-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}>
                            {cc.error ?? 'Token request failed.'}
                        </div>
                    )}
                    {cc?.status === 'ready' && cc.token && (
                        <div data-testid="ca-auth-cc-result" style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 6, fontSize: 11 }}>
                            <div><strong>Token type:</strong> {cc.token.tokenType}</div>
                            {cc.token.expiresIn !== undefined && <div><strong>Expires in:</strong> {cc.token.expiresIn}s</div>}
                            {cc.token.scope && <div><strong>Scope:</strong> {cc.token.scope}</div>}
                            <div style={{ marginTop: 4 }}><strong>Access token:</strong></div>
                            <pre style={{ fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 10, margin: '2px 0 0 0', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                                {cc.token.accessToken}
                            </pre>
                        </div>
                    )}
                </div>
            </details>

            {/* ── 2. Authorization URL builder ──────────────────────── */}
            <details className="ca-api-testing-details">
                <summary>Authorization URL (interactive login)</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Authorization endpoint</span>
                        <input
                            className="ca-api-testing-input"
                            type="url"
                            value={authEndpoint}
                            onChange={(e) => setAuthEndpoint(e.target.value)}
                            placeholder="https://auth.example.com/authorize"
                            aria-label="Authorization endpoint"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Client ID (authorize)</span>
                        <input
                            className="ca-api-testing-input"
                            type="text"
                            value={authClientId}
                            onChange={(e) => setAuthClientId(e.target.value)}
                            aria-label="Client ID (authorize)"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Redirect URI</span>
                        <input
                            className="ca-api-testing-input"
                            type="url"
                            value={authRedirectUri}
                            onChange={(e) => setAuthRedirectUri(e.target.value)}
                            placeholder="http://localhost:7742/callback"
                            aria-label="Redirect URI"
                            spellCheck={false}
                        />
                    </label>
                    <label>
                        <span style={{ fontSize: 11, opacity: 0.75 }}>Scope (authorize)</span>
                        <input
                            className="ca-api-testing-input"
                            type="text"
                            value={authScope}
                            onChange={(e) => setAuthScope(e.target.value)}
                            placeholder="openid profile email"
                            aria-label="Scope (authorize)"
                            spellCheck={false}
                        />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                        <input
                            type="checkbox"
                            checked={authUsePkce}
                            onChange={(e) => setAuthUsePkce(e.target.checked)}
                            aria-label="Use PKCE (S256)"
                        />
                        Use PKCE (S256)
                    </label>
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => onBuildAuthorizationUrl({
                            requestId: `au-${Date.now()}`,
                            authorizationEndpoint: authEndpoint,
                            clientId: authClientId,
                            redirectUri: authRedirectUri,
                            scope: authScope || undefined,
                            usePkce: authUsePkce,
                        })}
                        disabled={au?.status === 'loading' || !authEndpoint || !authClientId || !authRedirectUri}
                        data-testid="ca-auth-url-submit"
                    >
                        {au?.status === 'loading' ? '⏳ Building…' : '🔗 Build URL'}
                    </button>
                    {au?.status === 'error' && (
                        <div role="alert" data-testid="ca-auth-url-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}>
                            {au.error ?? 'URL build failed.'}
                        </div>
                    )}
                    {au?.status === 'ready' && au.url && (
                        <div data-testid="ca-auth-url-result" style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 6, fontSize: 11 }}>
                            <div><strong>State:</strong> {au.state}</div>
                            {au.codeVerifier && <div><strong>PKCE verifier:</strong> <code style={{ fontSize: 10 }}>{au.codeVerifier}</code></div>}
                            <div style={{ marginTop: 4 }}><strong>URL:</strong></div>
                            <a href={au.url} target="_blank" rel="noopener noreferrer" style={{ wordBreak: 'break-all', fontSize: 10 }}>{au.url}</a>
                        </div>
                    )}

                    {/* ── 3. Authorization code exchange ───────────── */}
                    <div style={{ marginTop: 10, borderTop: '1px solid var(--ca-border, #94a3b8)', paddingTop: 8 }}>
                        <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 6 }}>
                            After the user signs in, paste the <code>code</code> from the redirect URL below — or use the built-in callback receiver at <code>http://localhost:7742/oauth2/callback</code> to capture it automatically.
                        </div>
                        {/* #604 (2026-06-06) — render the captured-callback banner. */}
                        {callback?.ok && (
                            <div
                                data-testid="ca-auth-callback-banner"
                                style={{ background: 'var(--ca-success-bg, rgba(34,197,94,0.15))', border: '1px solid var(--ca-success, #22c55e)', borderRadius: 4, padding: 6, fontSize: 11, marginBottom: 6 }}
                            >
                                ✓ Received authorization code {callback.state ? `(state=${callback.state})` : ''} — code field auto-filled below.
                            </div>
                        )}
                        {callback && !callback.ok && (
                            <div
                                role="alert"
                                data-testid="ca-auth-callback-error"
                                style={{ background: 'var(--ca-error-bg, rgba(239,68,68,0.15))', border: '1px solid var(--ca-error, #ef4444)', borderRadius: 4, padding: 6, fontSize: 11, marginBottom: 6 }}
                            >
                                × OAuth2 callback error: <strong>{callback.error}</strong>
                                {callback.errorDescription ? ` — ${callback.errorDescription}` : ''}
                            </div>
                        )}
                        <label>
                            <span style={{ fontSize: 11, opacity: 0.75 }}>Token endpoint (exchange)</span>
                            <input
                                className="ca-api-testing-input"
                                type="url"
                                value={exTokenEndpoint}
                                onChange={(e) => setExTokenEndpoint(e.target.value)}
                                placeholder="https://auth.example.com/oauth/token"
                                aria-label="Token endpoint (exchange)"
                                spellCheck={false}
                            />
                        </label>
                        <label>
                            <span style={{ fontSize: 11, opacity: 0.75 }}>Client ID (optional for PKCE-only public clients)</span>
                            <input
                                className="ca-api-testing-input"
                                type="text"
                                value={exClientId}
                                onChange={(e) => setExClientId(e.target.value)}
                                aria-label="Client ID (exchange)"
                                spellCheck={false}
                            />
                        </label>
                        <label>
                            <span style={{ fontSize: 11, opacity: 0.75 }}>Client secret (optional)</span>
                            <input
                                className="ca-api-testing-input"
                                type="password"
                                value={exClientSecret}
                                onChange={(e) => setExClientSecret(e.target.value)}
                                aria-label="Client secret (exchange)"
                                spellCheck={false}
                            />
                        </label>
                        <label>
                            <span style={{ fontSize: 11, opacity: 0.75 }}>Redirect URI (exchange)</span>
                            <input
                                className="ca-api-testing-input"
                                type="url"
                                value={exRedirectUri}
                                onChange={(e) => setExRedirectUri(e.target.value)}
                                aria-label="Redirect URI (exchange-form)"
                                spellCheck={false}
                            />
                        </label>
                        <label>
                            <span style={{ fontSize: 11, opacity: 0.75 }}>Authorization code</span>
                            <input
                                className="ca-api-testing-input"
                                type="text"
                                value={exCode}
                                onChange={(e) => setExCode(e.target.value)}
                                aria-label="Authorization code"
                                spellCheck={false}
                            />
                        </label>
                        <button
                            type="button"
                            className="ca-api-testing-send"
                            onClick={() => onExchangeAuthorizationCode({
                                requestId: `ex-${Date.now()}`,
                                tokenEndpoint: exTokenEndpoint,
                                clientId: exClientId,
                                clientSecret: exClientSecret || undefined,
                                redirectUri: exRedirectUri,
                                code: exCode,
                                codeVerifier: au?.codeVerifier,
                            })}
                            disabled={ex?.status === 'loading' || !exTokenEndpoint || !exCode}
                            data-testid="ca-auth-exchange-submit"
                            style={{ marginTop: 6 }}
                        >
                            {ex?.status === 'loading' ? '⏳ Exchanging…' : '🔑 Exchange code'}
                        </button>
                        {ex?.status === 'error' && (
                            <div role="alert" data-testid="ca-auth-exchange-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11, marginTop: 4 }}>
                                {ex.error ?? 'Exchange failed.'}
                            </div>
                        )}
                        {ex?.status === 'ready' && ex.token && (
                            <div data-testid="ca-auth-exchange-result" style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 6, fontSize: 11, marginTop: 6 }}>
                                <div><strong>Token type:</strong> {ex.token.tokenType}</div>
                                {ex.token.expiresIn !== undefined && <div><strong>Expires in:</strong> {ex.token.expiresIn}s</div>}
                                <div style={{ marginTop: 4 }}><strong>Access token:</strong></div>
                                <pre style={{ fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 10, margin: '2px 0 0 0', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                                    {ex.token.accessToken}
                                </pre>
                                {ex.token.refreshToken && (
                                    <>
                                        <div style={{ marginTop: 4 }}><strong>Refresh token:</strong></div>
                                        <pre style={{ fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 10, margin: '2px 0 0 0', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                                            {ex.token.refreshToken}
                                        </pre>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </details>
        </div>
    );
}
