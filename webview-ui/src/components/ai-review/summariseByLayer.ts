/**
 * summariseByLayer.ts (#538)
 *
 * Deterministic, no-LLM summary of the current AI Review findings, designed
 * to read top-down and explain what the findings _mean_ at each layer of the
 * architecture — not just dump counts.
 *
 * The output is multi-line (newlines + indented sub-bullets). The renderer
 * must use `white-space: pre-wrap` to preserve the layout.
 *
 * Sections (in order):
 *   1. "Overall" — one-line severity totals.
 *   2. "Interpretation" — pattern detected across all findings (e.g.
 *      "auth and validation are the dominant themes").
 *   3. "Microservice" — workspace-level inference: cross-cutting concerns.
 *   4. "Features" — per-cluster bullet with a one-line theme inference.
 *   5. "Sequences" — per-route bullet; routes are user-facing failure
 *      surfaces so we keep them named.
 *   6. "Files / Function flows affected" — compressed lists of names; the
 *      individual findings live in the panel + popover, no need to repeat
 *      titles here.
 *   7. "Top concerns" — actionable shortlist, errors first.
 *
 * Capped at ~500 words. Returns '' when there are no open findings.
 */

import type { AiReviewFinding, AiReviewSeverity } from './types';

const SEV_RANK: Record<AiReviewSeverity, number> = { error: 0, warning: 1, info: 2 };
const MAX_WORDS = 500;
const TOP_CONCERNS_LIMIT = 5;

interface EntityBucket {
    graphId: string;
    name: string;
    counts: { error: number; warning: number; info: number };
    findings: AiReviewFinding[];
}

