/**
 * oauth2CallbackParser.ts — #604 OAuth2 callback receiver (2026-06-06).
 *
 * Parses `/oauth2/callback?...` redirect URLs into a structured result
 * the WS bridge can broadcast to the connected webview. Pure function,
 * no I/O — the wsBridge HTTP handler imports + calls this on every
 * matching request.
 *
 * Two success shapes the OAuth2 spec defines:
 *   - `code` + `state` → authorization-code redirect (success)
 *   - `error` + optional `error_description` → user denied / failure
 *
 * Any other shape returns null so the wsBridge can fall through to
 * the SPA-index handler.
 */

export type OAuth2CallbackResult =
    | { ok: true; code: string; state?: string }
    | { ok: false; error: string; errorDescription?: string; state?: string };

const OAUTH2_CALLBACK_PATH = '/oauth2/callback';

export function parseOAuth2Callback(urlString: string): OAuth2CallbackResult | null {
    let parsed: URL;
    try {
        // Relative URLs (`/oauth2/callback?…`) get a fake origin so the
        // URL constructor accepts them. Caller-supplied origins win when
        // the path is absolute.
        parsed = new URL(urlString, 'http://localhost:7742');
    } catch {
        return null;
    }
    if (parsed.pathname !== OAUTH2_CALLBACK_PATH) return null;

    const code = parsed.searchParams.get('code');
    const error = parsed.searchParams.get('error');
    const state = parsed.searchParams.get('state') ?? undefined;

    if (code) {
        return { ok: true, code, state };
    }
    if (error) {
        const errorDescription = parsed.searchParams.get('error_description');
        const result: OAuth2CallbackResult = { ok: false, error, state };
        if (errorDescription) (result as any).errorDescription = errorDescription;
        return result;
    }
    return null;
}
