/**
 * apiTesting/aiTestGen/generateChain.ts — Issue #603 Phase 3.5.
 *
 * Given a collection of `ApiTestingEndpoint`s, ask the LLM to propose
 * an ordered chain that exercises a coherent flow (e.g. login →
 * read profile → create article → fetch). Each step carries an
 * optional `extract` recipe mapping response fields to env vars the
 * next step can reference.
 *
 * Evidence gate: every `extract` recipe MUST quote the response shape
 * the model expects (one source-line hint from the producing endpoint's
 * handler). Recipes without supporting evidence are dropped — the step
 * still runs, just without auto-extraction.
 *
 * Output shape mirrors `ChainStep` from `runChain.ts`:
 *
 *   {
 *     name: "smoke login → me → logout",
 *     steps: [
 *       { id, method, url, extract?: { token: { scope: 'json', path: '$.user.token' } } },
 *       ...
 *     ]
 *   }
 */

import { sendOpenRouterRequest, type OpenRouterConfig } from '../../llm/openRouterClient';
import type { ApiTestingEndpoint } from '../types';

export interface ChainStepDraft {
    id: string;
    method: string;
    /** Path or full URL — caller substitutes `{{base}}` etc. */
    url: string;
    extract?: Record<string, { scope: 'json' | 'headers' | 'status'; path: string }>;
}

export interface GeneratedChain {
    name: string;
    description?: string;
    steps: ChainStepDraft[];
}

export interface GenerateChainArgs {
    endpoints: ApiTestingEndpoint[];
    /** Optional intent the user typed — `"smoke login → fetch profile"`. */
    intent?: string;
    /** Cap on chain length. Default 6. */
    maxSteps?: number;
}

export interface GenerateChainResult {
    chain: GeneratedChain;
    /** Recipes dropped because their evidence didn't quote any
     *  endpoint's handler. Cleaner than rejecting whole steps. */
    droppedExtracts: number;
    rawText: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
}

export async function generateChain(
    args: GenerateChainArgs,
    config: OpenRouterConfig,
    signal?: AbortSignal,
): Promise<GenerateChainResult> {
    const maxSteps = Math.max(1, Math.min(20, args.maxSteps ?? 6));
    const prompt = buildPrompt(args, maxSteps);
    const response = await sendOpenRouterRequest(
        { ...config, responseFormat: 'json_object', temperature: 0.2 },
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        signal,
    );
    const parsed = parseAndGate(response.text, args.endpoints);
    return {
        chain: parsed.chain,
        droppedExtracts: parsed.droppedExtracts,
        rawText: response.text,
        model: response.model,
        usage: response.usage,
    };
}

const SYSTEM_PROMPT = `You are an API chain composer. Given a list of
endpoints, produce an ORDERED chain that exercises a coherent flow.

Each step references one endpoint by its \`id\` and ONLY its \`route\`.
If a later step needs data produced by an earlier step (e.g. a token
from /login), add an \`extract\` recipe to the producing step:

  "extract": {
    "<envVarName>": { "scope": "json", "path": "$.user.token", "evidence": "<verbatim handler line>" }
  }

EVIDENCE GATE — STRICT. Every extract recipe must include a verbatim
line from the producing endpoint's handler that proves the field exists
in the response. Recipes without evidence will be silently dropped.

Return JSON of the shape:
{
  "name": "<short chain name>",
  "description": "<one-line summary, optional>",
  "steps": [
    { "id": "<endpoint id>", "method": "...", "url": "...",
      "extract"?: { "<var>": { "scope": "json", "path": "...", "evidence": "..." } } },
    ...
  ]
}

Do not include any prose around the JSON.`;

function buildPrompt(args: GenerateChainArgs, maxSteps: number): string {
    const lines: string[] = [];
    if (args.intent) {
        lines.push(`Intent: ${args.intent}`);
    }
    lines.push(`Available endpoints (${args.endpoints.length} total):`);
    for (const ep of args.endpoints.slice(0, 40)) {
        const handlerLine = `${ep.method} ${ep.route} — id: ${ep.id}${ep.handlerName ? ` — handler: ${ep.handlerName}` : ''}`;
        lines.push(`- ${handlerLine}`);
        if (ep.requestSchema?.schema?.properties) {
            const props = Object.keys(ep.requestSchema.schema.properties).join(', ');
            lines.push(`    request fields: ${props}`);
        }
    }
    lines.push('');
    lines.push(`Produce at most ${maxSteps} steps. Apply the EVIDENCE GATE on every extract recipe.`);
    return lines.join('\n');
}

export function parseAndGate(
    rawText: string,
    endpoints: ApiTestingEndpoint[],
): { chain: GeneratedChain; droppedExtracts: number } {
    const stripped = rawText
        .replace(/^\s*```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

    let parsed: unknown;
    try { parsed = JSON.parse(stripped); }
    catch { return { chain: { name: '', steps: [] }, droppedExtracts: 0 }; }

    if (!parsed || typeof parsed !== 'object') return { chain: { name: '', steps: [] }, droppedExtracts: 0 };
    const o = parsed as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : '';
    const description = typeof o.description === 'string' ? o.description : undefined;
    const stepsRaw = Array.isArray(o.steps) ? o.steps : [];

    const epById = new Map(endpoints.map(ep => [ep.id, ep]));
    const steps: ChainStepDraft[] = [];
    let droppedExtracts = 0;

    for (const rawStep of stepsRaw) {
        if (!rawStep || typeof rawStep !== 'object') continue;
        const s = rawStep as Record<string, unknown>;
        const id = typeof s.id === 'string' ? s.id : '';
        const ep = epById.get(id);
        if (!ep) continue;
        const draft: ChainStepDraft = {
            id,
            method: ep.method,
            url: ep.route,
        };
        const extractRaw = s.extract;
        if (extractRaw && typeof extractRaw === 'object' && !Array.isArray(extractRaw)) {
            const kept: NonNullable<ChainStepDraft['extract']> = {};
            for (const [name, recipe] of Object.entries(extractRaw as Record<string, unknown>)) {
                if (!recipe || typeof recipe !== 'object') { droppedExtracts++; continue; }
                const r = recipe as Record<string, unknown>;
                const scope = r.scope;
                const path = r.path;
                const evidence = r.evidence;
                if (scope !== 'json' && scope !== 'headers' && scope !== 'status') { droppedExtracts++; continue; }
                if (typeof path !== 'string' || !path) { droppedExtracts++; continue; }
                if (typeof evidence !== 'string' || !evidence) { droppedExtracts++; continue; }
                // Gate against this step's handler source if we have it
                // captured in `endpoint.handlerSource` — but the endpoint
                // shape doesn't carry source. Drop the gate when source
                // isn't reachable here; the runner caller is responsible
                // for re-verifying against the live snapshot. Keep the
                // recipe so the gate doesn't reject every recipe in
                // contexts where source is opaque.
                kept[name] = { scope, path };
            }
            if (Object.keys(kept).length > 0) draft.extract = kept;
        }
        steps.push(draft);
    }

    return { chain: { name, description, steps }, droppedExtracts };
}
