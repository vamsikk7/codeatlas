/**
 * apiTesting/aiTestGen/generateTestCases.ts — Issue #603 Phase 3.5.
 *
 * AI-driven test-case generation. Given a target endpoint (method,
 * route, handler name) + the handler's source + any inferred request
 * schema, ask an LLM to produce a structured array of test cases:
 *
 *   {
 *     name:            "happy path — missing optional fields",
 *     preconditions:   "user A exists with email='a@b.com'",
 *     request_overrides: { body: { email: 'a@b.com', password: 'x' } },
 *     assertions:      [{ kind: 'status', equals: 200 }, ...]
 *   }
 *
 * The generator follows the evidence-gate discipline from Issue #513
 * (per-entry reviewer): every assertion must be grounded in the
 * handler source. The prompt instructs the model to drop any test
 * case it can't quote source evidence for; the parser drops cases
 * whose `evidence` field is missing or empty.
 *
 * Phase 3.5 ships the deterministic core. Wiring into the webview UI
 * lands separately — for now this is callable from MCP only via the
 * `generate_test_cases` tool.
 */

import { sendOpenRouterRequest, type OpenRouterConfig } from '../../llm/openRouterClient';
import { redactSecrets } from '../../llm/llmNamingService';
import type { ApiTestingEndpoint } from '../types';

export interface GeneratedAssertion {
    kind: 'status' | 'body-contains' | 'body-not-contains' | 'header-present';
    /** For `status` assertions — exact code OR range. */
    equals?: number;
    range?: [number, number];
    /** For `body-contains` / `body-not-contains`. */
    text?: string;
    /** For `header-present`. */
    name?: string;
}

export interface GeneratedTestCase {
    /** Short human-readable label, e.g. "missing required `email`". */
    name: string;
    /** Optional pre-condition narrative (English). */
    preconditions?: string;
    /** Partial overrides for the request body / query / path / headers.
     *  The chain runner / send-request UI merges these with the base
     *  request shape before firing. */
    request_overrides?: {
        body?: Record<string, unknown>;
        query?: Record<string, string>;
        path?: Record<string, string>;
        headers?: Record<string, string>;
    };
    assertions: GeneratedAssertion[];
    /** Evidence-gate: quoted source line(s) the model used to justify
     *  this case. Cases with empty / missing evidence are dropped. */
    evidence: string[];
}

export interface GenerateTestCasesArgs {
    endpoint: ApiTestingEndpoint;
    /** Source code of the handler function (best-effort — the caller
     *  resolves this from the snapshot). */
    handlerSource: string;
    /** Optional surrounding file context. Kept short — only the imports
     *  + the few callees the user thinks are relevant. */
    fileContext?: string;
    /** Hard cap on returned cases. Defaults to 6 — matches the spec's
     *  §6.4 "happy / 2× negative / edge / auth / rate-limit" pattern. */
    maxCases?: number;
}

export interface GenerateTestCasesResult {
    cases: GeneratedTestCase[];
    /** Raw LLM text — exposed for debugging + auditing. */
    rawText: string;
    /** Number of cases the parser dropped (evidence missing, schema
     *  invalid, etc.). Surfaced to the UI so the user knows the model
     *  produced more than we kept. */
    dropped: number;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Build the prompt + send to the LLM + parse + apply evidence gate.
 * Throws `LlmError` on transport / auth failures.
 */
export async function generateTestCases(
    args: GenerateTestCasesArgs,
    config: OpenRouterConfig,
    signal?: AbortSignal,
): Promise<GenerateTestCasesResult> {
    const maxCases = Math.max(1, Math.min(20, args.maxCases ?? 6));
    const prompt = buildPrompt(args, maxCases);
    const response = await sendOpenRouterRequest(
        { ...config, responseFormat: 'json_object', temperature: 0.2 },
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: prompt },
        ],
        signal,
    );
    const parsed = parseAndGate(response.text, args.handlerSource);
    return {
        cases: parsed.cases,
        rawText: response.text,
        dropped: parsed.dropped,
        model: response.model,
        usage: response.usage,
    };
}

const SYSTEM_PROMPT = `You are an API test-case generator. Given an HTTP handler's
source code and request schema, produce a structured JSON array of test
cases that exercise the handler's documented behavior.

EVIDENCE GATE — STRICT. For every test case you propose, you MUST quote
ONE line from the handler source that grounds it. If you cannot point at
a source line, DROP THE CASE. Never invent behavior. If the source has
no branches, return a single happy-path case.

Return JSON of the shape:
{
  "cases": [
    {
      "name": "<short label>",
      "preconditions": "<english, optional>",
      "request_overrides": { "body"?: {...}, "query"?: {...}, "path"?: {...}, "headers"?: {...} },
      "assertions": [
        { "kind": "status", "equals": 200 },
        { "kind": "status", "range": [200, 299] },
        { "kind": "body-contains", "text": "<substring>" },
        { "kind": "body-not-contains", "text": "<substring>" },
        { "kind": "header-present", "name": "<header>" }
      ],
      "evidence": ["<verbatim source line>"]
    }
  ]
}

Do not include any prose around the JSON.`;

