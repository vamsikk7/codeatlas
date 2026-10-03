/**
 * mcpAnalytics.ts — Mixpanel event sink for the MCP standalone binary.
 *
 * v2 phase 8 (#723-followup) — adds opt-out telemetry to `@codeatlas/mcp`
 * so we can measure adoption + usage of the standalone npm distribution.
 *
 * Migrated from Amplitude to Mixpanel in the same cycle the extension's
 * sister sink moved over; the public API + on-the-wire shape are unchanged
 * from a caller's point of view.
 *
 * Design choices (locked at 2026-05-28):
 *   - Opt-OUT via `CODEATLAS_TELEMETRY=0|false|off|no` (also honours the
 *     industry-standard `DO_NOT_TRACK=1`). Default is ON.
 *   - Anonymous device_id = SHA-256(hostname + username + node version).
 *     Stable per machine; no PII leaves the process.
 *   - If the VS Code extension previously persisted a `user_id` at
 *     `~/.config/codeatlas/extension_user_id` we stitch MCP events to that
 *     user so the funnel covers both surfaces in one Mixpanel dashboard.
 *   - `event_source: 'mcp-standalone'` user property on every event so the
 *     extension funnel and the MCP funnel are filterable.
 *   - Best-effort fire-and-forget HTTP. Failures never block tool calls,
 *     never throw out of `track()`.
 *
 * Event catalogue (see mcp-server.ts + mcp-tools.ts for hook points):
 *   - mcp_install                  — first-ever run on this machine.
 *   - mcp_version_installed        — on install / upgrade / downgrade.
 *   - mcp_workspace_init_complete  — after the bootstrap finishes scanning.
 *   - mcp_browser_started          — when `--browser` mode boots.
 *   - mcp_tool_call_complete       — duration_ms + result_size_bytes.
 *   - mcp_tool_call_error          — truncated error message.
 *
 * Session lifecycle (mcp_server_boot / mcp_session_started / mcp_heartbeat /
 * mcp_session_ended) was REMOVED 2026-08 — a "session" now means the user
 * opened codeatlas.live, counted by the web dashboard, not that an MCP server
 * process started. Install/version + per-tool usage events are retained.
 *
 * The module deliberately does NOT depend on `vscode` — the standalone
 * runs under a plain Node process. The extension's `MixpanelService` is
 * the sibling surface (kept separate so extension events keep their
 * editor/distribution context properties).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { isTelemetryOptedOut } from '../../lib/telemetryOptOut';

// Mixpanel project token — build-time-injected via esbuild's `define`.
// CI provisions `CODEATLAS_MIXPANEL_TOKEN` for official releases. There is
// deliberately NO fallback token in source -- a build from a clone or a
// fork has an empty token and `flush()` returns before any HTTP call.
const MIXPANEL_TOKEN = process.env.CODEATLAS_MIXPANEL_TOKEN ?? '';
const MIXPANEL_TRACK_URL = 'https://api.mixpanel.com/track?verbose=1';

const FLUSH_INTERVAL_MS = 10_000;     // batched HTTP flush cadence
const FLUSH_MAX_BATCH = 25;            // batch size cap before forcing a flush
const ERROR_MSG_MAX_LEN = 500;         // truncate error messages so we don't
                                        // accidentally ship a stack trace

const STATE_DIR = path.join(os.homedir(), '.config', 'codeatlas');
const INSTALL_ID_FILE = path.join(STATE_DIR, 'mcp_install_id');
const LAST_VERSION_FILE = path.join(STATE_DIR, 'mcp_last_version');
const EXTENSION_USER_ID_FILE = path.join(STATE_DIR, 'extension_user_id');

/**
 * Mixpanel `/track` event shape. Mixpanel uses a single flat
 * `properties` object — no separate `event_properties` / `user_properties`
 * split like Amplitude. Profile-style fields (`event_source`,
 * `mcp_server_version`, …) are inlined into `properties` so segmentation
 * in Mixpanel works without a separate `/engage` call.
 *
 * `$`-prefixed properties are Mixpanel-reserved special meanings:
 *   `$device_id` — anonymous device identifier
 *   `$insert_id` — dedup key (retries don't double-count)
 *   `$session_id` — session correlator (Mixpanel renders session length
 *                   automatically when present)
 */
