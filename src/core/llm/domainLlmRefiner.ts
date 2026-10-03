/**
 * domainLlmRefiner.ts — Issue #733 (complementary LLM refinement).
 *
 * Sits ON TOP of the deterministic `detectDomains` heuristic. Never
 * replaces it; only renames + recalibrates confidence + suggests merges.
 * The heuristic system is the source of truth — the LLM gets the
 * deterministic output as structured input and adds judgment, mirroring
 * the AI Code Review pattern where deterministic Tier-1/Tier-2 evidence
 * is what the LLM reasons over.
 *
 * Design contract (per Issue #733):
 *   1. The heuristic `domains` argument is the **input**, never mutated.
 *   2. The returned `Record<string, DomainCluster>` is the heuristic
 *      output with refinements applied. Domains the LLM left alone keep
 *      `source: 'heuristic'`; touched ones flip to `source: 'llm-refined'`.
 *   3. Any error (parse failure, network, missing config) returns the
 *      ORIGINAL heuristic input unchanged — never a degraded set.
 *   4. The refiner is purely additive — it cannot remove a heuristic
 *      domain. Merges replace two domains with one; the post-merge id
 *      keeps the higher-confidence parent's slot.
 *
 * The output schema is validated via Zod (re-using the #704
 * `findingSchema` infrastructure) so a malformed LLM response can't
 * silently inject nulls into the snapshot store.
 */

import { z } from 'zod';
import type {
    DomainCluster,
    Snapshot,
    ApiRecord,
} from '../graph/graphTypes';

/**
 * LLM call adapter. Same shape as `PerEntryLlmCall` from `perEntryReviewer`
 * — we don't import that type to avoid an unrelated module dependency.
 * Returns the raw text body so the caller controls parsing.
 */
export type DomainLlmCall = (prompt: {
    system: string;
    user: string;
}, opts?: { signal?: AbortSignal }) => Promise<string>;

export interface RefineDomainsOptions {
    /** Cap on sample routes per domain included in the prompt. Default 5. */
    sampleRoutesPerDomain?: number;
    /** Cap on sample files per domain included in the prompt. Default 5. */
    sampleFilesPerDomain?: number;
    /** Abort signal — forwarded to the LLM call. */
    signal?: AbortSignal;
    /** Optional logger; default no-op. */
    log?: (msg: string) => void;
}

/**
 * LLM response Zod schema. Each field is optional + tolerated when
 * missing so a partial response still produces a partial refinement
 * instead of dropping everything.
 */
const renameSchema = z.object({
    id: z.string(),
    newName: z.string().min(1),
    /** LLM rationale — surfaced in the node tooltip but never trusted as
     *  ground truth. The deterministic system stays in charge. */
    reason: z.string().optional(),
});

const confidenceAdjustmentSchema = z.object({
    id: z.string(),
    confidence: z.number().min(0).max(1),
});

const mergeSchema = z.object({
    ids: z.array(z.string()).min(2),
    intoName: z.string().min(1),
    /** Verb override — LLM may relabel the action when merging. Falls
     *  back to the dominant input domain's verb when missing. */
    verb: z.string().optional(),
});

const refinementSchema = z.object({
    renames: z.array(renameSchema).optional(),
    confidenceAdjustments: z.array(confidenceAdjustmentSchema).optional(),
    merges: z.array(mergeSchema).optional(),
});

export type DomainRefinement = z.infer<typeof refinementSchema>;

/**
 * Refine the heuristic domain set via the supplied LLM call.
 *
 * @param domains   Heuristic output from `detectDomains`. NOT mutated.
 * @param snapshot  Working snapshot — used to look up routes for the
 *                  per-domain evidence pack.
 * @param llmCall   The async LLM adapter (shared with the AI Review pipeline).
 * @param options   Sample caps + abort signal + logger.
 * @returns         A new `Record<string, DomainCluster>` with the
 *                  refinements applied. On any error, returns the input
 *                  `domains` unchanged (never produces a degraded set).
 */
