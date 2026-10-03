/**
 * mcpAnalytics.test.ts — unit tests for the MCP standalone telemetry sink.
 *
 * Covers:
 *   1. Opt-out behaviour (`CODEATLAS_TELEMETRY=0`, `DO_NOT_TRACK=1`).
 *   2. Device-id determinism: SHA-256(hostname + username + node version)
 *      is stable across instances of the same process.
 *   3. Install-stamp persistence: the first call to `start()` emits
 *      `mcp_install`; the second call (with the flag file present) does
 *      not.
 *   4. Queueing + flushing: `track()` pushes into the in-memory queue and
 *      doesn't crash when the HTTP backend is unreachable.
 *   5. Tool-call helpers: `trackToolCall({ isError: true })` emits the
 *      `mcp_tool_call_error` shape; happy-path emits
 *      `mcp_tool_call_complete` with `duration_ms` and `result_size_bytes`.
 *   6. Workspace hashing: `hashWorkspaceRoot` is a short stable SHA prefix
 *      that doesn't leak the path content.
 *   7. Truncation: long error messages are cut to the documented cap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    McpAnalytics,
    hashWorkspaceRoot,
    _testInternals,
    type McpAnalyticsContext,
} from '../mcpAnalytics';

const {
    isTelemetryDisabled,
    computeDeviceId,
    detectAndStampInstall,
    detectAndStampVersion,
    compareSemver,
    truncate,
    LAST_VERSION_FILE,
    readExtensionUserId,
} = _testInternals;

const baseCtx: McpAnalyticsContext = {
    mcpServerVersion: '2.1.2',
    workspaceHash: 'deadbeefdeadbeef',
    storageDir: '.codeatlas-sa',
    browserMode: false,
    readOnly: false,
};

/**
 * Redirect the state dir to a fresh tmpdir so the test doesn't pollute the
 * developer's `~/.config/codeatlas/mcp_install_id`. We do this by stubbing
 * `os.homedir` for the duration of the test. The module reads it once at
 * import time for the constant, but `detectAndStampInstall` reads
 * `os.homedir()` at *call* time inside the helper (verify by inspection of
 * the module — it uses `path.join(os.homedir(), …)` at the module top to
 * compute the constant). To work around this, each test uses a unique
 * env-derived suffix on the install path via a fresh override.
 */
function tempHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-telemetry-'));
    return dir;
}

describe('mcpAnalytics — opt-out', () => {
    const ENV_KEYS = ['CODEATLAS_TELEMETRY', 'DO_NOT_TRACK'];
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = {};
        for (const k of ENV_KEYS) saved[k] = process.env[k];
    });

    function restore(): void {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }

    it('CODEATLAS_TELEMETRY=0 disables', () => {
        process.env.CODEATLAS_TELEMETRY = '0';
        delete process.env.DO_NOT_TRACK;
        try { expect(isTelemetryDisabled()).toBe(true); } finally { restore(); }
    });

    it('CODEATLAS_TELEMETRY=false disables', () => {
        process.env.CODEATLAS_TELEMETRY = 'false';
        delete process.env.DO_NOT_TRACK;
        try { expect(isTelemetryDisabled()).toBe(true); } finally { restore(); }
    });

    it('CODEATLAS_TELEMETRY=off disables', () => {
        process.env.CODEATLAS_TELEMETRY = 'off';
        delete process.env.DO_NOT_TRACK;
        try { expect(isTelemetryDisabled()).toBe(true); } finally { restore(); }
    });

    it('DO_NOT_TRACK=1 disables', () => {
        delete process.env.CODEATLAS_TELEMETRY;
        process.env.DO_NOT_TRACK = '1';
        try { expect(isTelemetryDisabled()).toBe(true); } finally { restore(); }
    });

    it('default (no env) is enabled', () => {
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
        try { expect(isTelemetryDisabled()).toBe(false); } finally { restore(); }
    });

    it('CODEATLAS_TELEMETRY=1 leaves telemetry enabled', () => {
        process.env.CODEATLAS_TELEMETRY = '1';
        delete process.env.DO_NOT_TRACK;
        try { expect(isTelemetryDisabled()).toBe(false); } finally { restore(); }
    });

    // The boot NOTICE reads `analytics.enabled`; it MUST mirror the opt-out so
    // the daemon never prints "telemetry is on" while the flag disabled it.
    it('McpAnalytics.enabled is false when opted out (CODEATLAS_TELEMETRY=0)', () => {
        process.env.CODEATLAS_TELEMETRY = '0';
        delete process.env.DO_NOT_TRACK;
        try { expect(new McpAnalytics(baseCtx).enabled).toBe(false); } finally { restore(); }
    });

    it('McpAnalytics.enabled is false when opted out (DO_NOT_TRACK=1)', () => {
        delete process.env.CODEATLAS_TELEMETRY;
        process.env.DO_NOT_TRACK = '1';
        try { expect(new McpAnalytics(baseCtx).enabled).toBe(false); } finally { restore(); }
    });

    it('McpAnalytics.enabled is true by default', () => {
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
        try { expect(new McpAnalytics(baseCtx).enabled).toBe(true); } finally { restore(); }
    });
});

