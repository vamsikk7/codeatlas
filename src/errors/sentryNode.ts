/**
 * sentryNode.ts — Issue #724 error tracking shim (extension host + MCP standalone).
 *
 * The deterministic system here is:
 *   1. Read the DSN from `CODEATLAS_SENTRY_DSN` (injected by esbuild
 *      `define` at build time — mirrors the Mixpanel token pattern).
 *   2. Honor `CODEATLAS_TELEMETRY=0` and `DO_NOT_TRACK=1` — when either
 *      is set, `initSentry()` is a no-op even if a DSN exists. One
 *      environment switch, both consequences.
 *   3. Dynamic-import `@sentry/node` so the shim ships even when the
 *      SDK isn't installed yet. When the user runs `npm install
 *      @sentry/node` and rebuilds, the SDK loads automatically; no code
 *      change required. Until then, every method is a no-op.
 *
 * Two entry points: `'extension'` (VS Code host) and `'mcp-standalone'`
 * (the @codeatlas/mcp bundle). Both report to ONE Sentry project tagged
 * by `event.tags.context` so a single dashboard separates them.
 *
 * Anonymous device id: reuses the same SHA-256(hostname+username+
 * node-version) Mixpanel computes, so usage events and error events
 * stitch in Sentry's UI without crossing the PII line.
 */

import * as crypto from 'crypto';
import * as os from 'os';

import { isTelemetryOptedOut } from '../lib/telemetryOptOut';

declare const CODEATLAS_SENTRY_DSN: string | undefined;

type SentryContext = 'extension' | 'mcp-standalone';

interface SentrySdk {
    init(opts: any): void;
    captureException(err: unknown, opts?: { extra?: Record<string, unknown> }): void;
    setUser(user: { id: string }): void;
    addEventProcessor(processor: (event: any) => any | null): void;
}

let sdk: SentrySdk | null = null;
let initialized = false;
let activeContext: SentryContext | null = null;

function isOptedOut(): boolean {
    // Audit S9 — shared with mcpAnalytics.ts and mixpanelService.ts so one
    // `DO_NOT_TRACK=1` silences every surface, not two of three.
    return isTelemetryOptedOut(process.env ?? {});
}

function getDsn(): string | null {
    try {
        // esbuild-injected at build time. `undefined` when the define
        // wasn't supplied (e.g. local dev builds without the secret).
        const injected = (typeof CODEATLAS_SENTRY_DSN !== 'undefined' ? CODEATLAS_SENTRY_DSN : '') ?? '';
        if (injected.length > 0) return injected;
    } catch { /* identifier not in scope — fall through */ }
    const fromEnv = process.env?.CODEATLAS_SENTRY_DSN;
    return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

function computeAnonymousId(): string {
    const seed = `${os.hostname()}::${os.userInfo().username}::${process.version}`;
    return crypto.createHash('sha256').update(seed).digest('hex');
}

/**
 * Drop noisy errors that aren't ours. Currently filters the Node v20
 * `ERR_INTERNAL_ASSERTION` race in `internalConnectMultipleTimeout`
 * (vitest test-cleanup quirk).
 */
function shouldDropEvent(event: any): boolean {
    const ex = event?.exception?.values?.[0];
    const msg: string = ex?.value ?? '';
    if (msg.includes('ERR_INTERNAL_ASSERTION') && msg.includes('internalConnectMultipleTimeout')) {
        return true;
    }
    return false;
}

/**
 * Initialize Sentry for the given context. Idempotent: subsequent calls
 * (e.g. re-activation in dev mode) are no-ops. Safe to call before the
 * SDK is installed — falls through silently.
 */
export function initSentry(context: SentryContext): void {
    if (initialized) return;
    initialized = true;
    activeContext = context;
    if (isOptedOut()) {
        // Telemetry off → leave sdk = null so all subsequent calls
        // short-circuit. Log nothing — opt-out is silent by design.
        return;
    }
    const dsn = getDsn();
    if (!dsn) return; // No DSN means dev build / fresh clone — no-op.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('@sentry/node') as SentrySdk | undefined;
        if (!mod || typeof mod.init !== 'function') return;
        sdk = mod;
        sdk.init({
            dsn,
            // Tag every event with the runtime context so a single project
            // dashboard can split extension vs mcp-standalone reports.
            initialScope: {
                tags: { context, codeatlas_runtime: process.version },
            },
            // Conservative sample rate — release builds, not dev — until
            // we measure noise volume.
            tracesSampleRate: 0.05,
            // Don't drown in the Node v20 vitest race.
            beforeSend: (event: any) => (shouldDropEvent(event) ? null : event),
        });
        sdk.addEventProcessor((event: any) => (shouldDropEvent(event) ? null : event));
        sdk.setUser({ id: computeAnonymousId() });
    } catch {
        // SDK not installed yet — every captureException becomes a no-op
        // until `npm install @sentry/node` runs. Acceptable for the
        // shim-ships-without-dep approach.
    }
}

/**
 * Report an exception to Sentry. No-ops cleanly when:
 *   - The SDK isn't installed yet, OR
 *   - `initSentry` was never called, OR
 *   - The user opted out of telemetry.
 *
 * Callers should NOT pre-stringify the error — pass the raw Error so
 * Sentry can extract the stack frame.
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
    if (!sdk) return;
    try {
        sdk.captureException(err, extra ? { extra } : undefined);
    } catch {
        // Any failure inside the reporting path stays internal — we
        // never let observability code break the actual feature.
    }
}

/**
 * Test-only accessor: returns the current context name once
 * `initSentry` has been called, or null otherwise. Used by the unit
 * tests to verify the activation path without exercising the network.
 */
export function _getActiveContextForTests(): SentryContext | null {
    return activeContext;
}

export function _resetForTests(): void {
    sdk = null;
    initialized = false;
    activeContext = null;
}
