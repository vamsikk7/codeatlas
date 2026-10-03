/**
 * findingSchema.ts — Zod-backed parser + auto-repair for raw LLM finding JSON.
 *
 * Issue #704. Two-pass parsing per finding:
 *   - **strict**: matches the prompt's specified shape exactly (recommended for
 *     capable models that quote verbatim).
 *   - **relaxed** (default): applies targeted repairs before validation —
 *     severity case + array-unwrap, layer-array wrapping, default missing
 *     `category` to `'code-quality'`, default missing `title` to first line
 *     of `body`. Recommended for small local coder models (deepseek-coder,
 *     qwen2.5-coder) where paraphrase + casing drift are the norm.
 *
 * On top of per-finding repair, the raw-text preprocessing strips Markdown
 * code fences and trailing commas — the two most common JSON-mode failure
 * modes across providers (Ollama, OpenRouter, Anthropic, OpenAI).
 *
 * Callers should prefer `parseFindings(rawText, tolerance)` over the older
 * `extractFindingsJson(rawText)`, which is kept as a thin wrapper for
 * backward compatibility (it routes through `relaxed` mode).
 */

import { z } from 'zod';
import { parseLlmJson } from './safeJson';
import type { AiReviewSeverity, AiReviewCategory, DiagramType } from '../graph/graphTypes';

const SEVERITIES = ['info', 'warning', 'error'] as const;
const CATEGORIES = [
    'architecture',
    'api-design',
    'code-quality',
    'logic-bug',
    'security',
    'performance',
    'guideline',
] as const;
const DIAGRAM_TYPES = [
    'sequence', 'file', 'flow', 'feature', 'microservice', 'api-list', 'health', 'screen-content',
] as const satisfies readonly DiagramType[];

/**
 * Mirror of `RawLlmFinding` from `perEntryReviewer.ts`. Kept here to avoid an
 * import cycle (perEntryReviewer imports findingSchema downstream).
 */
export interface RawLlmFinding {
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    layers: DiagramType[];
    anchor?: { filePath?: string; symbol?: string };
    evidence?: { filePath?: string; lineStart?: number; lineEnd?: number; snippet: string };
}

const anchorSchema = z.object({
    filePath: z.string().optional(),
    symbol: z.string().optional(),
}).optional();

const evidenceSchema = z.object({
    filePath: z.string().optional(),
    lineStart: z.number().optional(),
    lineEnd: z.number().optional(),
    snippet: z.string(),
}).optional();

/**
 * Strict shape: every required field must match the prompt's contract
 * exactly. Used when the producing model is trusted to honor structured
 * output (gpt-4o, claude-3.5-sonnet, gemini-1.5-pro).
 */
export const strictFindingSchema = z.object({
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES),
    title: z.string().min(1),
    body: z.string(),
    layers: z.array(z.enum(DIAGRAM_TYPES)),
    anchor: anchorSchema,
    evidence: evidenceSchema,
});

/**
 * Relaxed shape: tolerates the most common LLM divergences observed in the
 * #527 / #605 bench corpora. Each `preprocess` block runs once at parse
 * time and is idempotent — passing already-clean values through is a no-op.
 *
 *   - severity: `'Error'`, `'ERROR'`, `['error']` → `'error'`
 *   - category: missing or typo → `'code-quality'` (the cheapest safe bucket)
 *   - title: missing → first non-empty line of body (so the UI has a label)
 *   - body: missing → empty string (the UI handles empty bodies fine)
 *   - layers: missing or non-array → empty array (binder treats as "no layer claim")
 */
export const relaxedFindingSchema = z.object({
    severity: z.preprocess(coerceSeverity, z.enum(SEVERITIES)),
    category: z.preprocess(coerceCategory, z.enum(CATEGORIES)),
    title: z.preprocess(coerceTitle, z.string()),
    body: z.preprocess(v => typeof v === 'string' ? v : '', z.string()),
    layers: z.preprocess(coerceLayers, z.array(z.enum(DIAGRAM_TYPES))),
    anchor: anchorSchema,
    evidence: evidenceSchema,
});

function coerceSeverity(v: unknown): unknown {
    // Unwrap single-element arrays — some local models emit ['error'].
    if (Array.isArray(v) && v.length === 1) v = v[0];
    if (typeof v !== 'string') return 'info';
    const lower = v.trim().toLowerCase();
    // Common aliases.
    if (lower === 'high' || lower === 'critical') return 'error';
    if (lower === 'medium' || lower === 'med') return 'warning';
    if (lower === 'low' || lower === 'note') return 'info';
    return lower;
}

