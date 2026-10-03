import * as crypto from 'crypto';

/**
 * Pure Clerk JWT verification — no `vscode`, so it is shared by the VS Code
 * extension (`ClerkAuthService`) and the standalone `@codeatlas/mcp` server
 * (`StandaloneClerkAuth`). One implementation of the security-sensitive path.
 */

/**
 * Decode the Clerk publishable key to get the frontend API host, then build the
 * JWKS URL. Clerk encodes the host as base64(host + "$") after the pk_ prefix.
 */
export function jwksUrlFromPublishableKey(key: string): string {
    const b64 = key.replace(/^pk_(test|live)_/, '');
    const host = Buffer.from(b64, 'base64').toString('utf-8').replace(/\$$/, '');
    return `https://${host}/.well-known/jwks.json`;
}

/**
 * Verify a JWT against Clerk's JWKS endpoint using Node's built-in crypto.
 * RS256 only (Clerk default). Returns null on success, or an error string.
 */
export async function verifyClerkToken(
    token: string,
    jwksUrl: string,
    log?: (msg: string) => void,
): Promise<string | null> {
    const l = (m: string) => log?.(m);
    try {
        const parts = token.split('.');
        if (parts.length !== 3) { l('Invalid JWT format (expected 3 parts)'); return 'Invalid token format'; }
        const [headerB64, payloadB64, signatureB64] = parts;
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));

        if (payload.exp && payload.exp < Date.now() / 1000) {
            const expiredAt = new Date(payload.exp * 1000).toISOString();
            l(`Token expired at ${expiredAt}`);
            return `Session token expired at ${expiredAt}`;
        }
        if (header.alg !== 'RS256') { l(`Unsupported algorithm: ${header.alg}`); return `Unsupported token algorithm: ${header.alg}`; }

        l(`Fetching JWKS from ${jwksUrl}`);
        let resp: Response;
        try {
            resp = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) });
        } catch (fetchErr: any) {
            const msg = fetchErr?.message ?? String(fetchErr);
            l(`JWKS fetch error: ${msg}`);
            return `Could not reach authentication server: ${msg}`;
        }
        if (!resp.ok) { l(`JWKS fetch failed: ${resp.status} ${resp.statusText}`); return `Authentication server returned ${resp.status}`; }

        const jwks = await resp.json() as { keys: any[] };
        const jwk = header.kid
            ? jwks.keys.find((k: any) => k.kid === header.kid)
            : jwks.keys.find((k: any) => k.kty === 'RSA');
        if (!jwk) { l(`No matching key for kid=${header.kid}`); return `No matching signing key found (kid=${header.kid ?? 'none'})`; }

        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const valid = crypto.verify('SHA256', Buffer.from(`${headerB64}.${payloadB64}`), key, Buffer.from(signatureB64, 'base64url'));
        l(`Signature verification: ${valid ? 'OK' : 'FAILED'}`);
        return valid ? null : 'Token signature is invalid';
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        l(`verifyToken threw: ${msg}`);
        return `Verification error: ${msg}`;
    }
}
