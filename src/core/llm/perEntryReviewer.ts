/**
 * perEntryReviewer.ts — fan out AI review across every entry point's full
 * L1–L5 flow (#498 — AI Review across L1–L5 per entry point (orchestrator)).
 *
 * Distinct from `aiReviewEngine.executeAiReview`, which reviews diff-only
 * graph nodes in batches. This module reviews each entry point's complete
 * surface (handler source, sequence participants + messages, file deps,
 * flow control, cluster context) one at a time.
 *
 * Key design choices:
 *   - `llmCall` is injected so tests can run without a live provider.
 *   - Concurrency is bounded via a simple semaphore (default 4 in-flight).
 *   - Per-entry failures don't kill the run — they're captured per-entry.
 *   - User guidelines (from `getReviewGuidelines`) are injected verbatim
 *     into every prompt; the hash is stored on each finding for invalidation.
 */

import type { SnapshotStore } from '../storage/snapshotStore';
import type { ApiRecord } from '../graph/graphTypes';
import type {
    AiReviewFinding,
    AiReviewBaselineRef,
    AiReviewBinding,
    AiReviewSeverity,
    AiReviewCategory,
    DiagramType,
} from '../graph/graphTypes';
import { getEntryPointPack } from '../../mcp/contextPack';
import { postProcessFinding } from './findingPostProcess';
import { redactSecrets } from './llmNamingService';
import { buildDependentsForFiles, type FileDependents } from './dependencyContext';

export interface PerEntryLlmCall {
    (prompt: { system: string; user: string }, opts?: { signal?: AbortSignal }): Promise<RawLlmFindings>;
}

/** Findings as returned by the LLM (pre-binding).
 *
 * #513 — Every finding MUST include `evidence` quoting 1–5 lines from the
 * source. Findings without evidence that actually appears in the shipped
 * handler source are filtered out server-side. This is the primary lever
 * against the hallucination patterns observed in #512.
 */
export interface RawLlmFinding {
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    /** Layer claims — the binder maps these to graphIds. */
    layers: DiagramType[];
    /** Optional anchor inside the entry point's handler. */
    anchor?: { filePath?: string; symbol?: string };
    /** #513 — quoted evidence justifying the claim. Required at runtime. */
    evidence?: {
        filePath?: string;
        lineStart?: number;
        lineEnd?: number;
        snippet: string;
    };
}

export interface RawLlmFindings {
    findings: RawLlmFinding[];
}

/**
 * #513 / #527 / #605 — evidence-gate tolerance level.
 *
 * `strict` (default) preserves the original #527 behaviour: 5-line window,
 * budget = max(5, needle.length / 12). Recommended for capable models
 * (gpt-4o, claude-3.5-sonnet, gpt-4o-mini) that quote verbatim.
 *
 * `relaxed` widens the window to 10 lines and raises the floor to
 * max(8, needle.length / 8). Recommended for small local coder models
 * (deepseek-coder:6.7b, qwen2.5-coder:7b) that paraphrase more aggressively.
 * The bench in `e2e/llm-quality/keep-rate.bench.ts` measures the keep-rate
 * floor per (model, tolerance) pair.
 */
export type EvidenceGateTolerance = 'strict' | 'relaxed';

/**
 * #513 / #527 — verify a finding's evidence snippet actually appears in the
 * source we shipped to the model. Returns true if the finding should be kept.
 *
 * Tier 1: whitespace-normalised exact substring match. Fast, deterministic,
 * unchanged from the original #513 gate.
 *
 * Tier 2 (#527 — small-coder-model accommodation): if Tier 1 fails, slide a
 * window across the source and accept the closest Levenshtein match within
 * the configured budget. This catches the common deepseek-coder / starcoder
 * failure mode where the model paraphrases a quote (e.g. swaps a quote
 * style, fixes indentation, or trims a trailing comment) instead of copying
 * verbatim.
 *
 * Tier-2 parameters scale with `tolerance`: see EvidenceGateTolerance docs.
 *
 * Snippets shorter than 8 chars are still rejected (too easy to false-match).
 */
/**
 * #926 — strip unified-diff / line-number prefixes so a CLEAN code quote matches a
 * diff/windowed corpus: drops `… N unchanged …` markers and the leading
 * `+N: ` / `-     ` / ` N: ` / `N: ` prefix from each line. Safe on plain code
 * (lines without such a prefix are left unchanged).
 */
export function stripDiffPrefixes(text: string): string {
    return text.split('\n')
        .filter((l) => !/^\s*…/.test(l))
        .map((l) => l.replace(/^(?:[+\- ]\s*)?\d*:?\s?/, ''))
        .join('\n');
}

export function evidenceMatches(
    snippet: string,
    source: string,
    tolerance: EvidenceGateTolerance = 'strict',
): boolean {
    if (typeof snippet !== 'string' || typeof source !== 'string') return false;
    // #926 — the corpus is now a unified diff (`+`/`-`/`N:` prefixes); strip them so
    // a clean code quote (single- or multi-line) matches.
    const cleanSource = stripDiffPrefixes(source);
    const needle = stripDiffPrefixes(snippet).replace(/\s+/g, ' ').trim();
    if (needle.length < 8) return false;
    const hay = cleanSource.replace(/\s+/g, ' ');
    if (hay.includes(needle)) return true;
    return evidenceMatchesFuzzy(needle, cleanSource, tolerance);
}

/**
 * #855 — evidence confidence tier. `exact`/`fuzzy` come from the existing
 * substring/Levenshtein gate; `anchor` is the new fallback that rescues a
 * finding whose quote drifted too far to match BUT whose anchor symbol
 * resolves in the source AND whose quote demonstrably overlaps that symbol's
 * neighbourhood — the cal.com#8087 G2 failure mode (model retyped a long
 * multi-statement quote with one hallucinated token; anchor `bookingRefsFiltered`
 * was valid). `null` = drop.
 */
export type EvidenceConfidence = 'exact' | 'fuzzy' | 'anchor';

/**
 * Word-boundary token check: does `symbol` appear as an identifier in the
 * source (not as a substring of a longer identifier)?
 */
