// #948–#953 — deterministic false-positive reducers applied to the merged review
// findings before they become PR comments / extension findings. Sourced from a
// failure-mode analysis of 90 real false positives
// (e2e/benchmark/BENCHMARK_DEEPSEEK_CODEATLAS.md): the dominant mechanically-
// removable classes are OFF_DIFF_FILE (a finding on context code the PR never
// changed), low-value TEST_CODE nits, and DUPLICATE restatements. These run as a
// backstop to the prompt-level precision gates so the reducer holds even when the
// model ignores the instruction. Shared by the extension review path, the PR
// watcher / review-pr CLI, and the MCP filter_review_findings tool.

import type { AiReviewFinding } from '../graph/graphTypes';

/** Test / spec / fixture path detector (mirrors dependencyContext.TEST_RX + cypress/e2e). */
const TEST_PATH_RX = /(\.|_)(test|spec)\.|(^|\/)(tests?|specs?|__tests__|cypress|e2e|fixtures?)\//i;

export type DropReason = 'off-diff' | 'test-nit' | 'duplicate';

export interface ReviewFilterResult {
    kept: AiReviewFinding[];
    dropped: { finding: AiReviewFinding; reason: DropReason }[];
}

export interface ReviewFilterOptions {
    /** #949 — drop findings whose anchor file is not in the PR diff. Default on. */
    dropOffDiff?: boolean;
    /** #951 — drop `info`-severity findings on test/spec/fixture files (keep real test bugs). Default on. */
    demoteTestNits?: boolean;
    /** #953 — collapse near-duplicate findings (same defect restated). Default on. */
    dedupe?: boolean;
}

