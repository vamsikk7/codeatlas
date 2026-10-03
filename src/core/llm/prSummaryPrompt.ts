/**
 * prSummaryPrompt.ts — strict instruction schema for an LLM-produced PR
 * review summary.
 *
 * What this module owns:
 *
 *   1. `buildPrSummarySystemPrompt(...)` — the canonical system instruction
 *      string. Five fixed output blocks in order:
 *        Header → Summary → Interpretation → Findings → Instructions
 *      The Interpretation block is what turns a list of findings into a
 *      review (reframe + shift + pattern). Findings carry an explicit
 *      `mechanism` field. Instructions reference findings by id
 *      (addresses: ["F1","F2"]) with an observable acceptance condition.
 *      The merge-blocker checklist is a strict subset of Instructions.
 *
 *   2. `validatePrSummary(...)` — enforces the mapping rules deterministically
 *      AFTER the LLM responds:
 *        - no orphan criticals (every `error` finding is addressed)
 *        - no invented instructions (every `addresses[]` id exists in Findings)
 *        - severity-flows-up consistency between Findings and the headline
 *          Summary/Recommendation
 *
 * This keeps the prompt instruction and its validation in one file so they
 * can't drift. The validator returns a structured report rather than throwing
 * so callers can decide policy (drop the run, fall back to a partial render,
 * emit a quality toast, etc).
 */

// ── Public types ────────────────────────────────────────────────────────

export type PrSeverity = 'info' | 'warning' | 'error';

export type PrRecommendation =
    | 'merge'
    | 'merge-with-followups'
    | 'request-changes'
    | 'block';

export interface PrSummaryFinding {
    /** Stable per-summary id — `F1`, `F2`, … Used by Instructions to address. */
    id: string;
    severity: PrSeverity;
    /** One of a small open enum — security, perf, logic, api, etc. Caller picks vocabulary. */
    category: string;
    /** ≤ 80 chars, one-line. */
    title: string;
    /**
     * MECHANISM — the *how* the issue causes harm. What sets findings apart
     * from a linter dump. ≤ 240 chars. Example: "Missing CSRF token allows
     * any third-party origin to issue authenticated POST /users requests."
     */
    mechanism: string;
    /** 1–3 sentence explanation + suggested direction. */
    body: string;
    /** Optional file / symbol anchor for the editor jump. */
    anchor?: { filePath?: string; symbol?: string; lineStart?: number; lineEnd?: number };
    /** Verbatim source snippet — required for non-info severities. */
    evidence?: { snippet: string; filePath?: string; lineStart?: number; lineEnd?: number };
}

export interface PrSummaryInstruction {
    /** Stable per-summary id — `I1`, `I2`, … */
    id: string;
    /** Finding ids this instruction resolves — `["F1","F2"]`. Must be non-empty. */
    addresses: string[];
    /** Imperative action — ≤ 200 chars. "Add a CSRF middleware to /users." */
    action: string;
    /**
     * ACCEPTANCE — the observable condition that makes "done" verifiable.
     * Should describe what a reviewer would check, not implementation steps.
     * Example: "POST /users responds 403 when X-CSRF-Token header is missing."
     */
    acceptance: string;
}

export interface PrInterpretationBlock {
    /** Reframe — what the diff is really doing, in plain English. */
    reframe: string;
    /** Before / after / implication triplet. Each ≤ 200 chars. */
    shift: { before: string; after: string; implication: string };
    /** A single sentence that names the dominant pattern across findings. */
    pattern: string;
}

export interface PrSummaryDoc {
    /** Header — one-line title + recommendation. */
    header: { title: string; recommendation: PrRecommendation; severity: PrSeverity };
    /** Summary — ≤ 4 sentences. The "what changed, at what cost" line. */
    summary: string;
    interpretation: PrInterpretationBlock;
    findings: PrSummaryFinding[];
    instructions: {
        items: PrSummaryInstruction[];
        /** Strict subset of `items[].id` — instructions that must land before merge. */
        mergeBlockers: string[];
    };
}

// ── System prompt ───────────────────────────────────────────────────────

export interface BuildPromptOpts {
    /** User-supplied review guidelines, injected verbatim. */
    guidelinesText?: string;
    /** Optional vocabulary cap for the `category` field. Default: 7 stock categories. */
    categories?: string[];
}