function coerceCategory(v: unknown): unknown {
    if (typeof v !== 'string') return 'code-quality';
    const lower = v.trim().toLowerCase().replace(/[_\s]+/g, '-');
    // Exact match wins.
    if ((CATEGORIES as readonly string[]).includes(lower)) return lower;
    // Common synonyms / typos seen in deepseek-coder traces.
    if (lower === 'bug' || lower === 'bugs' || lower === 'logic') return 'logic-bug';
    if (lower === 'perf') return 'performance';
    if (lower === 'sec' || lower === 'vulnerability') return 'security';
    if (lower === 'design' || lower === 'arch') return 'architecture';
    if (lower === 'api' || lower === 'rest') return 'api-design';
    if (lower === 'style' || lower === 'quality') return 'code-quality';
    return 'code-quality';
}

function coerceTitle(v: unknown): unknown {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    return ''; // strict schema requires non-empty; relaxed falls through to default below.
}

function coerceLayers(v: unknown): unknown {
    if (Array.isArray(v)) {
        return v.filter(x => typeof x === 'string' && (DIAGRAM_TYPES as readonly string[]).includes(x));
    }
    if (typeof v === 'string' && (DIAGRAM_TYPES as readonly string[]).includes(v)) {
        return [v];
    }
    return [];
}

/**
 * Pre-JSON.parse cleanup of the raw LLM response. Idempotent.
 *
 *   - Strips ```json fences (already handled by the legacy extractor).
 *   - Strips a leading/trailing prose paragraph (also legacy).
 *   - Strips trailing commas before `]` / `}` — common JSON-mode bug across
 *     OpenAI's response_format=json_object, Ollama's format=json, and most
 *     small coder models.
 */
function cleanRawText(rawText: string): string {
    return rawText
        .replace(/```(?:json|JSON)?\s*/g, '')
        .replace(/```/g, '')
        .replace(/,(\s*[\]}])/g, '$1'); // trailing commas
}

/**
 * Extract the first balanced JSON object from a (cleaned) text. Walks brace
 * depth while respecting string boundaries and `\"` escapes. Returns `null`
 * if no balanced object is present.
 */
function extractBalancedJson(text: string): string | null {
    const firstBrace = text.indexOf('{');
    if (firstBrace < 0) return null;
    let depth = 0, inString = false, escape = false;
    for (let i = firstBrace; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(firstBrace, i + 1);
        }
    }
    return null;
}

export type FindingParseTolerance = 'strict' | 'relaxed';

export interface ParsedFindings {
    findings: RawLlmFinding[];
    /** Number of items the strict pass rejected and the relaxed pass repaired. */
    repaired: number;
    /** Number of items both passes rejected (dropped entirely). */
    dropped: number;
}

/**
 * Parse + validate a raw LLM response into a list of `RawLlmFinding`.
 *
 * Two-pass per item:
 *   1. Strict schema. If it passes, keep verbatim.
 *   2. If strict fails AND `tolerance === 'relaxed'`, run the relaxed schema
 *      (with the coercion preprocessors). If that passes, keep + bump
 *      `repaired`.
 *   3. Else, drop + bump `dropped`.
 *
 * Returns an empty list (and zero counts) on totally unparseable text.
 */
export function parseFindings(
    rawText: string,
    tolerance: FindingParseTolerance = 'relaxed',
): ParsedFindings {
    const cleaned = cleanRawText(rawText);
    const blob = extractBalancedJson(cleaned);
    if (!blob) return { findings: [], repaired: 0, dropped: 0 };

    let parsed: unknown;
    try {
        parsed = parseLlmJson(blob); // #891 — proto-pollution-safe
    } catch {
        return { findings: [], repaired: 0, dropped: 0 };
    }
    if (!parsed || typeof parsed !== 'object') return { findings: [], repaired: 0, dropped: 0 };
    const findingsRaw = (parsed as { findings?: unknown }).findings;
    if (!Array.isArray(findingsRaw)) return { findings: [], repaired: 0, dropped: 0 };

    const findings: RawLlmFinding[] = [];
    let repaired = 0, dropped = 0;
    for (const item of findingsRaw) {
        const strict = strictFindingSchema.safeParse(item);
        if (strict.success) {
            findings.push(strict.data as RawLlmFinding);
            continue;
        }
        if (tolerance === 'strict') {
            dropped++;
            continue;
        }
        const relaxed = relaxedFindingSchema.safeParse(item);
        if (relaxed.success) {
            findings.push(relaxed.data as RawLlmFinding);
            repaired++;
        } else {
            dropped++;
        }
    }
    return { findings, repaired, dropped };
}