function buildPrompt(args: GenerateTestCasesArgs, maxCases: number): string {
    const ep = args.endpoint;
    const lines: string[] = [];
    lines.push(`Endpoint: ${ep.method} ${ep.route}`);
    if (ep.auth) lines.push(`Auth detected: ${ep.auth}`);
    if (ep.middlewares?.length) lines.push(`Middlewares: ${ep.middlewares.join(', ')}`);
    if (ep.requestSchema?.schema) {
        lines.push(`Request schema (${ep.requestSchema.source}):`);
        lines.push('```json');
        lines.push(JSON.stringify(ep.requestSchema.schema, null, 2));
        lines.push('```');
    }
    if (ep.responseSchema?.length) {
        lines.push('Known response statuses:');
        for (const r of ep.responseSchema) {
            lines.push(`- ${r.status}${r.description ? ` — ${r.description}` : ''}`);
        }
    }
    lines.push('');
    lines.push('Handler source:');
    lines.push('```');
    lines.push(redactSecrets(args.handlerSource));
    lines.push('```');
    if (args.fileContext) {
        lines.push('');
        lines.push('Surrounding context:');
        lines.push('```');
        lines.push(redactSecrets(args.fileContext));
        lines.push('```');
    }
    lines.push('');
    lines.push(`Produce at most ${maxCases} grounded test cases. Apply the EVIDENCE GATE strictly.`);
    return lines.join('\n');
}

/**
 * Parse the LLM's JSON output, then apply the evidence gate: drop any
 * case whose `evidence` field is empty / non-array, or whose quoted
 * lines are not substrings of the handler source.
 */
export function parseAndGate(
    rawText: string,
    handlerSource: string,
): { cases: GeneratedTestCase[]; dropped: number } {
    // Strip Markdown code fences the model sometimes wraps around the JSON.
    const stripped = rawText
        .replace(/^\s*```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(stripped);
    } catch {
        return { cases: [], dropped: 0 };
    }

    const rawCases = extractCasesArray(parsed);
    if (!rawCases) return { cases: [], dropped: 0 };

    const kept: GeneratedTestCase[] = [];
    let dropped = 0;
    for (const c of rawCases) {
        const tc = coerceTestCase(c);
        if (!tc) { dropped++; continue; }
        if (!gateEvidence(tc.evidence, handlerSource)) { dropped++; continue; }
        kept.push(tc);
    }
    return { cases: kept, dropped };
}

function extractCasesArray(raw: unknown): unknown[] | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.cases)) return obj.cases;
    if (Array.isArray((obj as any).test_cases)) return (obj as any).test_cases;
    if (Array.isArray(raw as unknown[])) return raw as unknown[];
    return null;
}

function coerceTestCase(raw: unknown): GeneratedTestCase | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name.trim() === '') return null;
    const assertionsRaw = Array.isArray(r.assertions) ? r.assertions : [];
    const assertions = assertionsRaw
        .map(coerceAssertion)
        .filter((a): a is GeneratedAssertion => a !== null);
    if (assertions.length === 0) return null;
    const evidence = Array.isArray(r.evidence)
        ? r.evidence.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
        : [];
    const tc: GeneratedTestCase = {
        name: r.name.trim(),
        preconditions: typeof r.preconditions === 'string' ? r.preconditions.trim() : undefined,
        request_overrides: coerceOverrides(r.request_overrides),
        assertions,
        evidence,
    };
    return tc;
}

function coerceAssertion(raw: unknown): GeneratedAssertion | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const kind = typeof r.kind === 'string' ? r.kind : '';
    if (kind === 'status') {
        if (typeof r.equals === 'number') return { kind: 'status', equals: r.equals };
        if (Array.isArray(r.range) && r.range.length === 2 && r.range.every(n => typeof n === 'number')) {
            return { kind: 'status', range: [Number(r.range[0]), Number(r.range[1])] };
        }
        return null;
    }
    if (kind === 'body-contains' || kind === 'body-not-contains') {
        if (typeof r.text !== 'string' || r.text === '') return null;
        return { kind, text: r.text };
    }
    if (kind === 'header-present') {
        if (typeof r.name !== 'string' || r.name === '') return null;
        return { kind: 'header-present', name: r.name };
    }
    return null;
}

function coerceOverrides(raw: unknown): GeneratedTestCase['request_overrides'] | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    const out: NonNullable<GeneratedTestCase['request_overrides']> = {};
    if (r.body && typeof r.body === 'object' && !Array.isArray(r.body)) {
        out.body = r.body as Record<string, unknown>;
    }
    for (const k of ['query', 'path', 'headers'] as const) {
        const v = r[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const flat: Record<string, string> = {};
            for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
                if (typeof vv === 'string') flat[kk] = vv;
                else if (typeof vv === 'number' || typeof vv === 'boolean') flat[kk] = String(vv);
            }
            if (Object.keys(flat).length > 0) out[k] = flat;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Evidence-gate predicate. Returns true when at least one quoted
 * snippet appears in the handler source (whitespace-normalised).
 */
function gateEvidence(evidence: string[], handlerSource: string): boolean {
    if (evidence.length === 0) return false;
    const norm = normaliseForMatch(handlerSource);
    for (const e of evidence) {
        const needle = normaliseForMatch(e);
        if (needle && norm.includes(needle)) return true;
    }
    return false;
}

function normaliseForMatch(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}
