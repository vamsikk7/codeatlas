/**
 * mixpanelService.test.ts
 *
 * Issue 369 (ADR-016): pin the editor → distribution-channel heuristic.
 *
 * The .vsix binary is identical between MS Marketplace and Open VSX, so the
 * only attribution signal is the host editor's `vscode.env.appName`. If the
 * heuristic silently breaks (e.g. Microsoft ships a new official build name,
 * or a fork rebrands), telemetry dashboards skew and we lose the ability to
 * tell where installs are coming from.
 *
 * These tests pin the exhaustive list of editor names we recognize today.
 * Failure means the allowlist needs an update — check the
 * MICROSOFT_EDITOR_NAMES constant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vscode is unavailable in unit tests — stub the surface that
// mixpanelService.ts touches at module load.
// Issue #355 (2026-06-07) — the telemetry gate reads
// `vscode.env.isTelemetryEnabled`. The mock module exposes a mutable
// flag via `vi.hoisted` so each test can flip it without re-mocking.
// Default `true` so existing tests don't have to opt in.
const vscodeMock = vi.hoisted(() => ({
    env: {
        machineId: 'test-machine',
        sessionId: 'test-session',
        appName: 'Visual Studio Code',
        uriScheme: 'vscode',
        isTelemetryEnabled: true as boolean,
    },
    version: '1.0.0',
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));
vi.mock('vscode', () => vscodeMock);

import { classifyEditorContext, MICROSOFT_EDITOR_NAMES, MixpanelService } from '../mixpanelService';

describe('classifyEditorContext (Issue 369 / ADR-016)', () => {
    describe('Microsoft editors → marketplace', () => {
        const microsoftCases: Array<[string, string]> = [
            ['Visual Studio Code', 'vscode'],
            ['Visual Studio Code - Insiders', 'vscode-insiders'],
            ['Visual Studio Code - Exploration', 'vscode-exploration'],
        ];
        for (const [appName, scheme] of microsoftCases) {
            it(`recognizes "${appName}" as marketplace`, () => {
                const ctx = classifyEditorContext(appName, scheme, undefined);
                expect(ctx.editor).toBe(appName);
                expect(ctx.editor_distribution).toBe('marketplace');
                expect(ctx.is_open_vsx).toBe(false);
            });
        }
    });

    describe('Forks + open-source rebuilds → openvsx', () => {
        const openVsxCases: Array<[string, string]> = [
            ['VSCodium', 'vscodium'],
            ['Cursor', 'cursor'],
            ['Windsurf', 'windsurf'],
            ['Trae', 'trae'],
            ['Antigravity', 'antigravity'],
            ['Codium', 'codium'],
            // Any other fork that hasn't shipped yet
            ['SomeFutureForkedEditor', 'futurescheme'],
        ];
        for (const [appName, scheme] of openVsxCases) {
            it(`classifies "${appName}" as openvsx`, () => {
                const ctx = classifyEditorContext(appName, scheme, undefined);
                expect(ctx.editor).toBe(appName);
                expect(ctx.editor_distribution).toBe('openvsx');
                expect(ctx.is_open_vsx).toBe(true);
            });
        }
    });

    describe('Edge cases', () => {
        it('handles undefined appName gracefully', () => {
            const ctx = classifyEditorContext(undefined, undefined, undefined);
            expect(ctx.editor).toBe('unknown');
            // Unknown is treated as openvsx (safer for attribution: at-most-undercount marketplace).
            expect(ctx.editor_distribution).toBe('openvsx');
        });

        it('defaults editor_uri_scheme to "vscode" when missing', () => {
            const ctx = classifyEditorContext('Cursor', undefined, undefined);
            expect(ctx.editor_uri_scheme).toBe('vscode');
        });

        it('marks remote-mode workspaces correctly', () => {
            const wsl = classifyEditorContext('Visual Studio Code', 'vscode', 'wsl');
            expect(wsl.is_remote).toBe(true);
            expect(wsl.remote_kind).toBe('wsl');

            const local = classifyEditorContext('Visual Studio Code', 'vscode', undefined);
            expect(local.is_remote).toBe(false);
            expect(local.remote_kind).toBeNull();
        });
    });

    describe('MICROSOFT_EDITOR_NAMES allowlist invariants', () => {
        it('contains exactly the 3 known Microsoft variants (any addition requires ADR update)', () => {
            // This test exists to force a deliberate decision when extending the
            // allowlist. If it fails, update both the constant AND ADR-016.
            expect(MICROSOFT_EDITOR_NAMES.size).toBe(3);
            expect(MICROSOFT_EDITOR_NAMES.has('Visual Studio Code')).toBe(true);
            expect(MICROSOFT_EDITOR_NAMES.has('Visual Studio Code - Insiders')).toBe(true);
            expect(MICROSOFT_EDITOR_NAMES.has('Visual Studio Code - Exploration')).toBe(true);
        });

        it('does not include known forks', () => {
            // Sanity check — protects against accidental additions during refactors.
            for (const fork of ['Cursor', 'Windsurf', 'VSCodium', 'Trae', 'Antigravity']) {
                expect(MICROSOFT_EDITOR_NAMES.has(fork)).toBe(false);
            }
        });
    });
});

/**
 * Mixpanel HTTP envelope tests. The vendor swapped from Amplitude → Mixpanel;
 * the public `track()` API is unchanged but the wire shape moved from
 * `{api_key, events:[{event_type, event_properties, user_properties}]}` to
 * `[{event, properties:{token, distinct_id, $device_id, $insert_id, time}}]`.
 * These tests pin the new shape via a `fetch` mock so future refactors can't
 * silently revert the swap.
 */