/**
 * Legacy wrapper around `parseFindings(..., 'relaxed')`. Kept so existing
 * call sites in `aiReviewHandlers.ts` + `standalone/aiReview.ts` don't have
 * to change in lockstep with this PR. The shape (`{ findings: any[] }`) is
 * preserved so downstream consumers that index into fields like `title` or
 * `evidence.snippet` keep working unchanged.
 */
export function extractFindingsJson(rawText: string): { findings: RawLlmFinding[] } {
    return { findings: parseFindings(rawText, 'relaxed').findings };
}

// ─── Project-level review schema ─────────────────────────────────────────────

/**
 * Mirror of `ProjectRawFinding` from `projectLevelReviewer.ts`. Project-level
 * findings have a required `filePath` (which bundle file the finding applies
 * to) and a flatter evidence shape than per-entry findings, so they need a
 * separate schema rather than reusing `RawLlmFinding`.
 */
export interface ProjectRawFinding {
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    filePath: string;
    symbol?: string;
    evidence?: { snippet: string; lineStart?: number; lineEnd?: number };
}

const projectEvidenceSchema = z.object({
    snippet: z.string(),
    lineStart: z.number().optional(),
    lineEnd: z.number().optional(),
}).optional();

const strictProjectFindingSchema = z.object({
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES),
    title: z.string().min(1),
    body: z.string(),
    filePath: z.string().min(1),
    symbol: z.string().optional(),
    evidence: projectEvidenceSchema,
});

const relaxedProjectFindingSchema = z.object({
    severity: z.preprocess(coerceSeverity, z.enum(SEVERITIES)),
    category: z.preprocess(coerceCategory, z.enum(CATEGORIES)),
    title: z.preprocess(coerceTitle, z.string()),
    body: z.preprocess(v => typeof v === 'string' ? v : '', z.string()),
    // filePath is required at runtime — project-level findings without one
    // can't be bound back to a file. Empty string is preserved; the binder
    // drops items with empty `filePath` downstream.
    filePath: z.preprocess(v => typeof v === 'string' ? v : '', z.string()),
    symbol: z.string().optional(),
    evidence: projectEvidenceSchema,
});

export interface ParsedProjectFindings {
    findings: ProjectRawFinding[];
    repaired: number;
    dropped: number;
}

/**
 * Project-level variant of `parseFindings`. Same two-pass strict / relaxed
 * structure, applied to `ProjectRawFinding` shape (required `filePath`).
 */
export function parseProjectFindings(
    rawText: string,
    tolerance: FindingParseTolerance = 'relaxed',
): ParsedProjectFindings {
    const cleaned = cleanRawText(rawText);
    const blob = extractBalancedJson(cleaned);
    if (!blob) return { findings: [], repaired: 0, dropped: 0 };

    let parsed: unknown;
    try {
        parsed = parseLlmJson(blob); // #891 — proto-pollution-safe
    } catch {
        return { findings: [], repaired: 0, dropped: 0 };
    }
    if (!parsed || typeof parsed !== 'object') return { findings: [], repaired: 0, dropped: 0 };
    const findingsRaw = (parsed as { findings?: unknown }).findings;
    if (!Array.isArray(findingsRaw)) return { findings: [], repaired: 0, dropped: 0 };

    const findings: ProjectRawFinding[] = [];
    let repaired = 0, dropped = 0;
    for (const item of findingsRaw) {
        const strict = strictProjectFindingSchema.safeParse(item);
        if (strict.success) {
            findings.push(strict.data as ProjectRawFinding);
            continue;
        }
        if (tolerance === 'strict') {
            dropped++;
            continue;
        }
        const relaxed = relaxedProjectFindingSchema.safeParse(item);
        if (relaxed.success && relaxed.data.filePath !== '') {
            findings.push(relaxed.data as ProjectRawFinding);
            repaired++;
        } else {
            dropped++;
        }
    }
    return { findings, repaired, dropped };
}

/**
 * Project-level companion to `extractFindingsJson`. Wraps
 * `parseProjectFindings(..., 'relaxed')` for the call sites in
 * `aiReviewHandlers.ts` that drive project-level reviews.
 */
export function extractProjectFindingsJson(rawText: string): { findings: ProjectRawFinding[] } {
    return { findings: parseProjectFindings(rawText, 'relaxed').findings };
}