export async function refineDomainsWithLlm(
    domains: Record<string, DomainCluster>,
    snapshot: Snapshot,
    llmCall: DomainLlmCall,
    options: RefineDomainsOptions = {},
): Promise<Record<string, DomainCluster>> {
    const log = options.log ?? (() => { /* noop */ });
    const sampleRoutes = options.sampleRoutesPerDomain ?? 5;
    const sampleFiles = options.sampleFilesPerDomain ?? 5;

    const ids = Object.keys(domains);
    if (ids.length === 0) return domains;

    const prompt = buildPrompt(domains, snapshot, sampleRoutes, sampleFiles);

    let rawText: string;
    try {
        rawText = await llmCall(prompt, { signal: options.signal });
    } catch (err: any) {
        log(`[domainLlmRefiner] LLM call failed — keeping heuristic: ${err?.message ?? err}`);
        return domains;
    }

    const parsed = parseRefinement(rawText);
    if (!parsed) {
        log('[domainLlmRefiner] could not parse LLM response — keeping heuristic');
        return domains;
    }

    return applyRefinement(domains, parsed, log);
}

/**
 * #913 — preserve LLM-refined domain names across cascades. Every file save
 * re-runs the deterministic `detectDomains` heuristic and overwrites
 * `working.domains`; without this merge the user's LLM-refined names + calibrated
 * confidence are silently lost on the next edit (mirrors the #844 cluster-name
 * merge). For each FRESH heuristic domain, if the PREVIOUS set had the same id
 * marked `source: 'llm-refined'`, carry forward its refined `name` / `verb` /
 * `confidence` / `source` — while taking the fresh structural fields (routes,
 * files, serviceId, diff). Domain ids are stable across cascades (the heuristic
 * is deterministic and renames keep the original id), so the merge is by id.
 */
export function mergeRefinedDomainNames(
    fresh: Record<string, DomainCluster>,
    previous: Record<string, DomainCluster> | undefined | null,
): Record<string, DomainCluster> {
    if (!previous) return fresh;
    const out: Record<string, DomainCluster> = {};
    for (const [id, d] of Object.entries(fresh)) {
        const prev = previous[id];
        if (prev && prev.source === 'llm-refined') {
            out[id] = { ...d, name: prev.name, verb: prev.verb, confidence: prev.confidence, source: 'llm-refined' };
        } else {
            out[id] = d;
        }
    }
    return out;
}

// ─── Prompt construction ─────────────────────────────────────────────────────

/**
 * Build the system + user prompts. The system prompt is short and pins
 * the contract: respond with ONLY a JSON object matching the schema.
 * The user prompt is a structured pack of heuristic output that the LLM
 * reasons over — never the raw source code.
 */
function buildPrompt(
    domains: Record<string, DomainCluster>,
    snapshot: Snapshot,
    sampleRoutes: number,
    sampleFiles: number,
): { system: string; user: string } {
    const apiIndex = snapshot.apiIndex ?? {};
    const domainPack = Object.values(domains).map(d => {
        const routes = d.routes
            .map(rid => apiIndex[rid])
            .filter((api): api is ApiRecord => Boolean(api))
            .slice(0, sampleRoutes)
            .map(api => `${api.method} ${api.route}`);
        const files = d.files.slice(0, sampleFiles);
        return {
            id: d.id,
            name: d.name,
            verb: d.verb,
            routeCount: d.routes.length,
            fileCount: d.files.length,
            confidence: d.confidence,
            sampleRoutes: routes,
            sampleFiles: files,
        };
    });

    const system = [
        'You are a domain-modeling assistant. Your job is to REFINE a deterministic',
        'set of business-domain clusters that an automated heuristic produced from',
        'route paths and file groupings. You never invent new domains; you only',
        'rename, recalibrate confidence, or suggest merges of the provided ones.',
        '',
        'OUTPUT FORMAT: a single JSON object with these optional keys:',
        '  renames: [{ id, newName, reason? }, ...]',
        '  confidenceAdjustments: [{ id, confidence (0..1) }, ...]',
        '  merges: [{ ids: [id1, id2, ...], intoName, verb? }, ...]',
        '',
        'Rules:',
        '- "id" MUST be one of the input ids verbatim. Do not invent ids.',
        '- "newName" is a 2-4 word verb-led action ("Authenticate users", "Process payments").',
        '- "confidence" is the LLM\'s certainty 0..1; bump cautious values only when',
        '  the route + file evidence is unambiguous.',
        '- Use "merges" only when two heuristic domains clearly serve the same intent',
        '  (e.g. "Place orders" + "Fulfill orders" → "Order lifecycle").',
        '- Reply with ONLY the JSON object. No markdown fence, no prose.',
    ].join('\n');

    const user = [
        'Heuristic domain set (input):',
        JSON.stringify(domainPack, null, 2),
        '',
        'Refine the set per the rules above.',
    ].join('\n');

    return { system, user };
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Parse the LLM response into a `DomainRefinement` object. Tolerates:
 *   - Markdown code fences (`​`​`​`​`json ... `​`​`​`​`)
 *   - Trailing prose ("Here is the refinement: { ... } I hope this helps")
 *   - Trailing commas (common JSON-mode bug)
 * Returns `null` when no valid object can be extracted.
 */
function parseRefinement(rawText: string): DomainRefinement | null {
    const cleaned = rawText
        .replace(/```(?:json|JSON)?\s*/g, '')
        .replace(/```/g, '')
        .replace(/,(\s*[\]}])/g, '$1'); // trailing commas

    const firstBrace = cleaned.indexOf('{');
    if (firstBrace < 0) return null;

    let depth = 0, inString = false, escape = false, endIdx = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
        }
    }
    if (endIdx < 0) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned.slice(firstBrace, endIdx + 1));
    } catch {
        return null;
    }

    const result = refinementSchema.safeParse(parsed);
    return result.success ? result.data : null;
}