const norm = (p: string | undefined): string => (p ?? '').replace(/^\.\//, '').trim();
const baseName = (p: string): string => norm(p).split('/').pop() ?? norm(p);
const normTitle = (t: string | undefined): string => (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * #953 — two findings describe the SAME defect (root cause) when they are on the
 * SAME file AND one of: same anchored symbol, same normalized title, or the same
 * exact line span. Conservative on purpose — span EQUALITY (not overlap) and a
 * same-file gate avoid merging two genuinely distinct bugs. Cross-file
 * sibling-impl merging ("Office365 same as Lark") is left to the LLM consolidation
 * pass; this deterministic pass only collapses restatements of one defect.
 */
function sameRootCause(a: AiReviewFinding, b: AiReviewFinding): boolean {
    const fa = norm(a.anchor?.filePath);
    const fb = norm(b.anchor?.filePath);
    if (!fa || fa !== fb) return false;
    const sa = (a.anchor?.symbol ?? '').trim().toLowerCase();
    const sb = (b.anchor?.symbol ?? '').trim().toLowerCase();
    if (sa && sa === sb) return true;
    const ta = normTitle(a.title);
    if (ta && ta === normTitle(b.title)) return true;
    const aStart = a.anchor?.lineStart;
    const bStart = b.anchor?.lineStart;
    if (aStart != null && aStart === bStart && (a.anchor?.lineEnd ?? aStart) === (b.anchor?.lineEnd ?? bStart)) return true;
    return false;
}

/**
 * #953 — deterministic product-side de-duplication: collapse near-duplicate
 * findings (same defect restated) into one, keeping the first occurrence. Order-
 * stable. Returns the kept list and the dropped duplicates.
 */
export function dedupeFindings(findings: AiReviewFinding[]): { kept: AiReviewFinding[]; dropped: AiReviewFinding[] } {
    const kept: AiReviewFinding[] = [];
    const dropped: AiReviewFinding[] = [];
    for (const f of findings) {
        if (kept.some((k) => sameRootCause(k, f))) dropped.push(f);
        else kept.push(f);
    }
    return { kept, dropped };
}

/**
 * Filter false positives from a merged review-finding list. Deterministic: same
 * input → same output. When `changedFiles` is empty the off-diff gate is a no-op
 * (we can't know the diff scope), so the function is safe to call unconditionally.
 */
export function filterReviewFindings(
    findings: AiReviewFinding[],
    changedFiles: Set<string> | string[],
    opts: ReviewFilterOptions = {},
): ReviewFilterResult {
    const { dropOffDiff = true, demoteTestNits = true, dedupe = true } = opts;
    const changed = changedFiles instanceof Set ? changedFiles : new Set(changedFiles);
    const changedNorm = new Set([...changed].map(norm));
    const changedBase = new Set([...changedNorm].map(baseName));

    const survivors: AiReviewFinding[] = [];
    const dropped: ReviewFilterResult['dropped'] = [];

    for (const f of findings) {
        const fp = norm(f.anchor?.filePath);

        // #949 — OFF_DIFF: a finding anchored to a file the PR never changed is
        // reviewing context code (callers/dependents/entry-point packs). A golden
        // defect is graded on changed lines, so this is almost always a false
        // positive. Lenient basename fallback avoids dropping on path-format drift.
        if (dropOffDiff && changedNorm.size && fp && !changedNorm.has(fp) && !changedBase.has(baseName(fp))) {
            dropped.push({ finding: f, reason: 'off-diff' });
            continue;
        }

        // #951 — TEST_CODE: drop only LOW-severity (`info`) nits on test files
        // (stale ids, HTTP-status, placeholder creds). Keep `warning`/`error` —
        // a real test-correctness bug is a legitimate finding.
        if (demoteTestNits && fp && TEST_PATH_RX.test(fp) && f.severity === 'info') {
            dropped.push({ finding: f, reason: 'test-nit' });
            continue;
        }

        survivors.push(f);
    }

    // #953 — collapse near-duplicate restatements of the same defect.
    let kept = survivors;
    if (dedupe) {
        const d = dedupeFindings(survivors);
        kept = d.kept;
        for (const f of d.dropped) dropped.push({ finding: f, reason: 'duplicate' });
    }

    return { kept, dropped };
}

/** Minimal store surface needed to finalize findings — satisfied by SnapshotStore. */
export interface FindingStoreLike {
    listAiReviewFindings(filter?: { status?: string }): AiReviewFinding[];
    updateAiReviewFindingStatus(id: string, status: 'ignored', opts?: { actor?: string; note?: string }): unknown;
}

/** Store surface for deriving the changed-file set from working↔baseline hashes. */
export interface WorkingBaselineStoreLike {
    getWorking(): { files?: Record<string, { hash?: string }> };
    getBaseline?(): { files?: Record<string, { hash?: string }> };
}

/**
 * #949 — the changed-file set for a diff-scoped ('changed') review: working files
 * whose content hash differs from baseline (incl. brand-new files absent from
 * baseline). Used to feed the off-diff gate when the extension reviews "changed".
 */
export function changedFilesFromStoreHashes(store: WorkingBaselineStoreLike): Set<string> {
    const set = new Set<string>();
    const wf = store.getWorking()?.files ?? {};
    const bf = store.getBaseline?.()?.files ?? {};
    for (const [fp, rec] of Object.entries(wf)) {
        const base = (bf as Record<string, { hash?: string }>)[fp];
        if (!base || base.hash !== rec.hash) set.add(fp);
    }
    return set;
}

/**
 * #948–#953 — finalize a review by applying the FP filter + dedup to the OPEN
 * findings already persisted in the store, marking the dropped ones `ignored`
 * (recoverable — the user can reopen). Shared by the extension review path
 * (runFullReview) and the PR-watcher / review-pr CLI so all flows converge on the
 * same precision. Returns how many were ignored, by reason. `changedFiles` empty
 * → off-diff is a no-op (dedup + test-nit still apply).
 */
export function finalizeFindingsInStore(
    store: FindingStoreLike,
    changedFiles: Set<string> | string[],
    opts?: ReviewFilterOptions,
): { ignored: number; byReason: Record<DropReason, number> } {
    const open = store.listAiReviewFindings({ status: 'open' });
    const { dropped } = filterReviewFindings(open, changedFiles, opts);
    const byReason = { 'off-diff': 0, 'test-nit': 0, duplicate: 0 } as Record<DropReason, number>;
    for (const d of dropped) {
        store.updateAiReviewFindingStatus(d.finding.id, 'ignored', { actor: 'fp-filter', note: `auto-filtered: ${d.reason}` });
        byReason[d.reason] += 1;
    }
    return { ignored: dropped.length, byReason };
}
