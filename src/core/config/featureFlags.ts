/**
 * featureFlags.ts — Issue 370 / ADR-023
 *
 * INVARIANT: a runtime bug in a new code path can be disabled without an
 * extension republish. Flags are fetched from a remote JSON endpoint with
 * a 24-hour cache and are FAIL-OPEN: when the network call fails, every
 * flag is treated as enabled (so a fetch outage never breaks the product).
 *
 * Usage:
 *   if (await featureFlags.isEnabled('cascade_v2')) {
 *       runNewCascade();
 *   } else {
 *       runLegacyCascade();
 *   }
 *
 * Flag shape from server:
 *   {
 *     "version": 1,
 *     "flags": {
 *       "cascade_v2": { "enabled": true, "rollout_percent": 100 },
 *       "ai_review_streaming": { "enabled": false }
 *     }
 *   }
 *
 * Rollout percent uses a stable hash of vscode.env.machineId — the same
 * device gets the same answer across launches, so partial rollouts are
 * deterministic per user.
 */

interface FlagRule {
    enabled: boolean;
    /** 0-100. When unset, treated as 100 (everyone). */
    rollout_percent?: number;
}

interface FlagPayload {
    version: number;
    flags: Record<string, FlagRule>;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
// Hard cap on response body bytes — defends against a proxy / captive portal
// returning a giant HTML "blocked" page instead of JSON. 1 MB is ~25x larger
// than any realistic flags payload.
const MAX_BODY_BYTES = 1 * 1024 * 1024;
// Backoff after a failed attempt. Without this, every isEnabled() call with a
// null cache re-fires the fetch — a single user behind a proxy that blocks the
// host could trigger hundreds of timeouts per session. 5 min is enough to
// avoid hammering while still recovering quickly when the network comes back.
const FAIL_BACKOFF_MS = 5 * 60 * 1000;

interface CachedFlags {
    flags: Record<string, FlagRule>;
    fetchedAt: number;
}

export class FeatureFlagClient {
    private endpoint: string;
    private cache: CachedFlags | null = null;
    private inflight: Promise<void> | null = null;
    private deviceId: string;
    private log: (msg: string) => void = () => {};
    // Timestamp of the last failed fetch attempt. Used to back off so we don't
    // keep retrying every isEnabled() call when behind a blocking proxy.
    private lastFailureAt: number = 0;

    constructor(endpoint: string, deviceId: string) {
        this.endpoint = endpoint;
        this.deviceId = deviceId;
    }

    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    /**
     * INVARIANT: fail-open. Network errors / parse errors / unknown flag →
     * return `true`. The product behaves as if the flag is on; a remote-
     * disable is opt-in via an explicitly-set `enabled: false`.
     */
    async isEnabled(flagName: string): Promise<boolean> {
        await this.ensureFresh();
        const rule = this.cache?.flags[flagName];
        if (!rule) return true;             // unknown flag → fail-open
        if (!rule.enabled) return false;
        const pct = rule.rollout_percent ?? 100;
        if (pct >= 100) return true;
        if (pct <= 0) return false;
        // Deterministic per-device rollout: stable hash → 0-99 bucket.
        const bucket = stableBucket(`${this.deviceId}:${flagName}`);
        return bucket < pct;
    }

    /** Synchronous read of last-fetched value. Useful for tests + hot paths
     *  that already verified freshness. Returns true on missing cache. */
    isEnabledSync(flagName: string): boolean {
        const rule = this.cache?.flags[flagName];
        if (!rule) return true;
        if (!rule.enabled) return false;
        const pct = rule.rollout_percent ?? 100;
        if (pct >= 100) return true;
        if (pct <= 0) return false;
        return stableBucket(`${this.deviceId}:${flagName}`) < pct;
    }

    private async ensureFresh(): Promise<void> {
        const now = Date.now();
        const stale = !this.cache || (now - this.cache.fetchedAt) > CACHE_TTL_MS;
        if (!stale) return;
        // Backoff guard: if we just failed, don't hammer the endpoint on every
        // isEnabled() call. Behind a blocking proxy this would otherwise fan
        // out to ~1 request per cascade rebuild × 5s timeout each.
        if (this.lastFailureAt > 0 && (now - this.lastFailureAt) < FAIL_BACKOFF_MS) {
            return;
        }
        if (this.inflight) {
            // Coalesce concurrent fetches so a flurry of isEnabled() calls
            // doesn't fan out to N HTTP requests.
            return this.inflight;
        }
        this.inflight = this.fetchFlags()
            .catch(() => { /* fail-open — keep stale or null cache */ })
            .finally(() => { this.inflight = null; });
        return this.inflight;
    }

