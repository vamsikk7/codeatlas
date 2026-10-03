/**
 * formatFindingsMd.ts (#540)
 *
 * Pure-JS Markdown formatter for clipboard copy. Used by the per-row copy
 * button and the group "Copy all / by severity" dropdown.
 *
 * Output is human-readable so users can paste into PRs, Slack, ticket
 * trackers, or AI prompts:
 *
 *   ### AI Review findings — 3 total (1 errors, 2 warnings, 0 info)
 *   > Baseline: git:abc1234 · captured 2026-05-22T11:30:00Z
 *
 *   #### [ERROR] Missing auth on POST /api/admin
 *   The route accepts admin actions without verifying the JWT…
 *   Evidence:
 *   ```ts
 *   router.post('/api/admin', adminController.delete);
 *   ```
 *   Layer: api-list · File: src/admin.ts (handler: delete)
 */

import type { AiReviewFinding } from './types';

interface FormatOpts {
    /** Optional header line — usually a baseline-ref / scope label. */
    headerNote?: string;
}

export function formatFindingsMd(findings: AiReviewFinding[], opts: FormatOpts = {}): string {
    if (findings.length === 0) return '_No AI Review findings to copy._';

    const open = findings.filter((f) => f.status === 'open');
    const counts = countBy(open, (f) => f.severity);
    const total = open.length;
    const lines: string[] = [];

    lines.push(`### AI Review findings — ${total} total (${counts.error ?? 0} errors, ${counts.warning ?? 0} warnings, ${counts.info ?? 0} info)`);

    const refLine = collectBaselineRef(findings);
    if (refLine) lines.push(`> ${refLine}`);
    if (opts.headerNote) lines.push(`> ${opts.headerNote}`);
    lines.push('');

    // Sort error > warning > info, then by title.
    const sevRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
    const sorted = findings.slice().sort((a, b) =>
        (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9)
        || a.title.localeCompare(b.title),
    );

    for (const f of sorted) {
        lines.push(`#### [${f.severity.toUpperCase()}] ${f.title}`);
        if (f.body) lines.push(f.body.trim());
        const snippet = (f.anchor as any)?.snippet;
        if (snippet) {
            const lang = guessLangFromPath((f.anchor as any)?.filePath ?? '');
            lines.push('Evidence:');
            lines.push('```' + lang);
            lines.push(String(snippet).trim());
            lines.push('```');
        }
        const layers = [...new Set((f.bindings ?? []).map((b) => b.layer))].filter(Boolean).join(', ');
        const fp = (f.anchor as any)?.filePath ?? '';
        const sym = (f.anchor as any)?.symbol ?? '';
        const meta: string[] = [];
        if (layers) meta.push(`Layer: ${layers}`);
        if (fp) meta.push(`File: ${fp}${sym ? ` (handler: ${sym})` : ''}`);
        if (f.entryPointId) meta.push(`Entry point: ${f.entryPointId}`);
        if (meta.length > 0) lines.push(meta.join(' · '));
        lines.push('');
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function countBy<T>(items: T[], keyFn: (x: T) => string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const it of items) {
        const k = keyFn(it);
        out[k] = (out[k] ?? 0) + 1;
    }
    return out;
}

function collectBaselineRef(findings: AiReviewFinding[]): string | null {
    const refs = new Set<string>();
    for (const f of findings) {
        const r = (f as any).baselineRef;
        if (!r?.ref) continue;
        refs.add(`${r.kind ?? 'snap'}:${r.ref}${r.capturedAt ? ` · captured ${r.capturedAt}` : ''}`);
    }
    if (refs.size === 0) return null;
    if (refs.size === 1) return `Baseline: ${[...refs][0]}`;
    return `Baselines: ${[...refs].join('; ')}`;
}

function guessLangFromPath(p: string): string {
    const ext = p.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'py', rb: 'rb',
        go: 'go', rs: 'rs', java: 'java', kt: 'kotlin', cs: 'csharp',
        php: 'php', swift: 'swift', dart: 'dart',
    };
    return map[ext] ?? '';
}