const DEFAULT_CATEGORIES = [
    'security', 'auth', 'api-design', 'logic-bug',
    'performance', 'code-quality', 'architecture',
];

export function buildPrSummarySystemPrompt(opts: BuildPromptOpts = {}): string {
    const categories = (opts.categories ?? DEFAULT_CATEGORIES).map((c) => `"${c}"`).join(' | ');
    const lines: string[] = [
        'You are a senior reviewer producing a PR-style review summary of a code change.',
        'Your output is a single JSON document with FIVE fixed top-level blocks, in this exact order:',
        '  1) "header"          — title + recommendation + headline severity',
        '  2) "summary"         — ≤ 4 plain-English sentences: what changed, at what cost',
        '  3) "interpretation"  — what turns a list of findings into a review',
        '  4) "findings"        — strict per-entry schema with a MECHANISM field',
        '  5) "instructions"    — actions that address findings, with an acceptance condition',
        '',
        'BLOCK SHAPES — must match exactly:',
        '',
        '"header": {',
        '  "title":           string (≤ 80 chars),',
        '  "recommendation":  "merge" | "merge-with-followups" | "request-changes" | "block",',
        '  "severity":        "info" | "warning" | "error"',
        '}',
        '',
        '"summary": string  // ≤ 4 sentences. Name the change + the cost it introduces.',
        '',
        '"interpretation": {',
        '  "reframe":     string  // plain-English statement of what the diff is REALLY doing',
        '  "shift":       { "before": string, "after": string, "implication": string }',
        '  "pattern":     string  // ONE sentence: the dominant pattern across all findings',
        '}',
        '',
        '"findings": [',
        '  {',
        '    "id":         "F1" | "F2" | …  // stable per-summary ids in order',
        '    "severity":   "info" | "warning" | "error",',
        `    "category":   ${categories},`,
        '    "title":      string (≤ 80 chars),',
        '    "mechanism":  string (≤ 240 chars)  // the *how* — what makes this a review,',
        '                                       // not a linter dump. Example: "Missing CSRF',
        '                                       // token allows any third-party origin to',
        '                                       // issue authenticated POST /users requests."',
        '    "body":       string (1–3 sentences explaining the issue + suggested direction),',
        '    "anchor":     { "filePath"?, "symbol"?, "lineStart"?, "lineEnd"? }?,',
        '    "evidence":   { "snippet": string, "filePath"?, "lineStart"?, "lineEnd"? }?',
        '  }',
        ']',
        '',
        '"instructions": {',
        '  "items": [',
        '    {',
        '      "id":         "I1" | "I2" | …',
        '      "addresses":  ["F1", "F2"]  // finding ids this instruction resolves. NON-EMPTY.',
        '      "action":     string (≤ 200 chars, imperative),',
        '      "acceptance": string  // observable condition. Describes what a reviewer would',
        '                           // check, not the implementation steps. Example:',
        '                           // "POST /users responds 403 when X-CSRF-Token is missing."',
        '    }',
        '  ],',
        '  "mergeBlockers": [string]  // STRICT SUBSET of items[].id — instructions that must',
        '                            // land before merge.',
        '}',
        '',
        'MAPPING RULES — non-negotiable:',
        '',
        '  R1. No orphan criticals.',
        '      Every finding with severity="error" MUST have at least one instruction whose',
        '      `addresses[]` contains its id. The reviewer never names a critical without',
        '      saying how to clear it.',
        '',
        '  R2. No invented instructions.',
        '      Every id in any `addresses[]` MUST appear as a `findings[i].id`. You cannot',
        '      cite a finding that doesn\'t exist in this document.',
        '',
        '  R3. mergeBlockers is a strict subset.',
        '      Every id in `instructions.mergeBlockers` MUST appear in `instructions.items[].id`.',
        '      If you would mark any error-severity finding "must fix before merge", its',
        '      addressing instruction belongs in mergeBlockers.',
        '',
        '  R4. Severity flows up.',
        '      `header.severity` MUST equal the MAX severity across `findings[*].severity`',
        '      using rank error > warning > info. If you emit ANY error, the headline cannot',
        '      claim "info".',
        '',
        '  R5. recommendation matches severity + mergeBlockers.',
        '      • severity="error" AND mergeBlockers.length > 0  →  recommendation="block"',
        '      • severity="error" AND mergeBlockers.length == 0 →  recommendation="request-changes"',
        '      • severity="warning"                              →  "merge-with-followups"',
        '      • severity="info"                                 →  "merge"',
        '',
        'EVIDENCE RULE:',
        '  Every non-info finding MUST include `evidence.snippet` quoting 1–5 lines copied',
        '  VERBATIM from the source we provide. Do not invent code. Findings without',
        '  verifiable evidence will be dropped server-side.',
        '',
        'STYLE:',
        '  - Plain English. No vendor jargon.',
        '  - "mechanism" is the *how*. Avoid restating the title.',
        '  - "acceptance" is testable. A reviewer should be able to run / check it.',
        '  - Do not enumerate findings inside `interpretation` or `summary` — those blocks',
        '    are about meaning, not lists.',
        '',
        'OUTPUT:',
        '  Return ONLY the JSON document. No prose, no markdown, no code fences.',
    ];

    if (opts.guidelinesText && opts.guidelinesText.trim()) {
        lines.push('');
        lines.push('[USER GUIDELINES BEGIN]');
        lines.push(opts.guidelinesText.trim());
        lines.push('[USER GUIDELINES END]');
        lines.push('');
        lines.push('The user guidelines above are the ONLY guidelines. Do not invent additional ones.');
        lines.push('Only flag a "guideline"-category finding when (a) the guideline applies to this');
        lines.push('change and (b) you can quote evidence from the source.');
    }

    return lines.join('\n');
}