    /**
     * Fetch flags from the endpoint. INVARIANT (fail-open): ANY failure mode
     * — timeout, DNS failure, TLS, 4xx (incl. 403/407 proxy auth), 5xx, body
     * exceeding cap, non-JSON, malformed schema — leaves the cache untouched
     * and records `lastFailureAt`. The product behaves exactly as it would
     * with an empty payload. Defensive against:
     *   - Proxies that block `codeatlas.live` (403/407/blocked-page HTML).
     *   - Captive portals (200 + HTML redirect).
     *   - Slow networks (timeout via AbortSignal).
     *   - Misconfigured CDNs (5xx, oversized responses, gzip-bomb).
     *   - Older runtimes lacking `AbortSignal.timeout` or `fetch`.
     */
    private async fetchFlags(): Promise<void> {
        const recordFailure = (kind: string, detail?: unknown) => {
            this.lastFailureAt = Date.now();
            const msg = detail instanceof Error ? detail.message : String(detail ?? '');
            this.log(`[FeatureFlags] ${kind} (${this.endpoint})${msg ? ': ' + msg.slice(0, 200) : ''}`);
        };

        // Guard against environments where `fetch` or `AbortSignal.timeout`
        // aren't available (older Node / sandboxed runtimes).
        if (typeof fetch !== 'function') {
            recordFailure('fetch_unavailable');
            return;
        }

        // Build the abort signal with an unref'd timer — `AbortSignal.timeout`
        // (Node 17.3+) holds a referenced timer that keeps the event loop
        // alive for the full timeout duration even after the fetch settles,
        // which causes worker-shutdown hangs in tests. Hand-roll via
        // AbortController + `setTimeout(...).unref()` so the timer never
        // blocks process exit. Falls back gracefully when AbortController
        // is unavailable in older runtimes.
        let resp: Response;
        try {
            const init: RequestInit = { method: 'GET' };
            let timer: ReturnType<typeof setTimeout> | undefined;
            if (typeof AbortController === 'function') {
                const controller = new AbortController();
                timer = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
                // unref so a pending timer can't keep Node alive past the
                // fetch completion. In VS Code extension host this is fine
                // — the host owns the lifecycle, not us.
                if (typeof (timer as any).unref === 'function') (timer as any).unref();
                init.signal = controller.signal;
            }
            try {
                resp = await fetch(this.endpoint, init);
            } finally {
                if (timer !== undefined) clearTimeout(timer);
            }
        } catch (err: any) {
            // AbortError (timeout), DNS failure, TLS handshake error, TCP RST,
            // proxy connection refused, etc. All bucket as "network".
            const kind = err?.name === 'AbortError' || err?.name === 'TimeoutError'
                ? 'timeout' : 'network_error';
            recordFailure(kind, err);
            return;
        }

        // Any non-200 response — 3xx redirects that didn't follow, 4xx (incl.
        // 401/403/407 proxy auth, 404 endpoint missing), 5xx server errors.
        if (!resp.ok) {
            recordFailure(`http_${resp.status}`);
            return;
        }

        // Capped read so a misconfigured proxy returning a multi-MB HTML
        // block-page doesn't pin memory while we wait for `.json()` to fail.
        let bodyText: string;
        try {
            bodyText = await readBodyCapped(resp, MAX_BODY_BYTES);
        } catch (err: any) {
            const kind = err?.message === 'body_too_large' ? 'body_too_large'
                : err?.name === 'AbortError' ? 'body_read_timeout'
                : 'body_read_error';
            recordFailure(kind, err);
            return;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(bodyText);
        } catch (err: any) {
            recordFailure('parse_error', err);
            return;
        }

        if (!payload || typeof payload !== 'object' || typeof (payload as FlagPayload).flags !== 'object') {
            recordFailure('malformed_payload');
            return;
        }

        this.cache = { flags: (payload as FlagPayload).flags, fetchedAt: Date.now() };
        this.lastFailureAt = 0; // success — clear backoff
    }
}

/**
 * Read a fetch Response body as text, aborting once it crosses `maxBytes`.
 * Returns the joined string. Throws Error('body_too_large') when the cap is
 * exceeded. Preferred over `resp.text()` because the latter has no size limit
 * and a malicious or misconfigured upstream could pin memory.
 */
async function readBodyCapped(resp: Response, maxBytes: number): Promise<string> {
    // If the server set Content-Length and it's already too big, bail before
    // reading any bytes.
    const lenHeader = resp.headers.get('content-length');
    if (lenHeader) {
        const len = parseInt(lenHeader, 10);
        if (Number.isFinite(len) && len > maxBytes) {
            throw new Error('body_too_large');
        }
    }
    // Older runtimes / `node-fetch` without a `.body` ReadableStream — fall
    // back to `.text()` (we already capped via Content-Length above when set).
    if (!resp.body || typeof (resp.body as any).getReader !== 'function') {
        return resp.text();
    }
    const reader = (resp.body as any).getReader();
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let out = '';
    // Loop reads chunks; if cumulative size exceeds the cap we cancel the
    // stream so the network connection is closed (rather than draining a
    // gigabyte of HTML).
    /* eslint-disable no-constant-condition */
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            try { reader.cancel(); } catch { /* ignore */ }
            throw new Error('body_too_large');
        }
        out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
}

/** Deterministic 0-99 bucket from a string. FNV-1a → modulo 100. */
function stableBucket(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % 100;
}
