/**
 * apiTesting/oauth2/index.ts — Issue #604 OAuth2 helpers.
 *
 * Ships three building blocks for the three grant flows most APIs
 * actually use:
 *
 *   1. `clientCredentialsGrant` — fully server-side, no user interaction.
 *      Exchanges `client_id` + `client_secret` for an access token at the
 *      token endpoint. Common for machine-to-machine API access.
 *
 *   2. `buildAuthorizationUrl` — assembles the authorization-endpoint
 *      URL the user must visit in their browser. Returns the URL plus
 *      a `state` value the caller should round-trip.
 *
 *   3. `authorizationCodeGrant` — exchanges the `code` returned by the
 *      callback for an access + refresh token. The caller wires the
 *      callback receiver itself (the extension already has a
 *      `/auth/callback` route in `wsBridge.ts`).
 *
 * Plus a `refreshGrant` for renewing tokens. PKCE supported on the
 * authorization-code flow.
 *
 * All grants run server-side via Node `fetch`. The webview never
 * touches `client_secret` — it requests the grant via `sendOauthGrant`
 * postMessage and gets the token back to inject into subsequent
 * requests.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface OAuthTokenResponse {
    accessToken: string;
    tokenType: string;
    expiresIn?: number;
    refreshToken?: string;
    scope?: string;
    idToken?: string;
    raw: Record<string, unknown>;
}

export interface OAuthError {
    error: string;
    description?: string;
    /** HTTP status from the token endpoint. */
    status?: number;
}

export type OAuthResult =
    | { ok: true; token: OAuthTokenResponse }
    | { ok: false; error: OAuthError };

// ── 1. Client credentials grant ─────────────────────────────────────

export interface ClientCredentialsArgs {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    /** Optional space-separated list of scopes. */
    scope?: string;
    /** Optional `audience` parameter (Auth0 / Okta convention). */
    audience?: string;
    /** Override request timeout in ms. */
    timeoutMs?: number;
}

export async function clientCredentialsGrant(args: ClientCredentialsArgs): Promise<OAuthResult> {
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', args.clientId);
    body.set('client_secret', args.clientSecret);
    if (args.scope) body.set('scope', args.scope);
    if (args.audience) body.set('audience', args.audience);
    return postTokenEndpoint(args.tokenEndpoint, body, args.timeoutMs);
}

// ── 2. Authorization URL builder ────────────────────────────────────

export interface AuthorizationUrlArgs {
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    /** Optional space-separated scopes. */
    scope?: string;
    /** Optional pre-computed state. When omitted, a random value is
     *  generated and returned. */
    state?: string;
    /** Optional response type. Defaults to `code` (auth-code flow). */
    responseType?: string;
    /** PKCE — when supplied, attaches `code_challenge` + `code_challenge_method`.
     *  Pair with the same `codeVerifier` in the token-exchange step. */
    pkce?: {
        codeChallenge: string;
        codeChallengeMethod: 'S256' | 'plain';
    };
    /** Free-form extra params (e.g. `audience`, `prompt`, `login_hint`). */
    extra?: Record<string, string>;
}

export interface AuthorizationUrlResult {
    url: string;
    /** State value used in the URL (generated when caller didn't pass one). */
    state: string;
}

export function buildAuthorizationUrl(args: AuthorizationUrlArgs): AuthorizationUrlResult {
    const state = args.state ?? randomState();
    const params = new URLSearchParams();
    params.set('response_type', args.responseType ?? 'code');
    params.set('client_id', args.clientId);
    params.set('redirect_uri', args.redirectUri);
    params.set('state', state);
    if (args.scope) params.set('scope', args.scope);
    if (args.pkce) {
        params.set('code_challenge', args.pkce.codeChallenge);
        params.set('code_challenge_method', args.pkce.codeChallengeMethod);
    }
    for (const [k, v] of Object.entries(args.extra ?? {})) {
        if (typeof v === 'string') params.set(k, v);
    }
    const sep = args.authorizationEndpoint.includes('?') ? '&' : '?';
    return { url: `${args.authorizationEndpoint}${sep}${params.toString()}`, state };
}

// ── 3. Authorization code grant ────────────────────────────────────

export interface AuthorizationCodeArgs {
    tokenEndpoint: string;
    clientId: string;
    /** Optional — public clients (PKCE) omit it. */
    clientSecret?: string;
    code: string;
    redirectUri: string;
    /** PKCE — the `code_verifier` paired with the `code_challenge` from
     *  `buildAuthorizationUrl`. */
    codeVerifier?: string;
    timeoutMs?: number;
}