function symbolInSource(symbol: string, source: string): boolean {
    if (!symbol || symbol.length < 3) return false;
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$]|$)`);
    return re.test(source);
}

function tokenize(s: string): string[] {
    return (s.toLowerCase().match(/[a-z0-9_$]+/g) ?? []).filter((t) => t.length >= 2);
}

/**
 * Anchor-resolution tier (#855). Keep a quote-miss finding ONLY when both
 * hold, so precision stays defensible:
 *   1. the anchor symbol is a real identifier in the shipped source, and
 *   2. the model's snippet shares ≥60% of its tokens with the window of
 *      source lines around that symbol (it described the right code, just
 *      didn't copy it cleanly).
 */
export function anchorResolves(
    snippet: string,
    source: string,
    symbol: string | undefined,
): boolean {
    if (!symbol || typeof snippet !== 'string' || typeof source !== 'string') return false;
    if (!symbolInSource(symbol, source)) return false;
    const lines = source.split('\n');
    const hit = lines.findIndex((l) => symbolInSource(symbol, l));
    if (hit === -1) return false;
    // ±6 line window around the symbol's first appearance.
    const window = lines.slice(Math.max(0, hit - 6), hit + 7).join(' ');
    const winTokens = new Set(tokenize(window));
    const snipTokens = tokenize(snippet);
    if (snipTokens.length < 3) return false;
    const overlap = snipTokens.filter((t) => winTokens.has(t)).length;
    return overlap / snipTokens.length >= 0.6;
}

/**
 * Result-typed gate (#855). Returns the confidence tier a finding earned, or
 * `null` to drop. Wraps `evidenceMatches` (exact+fuzzy) and adds the anchor
 * tier when `allowAnchorTier` is set.
 */
export function resolveEvidence(
    snippet: string,
    source: string,
    opts: { tolerance?: EvidenceGateTolerance; symbol?: string; allowAnchorTier?: boolean } = {},
): EvidenceConfidence | null {
    if (typeof snippet !== 'string' || typeof source !== 'string') return null;
    const needle = snippet.replace(/\s+/g, ' ').trim();
    if (needle.length < 8) {
        // Too-short quote: anchor tier can still rescue if the symbol resolves.
        return opts.allowAnchorTier && anchorResolves(snippet, source, opts.symbol) ? 'anchor' : null;
    }
    const hay = source.replace(/\s+/g, ' ');
    if (hay.includes(needle)) return 'exact';
    if (evidenceMatchesFuzzy(needle, source, opts.tolerance ?? 'strict')) return 'fuzzy';
    if (opts.allowAnchorTier && anchorResolves(snippet, source, opts.symbol)) return 'anchor';
    return null;
}

/**
 * Sliding-window fuzzy match. For each window of up to maxWindow contiguous
 * source lines, normalise whitespace and compute Levenshtein distance to
 * the needle; accept if the best window is within the budget.
 *
 * `strict` (default): maxWindow=5, budget = max(5, needle.length / 12)
 * `relaxed`:          maxWindow=10, budget = max(8, needle.length / 8)
 */
function evidenceMatchesFuzzy(
    needle: string,
    source: string,
    tolerance: EvidenceGateTolerance,
): boolean {
    const lines = source.split('\n');
    if (lines.length === 0) return false;
    const isRelaxed = tolerance === 'relaxed';
    const budget = isRelaxed
        ? Math.max(8, Math.floor(needle.length / 8))
        : Math.max(5, Math.floor(needle.length / 12));
    const maxWindow = isRelaxed ? 10 : 5;
    for (let size = 1; size <= maxWindow; size++) {
        for (let i = 0; i + size <= lines.length; i++) {
            const window = lines.slice(i, i + size).join(' ').replace(/\s+/g, ' ').trim();
            if (Math.abs(window.length - needle.length) > budget) continue;
            if (levenshteinUnderBudget(window, needle, budget)) return true;
        }
    }
    return false;
}

/**
 * #605 — best-effort detector for "small coder model" identifiers. We
 * recommend `relaxed` tolerance + smallModelFallback for these so the gate
 * doesn't strand them at sub-50% keep-rate.
 *
 * Matched substrings: deepseek-coder, qwen2.5-coder / qwen-coder,
 * starcoder, codellama, granite-code, codegemma, opencoder.
 * Sizes ≤ 13B are auto-classified as "small". Anything matching `gpt-4`,
 * `claude-3-`, `claude-opus`, or `mistral-large` is "capable".
 */
export function isSmallCoderModel(modelId: string): boolean {
    const m = String(modelId ?? '').toLowerCase();
    if (!m) return false;
    // Capable model whitelist short-circuits.
    if (/(gpt-4|claude-3|claude-opus|mistral-large|llama-3\.[12].*70b)/.test(m)) return false;
    // Extract size first — `:<n>b` or `-<n>b`. If size > 13, treat as capable
    // regardless of family (e.g. qwen-coder:14b, codellama:34b).
    const sizeMatch = m.match(/[:\-](\d+(?:\.\d+)?)b\b/);
    const size = sizeMatch ? parseFloat(sizeMatch[1]) : null;
    if (size !== null && Number.isFinite(size) && size > 13) return false;
    // Known small-coder families (and any size ≤ 13 of those).
    if (/(deepseek-coder|qwen[0-9.]*-coder|qwen-coder|starcoder|codellama|granite-code|codegemma|opencoder)/.test(m)) return true;
    // Generic size-based heuristic — anything ≤ 13B.
    if (size !== null && Number.isFinite(size) && size <= 13) return true;
    return false;
}

/**
 * Capped Levenshtein: returns true as soon as a path within `budget` is
 * impossible, so worst-case work is `O(needle.length * budget)` instead
 * of `O(needle.length * window.length)`.
 */
function levenshteinUnderBudget(a: string, b: string, budget: number): boolean {
    if (Math.abs(a.length - b.length) > budget) return false;
    const m = a.length, n = b.length;
    if (m === 0) return n <= budget;
    if (n === 0) return m <= budget;
    // Standard two-row DP with early termination.
    let prev = new Array<number>(n + 1);
    let cur = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        let rowMin = cur[0];
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            cur[j] = Math.min(
                prev[j] + 1,        // delete
                cur[j - 1] + 1,     // insert
                prev[j - 1] + cost, // substitute
            );
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        // If every cell in this row exceeds budget, no completion can fit.
        if (rowMin > budget) return false;
        [prev, cur] = [cur, prev];
    }
    return prev[n] <= budget;
}

export interface ReviewScope {
    kind: 'all' | 'changed' | 'cluster' | 'entry';
    clusterId?: string;
    entryPointId?: string;
}

/**
 * Drop diagnostics for one entry-point run. #527 surfaces these to the UI
 * so users can tell when the model is struggling against the evidence gate.
 *
 *   raw            — number of findings the model emitted
 *   kept           — number that survived all gates and were persisted
 *   noEvidence     — dropped because the model omitted `evidence.snippet`
 *   evidenceMiss   — dropped because the snippet wasn't in the source
 *                    (tier-1 verbatim AND tier-2 fuzzy both missed)
 *   noBindings     — dropped because no layer mapped to a graphId
 *   gated          — dropped by applicability gate (#514 — Guidelines-applicability gate (per-finding)) / severity calib (#516)
 *   retried        — true if a re-quote retry pass fired for this entry
 */
export interface EntryDropCounts {
    raw: number;
    kept: number;
    noEvidence: number;
    evidenceMiss: number;
    noBindings: number;
    gated: number;
    retried: boolean;
}

export interface ReviewCallbacks {
    onEntryStart?(entryPointId: string, idx: number, total: number, api?: ApiRecord): void;
    /**
     * Fired when an entry's review completes (regardless of finding count).
     * `api` is the `ApiRecord` so the orchestrator can stamp cursors by
     * `apiId` after the loop — needed for #606-SYNTHETIC to distinguish
     * multiple call sites that share a `method:route` key.
     */
    onEntryDone?(entryPointId: string, findings: AiReviewFinding[], drops?: EntryDropCounts, api?: ApiRecord): void;
    onEntryError?(entryPointId: string, err: Error, api?: ApiRecord): void;
}

export interface ReviewRunResult {
    totalEntryPoints: number;
    reviewed: number;
    failed: number;
    findingsCount: number;
    durationMs: number;
    /**
     * #897 — entries that were NOT individually reviewed because the single-call
     * corpus budget filled up. They are excluded from the prompt entirely (so the
     * model is never asked to review source it can't see), and surfaced here so the
     * result can state an honest denominator ("N reviewed · M skipped").
     */
    skipped?: number;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Select the entry points in scope. Each row of `apiIndex` becomes one
 * review unit; we filter by `meta.clusterId` / method+route as requested.
 *
 * #606 — when `restrictToEntryPoints` is set, the post-scope list is
 * further filtered to only the listed `method:route` ids. The incremental
 * orchestrator uses this to skip entries whose review cursor still
 * matches the current source.
 */
export function selectEntryPoints(
    store: SnapshotStore,
    scope: ReviewScope,
    restrict?: ReadonlySet<string>,
    quiet = false,
): ApiRecord[] {
    const apis = Object.values(store.getWorking().apiIndex ?? {}) as ApiRecord[];
    const inScope = (() => {
        if (scope.kind === 'all') return apis;
        if (scope.kind === 'changed') {
            let changed = apis.filter((a) => a.diff && a.diff !== 'unchanged');
            // #894 — apply `restrict` BEFORE the rank/cap below. The incremental
            // orchestrator's re-review targets (#606 cursor) can rank beyond the
            // CAP when a shared routes/definition file in the diff marks a large
            // fan-out as `direct` — capping FIRST would drop exactly the entries
            // `restrict` asked for, so incremental review would silently review
            // nothing for them. Intersecting here makes the cap bound the
            // already-restricted (small) set instead. The final restrict filter
            // at the end of the function then re-applies as a harmless no-op.
            if (restrict && restrict.size > 0) {
                changed = changed.filter((a) => restrict.has(entryPointId(a)));
            }
            // #3 — a changed SHARED file (e.g. a core Rails model used by 470
            // endpoints) cascade-marks every dependent entry point as
            // `modified`, exploding the per-entry review to hundreds of calls
            // (discourse#10: 36 changed files → 473 entries → 1.1M tokens).
            // Distinguish DIRECTLY-changed handlers (own file changed) from
            // cascade-INDUCED (only a shared downstream changed): review all
            // direct, cap the induced (the shared file is covered by the
            // project pass). Uses file hashes already in the snapshot.
            const working = store.getWorking();
            const baseline = (store as { getBaseline?: () => { files?: Record<string, { hash?: string }> } }).getBaseline?.() ?? { files: {} };
            const fileChanged = (fp?: string): boolean => {
                if (!fp) return false;
                const w = (working.files as any)?.[fp]?.hash, b = (baseline.files as any)?.[fp]?.hash;
                return w === undefined || b === undefined || w !== b; // added / modified file
            };
            // Rank: entries whose OWN handler file changed first (`direct`),
            // then cascade-induced. NOTE: a shared DEFINITION file in the diff
            // (Rails `config/routes.rb`, Django `urls.py`) marks EVERY route it
            // defines as direct — so direct-vs-induced alone can't tame the
            // fan-out. The hard cap below is the catch-all.
            const direct = changed.filter((a) => fileChanged(a.filePath));
            const induced = changed.filter((a) => !fileChanged(a.filePath));
            // #943 — within directly-changed entries, rank ADDED ahead of MODIFIED.
            // A shared definition/routes file in the diff marks EVERY route it
            // defines as `direct` (and cascade-`modified`), so the route the PR
            // actually ADDED gets crowded out of the cap by pre-existing siblings
            // that merely share the touched file (discourse#4 added `embed#best`
            // but 24 unchanged sibling routes filled the cap and it was never
            // individually reviewed). A newly-added entry point is almost always
            // the PR's real change — surface it first.
            const directAdded = direct.filter((a) => a.diff === 'added');
            const directOther = direct.filter((a) => a.diff !== 'added');
            const ranked = [...directAdded, ...directOther, ...induced];
            const CAP = Number(process.env.CODEATLAS_REVIEW_ENTRY_CAP) || 25;
            if (ranked.length > CAP) {
                // No silent caps — log what was dropped (the broad change is
                // still reviewed once by the project pass over the changed files).
                // `quiet` suppresses the log for the #934 coverage probe that
                // calls this purely to learn WHICH files get reviewed.
                if (!quiet) {
                    // eslint-disable-next-line no-console
                    console.error(`[review] changed-scope: ${ranked.length} entry points marked changed (likely a shared definition/routes file in the diff). Capping per-entry review to ${CAP} (directly-changed-handler entries first); the remaining ${ranked.length - CAP} are NOT individually reviewed — the broad change is covered by the project pass. Override with CODEATLAS_REVIEW_ENTRY_CAP.`);
                }
                return ranked.slice(0, CAP);
            }
            return changed;
        }
        if (scope.kind === 'cluster' && scope.clusterId) {
            // Use the same `resolveClusterId` fallback as the binding resolver
            // so cluster-scoped reviews work even when `api.meta.clusterId`
            // isn't stamped on apiRecords (pipeline gap noted in the binding
            // resolver doc above).
            return apis.filter((a) => resolveClusterId(a, store) === scope.clusterId);
        }
        if (scope.kind === 'entry' && scope.entryPointId) {
            const [method, ...rest] = scope.entryPointId.split(':');
            const route = rest.join(':');
            return apis.filter((a) => String(a.method).toUpperCase() === method.toUpperCase() && a.route === route);
        }
        return [];
    })();
    if (!restrict || restrict.size === 0) return inScope;
    return inScope.filter((a) => restrict.has(`${String(a.method ?? '').toUpperCase()}:${a.route ?? ''}`));
}

