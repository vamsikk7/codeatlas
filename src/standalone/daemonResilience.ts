/**
 * daemonResilience.ts — keep the `--browser` daemon alive across transient,
 * environmental failures that are NOT the user's code being wrong.
 *
 * Two concerns:
 *   • BUG-EXP-14 — fd / watch-limit exhaustion (`EMFILE`/`ENFILE`/`ENOSPC`) on
 *     very large repos: the snapshot is already built + served, we only lose
 *     live file watching, so the daemon must degrade rather than die.
 *   • BUG-EXP-20 — Node's `autoSelectFamily` (happy-eyeballs) races IPv4/IPv6
 *     on an outbound multi-address connect and, on timeout, trips an internal
 *     assertion (`ERR_INTERNAL_ASSERTION` from `node:net internalConnectMultiple`)
 *     that otherwise crashes the whole daemon mid-session.
 *
 * The classifier is deliberately NARROW: only these known transient signatures
 * are survivable. A genuine `ERR_INTERNAL_ASSERTION` from anywhere else, and
 * every ordinary application error, still propagates so real bugs surface.
 */

/** True when the daemon should log-and-continue instead of crashing. */
export function isSurvivableDaemonError(e: unknown): boolean {
    if (e == null) return false;
    const err = e as { code?: unknown; message?: unknown; stack?: unknown };
    const codeOrMsg = String(err.code ?? err.message ?? e ?? '');
    // BUG-EXP-14 — file-descriptor / watch-limit exhaustion.
    if (/EMFILE|ENFILE|ENOSPC/.test(codeOrMsg)) return true;
    // BUG-EXP-20 — the autoSelectFamily net assertion, and ONLY that one. Match
    // both the code AND a node:net / internalConnectMultiple stack frame so we
    // don't swallow an unrelated internal assertion (which would be a real bug).
    if (err.code === 'ERR_INTERNAL_ASSERTION') {
        const stack = String(err.stack ?? '');
        if (/internalConnectMultiple|node:net/.test(stack)) return true;
    }
    return false;
}

/**
 * Disable Node's `autoSelectFamily` (happy-eyeballs) so outbound connections
 * dial addresses sequentially — the pre-Node-19 default. This removes the
 * IPv4/IPv6 race that trips the `ERR_INTERNAL_ASSERTION` above (BUG-EXP-20).
 * No-op on Node builds without the API.
 */
export function hardenOutboundConnections(): void {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const net = require('net');
        if (typeof net.setDefaultAutoSelectFamily === 'function') {
            net.setDefaultAutoSelectFamily(false);
        }
    } catch { /* older Node without the API — nothing to harden */ }
}
