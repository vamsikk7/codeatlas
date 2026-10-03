/**
 * ossReminder.ts — pure decision for the once-per-day "register open-source
 * interest" reminder shown in the VS Code editor (never the MCP server).
 *
 * Kept framework-free (no `vscode` import) so the throttle/gating logic is unit
 * tested directly. The extension supplies `now`, the persisted last-shown
 * timestamp, the local "already registered" flag, and the opt-out setting.
 *
 * Mirrors the 24h throttle used by `maybeNudgeOpenInBrowser` in extension.ts.
 */

export interface OssReminderInput {
    /** Current time (ms since epoch). */
    now: number;
    /** globalState timestamp of the last reminder shown; 0 if never. */
    lastShownMs: number;
    /** Local flag: the user has registered interest (or opted out for good). */
    registered: boolean;
    /** The `codeatlas.remindOpenSourceInterest` setting is OFF. */
    optOut: boolean;
    /** Minimum gap between reminders. Defaults to 24h. */
    intervalMs?: number;
}

export const OSS_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether to show the open-source-interest reminder now. Shown to anyone who
 * hasn't registered (signed-out included) and hasn't opted out, at most once
 * per `intervalMs`.
 */
export function shouldRemindOpenSource(input: OssReminderInput): boolean {
    if (input.optOut) return false;
    if (input.registered) return false;
    const interval = input.intervalMs ?? OSS_REMINDER_INTERVAL_MS;
    return input.now - input.lastShownMs >= interval;
}
