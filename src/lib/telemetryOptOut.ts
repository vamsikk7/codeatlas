/**
 * telemetryOptOut.ts — the single opt-out predicate for every phone-home path.
 *
 * Audit finding S9. Three telemetry surfaces previously answered to different
 * signals: `sentryNode.ts` and `mcp/analytics/mcpAnalytics.ts` each had their
 * own (identical) copy honouring `CODEATLAS_TELEMETRY` + `DO_NOT_TRACK`, while
 * the extension host's `analytics/mixpanelService.ts` honoured neither and
 * checked only VS Code's `telemetry.telemetryLevel`.
 *
 * The practical effect was that `DO_NOT_TRACK=1` silenced crash reporting and
 * the MCP server while the extension kept sending usage events. That is a
 * correctness bug on its own; in a public repository it also reads as a dark
 * pattern, which is why this is one function rather than three.
 *
 * Deliberately free of any `vscode` import: the MCP standalone server and the
 * Node error reporter run outside the extension host and must be able to call
 * this. Editor-specific signals (`vscode.env.isTelemetryEnabled`) are layered
 * on top by the caller that has access to them — see `mixpanelService.ts`.
 */

/** Values of `CODEATLAS_TELEMETRY` that mean "off". */
const DISABLE_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/** Values of `DO_NOT_TRACK` that mean "do not track". */
const DNT_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes']);

/**
 * True when the user has opted out of all telemetry via the environment.
 *
 * Honours:
 *   - `CODEATLAS_TELEMETRY=0|false|off|no` — the project's own flag
 *   - `DO_NOT_TRACK=1|true|yes`            — the industry-standard signal
 *
 * Both are case-insensitive and whitespace-tolerant, because these get set by
 * hand in shell profiles and CI configuration.
 *
 * @param env  Environment to read. Defaults to `process.env`; injectable for
 *             tests and for callers that run where `process` may be absent.
 */
export function isTelemetryOptedOut(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env ?? {}): boolean {
    const flag = (env.CODEATLAS_TELEMETRY ?? '').toLowerCase().trim();
    if (DISABLE_VALUES.has(flag)) return true;

    const dnt = (env.DO_NOT_TRACK ?? '').toLowerCase().trim();
    if (DNT_VALUES.has(dnt)) return true;

    return false;
}