interface MixpanelEvent {
    event: string;
    properties: {
        token: string;
        distinct_id: string;
        $device_id: string;
        $insert_id: string;
        /** seconds since epoch — Mixpanel `/track` convention. */
        time: number;
        $session_id?: number;
        [key: string]: unknown;
    };
}

/**
 * Read `CODEATLAS_TELEMETRY` (with sensible aliases) plus the
 * industry-standard `DO_NOT_TRACK` opt-out signal.
 *
 * Audit S9 — delegates to the one shared predicate so this surface cannot
 * drift from the extension host's and Sentry's.
 */
function isTelemetryDisabled(): boolean {
    return isTelemetryOptedOut(process.env);
}

/**
 * SHA-256 over hostname + username + node version. The MCP server has no
 * login flow; we need a stable but anonymous identifier so per-user funnels
 * + retention curves work in Mixpanel (it becomes the event's `distinct_id`
 * and `$device_id`).
 */
function computeDeviceId(): string {
    const seed = [
        os.hostname() ?? 'unknown-host',
        (() => { try { return os.userInfo().username; } catch { return 'unknown-user'; } })(),
        process.version,
    ].join('|');
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

/**
 * If the VS Code extension persisted a `user_id` (e.g. after the user
 * signed into Clerk in the extension), pick it up so MCP events stitch
 * with extension events. Best-effort — fails closed to anonymous.
 */
function readExtensionUserId(homeDir: string = os.homedir()): string | undefined {
    // Primary: the standalone Clerk session (`~/.codeatlas/session.json`, written
    // by StandaloneClerkAuth) — so MCP events stitch onto the signed-in user's
    // Mixpanel profile, the same identity the extension + dashboard merge to.
    // (The legacy `extension_user_id` flag file below was never written by any
    // code path — the extension keeps its session in VS Code globalState — so it
    // always fell through to anonymous. Kept only as a defensive fallback.)
    // `homeDir` is injectable for tests (the module captures os.homedir() at load
    // for other constants, so it can't be spied post-import).
    try {
        const sessionFile = path.join(homeDir, '.codeatlas', 'session.json');
        if (fs.existsSync(sessionFile)) {
            const parsed = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
            const uid = parsed?.userId;
            if (typeof uid === 'string' && uid.length > 0 && uid.length < 200) return uid;
        }
    } catch { /* fall through to legacy flag file */ }
    try {
        if (!fs.existsSync(EXTENSION_USER_ID_FILE)) return undefined;
        const raw = fs.readFileSync(EXTENSION_USER_ID_FILE, 'utf-8').trim();
        return raw.length > 0 && raw.length < 200 ? raw : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Returns `{ isFirstRun, installId }`. On first run, creates the install-id
 * flag file so subsequent runs know they're not the first one. The install
 * id is the same as the device id (a per-machine SHA), but the *flag file*
 * is what tells us whether this binary has ever booted on this machine.
 */
function detectAndStampInstall(deviceId: string): { isFirstRun: boolean; installId: string } {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        if (fs.existsSync(INSTALL_ID_FILE)) {
            const installId = fs.readFileSync(INSTALL_ID_FILE, 'utf-8').trim();
            return { isFirstRun: false, installId: installId || deviceId };
        }
        fs.writeFileSync(INSTALL_ID_FILE, deviceId, 'utf-8');
        return { isFirstRun: true, installId: deviceId };
    } catch {
        // File system blocked (e.g. read-only homedir) — treat as first run
        // each time. Better to overcount installs than to undercount.
        return { isFirstRun: true, installId: deviceId };
    }
}

/**
 * Returns `{ isVersionChange, previousVersion }`. Compares the current
 * `mcpServerVersion` against the version recorded the last time this
 * helper ran on this machine, and rewrites the file so the next boot
 * sees the new version as the baseline. Used to fire
 * `mcp_version_installed` on every fresh install AND every upgrade /
 * downgrade — the install funnel cares about "did the user actually
 * pull a new bundle?" not just "is this the first run ever?".
 *
 * Failure mode: when the state dir can't be written (read-only homedir,
 * permission issue, etc.), we report `isVersionChange = true` so the
 * event still fires on every boot — better to overcount upgrades than
 * to silently swallow a real version change.
 */
function detectAndStampVersion(currentVersion: string): { isVersionChange: boolean; previousVersion: string | null } {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        let previousVersion: string | null = null;
        if (fs.existsSync(LAST_VERSION_FILE)) {
            const raw = fs.readFileSync(LAST_VERSION_FILE, 'utf-8').trim();
            previousVersion = raw.length > 0 && raw.length < 100 ? raw : null;
        }
        if (previousVersion === currentVersion) {
            return { isVersionChange: false, previousVersion };
        }
        fs.writeFileSync(LAST_VERSION_FILE, currentVersion, 'utf-8');
        return { isVersionChange: true, previousVersion };
    } catch {
        return { isVersionChange: true, previousVersion: null };
    }
}

export interface McpAnalyticsContext {
    /** Semver of the bundled mcp-server binary. */
    mcpServerVersion: string;
    /** Hashed workspace root (no path content leaves the process). */
    workspaceHash: string;
    /** Storage dir name — `.codeatlas-sa` or `.codeatlas`. */
    storageDir: string;
    /** Whether `--browser` is enabled. */
    browserMode: boolean;
    /** Whether `--read-only` is enabled. */
    readOnly: boolean;
}

export class McpAnalytics {
    private readonly disabled: boolean;
    private readonly deviceId: string;
    private readonly userId: string | undefined;
    private readonly sessionId: number;
    private readonly installId: string;
    private readonly isFirstRun: boolean;
    private readonly isVersionChange: boolean;
    private readonly previousVersion: string | null;
    private readonly ctx: McpAnalyticsContext;
    private readonly queue: MixpanelEvent[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    /** Public for tests so they can introspect the in-flight queue. */
    readonly _testHooks = {
        getQueue: () => this.queue.slice(),
    };

    constructor(ctx: McpAnalyticsContext) {
        this.disabled = isTelemetryDisabled();
        this.ctx = ctx;
        this.deviceId = computeDeviceId();
        this.userId = readExtensionUserId();
        this.sessionId = Date.now();
        const stamp = detectAndStampInstall(this.deviceId);
        this.installId = stamp.installId;
        this.isFirstRun = stamp.isFirstRun;
        const versionStamp = detectAndStampVersion(ctx.mcpServerVersion);
        this.isVersionChange = versionStamp.isVersionChange;
        this.previousVersion = versionStamp.previousVersion;
    }

    /**
     * Whether telemetry is active. `false` when the user opted out via
     * `CODEATLAS_TELEMETRY=0|false|off|no` or `DO_NOT_TRACK`. Callers use this
     * to print an ACCURATE boot notice (the notice must not claim "telemetry is
     * on" when the flag disabled it).
     */
    get enabled(): boolean {
        return !this.disabled;
    }

    /**
     * Called once at the top of `runServer`. Emits `mcp_install` on the
     * first-ever run and `mcp_version_installed` on a version change. Does NOT
     * emit a per-boot/session event — sessions are counted on the dashboard.
     */
    start(): void {
        if (this.disabled) return;
        if (this.isFirstRun) {
            this.track('mcp_install', { install_id: this.installId });
        }
        // Fires on first install AND every upgrade/downgrade. `kind` lets
        // Amplitude segments distinguish "new user" vs "existing user
        // pulled a new bundle" without crawling each user's history.
        if (this.isVersionChange) {
            this.track('mcp_version_installed', {
                install_id: this.installId,
                new_version: this.ctx.mcpServerVersion,
                previous_version: this.previousVersion ?? null,
                kind: this.previousVersion === null
                    ? 'initial'
                    : compareSemver(this.ctx.mcpServerVersion, this.previousVersion) > 0
                        ? 'upgrade'
                        : 'downgrade',
            });
        }
        // Session lifecycle (mcp_server_boot / mcp_session_started / mcp_heartbeat
        // / mcp_session_ended) was removed 2026-08: a "session" now means the user
        // opened codeatlas.live, counted by the dashboard's mixpanel-provider — not
        // that an editor or MCP server process started. Install/version-change
        // funnel events + per-tool usage events are retained.
        this.flushTimer = setInterval(() => this.flush().catch(() => { /* swallow */ }), FLUSH_INTERVAL_MS);
        // Keep the loop unblocked — Node won't exit while a non-unref'd timer is alive.
        this.flushTimer.unref?.();
    }

    /**
     * Best-effort event capture. Adds context properties, pushes onto the
     * queue, and forces a flush when the batch is full. Never throws.
     */
    track(eventType: string, properties: Record<string, unknown> = {}): void {
        if (this.disabled) return;
        try {
            // Mixpanel uses one flat `properties` object. Profile-style
            // fields (`event_source`, `mcp_server_version`, …) are inlined
            // so segments work without a separate `/engage` call. The
            // extension's `userId` (when present) becomes `distinct_id`;
            // anonymous boots fall back to the device hash so retention
            // curves still work.
            const event: MixpanelEvent = {
                event: eventType,
                properties: {
                    token: MIXPANEL_TOKEN,
                    distinct_id: this.userId ?? this.deviceId,
                    $device_id: this.deviceId,
                    $insert_id: crypto.randomBytes(12).toString('hex'),
                    time: Math.floor(Date.now() / 1000),
                    $session_id: this.sessionId,
                    event_source: 'mcp-standalone',
                    mcp_server_version: this.ctx.mcpServerVersion,
                    node_version: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    ...this.contextProperties(),
                    ...properties,
                },
            };
            this.queue.push(event);
            if (this.queue.length >= FLUSH_MAX_BATCH) {
                this.flush().catch(() => { /* swallow */ });
            }
        } catch {
            // Telemetry must never throw out of a tool call.
        }
    }

    /**
     * Called at the end of a tool/call. Records duration, result size, and
     * error state. The actual result content never leaves the process.
     */
    trackToolCall(opts: {
        name: string;
        startMs: number;
        endMs: number;
        resultSizeBytes?: number;
        isError?: boolean;
        errorMessage?: string;
    }): void {
        if (this.disabled) return;
        const duration_ms = Math.max(0, opts.endMs - opts.startMs);
        if (opts.isError) {
            this.track('mcp_tool_call_error', {
                tool_name: opts.name,
                duration_ms,
                error_message: truncate(opts.errorMessage ?? '(no message)', ERROR_MSG_MAX_LEN),
            });
        } else {
            this.track('mcp_tool_call_complete', {
                tool_name: opts.name,
                duration_ms,
                result_size_bytes: opts.resultSizeBytes ?? 0,
            });
        }
    }

    /**
     * Drain the in-memory queue to Mixpanel. The HTTP request is fire-
     * and-forget; we don't surface failures because the user has no way
     * to act on them. Called periodically and on shutdown.
     *
     * Body shape: bare JSON array of events (Mixpanel `/track?verbose=1`
     * convention). The project token is embedded in each event's
     * `properties.token` so there's no top-level credential like
     * Amplitude's `api_key`.
     */
    async flush(): Promise<void> {
        if (this.disabled) return;
        // No token provisioned (any build from source) -- drop the queue
        // rather than POSTing events Mixpanel would reject anyway.
        if (!MIXPANEL_TOKEN || MIXPANEL_TOKEN === '__no_telemetry_key__') {
            this.queue.length = 0;
            return;
        }
        if (this.queue.length === 0) return;
        const batch = this.queue.splice(0, this.queue.length);
        const debug = process.env.CODEATLAS_TELEMETRY_DEBUG === '1';
        if (debug) {
            // `process.stderr` (not stdout) so the log doesn't mix into the
            // MCP stdio protocol when running as a Claude Desktop child.
            // Mirrors the extension's `mixpanelService.ts` debug pattern.
            for (const ev of batch) {
                process.stderr.write(`[CodeAtlas telemetry] sending: ${ev.event} (props=${Object.keys(ev.properties).length})\n`);
            }
        }
        try {
            // postJson logs its own HTTP status + response body when
            // CODEATLAS_TELEMETRY_DEBUG=1 — see its implementation. We
            // just need to swallow exceptions here.
            await postJson(MIXPANEL_TRACK_URL, batch);
        } catch {
            // Silently swallow — telemetry must never block tool calls.
            // The debug branch above already logged the failure detail.
        }
    }

    /**
     * Called on process exit. Forces a final flush of any queued usage events
     * (tool calls, init) via the same async post. No `mcp_session_ended` event —
     * session lifecycle is the dashboard's responsibility now.
     */
    async shutdown(): Promise<void> {
        if (this.disabled) return;
        if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
        await this.flush();
    }

    private contextProperties(): Record<string, unknown> {
        return {
            mcp_server_version: this.ctx.mcpServerVersion,
            workspace_hash: this.ctx.workspaceHash,
            storage_dir: this.ctx.storageDir,
            browser_mode: this.ctx.browserMode,
            read_only: this.ctx.readOnly,
        };
    }
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Compare two SEMVER-ish strings (`MAJOR.MINOR.PATCH`, with optional
 * pre-release tail). Returns `1` when `a > b`, `-1` when `a < b`, `0`
 * when equal. Non-numeric segments fall back to string compare so a
 * `dev` build sorts deterministically against a real release without
 * panicking. Used only to label `mcp_version_installed.kind` as
 * `'upgrade'` vs `'downgrade'`; the comparison is best-effort —
 * mis-labelling a build doesn't affect any other code path.
 */
function compareSemver(a: string, b: string): number {
    const partsA = a.split('-')[0].split('.').map((s) => Number.parseInt(s, 10));
    const partsB = b.split('-')[0].split('.').map((s) => Number.parseInt(s, 10));
    const len = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < len; i++) {
        const av = Number.isFinite(partsA[i]) ? partsA[i] : 0;
        const bv = Number.isFinite(partsB[i]) ? partsB[i] : 0;
        if (av !== bv) return av > bv ? 1 : -1;
    }
    // Same numeric trunk — fall back to lexical compare so `dev` vs
    // `2.1.2` is deterministic.
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Hash a workspace root path so the funnel can group per-repo activity
 * without learning the actual path (which often contains usernames).
 */
export function hashWorkspaceRoot(absPath: string): string {
    return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

/**
 * POST JSON to a URL via native https (no axios dependency). Times out
 * after 5s so a stalled Mixpanel request can't keep the process alive.
 *
 * Debug mode: set `CODEATLAS_TELEMETRY_DEBUG=1` to log the event count
 * + HTTP status + response body to stderr. Useful when the funnel
 * shows "no events" and you need to confirm the binary is actually
 * sending (Mixpanel `/track?verbose=1` returns `{status:0, error:…}`
 * inside a 200 OK body for some misconfigurations — visible only via
 * the response body).
 */
function postJson(url: string, body: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(body), 'utf-8');
        const u = new URL(url);
        const debug = process.env.CODEATLAS_TELEMETRY_DEBUG === '1';
        if (debug) {
            const count = Array.isArray(body) ? body.length : 1;
            process.stderr.write(`[CodeAtlas telemetry] POST ${url} (${count} event${count === 1 ? '' : 's'}, ${data.length}B)\n`);
        }
        const req = https.request({
            method: 'POST',
            hostname: u.hostname,
            path: u.pathname + u.search,
            port: u.port ? Number(u.port) : 443,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data.length,
            },
            timeout: 5_000,
        }, (res) => {
            let buf = '';
            res.on('data', (chunk) => { if (debug) buf += chunk.toString(); else res.resume(); });
            res.on('end', () => {
                if (debug) {
                    process.stderr.write(`[CodeAtlas telemetry] HTTP ${res.statusCode} body=${buf.slice(0, 200)}\n`);
                }
                resolve();
            });
        });
        req.on('error', (err) => {
            if (debug) process.stderr.write(`[CodeAtlas telemetry] send failed: ${err.message}\n`);
            reject(err);
        });
        req.on('timeout', () => { req.destroy(new Error('mixpanel_request_timeout')); });
        req.write(data);
        req.end();
    });
}

// ── Exports for tests ─────────────────────────────────────────────────
export const _testInternals = {
    isTelemetryDisabled,
    computeDeviceId,
    detectAndStampInstall,
    detectAndStampVersion,
    compareSemver,
    truncate,
    LAST_VERSION_FILE,
    readExtensionUserId,
};