function entryPointId(api: ApiRecord): string {
    return `${String(api.method ?? '').toUpperCase()}:${api.route ?? ''}`;
}

/**
 * #934 — the set of changed files the per-entry pass ACTUALLY reviews (cap-aware).
 * The project pass uses this (not "every entry-anchored file") to decide which
 * changed files still need diff-windowed coverage: when a shared file marks
 * >CAP entries changed, the controllers/migrations ranked beyond the cap are
 * reviewed by NEITHER pass otherwise. `quiet` so this probe never emits the
 * cap-log a second time.
 */
// #944 — narrow per-file HOOK methods review only a one-line declaration, never
// the file's other changed code. A Rails `before_action` (FILTER) or an ORM
// lifecycle callback (MODEL_HOOK) entry's handlerSource is just the hook
// declaration (and FILTER handlers are often INHERITED — resolved to a base
// class in a different file). So a changed file whose ONLY reviewed entry is such
// a hook is NOT actually covered: its real changed methods reached neither the
// per-entry pack (which showed only the hook line) nor the project pass (which
// excluded it as "covered"). discourse#10's EmbeddableHostsController surfaced
// only as an inherited `before_action :ensure_logged_in` FILTER, so its changed
// update/destroy bodies (golden G2) were never reviewed. Don't let a hook entry
// mark its file covered — a real handler (route/job/socket/etc.) in the same file
// still does, so a controller with a genuine route is unaffected.
const NON_COVERING_HOOK_METHODS = new Set(['FILTER', 'MODEL_HOOK']);

export function reviewedEntryPointFiles(store: SnapshotStore, scope: ReviewScope = { kind: 'changed' }): Set<string> {
    return new Set(
        selectEntryPoints(store, scope, undefined, true)
            .filter((a) => !NON_COVERING_HOOK_METHODS.has(String(a.method ?? '').toUpperCase()))
            .map((a) => a.filePath)
            .filter((fp): fp is string => typeof fp === 'string' && fp.length > 0),
    );
}

/**
 * Resolve an api's cluster id either from `api.meta.clusterId` (preferred —
 * stamped at pipeline finalization) or by falling back to the snapshot's
 * clusters' file membership lists. The fallback exists because not every
 * workspace populates `meta.clusterId` on apiRecords today (a pipeline gap
 * tracked separately) — without it, every finding bound to `feature` or
 * `api-list` would otherwise collapse onto `feature:workspace`, losing the
 * cluster name in summaries and the popover.
 */
function resolveClusterId(api: ApiRecord, store: SnapshotStore): string | undefined {
    const direct = (api.meta as any)?.clusterId;
    if (direct) return direct;
    const fp = api.filePath ?? '';
    if (!fp) return undefined;
    try {
        const clusters = store.getWorking().clusters ?? {};
        for (const c of Object.values(clusters)) {
            if ((c as any)?.files?.includes(fp)) return (c as any).id;
        }
    } catch { /* swallow — fallback only */ }
    return undefined;
}

/** Map an LLM layer claim to a concrete graphId for this entry point. */
function layerToGraphId(layer: DiagramType, api: ApiRecord, store: SnapshotStore): string | null {
    const fp = api.filePath ?? '';
    const handler = api.handlerName ?? '';
    switch (layer) {
        case 'microservice': return 'microservice:workspace';
        case 'feature': {
            const cid = resolveClusterId(api, store);
            return cid ? `feature:${cid}` : 'feature:workspace';
        }
        case 'api-list': {
            const cid = resolveClusterId(api, store);
            return cid ? `api-list:${cid}` : null;
        }
        case 'sequence': return fp && handler ? `sequence:${fp}:${handler}` : null;
        case 'file': return fp ? `file:${fp}` : null;
        case 'flow': return fp && handler ? `flow:${fp}:${handler}` : null;
        default: return null;
    }
}

