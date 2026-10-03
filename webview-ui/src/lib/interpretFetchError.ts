/**
 * interpretFetchError.ts — UX-23 (2026-06-04)
 *
 * Send-request failures arrive as a bare browser error string like
 * `TypeError: fetch failed` or `Failed to fetch` with no context.
 * For new users — especially when the target is a local API server
 * the user hasn't started yet — that's easy to mistake for a bug
 * in CodeAtlas. This pure helper inspects the error + the request
 * URL and returns an actionable hint to render alongside the raw
 * message.
 *
 * Returns null when no useful hint applies (the caller still shows
 * the raw error). The shape is intentionally tiny so the consumer
 * just spreads it into a `<div>`.
 */

export interface FetchErrorHint {
    /** Short headline shown next to the raw error. */
    headline: string;
    /** Optional longer suggestion (rendered as muted secondary text). */
    suggestion?: string;
}

const LOCAL_HOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;
const PRIVATE_HOST_RE = /^https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/i;

export function interpretFetchError(
    error: string | undefined | null,
    requestUrl?: string | null,
): FetchErrorHint | null {
    if (!error) return null;
    const lower = error.toLowerCase();

    // Pattern 1 — generic browser fetch failure (most common).
    // Browsers don't surface the underlying cause; show a hint that
    // covers the common "server isn't running on localhost" path.
    const isGenericFetchFail =
        /fetch failed/.test(lower) ||
        /failed to fetch/.test(lower) ||
        /network\s*(?:error|request failed)/.test(lower);

    // Pattern 2 — Node-style connection refused (when CodeAtlas
    // is proxying the request through the extension host).
    const isConnRefused = /econnrefused/.test(lower) || /connection refused/.test(lower);

    // Pattern 3 — explicit reset.
    const isConnReset = /econnreset/.test(lower) || /connection reset/.test(lower);

    // Pattern 4 — DNS resolution failure.
    const isDnsFail = /enotfound/.test(lower) || /eai_again/.test(lower) || /name not resolved/.test(lower);

    if (isDnsFail) {
        if (requestUrl) {
            const host = safeHost(requestUrl);
            return {
                headline: `Couldn't resolve ${host}.`,
                suggestion: `Check the URL in the request preview — the host name may be misspelled or your DNS is unreachable.`,
            };
        }
        return {
            headline: `Couldn't resolve the target host.`,
            suggestion: `Check the URL in the request preview — the host name may be misspelled or your DNS is unreachable.`,
        };
    }

    if (isConnRefused || isConnReset || isGenericFetchFail) {
        const isLocal = requestUrl ? LOCAL_HOST_RE.test(requestUrl) : false;
        const isPrivate = requestUrl ? PRIVATE_HOST_RE.test(requestUrl) : false;
        if (isLocal) {
            return {
                headline: `Is your API server running?`,
                suggestion: `CodeAtlas tried to reach ${requestUrl} but the connection was refused. Start the local server and click Send again.`,
            };
        }
        if (isPrivate) {
            return {
                headline: `Couldn't reach the private host.`,
                suggestion: `CodeAtlas tried to reach ${requestUrl} but the connection was refused. Check that you're on the right VPN / network.`,
            };
        }
        if (requestUrl) {
            return {
                headline: `Couldn't reach ${safeHost(requestUrl)}.`,
                suggestion: `The connection failed before any HTTP response. The server may be down, blocked by a firewall, or unreachable from here.`,
            };
        }
        return {
            headline: `The request couldn't reach the server.`,
            suggestion: `If the server should be on your machine, make sure it's running and click Send again.`,
        };
    }

    return null;
}

function safeHost(url: string): string {
    try {
        const u = new URL(url);
        return u.host || url;
    } catch {
        return url;
    }
}