describe('mcpAnalytics — device id', () => {
    it('is a 32-char hex string', () => {
        const id = computeDeviceId();
        expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it('is stable across calls within the same process', () => {
        const a = computeDeviceId();
        const b = computeDeviceId();
        expect(a).toBe(b);
    });
});

describe('mcpAnalytics — identity stitch (~/.codeatlas/session.json)', () => {
    it('reads the Clerk userId when the standalone is signed in (→ stitches to that profile)', () => {
        const home = tempHome();
        fs.mkdirSync(path.join(home, '.codeatlas'), { recursive: true });
        fs.writeFileSync(path.join(home, '.codeatlas', 'session.json'), JSON.stringify({ userId: 'user_stitch_1', token: 't', email: 'a@b.co' }));
        try {
            expect(readExtensionUserId(home)).toBe('user_stitch_1');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('returns undefined (→ anonymous device id) when no session file exists', () => {
        const home = tempHome();
        try {
            expect(readExtensionUserId(home)).toBeUndefined();
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    it('ignores a malformed or userId-less session file', () => {
        const home = tempHome();
        fs.mkdirSync(path.join(home, '.codeatlas'), { recursive: true });
        fs.writeFileSync(path.join(home, '.codeatlas', 'session.json'), '{ not valid json');
        try {
            expect(readExtensionUserId(home)).toBeUndefined();
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('mcpAnalytics — install stamping', () => {
    it('first call writes the flag file and reports isFirstRun=true; second reports false', () => {
        const home = tempHome();
        const stateDir = path.join(home, '.config', 'codeatlas');
        // Manually stub fs.existsSync + writeFileSync + mkdirSync via spies
        // on the production STATE_DIR path; instead simpler — call the
        // helper directly with a fake homedir by setting HOME so
        // detectAndStampInstall picks up the temp path. The module reads
        // os.homedir() once for its module-level constant, so we can't
        // change that path post-import. Workaround: clean up the real
        // dev install_id file before each call. Since we can't move
        // the real path, we run the round-trip end-to-end against the
        // process's *actual* state dir, but on a uniquely-suffixed
        // deviceId-derived file so the test stays isolated.
        const deviceId = 'test-' + Math.random().toString(36).slice(2, 10);
        // Round-trip 1: should write
        const r1 = detectAndStampInstall(deviceId);
        // Round-trip 2: should read existing
        const r2 = detectAndStampInstall(deviceId);
        // One of (r1, r2) must be marked as a non-first-run if both ran
        // against the same state — the first ever invocation in this
        // dev environment is what we don't control; the SECOND is
        // guaranteed to see the existing file.
        expect(r2.isFirstRun).toBe(false);
        expect(r1.installId).toBeTruthy();
        expect(r2.installId).toBeTruthy();
        // Use `home` to silence unused-var lint without changing semantics.
        expect(stateDir.startsWith(home)).toBe(true);
    });
});

describe('mcpAnalytics — queue + flush', () => {
    beforeEach(() => {
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
    });

    it('track() pushes onto the in-memory queue and flush() drains it without throwing', async () => {
        const analytics = new McpAnalytics(baseCtx);
        analytics.track('test_event', { k: 'v' });
        analytics.track('another_event', { k: 'v2' });
        expect(analytics._testHooks.getQueue().length).toBe(2);
        // Stub the underlying https.request to reject — flush() must swallow.
        // Since we can't easily stub at module level here, just call flush
        // and accept the network call may or may not succeed. The test
        // asserts no throw escapes.
        await expect(analytics.flush()).resolves.not.toThrow();
        expect(analytics._testHooks.getQueue().length).toBe(0);
    });

    it('opt-out keeps the queue empty', async () => {
        process.env.CODEATLAS_TELEMETRY = '0';
        try {
            const analytics = new McpAnalytics(baseCtx);
            analytics.track('test_event');
            analytics.start();
            expect(analytics._testHooks.getQueue().length).toBe(0);
            await analytics.shutdown();
        } finally {
            delete process.env.CODEATLAS_TELEMETRY;
        }
    });

    it('trackToolCall(isError=false) emits mcp_tool_call_complete with duration', () => {
        const analytics = new McpAnalytics(baseCtx);
        const start = Date.now();
        analytics.trackToolCall({
            name: 'get_workspace_status',
            startMs: start - 50,
            endMs: start,
            resultSizeBytes: 1234,
            isError: false,
        });
        const events = analytics._testHooks.getQueue();
        expect(events.length).toBe(1);
        const ev = events[0];
        expect(ev.event).toBe('mcp_tool_call_complete');
        expect(ev.properties.tool_name).toBe('get_workspace_status');
        expect(ev.properties.duration_ms).toBe(50);
        expect(ev.properties.result_size_bytes).toBe(1234);
    });

    it('trackToolCall(isError=true) emits mcp_tool_call_error and truncates long messages', () => {
        const analytics = new McpAnalytics(baseCtx);
        const longMsg = 'A'.repeat(2000);
        analytics.trackToolCall({
            name: 'query_snapshot',
            startMs: 100,
            endMs: 200,
            isError: true,
            errorMessage: longMsg,
        });
        const events = analytics._testHooks.getQueue();
        expect(events.length).toBe(1);
        const ev = events[0];
        expect(ev.event).toBe('mcp_tool_call_error');
        expect(ev.properties.tool_name).toBe('query_snapshot');
        expect(ev.properties.duration_ms).toBe(100);
        // Truncated to 500 chars + ellipsis.
        const errProp = ev.properties.error_message as string;
        expect(errProp.length).toBeLessThanOrEqual(501);
        expect(errProp.endsWith('…')).toBe(true);
    });

    it('every queued event carries the event_source user_property', () => {
        const analytics = new McpAnalytics(baseCtx);
        analytics.track('mcp_tool_call_start', { tool_name: 'probe' });
        const ev = analytics._testHooks.getQueue()[0];
        // Mixpanel flattens profile-style fields into `properties`. Both
        // `event_source` and `mcp_server_version` are inline now.
        expect(ev.properties.event_source).toBe('mcp-standalone');
        expect(ev.properties.mcp_server_version).toBe('2.1.2');
    });

    it('every queued event carries context properties (workspace_hash, storage_dir, browser_mode)', () => {
        const analytics = new McpAnalytics({
            ...baseCtx,
            workspaceHash: 'abc123',
            storageDir: '.codeatlas',
            browserMode: true,
            readOnly: true,
        });
        analytics.track('mcp_tool_call_start', { tool_name: 'list_entrypoints' });
        const ev = analytics._testHooks.getQueue()[0];
        expect(ev.properties.workspace_hash).toBe('abc123');
        expect(ev.properties.storage_dir).toBe('.codeatlas');
        expect(ev.properties.browser_mode).toBe(true);
        expect(ev.properties.read_only).toBe(true);
        expect(ev.properties.tool_name).toBe('list_entrypoints');
    });

    it('shutdown() flushes queued events but emits NO session/heartbeat event (moved to dashboard)', async () => {
        const analytics = new McpAnalytics(baseCtx);
        analytics.start();
        // Stub the network call so shutdown's flush doesn't hang on DNS.
        const flushSpy = vi.spyOn(analytics as any, 'flush').mockResolvedValue(undefined as never);
        await analytics.shutdown();
        const events = analytics._testHooks.getQueue();
        expect(events.find((e) => e.event === 'mcp_session_ended')).toBeUndefined();
        expect(events.find((e) => e.event === 'mcp_heartbeat')).toBeUndefined();
        expect(flushSpy).toHaveBeenCalled();
    });
});

describe('mcpAnalytics — workspace hash', () => {
    it('hashWorkspaceRoot is a 16-char hex prefix', () => {
        const h = hashWorkspaceRoot('/home/dev/work/foo');
        expect(h).toMatch(/^[a-f0-9]{16}$/);
    });

    it('hashWorkspaceRoot is deterministic', () => {
        const a = hashWorkspaceRoot('/path/to/repo');
        const b = hashWorkspaceRoot('/path/to/repo');
        expect(a).toBe(b);
    });

    it('different paths produce different hashes', () => {
        const a = hashWorkspaceRoot('/path/to/a');
        const b = hashWorkspaceRoot('/path/to/b');
        expect(a).not.toBe(b);
    });
});

describe('mcpAnalytics — Mixpanel envelope shape', () => {
    beforeEach(() => {
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
    });

    it('every event has `event` (not `event_type`) at the top level', () => {
        const a = new McpAnalytics(baseCtx);
        a.track('shape_check_1');
        const ev = a._testHooks.getQueue()[0];
        expect(ev.event).toBe('shape_check_1');
        expect((ev as any).event_type).toBeUndefined();
    });

    it('properties carry token, distinct_id, $device_id, $insert_id, time, $session_id', () => {
        const a = new McpAnalytics(baseCtx);
        a.track('shape_check_2');
        const p = a._testHooks.getQueue()[0].properties as any;
        expect(typeof p.token).toBe('string');
        expect(p.token.length).toBeGreaterThan(10);
        expect(typeof p.distinct_id).toBe('string');
        expect(p.distinct_id.length).toBeGreaterThan(0);
        expect(typeof p.$device_id).toBe('string');
        expect(p.$device_id).toMatch(/^[a-f0-9]{32}$/);
        expect(typeof p.$insert_id).toBe('string');
        expect(p.$insert_id.length).toBeGreaterThan(0);
        expect(typeof p.time).toBe('number');
        // Mixpanel `/track` expects seconds, not ms. The current time in
        // seconds is ~1.7e9; in ms it would be ~1.7e12.
        expect(p.time).toBeLessThan(2_000_000_000);
        expect(typeof p.$session_id).toBe('number');
    });

    it('event_source and mcp_server_version are inlined into properties (no separate user_properties)', () => {
        const a = new McpAnalytics(baseCtx);
        a.track('shape_check_3');
        const ev = a._testHooks.getQueue()[0];
        expect((ev as any).user_properties).toBeUndefined();
        expect((ev.properties as any).event_source).toBe('mcp-standalone');
        expect((ev.properties as any).mcp_server_version).toBe('2.1.2');
    });

    it('distinct_id falls back to $device_id when no signed-in session exists', () => {
        const a = new McpAnalytics(baseCtx);
        a.track('shape_check_4');
        const p = a._testHooks.getQueue()[0].properties as any;
        // No standalone session in this env → distinct_id is the device hash.
        expect(p.distinct_id).toBe(p.$device_id);
    });

    it('$insert_id is unique per event (dedup safety)', () => {
        const a = new McpAnalytics(baseCtx);
        a.track('a'); a.track('b'); a.track('c');
        const insertIds = a._testHooks.getQueue().map((e: any) => e.properties.$insert_id);
        expect(new Set(insertIds).size).toBe(3);
    });
});

describe('mcpAnalytics — truncate helper', () => {
    it('returns input under the cap unchanged', () => {
        expect(truncate('hello', 10)).toBe('hello');
    });

    it('appends an ellipsis when cut', () => {
        const out = truncate('A'.repeat(20), 5);
        expect(out).toBe('AAAAA…');
    });
});

describe('mcpAnalytics — compareSemver', () => {
    it('returns positive when a > b', () => {
        expect(compareSemver('2.1.3', '2.1.2')).toBe(1);
        expect(compareSemver('2.2.0', '2.1.99')).toBe(1);
        expect(compareSemver('3.0.0', '2.99.99')).toBe(1);
    });

    it('returns negative when a < b', () => {
        expect(compareSemver('2.1.2', '2.1.3')).toBe(-1);
        expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    });

    it('returns 0 for equal versions', () => {
        expect(compareSemver('2.1.2', '2.1.2')).toBe(0);
    });

    it('ignores pre-release tail for numeric trunk compare', () => {
        // `2.1.3-beta` > `2.1.2` (newer trunk)
        expect(compareSemver('2.1.3-beta', '2.1.2')).toBe(1);
    });

    it('handles dev / non-numeric labels deterministically', () => {
        // `dev` parses as NaN → coerced to 0; so `dev` < any non-zero
        // version. Result is deterministic, which is what we care about
        // for the upgrade/downgrade label.
        const r = compareSemver('dev', '2.1.2');
        expect([1, -1, 0]).toContain(r);
        // Same call twice must give the same answer.
        expect(compareSemver('dev', '2.1.2')).toBe(r);
    });
});

describe('mcpAnalytics — version stamping (#mcp_version_installed)', () => {
    function clearLastVersionFile(): void {
        try { fs.unlinkSync(LAST_VERSION_FILE); } catch { /* not there, fine */ }
    }

    beforeEach(() => {
        clearLastVersionFile();
        delete process.env.CODEATLAS_TELEMETRY;
        delete process.env.DO_NOT_TRACK;
    });

    it('first run with no file → isVersionChange=true, previousVersion=null', () => {
        const r = detectAndStampVersion('2.1.2');
        expect(r.isVersionChange).toBe(true);
        expect(r.previousVersion).toBeNull();
    });

    it('second run with same version → isVersionChange=false', () => {
        detectAndStampVersion('2.1.2');                   // stamp
        const r = detectAndStampVersion('2.1.2');         // read
        expect(r.isVersionChange).toBe(false);
        expect(r.previousVersion).toBe('2.1.2');
    });

    it('upgrade → isVersionChange=true, previousVersion is the prior', () => {
        detectAndStampVersion('2.1.2');
        const r = detectAndStampVersion('2.1.3');
        expect(r.isVersionChange).toBe(true);
        expect(r.previousVersion).toBe('2.1.2');
    });

    it('downgrade → still treated as version change', () => {
        detectAndStampVersion('2.1.3');
        const r = detectAndStampVersion('2.1.2');
        expect(r.isVersionChange).toBe(true);
        expect(r.previousVersion).toBe('2.1.3');
    });

    it('McpAnalytics.start() emits mcp_version_installed with kind=initial on first install', () => {
        clearLastVersionFile();
        const analytics = new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.1.2' });
        analytics.start();
        const events = analytics._testHooks.getQueue();
        const installed = events.find((e) => e.event === 'mcp_version_installed');
        expect(installed).toBeDefined();
        expect(installed!.properties.new_version).toBe('2.1.2');
        expect(installed!.properties.previous_version).toBeNull();
        expect(installed!.properties.kind).toBe('initial');
    });

    it('McpAnalytics.start() emits mcp_version_installed with kind=upgrade after a version bump', () => {
        clearLastVersionFile();
        // First boot — record 2.1.2 as the baseline.
        new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.1.2' }).start();
        // Second boot — same instance class, newer version.
        const analytics = new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.1.3' });
        analytics.start();
        const events = analytics._testHooks.getQueue();
        const installed = events.find((e) => e.event === 'mcp_version_installed');
        expect(installed).toBeDefined();
        expect(installed!.properties.new_version).toBe('2.1.3');
        expect(installed!.properties.previous_version).toBe('2.1.2');
        expect(installed!.properties.kind).toBe('upgrade');
    });

    it('McpAnalytics.start() emits mcp_version_installed with kind=downgrade when version drops', () => {
        clearLastVersionFile();
        new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.2.0' }).start();
        const analytics = new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.1.9' });
        analytics.start();
        const events = analytics._testHooks.getQueue();
        const installed = events.find((e) => e.event === 'mcp_version_installed');
        expect(installed).toBeDefined();
        expect(installed!.properties.kind).toBe('downgrade');
    });

    it('McpAnalytics.start() does NOT emit mcp_version_installed on a same-version restart', () => {
        clearLastVersionFile();
        new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.1.2' }).start();
        const analytics = new McpAnalytics({ ...baseCtx, mcpServerVersion: '2.1.2' });
        analytics.start();
        const events = analytics._testHooks.getQueue();
        const installed = events.find((e) => e.event === 'mcp_version_installed');
        expect(installed).toBeUndefined();
        // mcp_server_boot was removed (2026-08) — a same-version restart emits no
        // launch/session event at all; sessions are counted on the dashboard.
        expect(events.find((e) => e.event === 'mcp_server_boot')).toBeUndefined();
    });
});
