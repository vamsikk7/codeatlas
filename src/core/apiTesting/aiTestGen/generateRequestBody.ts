/**
 * apiTesting/aiTestGen/generateRequestBody.ts — Issue #603 Phase 3.5.
 *
 * Generate a single JSON request body skeleton for a target endpoint.
 * Sister tool to `generateTestCases.ts` — same LLM client, same
 * evidence-gate discipline, narrower output: just `{ body, evidence }`.
 *
 * Use case: the user is about to call POST /api/articles and the
 * schema inference produced `{ type: 'object' }` with no properties
 * (the handler reads `req.body` without validation). The LLM reads the
 * handler source + adjacent destructuring + persistence calls and
 * proposes a body with the fields that actually matter.
 *
 * Evidence gate: the model MUST quote ONE handler line per field it
 * proposes. Fields without an evidence line are stripped before return.
 */

import { sendOpenRouterRequest, type OpenRouterConfig } from '../../llm/openRouterClient';
import { redactSecrets } from '../../llm/llmNamingService';
import type { ApiTestingEndpoint } from '../types';

export interface GeneratedRequestBody {
    /** The proposed JSON body, ready to feed to `executeRequest`. */
    body: Record<string, unknown>;
    /** Per-field evidence — `evidence[name]` quotes one handler line. */
    evidence: Record<string, string>;
}

export interface GenerateRequestBodyArgs {
    endpoint: ApiTestingEndpoint;
    handlerSource: string;
    fileContext?: string;
}

export interface GenerateRequestBodyResult {
    body: Record<string, unknown>;
    /** Number of LLM-proposed fields dropped because their evidence
     *  line wasn't found in the handler source. */
    dropped: number;
    rawText: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function generateRequestBody(
    args: GenerateRequestBodyArgs,
    config: OpenRouterConfig,
    signal?: AbortSignal,
): Promise<GenerateRequestBodyResult> {
    const prompt = buildPrompt(args);
    const response = await sendOpenRouterRequest(
        { ...config, responseFormat: 'json_object', temperature: 0.2 },
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        signal,
    );
    const parsed = parseAndGate(response.text, args.handlerSource);
    return {
        body: parsed.body,
        dropped: parsed.dropped,
        rawText: response.text,
        model: response.model,
        usage: response.usage,
    };
}

const SYSTEM_PROMPT = `You are a request-body generator. Given an HTTP handler's
source code and route metadata, propose a single JSON request body
that exercises the handler's documented behavior.

EVIDENCE GATE — STRICT. For EVERY field you include in the body, you
MUST quote ONE line from the handler source that proves the field is
used (destructuring, validation, persistence call). If you cannot
quote a source line for a field, DROP THE FIELD. Do not invent fields.

Return JSON of the shape:
{
  "body": { "<field>": <example value>, ... },
  "evidence": { "<field>": "<verbatim source line>", ... }
}

Pick example values that match the inferred type (string → realistic
short string, number → small integer, boolean → true unless the source
implies false). Do not include any prose around the JSON.`;

function buildPrompt(args: GenerateRequestBodyArgs): string {
    const ep = args.endpoint;
    const lines: string[] = [];
    lines.push(`Endpoint: ${ep.method} ${ep.route}`);
    if (ep.requestSchema?.schema) {
        lines.push(`Inferred request schema (${ep.requestSchema.source}):`);
        lines.push('```json');
        lines.push(JSON.stringify(ep.requestSchema.schema, null, 2));
        lines.push('```');
    }
    lines.push('');
    lines.push('Handler source:');
    lines.push('```');
    lines.push(redactSecrets(args.handlerSource));
    lines.push('```');
    if (args.fileContext) {
        lines.push('');
        lines.push('Adjacent context:');
        lines.push('```');
        lines.push(redactSecrets(args.fileContext));
        lines.push('```');
    }
    lines.push('');
    lines.push('Produce one body. Apply the EVIDENCE GATE strictly.');
    return lines.join('\n');
}

export function parseAndGate(
    rawText: string,
    handlerSource: string,
): { body: Record<string, unknown>; dropped: number } {
    const stripped = rawText
        .replace(/^\s*```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

    let parsed: unknown;
    try { parsed = JSON.parse(stripped); }
    catch { return { body: {}, dropped: 0 }; }

    if (!parsed || typeof parsed !== 'object') return { body: {}, dropped: 0 };
    const rawBody = (parsed as Record<string, unknown>).body;
    const rawEvidence = (parsed as Record<string, unknown>).evidence;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) return { body: {}, dropped: 0 };
    const evidence = (rawEvidence && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence))
        ? rawEvidence as Record<string, unknown>
        : {};

    const norm = normaliseForMatch(handlerSource);
    const out: Record<string, unknown> = {};
    let dropped = 0;
    for (const [field, value] of Object.entries(rawBody)) {
        const ev = evidence[field];
        if (typeof ev !== 'string' || ev.trim() === '') { dropped++; continue; }
        if (!norm.includes(normaliseForMatch(ev))) { dropped++; continue; }
        out[field] = value;
    }
    return { body: out, dropped };
}

function normaliseForMatch(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}
