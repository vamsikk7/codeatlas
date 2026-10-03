/**
 * mixpanelService.ts — extension-side analytics sink.
 *
 * Mixpanel (US region, project token + project ID 3101163, project
 * timezone Asia/Kolkata). The public `track(eventType, properties)` API
 * is the single entry point all telemetry call sites flow through.
 *
 * Renamed 2026-06-07 from `amplitudeService.ts` to match the actual
 * vendor — the original Amplitude implementation was migrated some
 * cycles ago. Class is now `MixpanelService` (was `AmplitudeService`);
 * the exported singleton is still `analytics` so importers read
 * naturally: `import { analytics } from '../analytics/mixpanelService'`.
 *
 * Prior Amplitude history remains in that Amplitude project — it
 * does not get backfilled into Mixpanel.
 *
 * SECURITY: the project token below is a build-time-injected default.
 * Mixpanel project tokens are designed for client-side embedding —
 * they only authorize writes to the project, never reads. The API
 * secret (which authorizes reads via the data-export API) is NOT in
 * this bundle.
 *
 * Issue #355 (2026-06-07) — `track()` short-circuits when
 * `vscode.env.isTelemetryEnabled` is false, so users who set
 * `telemetry.telemetryLevel: "off"` in their VS Code settings see no
 * outbound network calls regardless of which event fired.
 */
import * as vscode from 'vscode';
import type { StoredSession } from '../auth/clerkAuthService';
import { isTelemetryOptedOut } from '../lib/telemetryOptOut';

// Build-time injected via esbuild's `define`. CI provisions
// `CODEATLAS_MIXPANEL_TOKEN`; local dev gets the no-op sentinel so
// engineering laptops don't pollute the production funnel.
const MIXPANEL_TOKEN = process.env.CODEATLAS_MIXPANEL_TOKEN ?? '';
const MIXPANEL_TRACK_URL = 'https://api.mixpanel.com/track?verbose=1';

/**
 * Mixpanel `/track` event shape. Everything (custom event properties,
 * user properties, identifiers, the project token, the timestamp) goes
 * into one flat `properties` object. The `$`-prefixed properties are
 * Mixpanel-reserved.
 */
interface MixpanelEvent {
    event: string;
    properties: {
        token: string;
        distinct_id: string;
        $device_id?: string;
        $insert_id?: string;
        /** seconds since epoch — Mixpanel `/track` convention. */
        time: number;
        [key: string]: unknown;
    };
}

/**
 * Editor + distribution-channel detection.
 *
 * The .vsix is binary-identical between MS Marketplace and Open VSX, so the
 * only way to attribute an event to a registry is to detect which editor
 * the extension is running inside. Every non-Microsoft editor in the VS
 * Code ecosystem (Cursor, Windsurf, VSCodium, Trae, Antigravity, Codium,
 * etc.) ships with Open VSX as its sole/default registry, so the editor
 * itself is a reliable channel proxy.
 *
 * Returns properties to merge into every Mixpanel event so you can filter
 * `editor`, `editor_distribution`, and `is_open_vsx` in the dashboard.
 */
/**
 * INVARIANT: this allowlist is the only signal CodeAtlas uses to attribute
 * an event to the Microsoft Marketplace channel. Everything else routes to
 * Open VSX. Bump this list when Microsoft ships a new official build (e.g.
 * a future `Visual Studio Code Web` desktop variant).
 *
 * See ADR-016 / Issue 369 — and the test in
 * `src/analytics/__tests__/mixpanelService.test.ts` pins the exhaustive
 * list of editor names we recognize today.
 */
export const MICROSOFT_EDITOR_NAMES: ReadonlySet<string> = new Set([
    'Visual Studio Code',
    'Visual Studio Code - Insiders',
    'Visual Studio Code - Exploration',
]);

export interface EditorContext {
    editor: string;
    editor_uri_scheme: string;
    editor_distribution: 'marketplace' | 'openvsx';
    is_open_vsx: boolean;
    is_remote: boolean;
    remote_kind: string | null;
}

/**
 * Pure function — given an editor's appName, uriScheme, and remoteName,
 * returns the analytics-context properties. Exported for unit testing
 * without needing to stub `vscode.env`.
 */
export function classifyEditorContext(
    appName: string | undefined,
    uriScheme: string | undefined,
    remoteName: string | undefined,
): EditorContext {
    const finalAppName = appName ?? 'unknown';
    const isMicrosoft = MICROSOFT_EDITOR_NAMES.has(finalAppName);
    return {
        editor: finalAppName,
        editor_uri_scheme: uriScheme ?? 'vscode',
        editor_distribution: isMicrosoft ? 'marketplace' : 'openvsx',
        is_open_vsx: !isMicrosoft,
        is_remote: !!remoteName,
        remote_kind: remoteName ?? null,
    };
}

function detectEditorContext(): EditorContext {
    return classifyEditorContext(
        vscode.env.appName,
        vscode.env.uriScheme,
        (vscode.env as any).remoteName as string | undefined,
    );
}