// ─── Refinement application ──────────────────────────────────────────────────

/**
 * Apply a parsed refinement to the heuristic domain set. Pure function;
 * input is not mutated. Unknown ids referenced by the LLM are silently
 * skipped (we never trust LLM output enough to error on bad ids).
 */
function applyRefinement(
    domains: Record<string, DomainCluster>,
    refinement: DomainRefinement,
    log: (msg: string) => void,
): Record<string, DomainCluster> {
    // Start with deep-cloned copies so we can flag `source: 'llm-refined'`
    // on the touched ones without mutating the heuristic input.
    const out: Record<string, DomainCluster> = {};
    for (const [id, d] of Object.entries(domains)) {
        out[id] = { ...d, routes: [...d.routes], files: [...d.files] };
    }

    // 1. Renames
    for (const rename of refinement.renames ?? []) {
        const target = out[rename.id];
        if (!target) {
            log(`[domainLlmRefiner] rename refs unknown id "${rename.id}" — skipped`);
            continue;
        }
        target.name = rename.newName;
        target.source = 'llm-refined';
    }

    // 2. Confidence calibrations
    for (const adj of refinement.confidenceAdjustments ?? []) {
        const target = out[adj.id];
        if (!target) {
            log(`[domainLlmRefiner] confidence ref unknown id "${adj.id}" — skipped`);
            continue;
        }
        // Cap the boost at +0.3 over the heuristic confidence so the LLM
        // can't unilaterally claim "100% sure" on a route the heuristic
        // had at 30%. The deterministic system retains weight.
        const ceiling = Math.min(1, target.confidence + 0.3);
        target.confidence = Math.min(adj.confidence, ceiling);
        target.source = 'llm-refined';
    }

    // 3. Merges
    for (const merge of refinement.merges ?? []) {
        const sources = merge.ids.map(id => out[id]).filter((d): d is DomainCluster => Boolean(d));
        if (sources.length < 2) {
            log(`[domainLlmRefiner] merge needs ≥2 known ids — skipped`);
            continue;
        }
        // Anchor on the highest-confidence parent; the merged domain
        // takes its slot. Routes + files are union-merged. Verb falls
        // back to the dominant parent's verb when LLM didn't supply one.
        sources.sort((a, b) => b.confidence - a.confidence);
        const anchor = sources[0];
        const others = sources.slice(1);
        for (const o of others) {
            for (const r of o.routes) if (!anchor.routes.includes(r)) anchor.routes.push(r);
            for (const f of o.files) if (!anchor.files.includes(f)) anchor.files.push(f);
            delete out[o.id];
        }
        anchor.name = merge.intoName;
        anchor.verb = merge.verb ?? anchor.verb;
        anchor.source = 'llm-refined';
        // Confidence after merge: average of the parents, capped at +0.2
        // over the highest input confidence (same containment rule).
        const avg = sources.reduce((s, d) => s + d.confidence, 0) / sources.length;
        anchor.confidence = Math.min(1, Math.max(anchor.confidence, avg + 0.1));
    }

    return out;
}
