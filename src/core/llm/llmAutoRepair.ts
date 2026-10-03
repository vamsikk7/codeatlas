/**
 * llmAutoRepair.ts — Issue #704 auto-repair leg.
 *
 * Wraps an LLM call so a Zod-invalid response triggers ONE corrective
 * re-prompt that quotes the validation error back to the model rather
 * than dropping the whole response. Distinct from the relaxed-schema
 * repair in `findingSchema.ts` — that pass is local (coercion); this
 * pass round-trips to the LLM with a targeted "fix these fields"
 * instruction.
 *
 * Designed to be cheap to adopt at any structured-output call site:
 *
 *     const result = await llmWithAutoRepair({
 *         llmCall: (prompt) => callOpenRouter(prompt, llmConfig),
 *         schema: z.object({...}),
 *         initialPrompt: 'You are a code reviewer. Output JSON…',
 *     });
 *     if ('error' in result) return reportError(result.error);
 *     useData(result.data);
 *
 * Default `maxRepairs` is 1 (one extra round-trip per failed call). Pass
 * `maxRepairs: 0` to disable repair entirely and fall back to single-shot
 * behaviour — useful for cost-sensitive bulk runs.
 */

import type { ZodSchema, ZodError, ZodIssue } from 'zod';

export interface LlmWithAutoRepairOptions<T> {
    /**
     * The underlying LLM caller. Takes a prompt string, returns the raw
     * text response. Caller is responsible for transport, auth, timeout.
     */
    llmCall: (prompt: string) => Promise<string>;
    /** Zod schema the raw text must satisfy after JSON.parse. */
    schema: ZodSchema<T>;
    /**
     * The prompt used for the first call. The repair prompt is built by
     * appending the validation-error description; the original prompt is
     * preserved verbatim so the LLM has the full task context.
     */
    initialPrompt: string;
    /**
     * How many extra round-trips to spend on repair. Default 1 — i.e. up
     * to 2 total LLM calls (one initial + one repair). Set to 0 to skip
     * repair entirely (fail-fast).
     */
    maxRepairs?: number;
}

export type LlmWithAutoRepairResult<T> =
    | { data: T; repaired: number }
    | { error: string };

/**
 * Strip ```json fences and the trailing-comma JSON-mode bug — same
 * lightweight cleanup `findingSchema.ts::cleanRawText` uses, replicated
 * here so this module has no findings-specific coupling.
 */
function cleanRawText(s: string): string {
    return s
        .replace(/```(?:json|JSON)?\s*/g, '')
        .replace(/```/g, '')
        .replace(/,(\s*[\]}])/g, '$1');
}

/**
 * Convert a `ZodError.issues` list into a human-readable bullet list the
 * LLM can act on. Each bullet quotes the path AND the expected vs.
 * received shape — enough specificity for a single re-prompt to fix
 * everything at once.
 */
function formatZodIssuesForLlm(issues: ZodIssue[]): string {
    return issues
        .map((iss) => {
            const path = iss.path.join('.') || '(root)';
            const expected = (iss as any).expected ?? (iss as any).options?.join(' | ') ?? iss.message;
            const received = (iss as any).received ?? (iss as any).input ?? '';
            const receivedClause = received !== '' ? ` (received: ${JSON.stringify(received).slice(0, 80)})` : '';
            return `  - Field "${path}": ${iss.message}. Expected: ${expected}${receivedClause}.`;
        })
        .join('\n');
}

/**
 * Build the corrective prompt sent on the next try. The shape is
 * deliberately verbose so smaller / cheaper models still recover —
 * larger models could likely fix it with just the schema diff, but
 * compact prompts here are penny-wise pound-foolish.
 */
function buildRepairPrompt(
    originalPrompt: string,
    rawResponse: string,
    issueSummary: string,
): string {
    return (
        `${originalPrompt}\n\n` +
        `Your previous response failed schema validation. Issues:\n${issueSummary}\n\n` +
        `Your previous response was:\n${rawResponse.slice(0, 1200)}${rawResponse.length > 1200 ? '... (truncated)' : ''}\n\n` +
        `Please return a corrected JSON object that satisfies the schema. ` +
        `Respond with ONLY the JSON — no commentary, no markdown fences, no leading prose.`
    );
}

function tryParse<T>(schema: ZodSchema<T>, raw: string): { ok: true; data: T } | { ok: false; reason: string; issues?: ZodIssue[] } {
    const cleaned = cleanRawText(raw);
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err: any) {
        return { ok: false, reason: `Response was not valid JSON: ${err?.message ?? err}` };
    }
    const result = schema.safeParse(parsed);
    if (result.success) {
        return { ok: true, data: result.data };
    }
    return { ok: false, reason: 'Response did not satisfy schema', issues: (result.error as ZodError).issues };
}

export async function llmWithAutoRepair<T>(
    opts: LlmWithAutoRepairOptions<T>,
): Promise<LlmWithAutoRepairResult<T>> {
    const { llmCall, schema, initialPrompt } = opts;
    const maxRepairs = opts.maxRepairs ?? 1;

    let lastRaw = '';
    let lastReason = '';
    let attempts = 0;

    while (attempts <= maxRepairs) {
        // Pick prompt: initial on round 0, repair prompt on rounds ≥ 1.
        let prompt: string;
        if (attempts === 0) {
            prompt = initialPrompt;
        } else {
            const issueSummary = lastReason.includes('schema')
                ? formatZodIssuesForLlm(((tryParse(schema, lastRaw) as any).issues ?? []))
                : `  - ${lastReason}`;
            prompt = buildRepairPrompt(initialPrompt, lastRaw, issueSummary);
        }

        const raw = await llmCall(prompt);
        lastRaw = raw;
        const parsed = tryParse(schema, raw);
        if (parsed.ok) {
            return { data: parsed.data, repaired: attempts };
        }
        lastReason = parsed.reason;
        attempts++;
    }

    return {
        error:
            `LLM response failed schema validation after ${maxRepairs} repair attempt(s). ` +
            `Last error: ${lastReason}`,
    };
}