/**
 * Generate a 24-character hex `$insert_id` for Mixpanel deduplication.
 * Mixpanel's `/track` endpoint uses `$insert_id` to drop duplicate
 * events that arrive twice (e.g. after a retry); without one, a flaky
 * network could inflate counts. We use `Math.random()` rather than
 * `crypto.randomBytes` because this module runs in both the extension
 * host (Node) and would in principle be portable to a browser context;
 * the collision risk for 24-char hex is negligible.
 */
function insertId(): string {
    let id = '';
    while (id.length < 24) id += Math.floor(Math.random() * 0xffffffff).toString(16);
    return id.slice(0, 24);
}

export class MixpanelService {
    private user: StoredSession | null = null;
    private context: vscode.ExtensionContext | null = null;
    private extensionVersion: string = '0.1.0';

    setUser(user: StoredSession | null): void {
        this.user = user;
        // Identity merge (2026-08): make the signed-in Clerk user the primary
        // Mixpanel distinct_id and stitch the anonymous per-machine device id
        // into it via a `$identify` event. Without this, anonymous device
        // events and signed-in user events stay separate Mixpanel profiles.
        // Fire-and-forget, gated by the same telemetry preference as track().
        if (!user?.userId) return;
        if (isTelemetryOptedOut()) return;
        if (typeof vscode.env.isTelemetryEnabled === 'boolean' && !vscode.env.isTelemetryEnabled) return;
        const deviceId = vscode.env.machineId;
        if (user.userId === deviceId) return; // already the same id — nothing to merge
        this.send([{
            event: '$identify',
            properties: {
                token: MIXPANEL_TOKEN,
                distinct_id: user.userId,
                $identified_id: user.userId,
                $anon_id: deviceId,
                $insert_id: insertId(),
                time: Math.floor(Date.now() / 1000),
            },
        }]).catch(() => { /* fire-and-forget — analytics must never surface errors */ });
    }

    /**
     * Wire up the lifecycle context. Call once from extension `activate()`
     * with the ExtensionContext. Reads the version from package.json and
     * fires the install/update funnel event automatically (a plain re-launch
     * fires nothing — editor opens are not sessions).
     */
    initLifecycle(context: vscode.ExtensionContext): void {
        this.context = context;
        this.extensionVersion = context.extension.packageJSON.version ?? '0.0.0';
        this.fireLifecycleEvent();
    }

    // Session lifecycle (session_heartbeat / session_ended) moved to the web
    // dashboard (2026-08): a "session" now means the user opened codeatlas.live,
    // not that the editor is open. The editor no longer manufactures sessions
    // via a heartbeat — see the dashboard's components/mixpanel-provider.tsx.
    // `initLifecycle` fires ONLY the install/update funnel event now; a plain
    // relaunch (same version) fires nothing.

    /**
     * Detect install / update / launch from globalState and emit the
     * appropriate event. Runs before sign-in so it's attributed to
     * `$device_id` (the per-machine anonymous ID); a later signed_in event
     * lets you join the device to the user in Mixpanel via `$identify`.
     */
    private fireLifecycleEvent(): void {
        if (!this.context) return;
        const KEY = 'codeatlas.installedVersion';
        const previousVersion = this.context.globalState.get<string>(KEY);
        const currentVersion = this.extensionVersion;
        const FIRST_SEEN_KEY = 'codeatlas.firstSeenAt';

        // Install/update FUNNEL only. A plain re-launch (same version) fires NO
        // event — editor opens are not sessions. Sessions + heartbeat are counted
        // on codeatlas.live (dashboard components/mixpanel-provider.tsx), for both
        // the VSIX and the MCP standalone.
        let event_type: 'extension_installed' | 'extension_updated';
        const props: Record<string, unknown> = { current_version: currentVersion };

        if (!previousVersion) {
            event_type = 'extension_installed';
            void this.context.globalState.update(FIRST_SEEN_KEY, Date.now());
        } else if (previousVersion !== currentVersion) {
            event_type = 'extension_updated';
            props.previous_version = previousVersion;
        } else {
            return; // same version, plain relaunch — no session/launch event
        }
        void this.context.globalState.update(KEY, currentVersion);

        this.track(event_type, props);
    }

