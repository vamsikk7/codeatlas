/**
 * prReviewPayload.ts — #850 (2026-06-11).
 *
 * Pure mapping layer for the PR review commenter (`codeatlas-mcp review-pr`,
 * designed to run inside GitHub Actions on pull_request events — the Action
 * IS the webhook). Maps evidence-gated AI findings onto GitHub's PR review
 * shape: inline comments only on lines the PR diff actually shows (RIGHT
 * side, exact line — a misplaced pin is worse than a summary entry), with
 * everything else folded into a marker-tagged summary body so no finding is
 * silently dropped.
 */

export const PR_REVIEW_MARKER = '<!-- codeatlas-pr-review -->';

export interface PrFindingLike {
    id?: string;
    severity?: string;
    title?: string;
    body?: string;
    anchor?: { filePath?: string; symbol?: string };
    evidence?: { filePath?: string; lineStart?: number; lineEnd?: number; snippet?: string };
    /** #855 — gate tier that accepted the evidence; 'anchor' is flagged as
     *  lower-confidence in the comment so reviewers know the quote drifted. */
    evidenceConfidence?: 'exact' | 'fuzzy' | 'anchor';
}

export interface PrInlineComment {
    path: string;
    line: number;
    side: 'RIGHT';
    body: string;
}

/**
 * Parse a unified diff into a map of file → RIGHT-side line numbers that
 * GitHub will accept inline comments on (added + context lines inside
 * hunks; deleted lines live on the LEFT side and are out of v1 scope).
 */
export function parseUnifiedDiff(diffText: string): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    if (!diffText) return out;
    let currentFile: string | null = null;
    let rightLine = 0;
    for (const raw of diffText.split('\n')) {
        if (raw.startsWith('+++ ')) {
            const p = raw.slice(4).trim();
            currentFile = p === '/dev/null' ? null : p.replace(/^b\//, '');
            if (currentFile && !out.has(currentFile)) out.set(currentFile, new Set());
            continue;
        }
        if (raw.startsWith('@@')) {
            const m = raw.match(/\+(\d+)(?:,(\d+))?/);
            rightLine = m ? parseInt(m[1], 10) : 0;
            continue;
        }
        if (!currentFile || rightLine === 0) continue;
        if (raw.startsWith('+')) {
            out.get(currentFile)!.add(rightLine);
            rightLine++;
        } else if (raw.startsWith('-')) {
            // left-side only — right cursor doesn't move
        } else if (raw.startsWith(' ') || raw === '') {
            out.get(currentFile)!.add(rightLine);
            rightLine++;
        } else {
            // diff metadata between hunks — stop counting until next @@
            rightLine = 0;
        }
    }
    // Drop files that gathered no commentable lines (pure deletions).
    for (const [f, lines] of out) if (lines.size === 0) out.delete(f);
    return out;
}

const SEVERITY_ICON: Record<string, string> = {
    error: '🔴', warning: '🟠', info: '🔵', suggestion: '💡',
};

function commentBody(f: PrFindingLike): string {
    const icon = SEVERITY_ICON[String(f.severity ?? '').toLowerCase()] ?? '🔵';
    const parts = [`${icon} **${f.title ?? 'Finding'}** (${f.severity ?? 'info'})`];
    if (f.body) parts.push('', f.body.trim());
    if (f.evidence?.snippet) parts.push('', '```', f.evidence.snippet.trim(), '```');
    // #855 — anchor-tier findings resolved by symbol, not an exact quote.
    const footer = f.evidenceConfidence === 'anchor'
        ? '_CodeAtlas AI review — symbol-anchored finding (quote approximate; verify against the cited symbol)._'
        : '_CodeAtlas AI review — evidence-gated finding._';
    parts.push('', footer);
    return parts.join('\n');
}

