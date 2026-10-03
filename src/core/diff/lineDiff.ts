/**
 * lineDiff.ts — #925. A compact LCS line-diff + a unified-diff "window" that shows
 * ONLY the affected hunks (`-` old / `+` new / context ± N) with `… N unchanged …`
 * gaps and a LOUD overflow marker (never a silent truncation).
 *
 * The AI-review context builders previously fed the reviewer the HEAD (new) code,
 * line-numbered, with no `+`/`-` markers — so the model couldn't tell what the PR
 * changed and reviewed the file generically, missing change-specific bugs (#925).
 * This produces the actual diff the way a PR reviewer reads it.
 *
 * Self-contained (no deps) so both the mcp `contextPack` and the `core/llm` project
 * reviewer share it without a layering inversion (`core/diff` sits below both).
 */

export interface DiffWindowOpts {
    /** unchanged context lines kept around each change. */
    contextLines: number;
    /** soft cap on emitted lines per file; overflow is MARKED, never silently dropped. */
    maxLines: number;
}
export const DIFF_WINDOW_DEFAULTS: DiffWindowOpts = { contextLines: 4, maxLines: 160 };

export type DiffOp = { t: ' ' | '-' | '+'; text: string; nln?: number };

/** Largest baseline/working line count we run the O(n*m) LCS on; bigger falls back. */
const MAX_DIFF_LINES = 4000;

/**
 * LCS line alignment of `a` (baseline) vs `b` (working): a flat op list of
 * ' ' (context / unchanged), '-' (removed from baseline), '+' (added in working).
 * Working line numbers (`nln`) are attached to context + added ops.
 */
export function lcsLineDiff(a: string[], b: string[]): DiffOp[] {
    const n = a.length, m = b.length;
    const dp: Int32Array[] = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i], next = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            row[j] = a[i] === b[j] ? next[j + 1] + 1 : (next[j] >= row[j + 1] ? next[j] : row[j + 1]);
        }
    }
    const ops: DiffOp[] = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ t: ' ', text: b[j], nln: j + 1 }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', text: a[i] }); i++; }
        else { ops.push({ t: '+', text: b[j], nln: j + 1 }); j++; }
    }
    while (i < n) ops.push({ t: '-', text: a[i++] });
    while (j < m) { ops.push({ t: '+', text: b[j], nln: j + 1 }); j++; }
    return ops;
}

/**
 * Unified-diff window of `working` vs `baseline`: the affected hunks only, each line
 * prefixed `+<n>: ` (added) / `-     ` (removed) / ` <n>: ` (context), with
 * `… N unchanged …` gaps between hunks. CHANGED (`+`/`-`) lines are ALWAYS emitted —
 * `maxLines` caps only CONTEXT lines, and a `maxLines×4` hard ceiling bounds a
 * pathological all-changed file; anything dropped gets a loud `… NOT shown …` marker
 * (#938). Returns '' when identical. When baseline is absent
 * (new file) every line is marked `+` under a NEW FILE banner; when either side is
 * too large to diff the head is shown under a loud TOO LARGE TO DIFF banner (#930).
 */
export function unifiedDiffWindow(working: string, baseline: string | undefined, opts: DiffWindowOpts = DIFF_WINDOW_DEFAULTS): string {
    const b = working.split('\n');
    // #930 — NEW FILE (no baseline version): every line is an ADDITION, so mark
    // each `+N:` and head it with a NEW FILE banner. A plain `N: ` dump (the old
    // behaviour) reads to the model as pre-existing/unchanged context, so bugs in
    // newly-added non-entry files were never attributed to the PR.
    if (baseline === undefined) {
        // #938 — a new file is ENTIRELY added (changed) lines, so cap it at the same
        // maxLines×4 hard ceiling the diff path applies to changed lines — NOT maxLines
        // (which truncated keycloak #36880's new ClientPermissionsV2.java at 200 and hid
        // the buggy hasPermission body past line 200). `maxLines` budgets context; there
        // is no context in an all-added file, so the ceiling governs.
        const cap = opts.maxLines * 4;
        const shown = b.slice(0, cap).map((l, i) => `+${i + 1}: ${l}`);
        if (b.length > cap) {
            shown.push(`        … +${b.length - cap} more added lines beyond the ${cap}-line hard cap — NOT shown …`);
        }
        return `        … NEW FILE — all ${b.length} line${b.length === 1 ? '' : 's'} added …\n${shown.join('\n')}`;
    }
    const a = baseline.split('\n');
    // #930 — TOO LARGE TO DIFF (the O(n*m) LCS guard): we can't compute which
    // lines changed, so show the head numbered with a LOUD banner making it
    // explicit the `+`/`-` markers are ABSENT here — never let a markerless dump
    // be mistaken for "all unchanged".
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
        const head = b.slice(0, opts.maxLines).map((l, i) => `${i + 1}: ${l}`).join('\n');
        return `        … FILE TOO LARGE TO DIFF (${b.length} working / ${a.length} baseline lines) — showing head; changed lines are NOT marked …\n${head}`;
    }
    const ops = lcsLineDiff(a, b);
    if (!ops.some((o) => o.t !== ' ')) return ''; // identical content
    const keep = new Array<boolean>(ops.length).fill(false);
    for (let k = 0; k < ops.length; k++) {
        if (ops[k].t === ' ') continue;
        for (let x = k - opts.contextLines; x <= k + opts.contextLines; x++) {
            if (x >= 0 && x < ops.length) keep[x] = true;
        }
    }
    const out: string[] = [];
    let drop = 0, emitted = 0, skippedCtx = 0, skippedChg = 0;
    // #938 — a reviewer MUST see every changed (`+`/`-`) line; only CONTEXT lines are
    // subject to the maxLines budget. Previously the budget dropped changed lines too,
    // so a buggy changed line in a large file fell past the window (keycloak #36880's
    // `+88 more … NOT shown`, grafana #90939). A hard ceiling (maxLines×4) still bounds a
    // pathological all-changed file; what's dropped is marked loudly, never silent.
    const hardCeil = opts.maxLines * 4;
    for (let k = 0; k < ops.length; k++) {
        if (!keep[k]) { drop++; continue; }
        const o = ops[k];
        const isChanged = o.t !== ' ';
        if (emitted >= hardCeil) { if (isChanged) skippedChg++; else skippedCtx++; drop++; continue; }
        if (!isChanged && emitted >= opts.maxLines) { skippedCtx++; drop++; continue; }
        if (drop > 0) { out.push(`        … ${drop} unchanged …`); drop = 0; }
        const prefix = o.t === '+' ? `+${o.nln}: ` : o.t === '-' ? '-     ' : ` ${o.nln}: `;
        out.push(prefix + o.text);
        emitted++;
    }
    if (skippedChg > 0) out.push(`        … +${skippedChg} more CHANGED lines beyond the ${hardCeil}-line hard cap — NOT shown …`);
    if (skippedCtx > 0) out.push(`        … +${skippedCtx} more context lines beyond the ${opts.maxLines}-line window — NOT shown …`);
    return out.join('\n');
}