    track(eventType: string, properties?: Record<string, unknown>): void {
        // Issue #355 (2026-06-07) — respect VS Code's user-level
        // telemetry preference. `vscode.env.isTelemetryEnabled` is true
        // when the user has either set `telemetry.telemetryLevel` to
        // `all` / `error` / `crash` (anything ≠ `off`) AND no master
        // workspace opt-out is in effect. Anonymous device-id metrics
        // (`extension_installed`, etc.) and product analytics
        // (`github_connected`, `llm_consent_granted`, …) both flow
        // through this method, so a single gate at the top covers every
        // call site without per-call audits.
        if (typeof vscode.env.isTelemetryEnabled === 'boolean' && !vscode.env.isTelemetryEnabled) {
            return;
        }
        // Audit S9 (2026-10-03) — the VS Code setting above was previously the
        // ONLY gate here, while Sentry and the MCP server both honoured
        // `CODEATLAS_TELEMETRY=0` / `DO_NOT_TRACK=1`. A user who set either env
        // var was silenced on two surfaces out of three and had no way to know.
        // Same shared predicate as the other two now.
        if (isTelemetryOptedOut()) {
            return;
        }
        const user = this.user;
        const editorCtx = detectEditorContext();
        const deviceId = vscode.env.machineId;
        // Mixpanel's primary identifier is `distinct_id`. Convention: use
        // the signed-in user id when available, fall back to the anonymous
        // device id so anonymous and signed-in events from the same
        // machine can be joined later via `$identify`.
        const distinctId = user?.userId ?? deviceId;

        // Flat properties object — Mixpanel doesn't have a separate
        // `event_properties` / `user_properties` split like Amplitude
        // does. The `$set` prefix is reserved for profile updates which
        // we don't push from this code path today.
        const props: MixpanelEvent['properties'] = {
            token: MIXPANEL_TOKEN,
            distinct_id: distinctId,
            $device_id: deviceId,
            $insert_id: insertId(),
            time: Math.floor(Date.now() / 1000),
            vscode_version: vscode.version,
            platform: process.platform,
            arch: process.arch,
            extension_version: this.extensionVersion,
            ...editorCtx,
            ...properties,
        };

        // Carry `$user_id` alongside `$device_id` on identified events so the
        // anonymous↔user stitch works under Mixpanel's *Simplified* ID Merge
        // (which ignores the `$identify` event we also send for Original merge).
        // Harmless under Original merge — it's just an extra property there.
        if (user?.userId) {
            props.$user_id = user.userId;
        }

        if (user) {
            // Profile-style fields. We send them inline on each event
            // (rather than via /engage $set) so the funnel can segment
            // by them without depending on whether a /engage call has
            // landed yet. This matches the Amplitude `user_properties`
            // behaviour we relied on previously.
            props.email = user.email;
            if (user.firstName) props.first_name = user.firstName;
            if (user.lastName) props.last_name = user.lastName;
        }

        this.send([{ event: eventType, properties: props }]).catch(() => {
            // Fire-and-forget — never surface errors to the user
        });
    }

    /**
     * Track a user-facing notification (info / warning / error toast or
     * status bar message). Useful for understanding which CTAs users see
     * and whether messaging is reaching them. Stamps `notification_kind`
     * + `notification_id` so notifications can be grouped in dashboards.
     */
    notification(
        id: string,
        kind: 'info' | 'warning' | 'error',
        properties?: Record<string, unknown>,
    ): void {
        this.track('notification_shown', { notification_id: id, notification_kind: kind, ...properties });
    }

    /**
     * Track when the user clicks an action button on a notification
     * (e.g. "Open System Design" on init-complete, "Sign In" on auth-required).
     */
    notificationActionClicked(
        id: string,
        action: string,
        properties?: Record<string, unknown>,
    ): void {
        this.track('notification_action_clicked', { notification_id: id, notification_action: action, ...properties });
    }

    private async send(events: MixpanelEvent[]): Promise<void> {
        // No token means no telemetry. This is the normal state for any
        // build from source: `esbuild.js` injects no fallback, so a clone
        // or a fork never reaches the network here. `__no_telemetry_key__`
        // remains accepted as an explicit opt-out sentinel for builds that
        // DO have a token provisioned but want it disabled.
        if (!MIXPANEL_TOKEN || MIXPANEL_TOKEN === '__no_telemetry_key__') return;
        // Last line of defence before the network. track() and identify()
        // already check this; repeating it here means a future call path that
        // reaches send() directly still cannot phone home against the user's
        // stated preference.
        if (isTelemetryOptedOut()) return;
        const debug = process.env.CODEATLAS_TELEMETRY_DEBUG === '1';
        if (debug) {
            for (const ev of events) {
                // Log to console.warn so it shows up in VS Code's
                // extension-host output without competing with regular
                // info logs. Only fires when the user opts in.
                console.warn(`[CodeAtlas telemetry] sending: ${ev.event} (props=${Object.keys(ev.properties).length})`);
            }
        }
        try {
            const res = await fetch(MIXPANEL_TRACK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(events),
                signal: AbortSignal.timeout(5000),
            });
            if (debug) {
                // Mixpanel returns 200 OK even for some malformed events
                // (with `{status: 0, error: "..."}` in the body when
                // `verbose=1`). Log the body so misconfiguration is
                // visible instead of silent.
                const text = await res.text().catch(() => '<no body>');
                console.warn(`[CodeAtlas telemetry] response: HTTP ${res.status} body=${text.slice(0, 200)}`);
            }
        } catch (err: any) {
            if (debug) {
                console.warn(`[CodeAtlas telemetry] send failed: ${err?.message ?? err}`);
            }
            // Silently ignore network errors — analytics must never impact user experience
        }
    }
}

export const analytics = new MixpanelService();
