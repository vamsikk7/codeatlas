/**
 * violationsBroadcaster.ts — UX-48 follow-up (2026-06-05).
 *
 * Architecture-rule violations used to be computed only when the user
 * opened `#/violations`. That meant a write route landed without auth
 * during normal work, and no one saw it until they manually navigated
 * to the page. This module installs an always-on broadcaster that
 * recomputes violations after every cascade refresh and pushes them
 * to the browser, throttled by a stable signature so we don't spam
 * clients with the same payload twice.
 *
 * The webview's `ViolationsView` already handles the `violations`
 * envelope. The new behaviour is just that the envelope arrives
 * proactively instead of on-demand.
 */

import type { Snapshot } from '../graph/graphTypes';
import { listArchitectureViolations } from '../../mcp/tier2';

/**
 * Pure helper extracted for testability. Runs the rule evaluator,
 * compares its signature against `ctx.lastSignature`, and emits the
 * standard `{type:'violations', rules, violations}` envelope when the
 * signature changed (or on the first call). Errors are swallowed —
 * a broken rule should never abort cascade.
 */
export function computeAndBroadcastViolations(
    snapshot: Snapshot,
    workspaceRoot: string,
    broadcast: (msg: any) => void,
    log: (msg: string) => void,
    ctx: { lastSignature: string | null },
): void {
    try {
        const result = listArchitectureViolations(snapshot, { workspaceRoot });
        const signature = signatureFor(result.violations);
        if (signature === ctx.lastSignature) return;
        ctx.lastSignature = signature;
        broadcast({
            type: 'violations',
            rules: result.rules,
            violations: result.violations,
        });
        log(`[violations broadcast] ${result.violations.length} violations across ${result.rules.length} rules`);
    } catch (err: any) {
        // Defensive — broken snapshot shape (missing apiIndex etc.) or a
        // rule that throws shouldn't bubble.
        log(`[violations broadcast] failed: ${err?.message ?? err}`);
    }
}

function signatureFor(violations: Array<{ rule: string; message: string }>): string {
    return violations
        .map((v) => `${v.rule}::${v.message}`)
        .sort()
        .join('|');
}

export interface ViolationsBroadcasterOptions {
    orchestrator: { onRefresh: (cb: (graphIds: string[]) => void) => void };
    store: { getWorking: () => Snapshot };
    broadcast: (msg: any) => void;
    workspaceRoot: string;
    log: (msg: string) => void;
    /** Debounce window. Default 1500ms — saves come in bursts during typing. */
    debounceMs?: number;
}

/**
 * Wire the broadcaster onto an orchestrator. Returns the registered
 * callback so callers can also fire it manually after initialization.
 */
export function makeViolationsBroadcaster(opts: ViolationsBroadcasterOptions): (graphIds: string[]) => void {
    const ctx = { lastSignature: null as string | null };
    const debounceMs = opts.debounceMs ?? 1500;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
        pending = null;
        try {
            computeAndBroadcastViolations(opts.store.getWorking(), opts.workspaceRoot, opts.broadcast, opts.log, ctx);
        } catch (err: any) {
            opts.log(`[violations broadcaster] fire failed: ${err?.message ?? err}`);
        }
    };
    const cb = (_graphIds: string[]) => {
        if (pending) clearTimeout(pending);
        pending = setTimeout(fire, debounceMs);
    };
    opts.orchestrator.onRefresh(cb);
    return cb;
}