export async function authorizationCodeGrant(args: AuthorizationCodeArgs): Promise<OAuthResult> {
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', args.clientId);
    if (args.clientSecret) body.set('client_secret', args.clientSecret);
    body.set('code', args.code);
    body.set('redirect_uri', args.redirectUri);
    if (args.codeVerifier) body.set('code_verifier', args.codeVerifier);
    return postTokenEndpoint(args.tokenEndpoint, body, args.timeoutMs);
}

// ── 4. Refresh token grant ─────────────────────────────────────────

export interface RefreshTokenArgs {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    /** Optional new scope (must be a subset of the original). */
    scope?: string;
    timeoutMs?: number;
}

export async function refreshGrant(args: RefreshTokenArgs): Promise<OAuthResult> {
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('client_id', args.clientId);
    if (args.clientSecret) body.set('client_secret', args.clientSecret);
    body.set('refresh_token', args.refreshToken);
    if (args.scope) body.set('scope', args.scope);
    return postTokenEndpoint(args.tokenEndpoint, body, args.timeoutMs);
}

// ── PKCE helpers ────────────────────────────────────────────────────

export interface PkcePair {
    codeVerifier: string;
    codeChallenge: string;
    codeChallengeMethod: 'S256';
}

/**
 * Generate a PKCE verifier + S256 challenge. Cryptographically random
 * verifier (43-128 chars per RFC 7636); SHA-256 challenge base64url-encoded.
 */
export async function generatePkcePair(): Promise<PkcePair> {
    const codeVerifier = randomVerifier();
    const codeChallenge = await sha256Base64Url(codeVerifier);
    return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

// ── internals ──────────────────────────────────────────────────────

async function postTokenEndpoint(
    url: string,
    body: URLSearchParams,
    timeoutMs?: number,
): Promise<OAuthResult> {
    if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: { error: 'invalid_request', description: 'tokenEndpoint must be http:// or https://' } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(120_000, Math.max(1_000, timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            body: body.toString(),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(text); } catch { /* form-encoded fallback */ }
        if (Object.keys(parsed).length === 0) {
            const fallback = new URLSearchParams(text);
            for (const [k, v] of fallback) parsed[k] = v;
        }
        if (!res.ok) {
            return {
                ok: false,
                error: {
                    error: String(parsed.error ?? `http_${res.status}`),
                    description: typeof parsed.error_description === 'string' ? parsed.error_description : res.statusText,
                    status: res.status,
                },
            };
        }
        if (typeof parsed.access_token !== 'string') {
            return { ok: false, error: { error: 'invalid_response', description: 'access_token missing', status: res.status } };
        }
        return {
            ok: true,
            token: {
                accessToken: parsed.access_token as string,
                tokenType: typeof parsed.token_type === 'string' ? parsed.token_type as string : 'Bearer',
                expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in as number : undefined,
                refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token as string : undefined,
                scope: typeof parsed.scope === 'string' ? parsed.scope as string : undefined,
                idToken: typeof parsed.id_token === 'string' ? parsed.id_token as string : undefined,
                raw: parsed,
            },
        };
    } catch (err: any) {
        clearTimeout(timer);
        const aborted = controller.signal.aborted;
        return {
            ok: false,
            error: {
                error: aborted ? 'timeout' : 'network',
                description: err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
            },
        };
    }
}

function randomState(): string {
    // 16 bytes → 22-char base64url string. Avoids the chunk of dashed
    // randomness that crypto.randomUUID() returns.
    return base64UrlEncode(getRandomBytes(16));
}

function randomVerifier(): string {
    return base64UrlEncode(getRandomBytes(32));
}

function getRandomBytes(n: number): Uint8Array {
    const arr = new Uint8Array(n);
    // Both Node and browsers expose `crypto.getRandomValues` on the
    // global crypto object.
    const g = (globalThis as any).crypto;
    if (g && typeof g.getRandomValues === 'function') {
        g.getRandomValues(arr);
        return arr;
    }
    // Fallback (extremely rare on modern Node) — use Math.random.
    for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
    return arr;
}

function base64UrlEncode(bytes: Uint8Array): string {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bytes).toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Base64Url(input: string): Promise<string> {
    const g = (globalThis as any).crypto;
    if (g && g.subtle) {
        const buf = await g.subtle.digest('SHA-256', new TextEncoder().encode(input));
        return base64UrlEncode(new Uint8Array(buf));
    }
    // Node fallback — crypto.createHash sync.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto');
    const buf = createHash('sha256').update(input).digest();
    return base64UrlEncode(new Uint8Array(buf));
}