/**
 * Build the bindings for a finding by resolving each claimed layer into a
 * graphId. `targetId` defaults to a stable per-entry-point key so the UI can
 * dedup; the per-entity binder (#501 — Per-entity finding markers) refines this later.
 */
function bindFinding(raw: RawLlmFinding, api: ApiRecord, store: SnapshotStore): AiReviewBinding[] {
    const out: AiReviewBinding[] = [];
    const epKey = entryPointId(api);
    for (const layer of raw.layers || []) {
        const gid = layerToGraphId(layer, api, store);
        if (!gid) continue;
        out.push({
            graphId: gid,
            targetId: `${epKey}::entry`,   // refined by #501
            targetType: 'node',
            layer,
        });
    }
    return out;
}

/**
 * Build the prompt for a single entry point. Returns `{ system, user,
 * sourceCorpus }` — the corpus is the verbatim source we ship to the model
 * and is what the server-side evidence filter checks against.
 */
function buildPromptContext(api: ApiRecord, store: SnapshotStore): { system: string; user: string; sourceCorpus: string } {
    const guidelines = store.getReviewGuidelines();
    const pack = (() => {
        try {
            // #866: pass content resolvers + `lean` so the per-entry pack carries
            // a diff-windowed `handlerSource` (previously undefined → the model
            // was source-blind to code-level bugs) plus a diff-relevant/top-K
            // graph. baseline-vs-working content IS the PR diff (review-pr sets
            // baseline=base, working=head), so no git-hunk plumbing is needed.
            const working = (fp: string) => store.getFileContent?.('working', fp) ?? (store.getWorking().files as any)?.[fp]?.content;
            const baseline = (fp: string) => store.getFileContent?.('baseline', fp) ?? (store.getBaseline?.()?.files as any)?.[fp]?.content;
            return getEntryPointPack(store.getWorking(), api.method, api.route, {
                workspaceFileContent: working,
                baselineFileContent: baseline,
                lean: true,
            });
        } catch {
            return null;
        }
    })();
    // #886 — redact secrets from EVERY source channel BEFORE it enters the
    // prompt OR the evidence corpus. Sibling AI paths already redact
    // (aiReviewEngine.ts, llmNamingService.ts); the per-entry path was the gap —
    // a handler with a hardcoded key / `Authorization: Bearer …` / connection URI
    // was shipped verbatim to the remote LLM. The SAME redacted text feeds both
    // the prompt and the gate corpus, so the model can only ever quote a redacted
    // line and the gate stays consistent (no spurious drops). Redact the handler
    // source in the pack in place so the pack embedded in `user` is clean too.
    if (pack && typeof (pack as any).handlerSource === 'string') {
        (pack as any).handlerSource = redactSecrets((pack as any).handlerSource);
    }
    // #865 — redact downstream callee sources too (same channel discipline): the
    // pack embedded in `user` and the gate corpus must both see only redacted text.
    if (pack && Array.isArray((pack as any).participantSources)) {
        for (const ps of (pack as any).participantSources) {
            if (ps && typeof ps.source === 'string') ps.source = redactSecrets(ps.source);
        }
    }
    // The corpus the evidence-gate verifies against. Includes the handler
    // source slice (from the pack) PLUS the full file content from the
    // snapshot (so we don't false-reject quotes from outside the handler
    // body the pack happened to slice). Anything outside this corpus is
    // hallucination.
    const fileContent = (() => {
        try {
            const fp = api.filePath ?? '';
            // #892 — `.content` is dropped from the in-RAM snapshot after save()
            // (lazy-content), and review-pr saves BEFORE the review runs, so the
            // bare `files[fp].content` read is EMPTY during the PR-review path →
            // the gate then mass-drops valid findings (false "no issues"). Use the
            // getFileContent fallback (re-hydrates from SQLite) first.
            const raw = store.getFileContent?.('working', fp) ?? (store.getWorking().files as any)?.[fp]?.content ?? '';
            return redactSecrets(String(raw)); // #886
        } catch { return ''; }
    })();
    const sourceCorpus = [
        (pack as any)?.handlerSource ?? '',   // #886 — already redacted in place above
        fileContent,                           // #886 — redacted
        // #865 — downstream callee function bodies from the resolved interactions,
        // so a cross-file quote (validate-here-use-there, unawaited downstream,
        // contract mismatch in a callee) survives the evidence gate.
        ...(((pack as any)?.participantSources ?? []).map((ps: any) => String(ps?.source ?? ''))),
        // Pack-emitted sibling messages / participants → strings the model
        // can quote even if they're not "in" the file's source proper.
        redactSecrets(JSON.stringify((pack as any)?.messages ?? '')),
        redactSecrets(JSON.stringify((pack as any)?.flowNodes ?? '')),
    ].join('\n\n');

    const system = [
        'You are a senior code reviewer for a multi-layer codebase. Review the entry point provided.',
        '',
        'DIFF FORMAT (#925): the `handlerSource` is a UNIFIED DIFF of THIS PR — `+N: <added line>`, `-     <removed line>`, ` N: <context>`,',
        '  with `… N unchanged …` gaps. The `+`/`-` lines are EXACTLY what the PR changed — focus there and reason about what the change BREAKS',
        '  (a bug the diff introduced), not pre-existing code. When you quote evidence, copy ONLY the code text (drop the leading `+`/`-`/`N:` prefix).',
        '',
        'EVIDENCE RULE — non-negotiable (#855 — short exact quotes):',
        '  Every finding MUST include an `evidence` field with a snippet copied VERBATIM from the source we provide.',
        '  Quote ONE short fragment — 1 line, at most 2 — copied CHARACTER-FOR-CHARACTER. Do NOT merge multiple',
        '  statements into one quote, do NOT reflow, re-indent, or retype from memory. A long retyped quote that',
        '  changes even a single token (e.g. `booking_ref` vs `bookingRef`) is REJECTED. When in doubt, quote less.',
        '  Always set `anchor.symbol` to the exact identifier the issue is about — it is used to resolve your finding',
        '  even if your quote drifts. Do NOT invent code. If you cannot find the issue in the actual source, drop it.',
        '',
        'CHANGED-LINE HYGIENE (#855):',
        '  Inspect every line this PR adds or modifies. A newly added `await`, dynamic `import(...)`, fetch, or other',
        '  I/O call with NO surrounding error handling (try/catch or `.catch`) IS a finding. New code is the highest',
        '  priority — a pre-existing issue on an unchanged line matters less than one the PR introduces.',
        '',
        'APPLICABILITY RULE:',
        '  For category "guideline", only flag a finding when the route/handler actually has the property the guideline targets.',
        '  Example: a guideline about "POST/PUT/PATCH/DELETE need auth" does NOT apply to GET routes — skip it.',
        '  Example: a "webhook signature" guideline does NOT apply unless the route is genuinely a webhook (path/cluster matches).',
        '',
        'MIDDLEWARE-CHAIN AWARENESS — UX-48 (2026-06-05):',
        '  `entryPoint.meta.middlewares` (when present) is the SOURCE-EXTRACTED middleware chain for this route — already',
        '  resolved across cors, auth, rate-limit, validation, caching, error-handling, etc. When the chain contains an',
        '  auth-shaped middleware (entries matching `auth*`/`jwt*`/`requireAuth`/`login_required`/`IsAuthenticated`/`@Authorize`/etc.)',
        '  the route IS auth-gated — do NOT raise "missing auth" findings against it on the basis of the handler body alone.',
        '  Conversely, an empty/absent middlewares array on a write route (POST/PUT/PATCH/DELETE) IS evidence that the route',
        '  lacks the auth/validation/rate-limit pieces a guideline might require — that absence is fair game.',
        '',
        'CALL-CHAIN REASONING — #864 (your edge over diff-only review):',
        '  The `pack` resolves this entry point\'s cross-file call chain for you: `messages` (who calls whom across',
        '  files, with the call label), `flowNodes` (the handler\'s control flow), and `participants` (the downstream',
        '  files/modules reached). Reason over the WHOLE chain, not just the handler body. The highest-value findings',
        '  are ones invisible in a single diff hunk:',
        '    • a value validated/authorized in the handler but passed UNCHECKED to a downstream participant,',
        '    • auth/tenant scoping enforced at the controller but missing on a service the chain reaches,',
        '    • an unawaited / un-caught downstream call whose failure escapes the handler\'s try/catch,',
        '    • a contract mismatch — the handler passes a shape the callee does not handle.',
        '  #865: `participantSources` gives you the ACTUAL source of the downstream functions this handler calls (the',
        '  resolved interactions, not whole files). Read it — a cross-file bug (the callee that mis-handles the shape, the',
        '  service missing the auth check, the unawaited downstream write) is provable by quoting a line from THAT callee.',
        '  Quote evidence ONLY from what you were actually shown (the handler source, a `participantSources[].source`, or the',
        '  `messages`/`flowNodes` the pack lists) — set `anchor.filePath` to the participant file the bug concerns (the',
        '  `participantSources[].filePath`) and `layers` to include "sequence".',
        '',
        'CORRECTNESS BUG CLASSES — #872/#881 (derived from 136 real reviewer-found bugs; the highest-recall families):',
        '  Actively check the CHANGED code for each of these. Flag ONLY with concrete harm + verbatim evidence (precision still rules):',
        '  • Null/undefined safety: a value that can be null/undefined dereferenced without a guard (`.x`, `[i]`, a call); an',
        '    empty/zero/`""` default a downstream step assumes is populated; a `?.` that is REDUNDANT because the value was already null-checked.',
        '  • Async ordering: `forEach(async …)`, an unawaited promise, or a fire-and-forget call on a cleanup / delete / payment / notify path.',
        '  • Logic slips: an inverted boolean (`&&` where `||` is meant — especially admin/permission checks), off-by-one / boundary,',
        '    the WRONG variable used (e.g. start vs end time), an unreachable `else`/branch, or a method/const DEFINED TWICE.',
        '  • Reference equality: `===` / `!==` comparing objects or dates (`Date`, dayjs) — compares identity not value, so the branch is always false.',
        '  • Case / normalization: case-sensitive `===` / `indexOf` / blacklist on values that should be normalized (email, codes, usernames) — a trivial-case bypass.',
        '  • Type / contract mismatch: a value passed in a shape the callee does not handle; a return used as the wrong type',
        '    (e.g. a `safeParse` result `{success,data,error}` used as the data object); an HTTP method the handler does not implement.',
        '  • Unvalidated input → sensitive sink: external input reaching `open(url)` / `fetch(url)` with no allowlist (SSRF), a query/exec',
        '    without sanitization (injection), or a write route with no schema validation.',
        '  • Portability: platform-specific shell/syntax (e.g. macOS `sed -i \'\'`) in a script meant to run cross-platform / in CI.',
        '  • Concurrency / TOCTOU (#881): a check-then-act on shared state with no lock/transaction (device/quota limits, one-time codes — two requests both pass);',
        '    a non-atomic read-modify-write (`x = row.count + 1` then save — should be an atomic DB increment); a double-checked lock that omits the re-check, or',
        '    a cache that TRUSTS grants but re-fetches denials (asymmetric trust → stale grant survives a revoke).',
        '  • Authorization resolution (#881): a permission / scope / ownership check resolved against the WRONG key — a per-resource lookup that always falls back',
        '    to a type-level / "all-*" resource, an id-vs-name or owner mismatch, or a check guarded by the wrong feature-flag VERSION (V1 vs V2) so cleanup/denial silently skips.',
        '  • Resource lifecycle / cleanup (#881): an operation that leaves ORPHANED state — a record cancelled in one branch but not the symmetric one, a loop that',
        '    `break`s before terminating the remaining workers/processes, or an empty `data: {}` update that skips an ORM auto-timestamp (`@updatedAt`).',
        '  • Error handling (#881): a fallible call (await / network / parse / decode) with no try-catch on a path that must fail gracefully; an over-broad',
        '    `catch (Exception/RuntimeException)` that hides the specific error a test/caller expects; a wrong log LEVEL (Error for debug → pollutes prod) or a dropped trace id.',
        '  • ORM / query pitfalls (#881): framework query traps — Django querysets reject negative slicing/indexing; `floor`/`ceil` on a datetime cursor key (TypeError);',
        '    a bulk `createMany`/insert with no in-input dedup; a non-deterministic `hash()` used as a cross-process cache key.',
        '  • Contract & identifier integrity (#881): a subclass that leaves an abstract/interface method UNIMPLEMENTED (TypeError at instantiate); an HTTP verb the route',
        '    expects but the handler omits; a renamed/misspelled identifier that breaks a CONTRACT or CONVENTION callers depend on (method/property/serializer name,',
        '    Rails `include_*?` suffix) — NOT cosmetic typos in comments or test names.',
        '  • Logging / observability (#920): the CHANGED code logs the WRONG level (debug/info content emitted at ERROR/WARN → pollutes prod dashboards & alerting),',
        '    OVER-logs on a hot path or inside a loop (perf + log-volume + cost blow-up), logs a SECRET / token / PII / full request body, or DROPS a trace /',
        '    correlation / request id that breaks request tracing. Conversely, a critical failure path that logs NOTHING (silent swallow) is also a finding.',
        '  • Behavior-change / regression (#924): the diff silently CHANGES runtime semantics in a breaking way — a previously async / non-blocking / non-fatal path now',
        '    blocks or fails the whole request (e.g. an auth/tagging step that used to fail-open now fails-closed), a default flipped, or a guard that now rejects inputs it used to accept.',
        '  • Config hardcoding (#924): a hardcoded literal (size / limit / URL / timeout / feature flag) that bypasses a configurable or server-side setting, so client vs server',
        '    (or per-environment) limits silently DIVERGE — the value should read from the setting/config, not a constant.',
        '  • CSRF / weak token (#924): a state / CSRF / nonce / session / OAuth-state token derived from a STATIC or predictable value (a fixed signature, a constant, a counter)',
        '    instead of per-request cryptographic randomness — it can be forged or replayed. (Distinct from the SSRF/injection sink above.)',
        '  • Recursion / self-delegation (#924): a method that recurses through ITSELF / the cache / the session instead of the underlying delegate/store → infinite loop or',
        '    cache-bypass (e.g. a caching `get`/`check` that calls back through the cache layer rather than the backing delegate).',
        '  • Wrong / misleading return (#924): returns the WRONG object (a default/fallback instead of the specific one requested), or a misleading error/status for the actual',
        '    condition (e.g. "limit reached" when the real cause is "no rows matched") — the caller then branches on a false signal.',
        '',
        'PRECISION DISCIPLINE — #864 (precision over volume):',
        '  Emit a finding only when you can name the concrete harm — WHAT breaks and for WHOM — and quote evidence.',
        '  Do NOT pad the review with stylistic nits, naming opinions, or "consider extracting/refactoring" suggestions;',
        '  on a PR those are noise that bury the real issues. If you are not confident the bug is real, drop it.',
        '  One well-evidenced `error` is worth more than five speculative `info`s.',
        '',
        'PRECISION GATES — apply to EVERY finding (#948–#952; a missed nit costs far less than a false alarm):',
        '  • EVIDENCE-GATED (#948): the finding must rest on a CHANGED (`+`) line of `handlerSource` you can quote. If your only',
        '    basis is hypothetical — "could"/"may"/"might"/"possibly"/"if an attacker"/"what if" — and the trigger is NOT in the',
        '    diff, DROP it. No speculative CSRF/retry/idempotency/empty-input/concurrency claims without diff evidence.',
        '  • DIFF-SCOPED (#949): raise findings on the CHANGED handler code (`+`/`-`) or a provably-buggy downstream',
        '    `participantSources[]` line you can quote. `pack`/`dependents`/`messages` and the unchanged ` N:` context are',
        '    REFERENCE to reason with — never a finding location for an unchanged-code root cause.',
        '  • VERIFY-BEFORE-ABSENT (#950): never claim a symbol/route/handler/import/action is "missing"/"undefined"/"not',
        '    implemented", or that a "caller breaks", without confirming it is absent from ALL provided sources. Do NOT infer',
        '    breakage from an elided "… N unchanged …" gap or a truncated snippet.',
        '  • REDACTION (#952): `[REDACTED]` / `[REDACTED_URI]` is a masked secret VALUE — treat it as opaque and valid; never',
        '    flag it as a syntax error, an always-truthy/falsy condition, an invalid literal, or a type mismatch.',
        '  • PRODUCTION-FIRST (#951): spend findings on production code; in test/spec/fixture/cypress files report ONLY a real',
        '    test-correctness bug (a wrong assertion/verb that lets a product bug pass) — skip stale-id/HTTP-status/placeholder nits.',
        '',
        'For each issue you identify, emit JSON with these fields:',
        '  - severity: "info" | "warning" | "error"',
        '      • error: security/auth bypass, data corruption, missing critical validation, AND',
        '        unawaited async side-effects in cleanup/deletion/payment/notification paths',
        '        (e.g. `forEach(async …)` or a fire-and-forget promise whose failure escapes try/catch)',
        '        — these are race conditions / silent data loss, NOT mere code-quality nits. Rate them `error`.',
        '      • warning: N+1, missing error handling on non-critical paths, redundant/unreachable logic',
        '      • info: nits, stylistic, low-impact suggestions',
        '  - category: one of "architecture", "api-design", "code-quality", "logic-bug", "security", "performance", "guideline"',
        '  - title: short headline (≤ 60 chars)',
        '  - body: 1–3 sentences explaining the issue and the fix',
        '  - layers: subset of ["microservice","feature","api-list","sequence","file","flow"]',
        '  - anchor: { filePath, symbol } if tied to a specific symbol',
        '  - evidence: { snippet: "verbatim source lines", lineStart?: N, lineEnd?: N }',
        '',
        'DEPENDENTS (#946): a `dependents` array may list callers / interface implementers / sibling-impls / tests of',
        '  this handler\'s file that live in OTHER files. Use them to judge cross-file contract breaks — a caller that',
        '  assumes the handler\'s old return shape/nullability/error behavior, or an implementer/sibling that did not',
        '  update to a changed signature. Anchor the finding on a file you were shown; name the dependent in the body.',
        'Return JSON of shape { "findings": [...] }. No prose, no code fences.',
        guidelines.text
            ? `\n[USER GUIDELINES BEGIN]\n${guidelines.text}\n[USER GUIDELINES END]\n\nThe user guidelines above are the ONLY guidelines. Do not invent additional ones. Only flag a "guideline"-category finding when both (a) the guideline applies to this route, and (b) you can quote evidence from the source.`
            : '',
    ].join('\n');
    // #946 — dependency-aware context: callers / implementers / tests of this
    // handler's file that live OFF-screen, so a contract change here can be judged
    // against its consumers. Read-only; never throws.
    let dependents: FileDependents[] = [];
    try {
        if (api.filePath) dependents = buildDependentsForFiles(store as any, [api.filePath], { maxPerFile: 4 });
    } catch {
        dependents = [];
    }
    // #886 — final redaction pass over the whole serialized prompt catches any
    // OTHER source-bearing pack field (file-source slices, graph node bodies)
    // beyond `handlerSource`, so no raw secret reaches the LLM.
    const dep = dependents[0]?.dependents?.length ? { dependents: dependents[0].dependents } : {};
    const user = redactSecrets(JSON.stringify({
        entryPoint: { method: api.method, route: api.route, handlerName: api.handlerName, filePath: api.filePath, meta: api.meta },
        pack,
        ...dep,
    }, null, 2));
    return { system, user, sourceCorpus };
}