// ── Validator ────────────────────────────────────────────────────────────

export interface ValidationViolation {
    rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'shape';
    detail: string;
    /** Optional finding / instruction id this violation points at. */
    refId?: string;
}

export interface ValidationReport {
    ok: boolean;
    violations: ValidationViolation[];
}

const SEV_RANK: Record<PrSeverity, number> = { info: 0, warning: 1, error: 2 };
const RANK_SEV: PrSeverity[] = ['info', 'warning', 'error'];

/**
 * Validate a candidate PR summary against the schema and the five mapping
 * rules. Returns a structured report — the caller decides whether to retry,
 * fall back, or surface the violations as a quality toast.
 */
export function validatePrSummary(doc: unknown): ValidationReport {
    const violations: ValidationViolation[] = [];
    const push = (rule: ValidationViolation['rule'], detail: string, refId?: string): void => {
        violations.push({ rule, detail, ...(refId ? { refId } : {}) });
    };

    if (!doc || typeof doc !== 'object') {
        push('shape', 'doc is not an object');
        return { ok: false, violations };
    }
    const d = doc as Partial<PrSummaryDoc>;

    // ── Shape checks ────────────────────────────────────────────────────
    if (!d.header || typeof d.header !== 'object') push('shape', 'missing header');
    if (typeof d.summary !== 'string' || d.summary.trim() === '') push('shape', 'missing summary');
    if (!d.interpretation || typeof d.interpretation !== 'object') push('shape', 'missing interpretation');
    if (!Array.isArray(d.findings)) push('shape', 'findings is not an array');
    if (!d.instructions || typeof d.instructions !== 'object') push('shape', 'missing instructions');

    if (d.interpretation) {
        const i = d.interpretation;
        if (typeof i.reframe !== 'string' || !i.reframe.trim()) push('shape', 'interpretation.reframe missing');
        if (!i.shift || typeof i.shift !== 'object') push('shape', 'interpretation.shift missing');
        else {
            if (typeof i.shift.before !== 'string') push('shape', 'interpretation.shift.before missing');
            if (typeof i.shift.after !== 'string') push('shape', 'interpretation.shift.after missing');
            if (typeof i.shift.implication !== 'string') push('shape', 'interpretation.shift.implication missing');
        }
        if (typeof i.pattern !== 'string' || !i.pattern.trim()) push('shape', 'interpretation.pattern missing');
    }

    const findings = Array.isArray(d.findings) ? d.findings : [];
    const findingIds = new Set<string>();
    for (const f of findings) {
        if (!f || typeof f !== 'object') { push('shape', 'finding is not an object'); continue; }
        if (typeof f.id !== 'string' || !/^F\d+$/.test(f.id)) push('shape', `finding.id must match /^F\\d+$/`, (f as any).id);
        if (!isSeverity(f.severity)) push('shape', `finding.${f.id ?? '?'}.severity invalid`, f.id);
        if (typeof f.title !== 'string' || !f.title.trim()) push('shape', `finding.${f.id ?? '?'}.title missing`, f.id);
        if (typeof f.mechanism !== 'string' || !f.mechanism.trim()) push('shape', `finding.${f.id ?? '?'}.mechanism missing — this is the field that distinguishes a review from a linter dump`, f.id);
        if (typeof f.body !== 'string' || !f.body.trim()) push('shape', `finding.${f.id ?? '?'}.body missing`, f.id);
        if (f.id) findingIds.add(f.id);
    }

    const instr = d.instructions ?? { items: [], mergeBlockers: [] };
    const items = Array.isArray(instr.items) ? instr.items : [];
    const mergeBlockers = Array.isArray(instr.mergeBlockers) ? instr.mergeBlockers : [];
    const itemIds = new Set<string>();
    for (const it of items) {
        if (!it || typeof it !== 'object') { push('shape', 'instruction is not an object'); continue; }
        if (typeof it.id !== 'string' || !/^I\d+$/.test(it.id)) push('shape', `instruction.id must match /^I\\d+$/`, (it as any).id);
        if (!Array.isArray(it.addresses) || it.addresses.length === 0) push('shape', `instruction.${it.id ?? '?'}.addresses must be non-empty`, it.id);
        if (typeof it.action !== 'string' || !it.action.trim()) push('shape', `instruction.${it.id ?? '?'}.action missing`, it.id);
        if (typeof it.acceptance !== 'string' || !it.acceptance.trim()) push('shape', `instruction.${it.id ?? '?'}.acceptance missing — every instruction must carry an observable acceptance condition`, it.id);
        if (it.id) itemIds.add(it.id);
    }

    // ── R1: no orphan criticals ─────────────────────────────────────────
    const errorFindings = findings.filter((f) => f && f.severity === 'error' && f.id);
    const addressedIds = new Set<string>();
    for (const it of items) for (const a of (it?.addresses ?? [])) addressedIds.add(a);
    for (const f of errorFindings) {
        if (!addressedIds.has(f.id)) {
            push('R1', `${f.id} is severity=error but no instruction addresses it`, f.id);
        }
    }

    // ── R2: no invented instructions ────────────────────────────────────
    for (const it of items) {
        for (const a of (it?.addresses ?? [])) {
            if (!findingIds.has(a)) {
                push('R2', `${it.id ?? '?'} addresses ${a} but that finding does not exist`, it.id);
            }
        }
    }

    // ── R3: mergeBlockers is a strict subset of items[].id ──────────────
    for (const id of mergeBlockers) {
        if (!itemIds.has(id)) {
            push('R3', `mergeBlockers includes ${id} but no instruction has that id`, id);
        }
    }

    // ── R4: header.severity = max(findings[*].severity) ─────────────────
    if (d.header && findings.length > 0) {
        const ranks = findings
            .filter((f) => f && isSeverity(f.severity))
            .map((f) => SEV_RANK[f.severity as PrSeverity]);
        const maxRank = ranks.length > 0 ? Math.max(...ranks) : 0;
        const maxFindingSev: PrSeverity = RANK_SEV[maxRank] ?? 'info';
        const headerSev: PrSeverity = isSeverity((d.header as any).severity) ? ((d.header as any).severity as PrSeverity) : 'info';
        if (SEV_RANK[headerSev] < SEV_RANK[maxFindingSev]) {
            push('R4', `header.severity="${headerSev}" but findings contain severity="${maxFindingSev}" — severity must flow up`);
        }
    }

    // ── R5: recommendation matches severity + mergeBlockers ─────────────
    if (d.header) {
        const sev = isSeverity((d.header as any).severity) ? (d.header as any).severity : 'info';
        const rec = (d.header as any).recommendation as PrRecommendation;
        const expected = expectedRecommendation(sev, mergeBlockers.length > 0);
        if (rec !== expected) {
            push('R5', `header.recommendation="${rec}" but expected "${expected}" (severity="${sev}", mergeBlockers=${mergeBlockers.length})`);
        }
    }

    return { ok: violations.length === 0, violations };
}

function isSeverity(s: unknown): s is PrSeverity {
    return s === 'info' || s === 'warning' || s === 'error';
}

function expectedRecommendation(sev: PrSeverity, hasMergeBlockers: boolean): PrRecommendation {
    if (sev === 'error' && hasMergeBlockers) return 'block';
    if (sev === 'error') return 'request-changes';
    if (sev === 'warning') return 'merge-with-followups';
    return 'merge';
}
