/**
 * featureFlags.test.ts — Issue 370 / ADR-023
 *
 * Pins the fail-open invariant + per-device rollout determinism.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FeatureFlagClient } from '../featureFlags';

const ENDPOINT = 'https://example.test/flags';

/**
 * Mock helper that mirrors the production code's `text() → JSON.parse` path
 * (chosen so we can cap body size via `body.getReader()` in production). The
 * helper returns a Response-shaped object with both `.body.getReader()` AND
 * `.text()` so the size-capped reader and fallback path both work.
 */
function mockOkJsonResponse(payload: any, headers: Record<string, string> = {}): any {
    const bodyText = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(bodyText);
    const hdrs = new Headers(headers);
    return {
        ok: true,
        status: 200,
        headers: hdrs,
        body: {
            getReader: () => {
                let sent = false;
                return {
                    read: () => sent
                        ? Promise.resolve({ done: true, value: undefined })
                        : (sent = true, Promise.resolve({ done: false, value: bytes })),
                    cancel: () => Promise.resolve(),
                };
            },
        },
        text: () => Promise.resolve(bodyText),
        json: () => Promise.resolve(payload),
    };
}

describe('FeatureFlagClient (Issue 370)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('fail-open: network error → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network'))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('any_flag')).resolves.toBe(true);
    });

    it('fail-open: malformed payload → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(mockOkJsonResponse(null))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('any_flag')).resolves.toBe(true);
    });

    it('respects an explicit enabled:false', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(mockOkJsonResponse({
            version: 1, flags: { dangerous_feature: { enabled: false } },
        }))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('dangerous_feature')).resolves.toBe(false);
    });

    it('respects an explicit enabled:true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(mockOkJsonResponse({
            version: 1, flags: { stable_feature: { enabled: true } },
        }))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('stable_feature')).resolves.toBe(true);
    });

    it('returns true for unknown flags (fail-open)', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(mockOkJsonResponse({
            version: 1, flags: {},
        }))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('not_in_payload')).resolves.toBe(true);
    });

    it('partial rollout: same device gets same answer across calls', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(mockOkJsonResponse({
            version: 1, flags: { canary: { enabled: true, rollout_percent: 50 } },
        }))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-stable');
        const a = await client.isEnabled('canary');
        const b = await client.isEnabled('canary');
        const c = await client.isEnabled('canary');
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('partial rollout: different devices get different answers (over a sample)', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(mockOkJsonResponse({
            version: 1, flags: { ramp: { enabled: true, rollout_percent: 50 } },
        }))));
        let trues = 0;
        let falses = 0;
        for (let i = 0; i < 100; i++) {
            const client = new FeatureFlagClient(ENDPOINT, `device-${i}`);
            if (await client.isEnabled('ramp')) trues++;
            else falses++;
        }
        // Roughly 50/50 split; allow ±20 wiggle room for hash skew on a
        // small sample.
        expect(trues).toBeGreaterThan(30);
        expect(falses).toBeGreaterThan(30);
    });

    it('coalesces concurrent fetches when cache is stale', async () => {
        const fetchSpy = vi.fn(() => Promise.resolve(mockOkJsonResponse({
            version: 1, flags: {},
        })));
        vi.stubGlobal('fetch', fetchSpy);
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await Promise.all([
            client.isEnabled('a'),
            client.isEnabled('b'),
            client.isEnabled('c'),
        ]);
        // Single network call serves all three lookups.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // ─── Proxy / network-failure hardening (user-requested) ──────────────────
    // The endpoint may be blocked by corporate proxies, captive portals, ad
    // blockers, or simply offline. Every failure mode must fail-open AND
    // back off so we don't hammer the network on every subsequent call.

    it('fail-open: HTTP 403 (proxy block) → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false, status: 403, headers: new Headers(),
        } as any)));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('fail-open: HTTP 407 (proxy auth required) → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false, status: 407, headers: new Headers(),
        } as any)));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('fail-open: HTTP 503 (server error) → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false, status: 503, headers: new Headers(),
        } as any)));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('fail-open: HTTP 404 (endpoint missing — current production state) → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: false, status: 404, headers: new Headers(),
        } as any)));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('fail-open: AbortError (timeout) → flag returns true', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('fail-open: HTML body where JSON was expected (captive portal) → flag returns true', async () => {
        const html = '<!DOCTYPE html><html><body>Blocked by proxy</body></html>';
        const bytes = new TextEncoder().encode(html);
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true, status: 200, headers: new Headers(),
            body: { getReader: () => { let s=false; return { read: () => s ? Promise.resolve({done:true}) : (s=true, Promise.resolve({done:false,value:bytes})), cancel: () => Promise.resolve() }; } },
            text: () => Promise.resolve(html),
        } as any)));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('fail-open: Content-Length over cap → flag returns true (oversized-response defense)', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
            ok: true, status: 200,
            headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
            body: { getReader: () => ({ read: () => Promise.resolve({done:true}), cancel: () => Promise.resolve() }) },
            text: () => Promise.resolve(''),
        } as any)));
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });

    it('backoff: a failed fetch is NOT re-attempted on every subsequent isEnabled call', async () => {
        const fetchSpy = vi.fn(() => Promise.resolve({
            ok: false, status: 403, headers: new Headers(),
        } as any));
        vi.stubGlobal('fetch', fetchSpy);
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');

        await client.isEnabled('a');
        await client.isEnabled('b');
        await client.isEnabled('c');
        await client.isEnabled('d');
        await client.isEnabled('e');

        // First call fetches and fails. Subsequent calls within the
        // FAIL_BACKOFF_MS window (5min) should NOT refetch — the user's
        // proxy-blocked machine shouldn't spam codeatlas.live with retries.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not throw when fetch global is undefined (older runtimes)', async () => {
        vi.stubGlobal('fetch', undefined);
        const client = new FeatureFlagClient(ENDPOINT, 'device-1');
        await expect(client.isEnabled('cascade_on_route')).resolves.toBe(true);
    });
});