// ── #527 helpers ─────────────────────────────────────────────────────────

interface ProcessOpts {
    raw: RawLlmFinding[];
    api: ApiRecord;
    prompt: { sourceCorpus: string };
    gateEnabled: boolean;
    model: string;
    store: SnapshotStore;
    guidelinesHash?: string;
    baselineRef?: AiReviewBaselineRef;
    /** #605 — gate tolerance for the evidence-snippet match. */
    tolerance?: EvidenceGateTolerance;
    /**
     * #855 — allow the anchor-resolution fallback tier. When a quote misses
     * exact+fuzzy but the anchor symbol resolves and the quote overlaps its
     * neighbourhood, keep the finding tagged `anchor` instead of dropping.
     * Defaults on; set false to restore strict quote-only behaviour.
     */
    allowAnchorTier?: boolean;
    /**
     * Blast radius summary for this entry-point's file. Stamped onto every
     * kept finding so the popover can show "fixing this affects N callers
     * across M services" alongside severity.
     */
    blastRadius?: import('../graph/graphTypes').AiReviewBlastRadius;
}

interface ProcessResult {
    kept: AiReviewFinding[];
    drops: { noEvidence: number; evidenceMiss: number; noBindings: number; gated: number };
    /** Findings whose evidence didn't match — fed into the #527 retry prompt. */
    evidenceRejected: RawLlmFinding[];
}

