/**
 * sentryBrowser.ts — Issue #724 error tracking shim for the webview.
 *
 * Same deterministic philosophy as `sentryNode.ts`: the SDK isn't
 * required at install time. When `@sentry/react` is missing, every
 * method is a no-op. When the user installs it + supplies the DSN via
 * Vite's `define`, errors get reported automatically.
 *
 * Why not bundle `@sentry/react` by default? Three reasons:
 *   1. Webview bundle size — Sentry adds ~30KB minified to a budget
 *      that already triggers the Vite chunk-size warning.
 *   2. PII surface — even with anonymized device ids, opting in by
 *      default would surprise users who run CodeAtlas in regulated
 *      environments. Matching `@sentry/node`'s opt-in posture.
 *   3. Single switch — the same `CODEATLAS_TELEMETRY=0` /
 *      `DO_NOT_TRACK=1` flags that gate Mixpanel ALSO gate Sentry, so
 *      users get one toggle for the entire observability stack.
 */

declare const CODEATLAS_SENTRY_DSN: string | undefined;

interface SentryReactSdk {
    init(opts: any): void;
    captureException(err: unknown, opts?: { extra?: Record<string, unknown> }): void;
    setUser(user: { id: string }): void;
}

let sdk: SentryReactSdk | null = null;
let initialized = false;

function isOptedOut(): boolean {
    // The webview runs in the browser; `import.meta.env` carries Vite's
    // env vars, and the host page may set these via the launch URL.
    try {
        const meta: any = (import.meta as any);
        if (meta?.env?.CODEATLAS_TELEMETRY === '0') return true;
        if (meta?.env?.DO_NOT_TRACK === '1') return true;
    } catch { /* noop */ }
    try {
        // Some embed contexts (VS Code webview) expose env via globals.
        const g: any = globalThis as any;
        if (g?.process?.env?.CODEATLAS_TELEMETRY === '0') return true;
        if (g?.process?.env?.DO_NOT_TRACK === '1') return true;
    } catch { /* noop */ }
    return false;
}

function getDsn(): string | null {
    try {
        const injected = typeof CODEATLAS_SENTRY_DSN !== 'undefined' ? CODEATLAS_SENTRY_DSN : '';
        if (injected && injected.length > 0) return injected;
    } catch { /* identifier not in scope */ }
    return null;
}

async function loadSdk(): Promise<SentryReactSdk | null> {
    try {
        // Real dynamic import — Vite sees it, code-splits `@sentry/react`
        // into its own chunk that only loads when this branch runs (i.e.
        // when a DSN is configured AND telemetry isn't opted out). Pays
        // the ~30KB cost only on the first error report, not at boot.
        //
        // We previously used `new Function('m', 'return import(m)')` to
        // hide the import from the bundler so the shim could ship before
        // the dep was installed — but that left the browser unable to
        // resolve `@sentry/react` at runtime (no node_modules in the
        // webview). Now that `@sentry/react` is a real dep, a normal
        // dynamic import is correct: Vite bundles it, the browser
        // fetches the chunk on demand. If the dep is removed and not
        // re-installed, the build fails loud — which is what we want.
        const mod = await import('@sentry/react');
        if (mod && typeof (mod as unknown as SentryReactSdk).init === 'function') {
            return mod as unknown as SentryReactSdk;
        }
    } catch {
        // Chunk failed to load OR SDK init function missing — silent
        // no-op so observability code never breaks the actual feature.
    }
    return null;
}

/**
 * Initialize the webview Sentry SDK. Resolves once the SDK is loaded +
 * initialized, or immediately when no DSN exists / user opted out / SDK
 * isn't installed. Callers don't await this — fire and forget at App
 * boot.
 */
export async function initSentryBrowser(): Promise<void> {
    if (initialized) return;
    initialized = true;
    if (isOptedOut()) return;
    const dsn = getDsn();
    if (!dsn) return;
    const loaded = await loadSdk();
    if (!loaded) return;
    sdk = loaded;
    try {
        sdk.init({
            dsn,
            tracesSampleRate: 0.05,
            initialScope: { tags: { context: 'webview-ui' } },
        });
    } catch {
        sdk = null;
    }
}

export function captureException(err: unknown, extra?: Record<string, unknown>): void {
    if (!sdk) return;
    try {
        sdk.captureException(err, extra ? { extra } : undefined);
    } catch { /* noop */ }
}

export function _resetForTests(): void {
    sdk = null;
    initialized = false;
}
