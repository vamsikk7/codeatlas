/**
 * sentryAdapter.ts — #911 (2026-06-26).
 *
 * The first RUNTIME-DATA overlay adapter: Sentry error-rate, end-to-end
 * (fetch → join → paint). Proves the north-star "overlays are a lens, anchors
 * are the join key" contract against a real external signal — the same shape a
 * future APM/latency adapter will use.
 *
 * Design:
 *   - Config lives in `.codeatlas/sentry.json` (org, project, authToken, host?).
 *     The fetch context carries no secrets, so a workspace-local config file is
 *     the pragmatic source. No config ⇒ fetch() returns [] (the emptyHint
 *     guides setup) — never throws, never blocks.
 *   - `parseSentryIssues` is a PURE function (Sentry issues JSON → data points
 *     keyed by file/function) so the join + severity logic is unit-tested
 *     without touching the network. The HTTP call is a thin wrapper.
 *   - Each issue's event `count` becomes the painted value; severity escalates
 *     past `errorThreshold`. The join engine maps `metadata.filename` /
 *     `metadata.function` onto graph node anchors.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { OverlayDataPoint, OverlayDescriptor, OverlayFetchContext } from './overlayTypes';

export interface SentryConfig {
    /** Sentry host, e.g. https://sentry.io (default) or a self-hosted URL. */
    host?: string;
    /** Organisation slug. */
    org: string;
    /** Project slug. */
    project: string;
    /** Internal integration / personal auth token (Bearer). */
    authToken: string;
    /** Stats window for the issues query (default 24h). */
    statsPeriod?: string;
    /** Event count at/above which an issue paints `error` (default 10). */
    errorThreshold?: number;
}

/** A trimmed shape of the Sentry "issues" API row we read. */
export interface SentryIssue {
    id?: string;
    title?: string;
    culprit?: string;
    count?: string | number;
    userCount?: number;
    metadata?: { type?: string; value?: string; filename?: string; function?: string };
}

/** Load `.codeatlas/sentry.json`. Returns null when absent/invalid/incomplete. */
export function loadSentryConfig(workspaceRoot: string): SentryConfig | null {
    try {
        const p = path.join(workspaceRoot, '.codeatlas', 'sentry.json');
        if (!fs.existsSync(p)) return null;
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!raw || typeof raw !== 'object') return null;
        if (!raw.org || !raw.project || !raw.authToken) return null;
        return {
            host: typeof raw.host === 'string' ? raw.host : undefined,
            org: String(raw.org),
            project: String(raw.project),
            authToken: String(raw.authToken),
            statsPeriod: typeof raw.statsPeriod === 'string' ? raw.statsPeriod : undefined,
            errorThreshold: typeof raw.errorThreshold === 'number' ? raw.errorThreshold : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * PURE: Sentry issues → overlay data points. Keyed by the issue's source file
 * (+ function when present). `resolveFile` lets the caller normalise a Sentry
 * filename onto a workspace-relative path so the anchor join lands; without it
 * the raw filename is used (the join still suffix-matches best-effort).
 */
export function parseSentryIssues(
    issues: SentryIssue[],
    opts?: { errorThreshold?: number; resolveFile?: (filename: string) => string | undefined },
): OverlayDataPoint[] {
    const threshold = opts?.errorThreshold ?? 10;
    const points: OverlayDataPoint[] = [];
    for (const issue of issues ?? []) {
        const rawFile = issue.metadata?.filename || '';
        const fn = issue.metadata?.function;
        if (!rawFile) continue;
        const filePath = opts?.resolveFile?.(rawFile) ?? rawFile;
        const count = Number(issue.count ?? 0) || 0;
        points.push({
            key: fn ? { filePath, functionName: fn } : { filePath },
            value: count,
            severity: count >= threshold ? 'error' : 'warn',
            meta: { title: issue.title, issueId: issue.id, userCount: issue.userCount },
        });
    }
    return points;
}

/** Best-effort: map a Sentry filename onto a workspace file by suffix match. */
export function makeFileResolver(workingFiles: string[]): (filename: string) => string | undefined {
    return (filename: string) => {
        if (!filename) return undefined;
        if (workingFiles.includes(filename)) return filename;
        const norm = filename.replace(/^[./]+/, '');
        // Prefer the shortest workspace path that ends with the sentry filename.
        let best: string | undefined;
        for (const wf of workingFiles) {
            if (wf === norm || wf.endsWith('/' + norm) || norm.endsWith('/' + wf)) {
                if (!best || wf.length < best.length) best = wf;
            }
        }
        return best;
    };
}

/** Thin HTTP wrapper around the Sentry issues API. Network-only; not unit-tested. */
export async function fetchSentryIssues(config: SentryConfig): Promise<SentryIssue[]> {
    const host = (config.host || 'https://sentry.io').replace(/\/+$/, '');
    const period = config.statsPeriod || '24h';
    const url = `${host}/api/0/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(config.project)}/issues/?query=is:unresolved&statsPeriod=${encodeURIComponent(period)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.authToken}` } });
    if (!res.ok) throw new Error(`Sentry API ${res.status} ${res.statusText}`);
    const body = await res.json();
    return Array.isArray(body) ? body as SentryIssue[] : [];
}

export const sentryErrorsOverlay: OverlayDescriptor = {
    id: 'sentry-errors',
    displayName: 'Sentry error rate',
    emptyHint: 'No Sentry data — add .codeatlas/sentry.json with { org, project, authToken } to paint error rates.',
    join: 'anchor',
    paint: 'severity',
    aggregation: 'sum',
    refreshPolicy: { kind: 'interval', seconds: 300 },
    timeWindowed: true,
    async fetch(ctx: OverlayFetchContext): Promise<OverlayDataPoint[]> {
        const config = loadSentryConfig(ctx.workspaceRoot);
        if (!config) return [];
        const issues = await fetchSentryIssues(config);
        const resolver = makeFileResolver(Object.keys(ctx.working.files ?? {}));
        return parseSentryIssues(issues, { errorThreshold: config.errorThreshold, resolveFile: resolver });
    },
};