/**
 * Apply the same gauntlet (evidence → bindings → applicability/severity) to
 * a list of raw findings. Extracted out of `runPerEntryReview` so the #527
 * retry pass can reuse the exact same path.
 */
function processFindings(opts: ProcessOpts): ProcessResult {
    const kept: AiReviewFinding[] = [];
    const drops = { noEvidence: 0, evidenceMiss: 0, noBindings: 0, gated: 0 };
    const evidenceRejected: RawLlmFinding[] = [];
    for (const raw of opts.raw) {
        const snippet = raw.evidence?.snippet ?? '';
        // #855 — confidence tier of the kept evidence (exact when the gate is
        // off, since we shipped no verification).
        let confidence: EvidenceConfidence = 'exact';
        if (opts.gateEnabled) {
            if (!snippet) { drops.noEvidence += 1; continue; }
            const tier = resolveEvidence(snippet, opts.prompt.sourceCorpus, {
                tolerance: opts.tolerance ?? 'strict',
                symbol: raw.anchor?.symbol ?? opts.api.handlerName,
                allowAnchorTier: opts.allowAnchorTier !== false,
            });
            if (tier === null) {
                drops.evidenceMiss += 1;
                evidenceRejected.push(raw);
                continue;
            }
            confidence = tier;
        }
        const bindings = bindFinding(raw, opts.api, opts.store);
        if (bindings.length === 0) { drops.noBindings += 1; continue; }
        const post = postProcessFinding({
            severity: raw.severity,
            category: raw.category,
            title: raw.title,
            body: raw.body,
            bindings,
            entryPointId: entryPointId(opts.api),
            snippet,
            method: opts.api.method,
            route: opts.api.route,
            clusterId: (opts.api.meta as any)?.clusterId,
        });
        if (!post.keep) { drops.gated += 1; continue; }
        const f = opts.store.upsertAiReviewFinding({
            entryPointId: entryPointId(opts.api),
            bindings,
            severity: post.finding.severity,
            category: post.finding.category,
            title: post.finding.title,
            body: post.finding.body,
            anchor: {
                filePath: raw.anchor?.filePath ?? opts.api.filePath,
                symbol: raw.anchor?.symbol ?? opts.api.handlerName,
                ...(snippet ? { snippet, lineStart: raw.evidence?.lineStart, lineEnd: raw.evidence?.lineEnd } : {}),
                // #855 — evidence confidence tier ('anchor' = quote drifted but
                // the symbol resolved; surfaced in the PR comment).
                evidenceConfidence: confidence,
            } as any,
            status: 'open',
            model: opts.model,
            guidelinesHash: opts.guidelinesHash,
            ...(opts.baselineRef ? { baselineRef: opts.baselineRef } : {}),
            // Blast-radius stamp — pre-computed per entry-point so every
            // finding from the same handler shares the same summary.
            ...(opts.blastRadius ? { blastRadius: opts.blastRadius } : {}),
        } as any);
        kept.push(f);
    }
    return { kept, drops, evidenceRejected };
}

