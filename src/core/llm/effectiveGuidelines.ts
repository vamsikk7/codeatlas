/**
 * ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — effective guidelines merge.
 *
 * The AI review engine accepts ONE guidelines text per run. In multi-repo
 * mode, two sources contribute to that text:
 *
 *   1. `monorepo.db.workspace_review_guidelines` — workspace-wide rules
 *      that apply to every repo (e.g. "all POST routes require auth").
 *   2. `state.db.review_guidelines` (per repo) — repo-specific overrides
 *      (e.g. "this Python repo also requires type hints").
 *
 * `getEffectiveGuidelines(repoId, workspace, repo)` returns the merged
 * text. The merge is line-oriented + deduplicating:
 *
 *   - Workspace rules are listed first under a `## Workspace rules` header.
 *   - Per-repo overrides follow under `## ${repoId} overrides`.
 *   - Duplicate lines (case-insensitive trim) appear ONCE, with the
 *     stricter scope winning. Repo > workspace; later text wins on tie.
 *
 * Empty inputs are handled — when only one side has rules, the headers
 * are dropped so the LLM sees just the rule text.
 *
 * This function is pure — no FS, no DB, no LLM. The aggregator and per-repo
 * readers happen one level up.
 */

export interface GuidelinesSource {
    text: string;
    hash: string;
    updatedAt: number;
}

export interface EffectiveGuidelines {
    /** The merged text the LLM consumes. */
    text: string;
    /** SHA-256 of `text`, truncated to 16 hex chars. Stable across runs. */
    hash: string;
    /** `max(workspace.updatedAt, repo.updatedAt)`. */
    updatedAt: number;
    /** True when workspace had non-empty rules. */
    hasWorkspace: boolean;
    /** True when per-repo had non-empty rules. */
    hasRepo: boolean;
}

const EMPTY_SOURCE: GuidelinesSource = { text: '', hash: '', updatedAt: 0 };

export function getEffectiveGuidelines(
    repoId: string,
    workspace: GuidelinesSource | undefined,
    repo: GuidelinesSource | undefined,
): EffectiveGuidelines {
    const w = (workspace?.text ?? '').trim();
    const r = (repo?.text ?? '').trim();
    const wsTimestamp = workspace?.updatedAt ?? 0;
    const repoTimestamp = repo?.updatedAt ?? 0;
    const updatedAt = Math.max(wsTimestamp, repoTimestamp);

    if (!w && !r) {
        return { text: '', hash: '', updatedAt, hasWorkspace: false, hasRepo: false };
    }

    // Compute dedup-aware rule set. Lines are split, blank lines kept as
    // section separators if both sides contribute, normalised for dedup
    // (lowercase + collapse whitespace) but the original line text is
    // emitted to the LLM.
    const wLines = splitRules(w);
    const rLines = splitRules(r);

    // Repo wins on conflict: stage repo lines first into the dedup set,
    // THEN add workspace lines that don't conflict.
    const seen = new Set<string>();
    const repoEmitted: string[] = [];
    for (const line of rLines) {
        const key = normaliseForDedup(line);
        if (seen.has(key)) continue;
        seen.add(key);
        repoEmitted.push(line);
    }
    const workspaceEmitted: string[] = [];
    for (const line of wLines) {
        const key = normaliseForDedup(line);
        if (seen.has(key)) continue;
        seen.add(key);
        workspaceEmitted.push(line);
    }

    let text = '';
    if (workspaceEmitted.length && repoEmitted.length) {
        text =
            `## Workspace rules\n\n${workspaceEmitted.join('\n')}\n\n` +
            `## ${repoId} overrides\n\n${repoEmitted.join('\n')}`;
    } else if (workspaceEmitted.length) {
        text = workspaceEmitted.join('\n');
    } else {
        text = repoEmitted.join('\n');
    }

    return {
        text,
        hash: hashOf(text),
        updatedAt,
        hasWorkspace: w.length > 0,
        hasRepo: r.length > 0,
    };
}

/** Convenience helper for callers that want the empty marker. */
export function emptyEffectiveGuidelines(): EffectiveGuidelines {
    return { text: '', hash: '', updatedAt: 0, hasWorkspace: false, hasRepo: false };
}

export { EMPTY_SOURCE as EMPTY_GUIDELINES_SOURCE };

// ─── helpers ────────────────────────────────────────────────────────────

function splitRules(text: string): string[] {
    if (!text) return [];
    // Preserve list items + paragraphs as separate rules. Comment lines
    // (#-prefixed Markdown headings inside the user's own text) stay
    // attached to the following paragraph by NOT trimming blank lines —
    // dedup operates on non-empty lines, so headers pass through if the
    // text actually contains them.
    return text
        .split(/\r?\n/)
        .map((l) => l.replace(/[ \t]+$/, ''))
        .filter((l) => l.length > 0);
}

function normaliseForDedup(line: string): string {
    return line.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hashOf(text: string): string {
    if (!text) return '';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
