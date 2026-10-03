/**
 * analytics.ts (webview) — ADR-030
 *
 * INVARIANT: webview never talks to Amplitude directly. Every analytics
 * event posts a `webviewAnalytics` message to the extension host, which
 * validates + stamps shared properties (editor context, user_id, etc.)
 * before forwarding to Amplitude. This keeps event attribution consistent
 * and prevents the webview from spoofing user-level fields.
 *
 * Event naming convention: every event is prefixed `webview.` so dashboards
 * can filter client-side events from extension-side ones. The extension
 * handler enforces this prefix; events without it are dropped.
 */

// `Window.vscodeApi` is declared in App.tsx with the full shape
// (postMessage + getState + setState). We only need postMessage here, so
// no extra ambient declaration is added — TS picks up the App-level one.

/**
 * Track a UI interaction. Properties are flattened — nested objects /
 * arrays get dropped silently to keep WS frame size bounded. Strings are
 * truncated at 200 chars; max 12 properties per event.
 */
export function trackWebviewEvent(
    event: string,
    properties?: Record<string, string | number | boolean>,
): void {
    try {
        // Auto-prefix if caller forgot. The extension handler also rejects
        // non-prefixed events, so this is defense-in-depth.
        const eventName = event.startsWith('webview.') ? event : `webview.${event}`;
        window.vscodeApi?.postMessage({
            type: 'webviewAnalytics',
            event: eventName,
            properties: properties ?? {},
        });
    } catch {
        // Telemetry must never break the UI. Swallow anything (vscodeApi
        // missing in dev/standalone preview, postMessage failure, etc.).
    }
}