export function mapFindingsToPrReview(
    findings: ReadonlyArray<PrFindingLike>,
    commentableLines: Map<string, Set<number>>,
): { inline: PrInlineComment[]; outside: PrFindingLike[] } {
    const inline: PrInlineComment[] = [];
    const outside: PrFindingLike[] = [];
    for (const f of findings) {
        const path = f.evidence?.filePath ?? f.anchor?.filePath;
        const line = f.evidence?.lineStart;
        const lines = path ? commentableLines.get(path) : undefined;
        if (path && typeof line === 'number' && lines?.has(line)) {
            inline.push({ path, line, side: 'RIGHT', body: commentBody(f) });
        } else {
            outside.push(f);
        }
    }
    return { inline, outside };
}

/**
 * #853 — compact "What to re-test" markdown from a regression scope
 * (core/analysis/regressionScope.ts). Pure renderer: undefined when the
 * scope carries nothing actionable, so callers can skip the section.
 */
export function renderRegressionHint(scope: {
    affectedApis?: ReadonlyArray<{ method?: string; route?: string }>;
    testsToRun?: ReadonlyArray<{ testFile?: string }>;
    testCommand?: string | null;
    untestedBlastRadius?: ReadonlyArray<unknown>;
    crossRepoConsumers?: ReadonlyArray<{ consumerRepo?: string; method?: string; route?: string }>;
} | null | undefined): string | undefined {
    if (!scope) return undefined;
    const lines: string[] = [];
    const apis = (scope.affectedApis ?? []).slice(0, 6);
    if (apis.length > 0) {
        lines.push(`**Affected endpoints:** ${apis.map((a) => `\`${[a.method, a.route].filter(Boolean).join(' ')}\``).join(', ')}${(scope.affectedApis?.length ?? 0) > 6 ? ` (+${scope.affectedApis!.length - 6} more)` : ''}`);
    }
    const tests = (scope.testsToRun ?? []).slice(0, 6);
    if (tests.length > 0) {
        lines.push(`**Tests covering the blast radius:** ${tests.map((t) => `\`${t.testFile}\``).join(', ')}${(scope.testsToRun?.length ?? 0) > 6 ? ` (+${scope.testsToRun!.length - 6} more)` : ''}`);
    }
    if (scope.testCommand) lines.push(`**Run them:** \`${scope.testCommand}\``);
    const untested = scope.untestedBlastRadius?.length ?? 0;
    if (untested > 0) lines.push(`⚠️ **${untested} impacted function${untested === 1 ? '' : 's'} with no mapped test** — manual verification recommended.`);
    const consumers = (scope.crossRepoConsumers ?? []).slice(0, 4);
    if (consumers.length > 0) {
        lines.push(`**Cross-repo consumers:** ${consumers.map((c) => `${c.consumerRepo} (\`${[c.method, c.route].filter(Boolean).join(' ')}\`)`).join(', ')} — coordinate before merging.`);
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * #916 — the review's honest DENOMINATOR. Every review result must state what
 * was actually reviewed so "no issues" can never read as a blanket all-clear
 * over a partially-reviewed change.
 */
export interface ReviewCoverage {
    /** Changed source files in the PR (the universe we measure coverage against). */
    changedSourceTotal: number;
    /** Changed source files whose actual code reached the model (entry-anchored / changed-pass / infra). */
    reviewed: number;
    /** Changed source files NOT shown to the model (over the cap / no entry point) — the verdict does NOT cover these. */
    reviewedBlind: number;
    /** A short list of the reviewed-blind file paths (for the "[list]"). */
    blindFiles?: string[];
}

export function buildPrSummaryBody(args: {
    inline: PrInlineComment[];
    outside: PrFindingLike[];
    allFindings: ReadonlyArray<PrFindingLike>;
    meta: { headSha?: string; entryPointsReviewed?: number; failedEntryPoints?: number; regressionHint?: string; coverage?: ReviewCoverage };
}): string {
    const { inline, outside, allFindings, meta } = args;
    const cov = meta.coverage;
    // #916 — scope an empty verdict to exactly what was reviewed.
    const scope = cov
        ? `in the ${meta.entryPointsReviewed ?? 0} entry point${(meta.entryPointsReviewed ?? 0) === 1 ? '' : 's'} + ${cov.reviewed} changed file${cov.reviewed === 1 ? '' : 's'} reviewed`
        : 'in the changed entry points';
    const bySeverity = new Map<string, number>();
    for (const f of allFindings) {
        const sev = String(f.severity ?? 'info').toLowerCase();
        bySeverity.set(sev, (bySeverity.get(sev) ?? 0) + 1);
    }
    const counts = ['error', 'warning', 'info', 'suggestion']
        .filter((s) => bySeverity.has(s))
        .map((s) => `${bySeverity.get(s)} ${s}${bySeverity.get(s)! > 1 ? 's' : ''}`)
        .join(' · ');

    const lines: string[] = [PR_REVIEW_MARKER, '## CodeAtlas review', ''];
    if (allFindings.length === 0) {
        // #916 — never a bare "no issues": always scope it to what was reviewed.
        lines.push(`✅ **No issues found** ${scope}.`);
    } else {
        lines.push(`**${allFindings.length} finding${allFindings.length > 1 ? 's' : ''}** — ${counts}.`);
        if (inline.length > 0) lines.push('', `${inline.length} posted as inline comments on the diff.`);
        if (outside.length > 0) {
            lines.push('', '### Findings outside the diff', '');
            for (const f of outside) {
                const icon = SEVERITY_ICON[String(f.severity ?? '').toLowerCase()] ?? '🔵';
                const loc = f.evidence?.filePath
                    ? ` — \`${f.evidence.filePath}${f.evidence.lineStart ? `:${f.evidence.lineStart}` : ''}\``
                    : f.anchor?.filePath ? ` — \`${f.anchor.filePath}\`` : '';
                lines.push(`- ${icon} **${f.title ?? 'Finding'}**${loc}${f.body ? ` — ${String(f.body).split('\n')[0]}` : ''}`);
            }
        }
    }
    if (meta.failedEntryPoints) {
        // INVARIANT: partial review failures must be visible on the PR — a
        // silent drop reads as "reviewed clean" when it wasn't; see ADR-044.
        lines.push('', `⚠️ ${meta.failedEntryPoints} entry point${meta.failedEntryPoints > 1 ? 's' : ''} could not be reviewed (LLM errors) — coverage is partial.`);
    }
    // #916 — always surface the coverage denominator: how many changed source
    // files actually reached the model, and which were reviewed-blind (over the
    // cap / no entry point). The verdict above covers ONLY the reviewed set.
    if (cov && cov.changedSourceTotal > 0) {
        lines.push('', `**Coverage:** reviewed ${cov.reviewed}/${cov.changedSourceTotal} changed source file${cov.changedSourceTotal === 1 ? '' : 's'} that reached the model.`);
        if (cov.reviewedBlind > 0) {
            const list = cov.blindFiles?.length
                ? ` — ${cov.blindFiles.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${cov.reviewedBlind > 8 ? ` +${cov.reviewedBlind - 8} more` : ''}`
                : '';
            lines.push(`⚠️ **${cov.reviewedBlind} changed file${cov.reviewedBlind === 1 ? '' : 's'} NOT reviewed** (over the file cap / no entry point)${list}. The verdict above does not cover ${cov.reviewedBlind === 1 ? 'it' : 'these'}.`);
        }
    }
    if (meta.regressionHint) lines.push('', '### What to re-test', '', meta.regressionHint);
    lines.push('', '---');
    const reviewed = meta.entryPointsReviewed != null ? `${meta.entryPointsReviewed} entry point${meta.entryPointsReviewed === 1 ? '' : 's'} reviewed` : 'review complete';
    lines.push(`_${reviewed}${meta.headSha ? ` at \`${meta.headSha.slice(0, 7)}\`` : ''} · findings are evidence-gated (quotes must resolve to real source)._`);
    return lines.join('\n');
}