export function summariseByLayer(findings: AiReviewFinding[]): string {
    const open = findings.filter((f) => f.status === 'open');
    if (open.length === 0) return '';

    const lines: string[] = [];
    const sevTotals = { error: 0, warning: 0, info: 0 };
    for (const f of open) sevTotals[f.severity] += 1;

    // ── 1. Overall ───────────────────────────────────────────────────────
    lines.push(`Overall: ${open.length} open finding${open.length === 1 ? '' : 's'} — ${sevTotals.error} error${sevTotals.error === 1 ? '' : 's'}, ${sevTotals.warning} warning${sevTotals.warning === 1 ? '' : 's'}, ${sevTotals.info} info.`);

    // ── 2. Interpretation (themes detected across all findings) ──────────
    const theme = inferOverallTheme(open);
    if (theme) lines.push(`Interpretation: ${theme}`);
    lines.push('');

    // ── 3. Microservice (workspace-level cross-cutting concerns) ─────────
    const mcr = groupByLayer(open, 'microservice');
    if (mcr.length > 0) {
        const bucket = mcr[0]; // there's only one — `microservice:workspace`
        lines.push('Microservice');
        lines.push(`  ${bucket.counts.error + bucket.counts.warning + bucket.counts.info} cross-cutting finding${bucket.counts.error + bucket.counts.warning + bucket.counts.info === 1 ? '' : 's'} on the workspace (${countsPhrase(bucket.counts)}).`);
        const inf = inferEntityTheme(bucket);
        if (inf) lines.push(`  ${inf}`);
        lines.push('');
    }

    // ── 4. Features (named clusters) ────────────────────────────────────
    const features = groupByLayer(open, 'feature');
    if (features.length > 0) {
        lines.push(`Features (${features.length} affected)`);
        for (const b of features.slice(0, 6)) {
            lines.push(`  • ${b.name} — ${countsPhrase(b.counts)}`);
            const inf = inferEntityTheme(b);
            if (inf) lines.push(`      ${inf}`);
        }
        if (features.length > 6) lines.push(`  • plus ${features.length - 6} more cluster${features.length - 6 === 1 ? '' : 's'}`);
        lines.push('');
    }

    // ── 5. Sequences (named routes via entryPointId) ────────────────────
    const sequences = groupByLayer(open, 'sequence');
    if (sequences.length > 0) {
        lines.push(`Sequences (${sequences.length} endpoint${sequences.length === 1 ? '' : 's'} flagged)`);
        for (const b of sequences.slice(0, 6)) {
            const worst = b.findings.slice().sort((a, c) => SEV_RANK[a.severity] - SEV_RANK[c.severity])[0];
            lines.push(`  • ${b.name} — ${countsPhrase(b.counts)}: ${truncate(worst.title, 70)}`);
        }
        if (sequences.length > 6) lines.push(`  • plus ${sequences.length - 6} more endpoint${sequences.length - 6 === 1 ? '' : 's'}`);
        lines.push('');
    }

    // ── 6. Files + Function flows (compressed; details live in the panel) ─
    const files = groupByLayer(open, 'file');
    const flows = groupByLayer(open, 'flow');
    if (files.length > 0) {
        const names = files.slice(0, 8).map((b) => b.name);
        const tail = files.length > 8 ? ` (+${files.length - 8} more)` : '';
        lines.push(`Files affected (${files.length}): ${names.join(', ')}${tail}.`);
    }
    if (flows.length > 0) {
        const names = flows.slice(0, 6).map((b) => b.name);
        const tail = flows.length > 6 ? ` (+${flows.length - 6} more)` : '';
        lines.push(`Function flows affected (${flows.length}): ${names.join('; ')}${tail}.`);
    }
    if (files.length > 0 || flows.length > 0) lines.push('');

    // ── 6b. Blast radius (theme × cluster cross-tab) ────────────────────
    // Answers "which clusters/files are bearing each issue type?"
    // For every theme detected, list the top clusters (or files when no
    // cluster binding is available) by finding count, plus a couple of
    // sample entry-point routes so the reader can jump straight into the
    // relevant L2b panel.
    const radius = computeBlastRadius(open);
    if (radius.length > 0) {
        lines.push('Blast radius (issue type → where it lands)');
        for (const r of radius.slice(0, 6)) {
            lines.push(`  ${r.theme} (${r.total} finding${r.total === 1 ? '' : 's'})`);
            for (const e of r.entries.slice(0, 4)) {
                const examples = e.examples.length > 0
                    ? ` — ${e.examples.slice(0, 2).join(', ')}${e.examples.length > 2 ? '…' : ''}`
                    : '';
                lines.push(`    • ${e.bucket}: ${e.count}${examples}`);
            }
            if (r.entries.length > 4) lines.push(`    • plus ${r.entries.length - 4} more`);
        }
        if (radius.length > 6) lines.push(`  … plus ${radius.length - 6} more issue types`);
        lines.push('');
    }

    // ── 7. Top concerns ─────────────────────────────────────────────────
    const ranked = open.slice().sort((a, b) =>
        SEV_RANK[a.severity] - SEV_RANK[b.severity]
        || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
    const top = ranked.slice(0, TOP_CONCERNS_LIMIT);
    if (top.length > 0) {
        lines.push('Top concerns (focus here first)');
        top.forEach((f, i) => {
            const where = describeFindingLocation(f);
            lines.push(`  ${i + 1}. [${f.severity.toUpperCase()}] ${truncate(f.title, 72)}${where ? ` — ${where}` : ''}`);
        });
    }

    return clipWords(lines.join('\n'), MAX_WORDS);
}

/** Group findings by binding.graphId within one layer, ordered worst-first. */
function groupByLayer(findings: AiReviewFinding[], layerKey: string): EntityBucket[] {
    const out = new Map<string, EntityBucket>();
    for (const f of findings) {
        const seen = new Set<string>();
        for (const b of f.bindings ?? []) {
            if (b.layer !== layerKey) continue;
            if (seen.has(b.graphId)) continue;
            seen.add(b.graphId);
            let bucket = out.get(b.graphId);
            if (!bucket) {
                bucket = {
                    graphId: b.graphId,
                    name: humanizeGraphId(b.graphId, f),
                    counts: { error: 0, warning: 0, info: 0 },
                    findings: [],
                };
                out.set(b.graphId, bucket);
            }
            bucket.counts[f.severity] += 1;
            bucket.findings.push(f);
        }
    }
    return Array.from(out.values()).sort((a, b) => {
        const aWorst = a.counts.error > 0 ? 0 : a.counts.warning > 0 ? 1 : 2;
        const bWorst = b.counts.error > 0 ? 0 : b.counts.warning > 0 ? 1 : 2;
        if (aWorst !== bWorst) return aWorst - bWorst;
        return (b.counts.error + b.counts.warning + b.counts.info) - (a.counts.error + a.counts.warning + a.counts.info);
    });
}

// ── Theme inference (deterministic, keyword-driven) ──────────────────────

interface ThemeBucket { theme: string; count: number; }

/**
 * Lightweight pattern detection over finding titles + bodies. Produces a
 * 1–2 sentence read like:
 *   "Auth and input validation are the dominant themes; 5 / 18 findings
 *   touch security and another 4 flag silent error swallowing."
 *
 * The patterns are intentionally generic (English text matchers) — they
 * don't depend on the LLM or any specific category vocabulary, so they
 * stay useful even when the underlying review prompt changes.
 */
function inferOverallTheme(findings: AiReviewFinding[]): string {
    const themes = scanThemes(findings);
    if (themes.length === 0) return '';
    const top = themes.slice(0, 3);
    if (top.length === 1) {
        return `${top[0].theme} dominates (${top[0].count}/${findings.length} findings touch this).`;
    }
    const lead = top[0];
    const rest = top.slice(1).map((t) => `${t.theme.toLowerCase()} (${t.count})`).join(', and ');
    return `${lead.theme} is the dominant theme (${lead.count}/${findings.length} findings); next are ${rest}.`;
}

function inferEntityTheme(bucket: EntityBucket): string {
    const themes = scanThemes(bucket.findings);
    if (themes.length === 0) return '';
    const top = themes[0];
    const total = bucket.findings.length;
    if (top.count >= Math.ceil(total / 2)) {
        // Strong signal — name the theme.
        return `Pattern: ${top.theme.toLowerCase()} (${top.count}/${total}).`;
    }
    return `Patterns: ${themes.slice(0, 2).map((t) => t.theme.toLowerCase()).join(' + ')}.`;
}

/**
 * Theme keyword table. Each entry produces one ThemeBucket if matched.
 * Order: more specific patterns first so we don't double-count
 * (a "JWT secret" finding shouldn't also count as plain "auth").
 */
const THEME_PATTERNS: Array<{ theme: string; rx: RegExp }> = [
    // Each token uses `\w*` after the stem so "authentication", "authorize",
    // "authorization", "validated", "injected" all match — `\b(stem)\b` alone
    // fails on the trailing word characters of inflected forms.
    { theme: 'Secret / credential leakage', rx: /\b(secret\w*|jwt|api[\s-]?key|hardcoded|leak\w*)\b/i },
    { theme: 'Auth & authorization gaps', rx: /\b(auth|authenticat\w*|authoriz\w*|permission\w*|access[\s-]?control|csrf|session|token)\b/i },
    { theme: 'Input validation / injection risk', rx: /\b(validat\w*|sanitiz\w*|escape\w*|inject\w*|xss|sql[\s-]?inject|user[\s-]?input)\b/i },
    { theme: 'Silent error swallowing', rx: /\b(swallow\w*|silent|unhandled|catch|empty[\s-]?catch|ignore[d]?[\s-]?error)\b/i },
    { theme: 'Performance — query patterns', rx: /\b(n\s*\+\s*1|loop[\s-]?query|nested[\s-]?find|slow[\s-]?query|over[\s-]?fetch|n\+1\s*query|n-plus-one)\b/i },
    { theme: 'Logging / observability gaps', rx: /\b(log|console\.(log|info|warn)|telemetry|trace)\b/i },
    { theme: 'Dead / unused code', rx: /\b(dead[\s-]?code|unused|unreachable|orphan\w*)\b/i },
    { theme: 'Type / null safety', rx: /\b(null|undefined|type[\s-]?coercion|nullable|optional[\s-]?chain)\b/i },
];

function scanThemes(findings: AiReviewFinding[]): ThemeBucket[] {
    const counts: Record<string, number> = {};
    for (const f of findings) {
        const text = `${f.title ?? ''} ${f.body ?? ''} ${f.category ?? ''}`;
        // First-match wins per finding to avoid double-counting.
        for (const { theme, rx } of THEME_PATTERNS) {
            if (rx.test(text)) {
                counts[theme] = (counts[theme] ?? 0) + 1;
                break;
            }
        }
    }
    return Object.entries(counts)
        .map(([theme, count]) => ({ theme, count }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Cross-tabulate (theme × cluster) for the Blast Radius section.
 * For each detected theme, group its findings by the best available
 * "where" bucket — preferring the feature cluster (`feature:cluster:<id>`
 * or `api-list:cluster:<id>`), falling back to the file path, then the
 * `entryPointId`. Returns themes ordered by total finding count and, per
 * theme, buckets ordered by count.
 */
interface BlastEntry { bucket: string; count: number; examples: string[]; }
interface BlastRow { theme: string; total: number; entries: BlastEntry[]; }

function computeBlastRadius(findings: AiReviewFinding[]): BlastRow[] {
    // theme → bucketKey → { count, examples }
    const byTheme: Record<string, Map<string, { count: number; examples: Set<string> }>> = {};
    for (const f of findings) {
        const text = `${f.title ?? ''} ${f.body ?? ''} ${f.category ?? ''}`;
        let matchedTheme: string | undefined;
        for (const { theme, rx } of THEME_PATTERNS) {
            if (rx.test(text)) { matchedTheme = theme; break; }
        }
        if (!matchedTheme) continue;
        const bucketKey = pickBlastBucket(f);
        if (!bucketKey) continue;
        if (!byTheme[matchedTheme]) byTheme[matchedTheme] = new Map();
        let cell = byTheme[matchedTheme].get(bucketKey);
        if (!cell) { cell = { count: 0, examples: new Set() }; byTheme[matchedTheme].set(bucketKey, cell); }
        cell.count += 1;
        if (f.entryPointId && /^[A-Z_]+:/.test(f.entryPointId)) {
            cell.examples.add(f.entryPointId.replace(':', ' '));
        }
    }
    return Object.entries(byTheme).map(([theme, m]) => {
        const entries: BlastEntry[] = Array.from(m.entries())
            .map(([bucket, v]) => ({ bucket, count: v.count, examples: Array.from(v.examples) }))
            .sort((a, b) => b.count - a.count);
        const total = entries.reduce((acc, e) => acc + e.count, 0);
        return { theme, total, entries };
    }).sort((a, b) => b.total - a.total);
}

/**
 * Pick the most informative bucket name for a finding's blast-radius
 * grouping. Preference order:
 *   1. feature:cluster:<id> or feature:<id>  (named feature cluster)
 *   2. api-list:cluster:<id>                  (cluster API list — same name)
 *   3. file: binding's basename               (when no cluster info available)
 *   4. method:route                           (last-resort handler-level)
 */
function pickBlastBucket(f: AiReviewFinding): string {
    const bindings = f.bindings ?? [];
    for (const b of bindings) {
        if (b.layer === 'feature' && b.graphId.startsWith('feature:cluster:')) {
            return `${b.graphId.slice('feature:cluster:'.length)} cluster`;
        }
        if (b.layer === 'feature' && b.graphId.startsWith('feature:') && b.graphId !== 'feature:workspace') {
            return `${b.graphId.slice('feature:'.length)} cluster`;
        }
    }
    for (const b of bindings) {
        if (b.layer === 'api-list' && b.graphId.startsWith('api-list:cluster:')) {
            return `${b.graphId.slice('api-list:cluster:'.length)} cluster`;
        }
    }
    for (const b of bindings) {
        if (b.layer === 'file' && b.graphId.startsWith('file:')) {
            const fp = b.graphId.slice('file:'.length);
            const slash = fp.lastIndexOf('/');
            return slash >= 0 ? fp.slice(slash + 1) : fp;
        }
    }
    if (f.entryPointId && /^[A-Z_]+:/.test(f.entryPointId)) return f.entryPointId.replace(':', ' ');
    return '';
}

// ── Formatting helpers ──────────────────────────────────────────────────

function countsPhrase(c: { error: number; warning: number; info: number }): string {
    const pieces: string[] = [];
    if (c.error > 0) pieces.push(`${c.error} error${c.error === 1 ? '' : 's'}`);
    if (c.warning > 0) pieces.push(`${c.warning} warning${c.warning === 1 ? '' : 's'}`);
    if (c.info > 0) pieces.push(`${c.info} info`);
    return pieces.length === 0 ? 'no findings' : pieces.join(', ');
}

function humanizeGraphId(graphId: string, fallbackFinding: AiReviewFinding): string {
    if (graphId === 'microservice:workspace') return 'workspace';
    if (graphId === 'feature:workspace') return 'workspace-wide';
    if (graphId.startsWith('feature:cluster:')) return `the ${graphId.slice('feature:cluster:'.length)} cluster`;
    if (graphId.startsWith('feature:')) return `the ${graphId.slice('feature:'.length)} cluster`;
    if (graphId.startsWith('api-list:cluster:')) return `${graphId.slice('api-list:cluster:'.length)} APIs`;
    if (graphId.startsWith('api-list:')) return `${graphId.slice('api-list:'.length)} APIs`;
    if (graphId.startsWith('sequence:')) {
        if (fallbackFinding.entryPointId && /^[A-Z_]+:/.test(fallbackFinding.entryPointId)) {
            return fallbackFinding.entryPointId.replace(':', ' ');
        }
        const rest = graphId.slice('sequence:'.length);
        return basename(rest.split(':')[0]);
    }
    if (graphId.startsWith('file:')) return basename(graphId.slice('file:'.length));
    if (graphId.startsWith('flow:')) {
        const rest = graphId.slice('flow:'.length);
        const lastColon = rest.lastIndexOf(':');
        if (lastColon > 0) {
            const file = rest.slice(0, lastColon);
            const fn = rest.slice(lastColon + 1);
            return `${fn} in ${basename(file)}`;
        }
        return rest;
    }
    return graphId;
}

function describeFindingLocation(f: AiReviewFinding): string {
    if (f.entryPointId && /^[A-Z_]+:/.test(f.entryPointId)) return f.entryPointId.replace(':', ' ');
    const fp = (f.anchor as any)?.filePath;
    if (fp) return basename(fp);
    return '';
}

function basename(p: string): string {
    if (!p) return '';
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function clipWords(s: string, maxWords: number): string {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return s;
    return words.slice(0, maxWords).join(' ') + '…';
}