function mergeDrops(
    a: ProcessResult['drops'],
    b: ProcessResult['drops'],
): ProcessResult['drops'] {
    return {
        noEvidence: a.noEvidence + b.noEvidence,
        evidenceMiss: a.evidenceMiss + b.evidenceMiss,
        noBindings: a.noBindings + b.noBindings,
        gated: a.gated + b.gated,
    };
}

/**
 * Build the second-pass user-message addendum that asks the model to re-quote
 * its evidence verbatim. Lists the rejected titles + their attempted snippets
 * so the model has the specific context for what to fix.
 */
function buildRequoteHint(rejected: RawLlmFinding[]): string {
    const items = rejected.slice(0, 5).map((r, i) => {
        const att = (r.evidence?.snippet ?? '').slice(0, 200);
        return `  ${i + 1}. "${r.title}" — your attempted quote: \`${att}\``;
    });
    return [
        '[EVIDENCE GATE — RETRY]',
        'Your previous response was rejected because the snippets you quoted',
        'do not appear verbatim in the source we provided. Re-emit ONLY the',
        'findings below, but this time copy the `evidence.snippet` field',
        'EXACTLY from one of the source files in the user-message pack — same',
        'whitespace, same quote style, same identifiers. If a finding cannot',
        'be grounded that way, drop it instead of paraphrasing.',
        '',
        ...items,
        '',
        'Return the same JSON shape: { "findings": [...] }. No prose.',
    ].join('\n');
}

/** Simple semaphore — bounded concurrency without external deps. */
function semaphore(max: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    return {
        async acquire(): Promise<void> {
            if (active < max) { active += 1; return; }
            await new Promise<void>((res) => queue.push(res));
            active += 1;
        },
        release() {
            active -= 1;
            const next = queue.shift();
            if (next) next();
        },
    };
}

export interface RunPerEntryReviewArgs {
    store: SnapshotStore;
    scope: ReviewScope;
    llmCall: PerEntryLlmCall;
    model: string;
    callbacks?: ReviewCallbacks;
    concurrency?: number;
    signal?: AbortSignal;
    /**
     * #513 — when false, the server-side evidence gate is bypassed and every
     * finding the model emits is kept (the gate's drop reasons still go into
     * the debug log). Default: true (gate enforced). Exposed as a webview
     * toggle so users can compare gated vs un-gated output.
     */
    evidenceGate?: boolean;
    /**
     * #534 — provenance tag stamped on every finding emitted by this run.
     * Caller computes it once via `computeBaselineRef()` so all findings in
     * a single review share the same ref.
     */
    baselineRef?: AiReviewBaselineRef;
    /**
     * #605 — evidence-gate tolerance. When omitted, we auto-pick:
     * `relaxed` for known small-coder models (deepseek-coder, qwen-coder,
     * etc. — see `isSmallCoderModel`), `strict` for everything else.
     * Callers can override (e.g. the bench passes both values to compare).
     */
    tolerance?: EvidenceGateTolerance;
    /**
     * #605 — small-model fallback. When both the first pass AND the #527
     * re-quote retry return zero kept findings on a small-coder model, and
     * this is set, we re-run that single entry-point against a stronger
     * model via `fallbackLlmCall`. Bounded to one extra call per entry to
     * keep cost predictable. Skipped when the run was started with a model
     * already classified as "capable" (`!isSmallCoderModel(model)`).
     */
    fallbackLlmCall?: PerEntryLlmCall;
    fallbackModel?: string;
    /**
     * #606 — restrict the in-scope entries to only these `method:route`
     * ids. The incremental review orchestrator computes the delta against
     * the per-entry cursors and passes the changed-only set here so the
     * LLM is invoked exclusively on entries that actually need re-review.
     * When omitted, every entry in `scope` is reviewed.
     */
    restrictToEntryPoints?: ReadonlySet<string>;
}

export async function runPerEntryReview(args: RunPerEntryReviewArgs): Promise<ReviewRunResult> {
    const started = Date.now();
    const apis = selectEntryPoints(args.store, args.scope, args.restrictToEntryPoints);
    const sem = semaphore(args.concurrency ?? DEFAULT_CONCURRENCY);
    let reviewed = 0;
    let failed = 0;
    let findingsCount = 0;
    const guidelinesHash = args.store.getReviewGuidelines().hash || undefined;
    // #605 — pick a tolerance level for the gate. Caller's explicit choice
    // wins; otherwise relax for known small-coder models.
    const tolerance: EvidenceGateTolerance = args.tolerance
        ?? (isSmallCoderModel(args.model) ? 'relaxed' : 'strict');
    // #605 — only attempt the small-model fallback when we're actually
    // running a small-coder model AND the caller wired a fallback.
    const fallbackEnabled = !!args.fallbackLlmCall
        && !!args.fallbackModel
        && isSmallCoderModel(args.model);

    const tasks = apis.map(async (api, idx) => {
        await sem.acquire();
        try {
            if (args.signal?.aborted) return;
            args.callbacks?.onEntryStart?.(entryPointId(api), idx, apis.length, api);
            const prompt = buildPromptContext(api, args.store);
            const gateEnabled = args.evidenceGate !== false;

            // First pass.
            const first = await args.llmCall(
                { system: prompt.system, user: prompt.user },
                { signal: args.signal },
            );
            const firstRaw = first.findings ?? [];
            const firstPass = processFindings({
                raw: firstRaw, api, prompt, gateEnabled,
                model: args.model, store: args.store,
                guidelinesHash, baselineRef: args.baselineRef, tolerance,
            });

            let newFindings = firstPass.kept;
            let dropCounts = firstPass.drops;
            let rawCount = firstRaw.length;
            let retried = false;

            // #527 — Re-quote retry. When the first pass kept nothing AND we
            // rejected at least one finding for evidence-miss, the model
            // probably paraphrased. Ask it to re-quote, verbatim this time.
            // Bounded to one extra call per entry to keep latency + cost in
            // check on slow local models like deepseek-coder.
            if (
                gateEnabled
                && newFindings.length === 0
                && firstPass.evidenceRejected.length > 0
                && !args.signal?.aborted
            ) {
                retried = true;
                const retryHint = buildRequoteHint(firstPass.evidenceRejected);
                const second = await args.llmCall(
                    { system: prompt.system, user: `${prompt.user}\n\n${retryHint}` },
                    { signal: args.signal },
                );
                const secondRaw = second.findings ?? [];
                const secondPass = processFindings({
                    raw: secondRaw, api, prompt, gateEnabled,
                    model: args.model, store: args.store,
                    guidelinesHash, baselineRef: args.baselineRef, tolerance,
                });
                newFindings = secondPass.kept;
                dropCounts = mergeDrops(dropCounts, secondPass.drops);
                rawCount += secondRaw.length;
            }

            // #605 — small-model fallback. If the small-coder model still
            // produced 0 kept findings after the re-quote retry, escalate
            // this single entry-point to the configured stronger model.
            // Capable models keep their `strict` tolerance for the fallback;
            // the assumption is they don't paraphrase.
            if (
                fallbackEnabled
                && gateEnabled
                && newFindings.length === 0
                && !args.signal?.aborted
            ) {
                const fbResp = await args.fallbackLlmCall!(
                    { system: prompt.system, user: prompt.user },
                    { signal: args.signal },
                );
                const fbRaw = fbResp.findings ?? [];
                const fbPass = processFindings({
                    raw: fbRaw, api, prompt, gateEnabled,
                    model: args.fallbackModel!, store: args.store,
                    guidelinesHash, baselineRef: args.baselineRef, tolerance: 'strict',
                });
                newFindings = fbPass.kept;
                dropCounts = mergeDrops(dropCounts, fbPass.drops);
                rawCount += fbRaw.length;
            }

            reviewed += 1;
            findingsCount += newFindings.length;
            const droppedReport: EntryDropCounts = {
                raw: rawCount,
                kept: newFindings.length,
                noEvidence: dropCounts.noEvidence,
                evidenceMiss: dropCounts.evidenceMiss,
                noBindings: dropCounts.noBindings,
                gated: dropCounts.gated,
                retried,
            };
            if (process.env.CODEATLAS_DEBUG_REVIEW === '1') {
                process.stderr.write(`[per-entry] ${entryPointId(api)}: ${JSON.stringify(droppedReport)}\n`);
            }
            args.callbacks?.onEntryDone?.(entryPointId(api), newFindings, droppedReport, api);
        } catch (err: any) {
            failed += 1;
            args.callbacks?.onEntryError?.(entryPointId(api), err, api);
        } finally {
            sem.release();
        }
    });

    await Promise.all(tasks);

    return {
        totalEntryPoints: apis.length,
        reviewed,
        failed,
        findingsCount,
        durationMs: Date.now() - started,
    };
}