describe('MixpanelService — Mixpanel HTTP envelope', () => {
    const realFetch = (globalThis as any).fetch;
    let captured: { url: string; init: any } | null = null;
    let captures: { url: string; init: any }[] = [];

    beforeEach(() => {
        captured = null;
        captures = [];
        (globalThis as any).fetch = (url: string, init: any) => {
            captured = { url, init };
            captures.push({ url, init });
            // Resolve with a synthetic 200 OK so `await fetch` doesn't block.
            return Promise.resolve({
                status: 200,
                text: () => Promise.resolve('1'),
            } as any);
        };
    });

    afterEach(() => {
        (globalThis as any).fetch = realFetch;
    });

    it('POSTs to api.mixpanel.com/track (US region) with JSON array body', async () => {
        const svc = new MixpanelService();
        svc.track('test_event', { foo: 'bar' });
        // `track()` returns void; the underlying `send()` is fire-and-forget.
        // Yield to the microtask queue so the promise resolves.
        await new Promise((r) => setImmediate(r));
        expect(captured).not.toBeNull();
        expect(captured!.url).toContain('api.mixpanel.com/track');
        expect(captured!.init.method).toBe('POST');
        expect(captured!.init.headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(captured!.init.body);
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(1);
    });

    it('envelope has `event` (not `event_type`)', async () => {
        const svc = new MixpanelService();
        svc.track('envelope_check', { k: 'v' });
        await new Promise((r) => setImmediate(r));
        const ev = JSON.parse(captured!.init.body)[0];
        expect(ev.event).toBe('envelope_check');
        expect(ev.event_type).toBeUndefined();
    });

    it('properties carry token, distinct_id, $device_id, $insert_id, and time-in-seconds', async () => {
        const svc = new MixpanelService();
        svc.track('props_check');
        await new Promise((r) => setImmediate(r));
        const p = JSON.parse(captured!.init.body)[0].properties;
        expect(typeof p.token).toBe('string');
        expect(p.token.length).toBeGreaterThan(10);
        expect(typeof p.distinct_id).toBe('string');
        // vscode mock at the top of this file sets machineId = 'test-machine'
        expect(p.$device_id).toBe('test-machine');
        expect(typeof p.$insert_id).toBe('string');
        expect(p.$insert_id.length).toBeGreaterThan(0);
        // seconds since epoch, not ms
        expect(p.time).toBeLessThan(2_000_000_000);
    });

    it('custom event properties are merged inline into properties (no nested event_properties)', async () => {
        const svc = new MixpanelService();
        svc.track('inline_check', { foo: 'bar', n: 42 });
        await new Promise((r) => setImmediate(r));
        const ev = JSON.parse(captured!.init.body)[0];
        expect(ev.event_properties).toBeUndefined();
        expect(ev.properties.foo).toBe('bar');
        expect(ev.properties.n).toBe(42);
    });

    // Issue #355 (2026-06-07) — VS Code's user-level telemetry preference.
    // When `vscode.env.isTelemetryEnabled` is false the gate at the top of
    // `track()` returns before the fetch, so no network call happens.
    it('Issue #355: skips the fetch when vscode.env.isTelemetryEnabled is false', async () => {
        vscodeMock.env.isTelemetryEnabled = false;
        try {
            const svc = new MixpanelService();
            svc.track('should_not_fire');
            await new Promise((r) => setImmediate(r));
            expect(captured, 'fetch must not be called when telemetry is off').toBeNull();
        } finally {
            vscodeMock.env.isTelemetryEnabled = true;
        }
    });

    it('Issue #355: resumes tracking when isTelemetryEnabled flips back to true', async () => {
        vscodeMock.env.isTelemetryEnabled = false;
        const svc = new MixpanelService();
        svc.track('blocked');
        await new Promise((r) => setImmediate(r));
        expect(captured).toBeNull();
        vscodeMock.env.isTelemetryEnabled = true;
        svc.track('allowed');
        await new Promise((r) => setImmediate(r));
        expect(captured).not.toBeNull();
        expect(JSON.parse(captured!.init.body)[0].event).toBe('allowed');
    });

    it('editor context (editor, editor_distribution, is_open_vsx) lands inline on properties', async () => {
        const svc = new MixpanelService();
        svc.track('editor_check');
        await new Promise((r) => setImmediate(r));
        const p = JSON.parse(captured!.init.body)[0].properties;
        expect(p.editor).toBe('Visual Studio Code');
        expect(p.editor_distribution).toBe('marketplace');
        expect(p.is_open_vsx).toBe(false);
    });

    it('signed-in user_id becomes distinct_id; anonymous distinct_id falls back to $device_id', async () => {
        // Anonymous baseline first.
        const anon = new MixpanelService();
        anon.track('anon_check');
        await new Promise((r) => setImmediate(r));
        const anonProps = JSON.parse(captured!.init.body)[0].properties;
        expect(anonProps.distinct_id).toBe(anonProps.$device_id);

        // Now sign in — setUser must emit a `$identify` merge (device → user).
        captures.length = 0;
        const signedIn = new MixpanelService();
        signedIn.setUser({
            userId: 'user-42',
            email: 'test@example.com',
            firstName: 'Test',
        } as any);
        signedIn.track('signed_in_check');
        await new Promise((r) => setImmediate(r));

        const events = captures.map((c) => JSON.parse(c.init.body)[0]);
        // Identity merge: the anonymous device id is stitched into the Clerk user id.
        const identify = events.find((e) => e.event === '$identify');
        expect(identify, 'setUser should emit a $identify merge').toBeTruthy();
        expect(identify.properties.$identified_id).toBe('user-42');
        expect(identify.properties.$anon_id).toBe('test-machine');

        // Subsequent events use the user id as the primary distinct_id, device retained.
        const tracked = events.find((e) => e.event === 'signed_in_check');
        expect(tracked.properties.distinct_id).toBe('user-42');
        expect(tracked.properties.$device_id).toBe('test-machine');
        expect(tracked.properties.email).toBe('test@example.com');
        expect(tracked.properties.first_name).toBe('Test');
    });

    it('signed-out setUser(null) does NOT emit a $identify event', async () => {
        const svc = new MixpanelService();
        svc.setUser(null);
        await new Promise((r) => setImmediate(r));
        expect(captures.some((c) => JSON.parse(c.init.body)[0].event === '$identify')).toBe(false);
    });

    it('session lifecycle was moved off the editor — heartbeat/session methods are gone', () => {
        const svc = new MixpanelService() as any;
        // Removed with the 2026-08 move of sessions to the web dashboard.
        expect(svc.endSession).toBeUndefined();
        expect(svc.startSession).toBeUndefined();
    });
});

/**
 * Audit S9 (2026-10-03) — environment opt-out must silence the extension host,
 * not just Sentry and the MCP server.
 *
 * Before this, `mixpanelService.ts` checked only `vscode.env.isTelemetryEnabled`
 * while the other two surfaces honoured `CODEATLAS_TELEMETRY` and
 * `DO_NOT_TRACK`. A user setting DO_NOT_TRACK=1 was silenced on two of three
 * surfaces, which made the claim in PRIVACY.md false. These tests fail against
 * the old behaviour.
 */
describe('MixpanelService — environment opt-out (audit S9)', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        vscodeMock.env.isTelemetryEnabled = true;
        saved.CODEATLAS_TELEMETRY = process.env.CODEATLAS_TELEMETRY;
        saved.DO_NOT_TRACK = process.env.DO_NOT_TRACK;
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
        fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '1' });
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        vi.unstubAllGlobals();
    });

    it('sends when neither opt-out signal is set (control)', async () => {
        new MixpanelService('9.9.9').track('test_event');
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    });

    for (const value of ['0', 'false', 'off', 'no']) {
        it(`sends nothing when CODEATLAS_TELEMETRY=${value}`, async () => {
            process.env.CODEATLAS_TELEMETRY = value;
            new MixpanelService('9.9.9').track('test_event');
            await new Promise((r) => setTimeout(r, 20));
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    }

    it('sends nothing when DO_NOT_TRACK=1', async () => {
        process.env.DO_NOT_TRACK = '1';
        new MixpanelService('9.9.9').track('test_event');
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('opts out even when the VS Code setting permits telemetry', async () => {
        vscodeMock.env.isTelemetryEnabled = true;
        process.env.DO_NOT_TRACK = '1';
        new MixpanelService('9.9.9').track('test_event');
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('suppresses the $identify stitch too, not only track()', async () => {
        process.env.DO_NOT_TRACK = '1';
        const svc = new MixpanelService('9.9.9');
        svc.setUser({ userId: 'u1', email: 'a@b.c', token: 't', verifiedAt: 0 } as never);
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