/**
 * #856 — CONDENSED single-call review (benchmark mode). Reviews ALL changed
 * entry points in ONE LLM call instead of one call per entry. The graph
 * context (every entry's pack + source corpus) is concatenated into a single
 * prompt, so this isolates "does CodeAtlas's context help at the SAME call
 * budget as a raw diff review?" from "context costs N× more calls".
 *
 * Findings are gated against the combined corpus (same #855 tiers) and bound
 * by `anchor.filePath` → `file:` graph + `microservice:workspace` (like the
 * project-level reviewer), since one call spans multiple entry points.
 *
 * NOT the default path — `runFullReview` opts in via `codeatlas.reviewSingleCall`.
 */
export async function runSingleCallReview(args: RunPerEntryReviewArgs): Promise<ReviewRunResult> {
    const started = Date.now();
    const apis = selectEntryPoints(args.store, args.scope, args.restrictToEntryPoints);
    if (apis.length === 0) {
        return { totalEntryPoints: 0, reviewed: 0, failed: 0, findingsCount: 0, durationMs: 0 };
    }
    const gateEnabled = args.evidenceGate !== false;
    const tolerance: EvidenceGateTolerance = args.tolerance
        ?? (isSmallCoderModel(args.model) ? 'relaxed' : 'strict');
    const guidelinesHash = args.store.getReviewGuidelines().hash || undefined;

    // Build per-entry contexts, then condense into one prompt. Cap the
    // combined user payload so a wide PR doesn't blow the context window;
    // entries beyond the budget are dropped with a recorded note.
    const CORPUS_CHAR_BUDGET = Number(process.env.CODEATLAS_REVIEW_CORPUS_BUDGET) || 120_000; // ~30k tokens of context; #897 env-tunable
    const contexts = apis.map((api) => ({ api, ctx: buildPromptContext(api, args.store) }));
    const system = contexts[0].ctx.system; // depends only on guidelines (store-level)
    const entryPayloads: any[] = [];
    const corpora: string[] = [];
    let used = 0;
    let dropped = 0;
    for (const { api, ctx } of contexts) {
        const add = ctx.sourceCorpus.length + ctx.user.length;
        if (used + add > CORPUS_CHAR_BUDGET && entryPayloads.length > 0) { dropped += 1; continue; }
        used += add;
        corpora.push(ctx.sourceCorpus);
        // ctx.user is a JSON string {entryPoint, pack}; re-parse so the
        // combined user is one well-formed JSON array.
        try { entryPayloads.push(JSON.parse(ctx.user)); } catch { entryPayloads.push({ raw: ctx.user }); }
    }
    const combinedCorpus = corpora.join('\n\n');
    const user = JSON.stringify({
        instruction: `Review ALL ${entryPayloads.length} changed entry points below in a single pass. Emit findings across every entry point — set each finding's anchor.filePath to the file it belongs to.`,
        entryPoints: entryPayloads,
    }, null, 2);

    let raw: RawLlmFinding[];
    try {
        const resp = await args.llmCall({ system, user }, { signal: args.signal });
        raw = resp.findings ?? [];
    } catch (err: any) {
        args.callbacks?.onEntryError?.('single-call', err instanceof Error ? err : new Error(String(err)));
        return { totalEntryPoints: apis.length, reviewed: 0, failed: apis.length, findingsCount: 0, durationMs: Date.now() - started };
    }

    // Gate + bind each finding against the combined corpus. Binding is by
    // anchor.filePath (one call spans many entries), mirroring the project
    // reviewer's microservice+file binding.
    const kept: AiReviewFinding[] = [];
    for (const rf of raw) {
        const snippet = rf.evidence?.snippet ?? '';
        let confidence: EvidenceConfidence = 'exact';
        if (gateEnabled) {
            if (!snippet) continue;
            const tier = resolveEvidence(snippet, combinedCorpus, {
                tolerance,
                symbol: rf.anchor?.symbol,
                allowAnchorTier: true,
            });
            if (tier === null) continue;
            confidence = tier;
        }
        const filePath = rf.anchor?.filePath ?? '';
        const bindings: AiReviewBinding[] = [
            { graphId: 'microservice:workspace', targetId: `single::${filePath}`, targetType: 'node', layer: 'microservice' },
            ...(filePath ? [{ graphId: `file:${filePath}`, targetId: rf.anchor?.symbol ?? filePath, targetType: 'node' as const, layer: 'file' as DiagramType }] : []),
        ];
        const f = args.store.upsertAiReviewFinding({
            entryPointId: `single::${filePath || 'workspace'}`,
            bindings,
            severity: rf.severity,
            category: rf.category,
            title: rf.title,
            body: rf.body,
            anchor: {
                filePath,
                symbol: rf.anchor?.symbol,
                ...(snippet ? { snippet, lineStart: rf.evidence?.lineStart, lineEnd: rf.evidence?.lineEnd } : {}),
                evidenceConfidence: confidence,
            } as any,
            status: 'open',
            model: args.model,
            guidelinesHash,
            ...(args.baselineRef ? { baselineRef: args.baselineRef } : {}),
        } as any);
        kept.push(f);
    }
    args.callbacks?.onEntryDone?.('single-call', kept);
    if (dropped > 0) args.callbacks?.onEntryError?.('single-call', new Error(`${dropped} entry packs dropped (corpus budget)`));

    return {
        totalEntryPoints: apis.length,
        reviewed: entryPayloads.length,   // #897 — exactly the entries that made it into the prompt
        failed: 0,
        findingsCount: kept.length,
        durationMs: Date.now() - started,
        skipped: dropped,                 // #897 — budget-dropped entries, surfaced not vanished
    };
}
