/**
 * AI Review Engine — generates LLM-powered code review items for diff diagram nodes.
 *
 * Groups changed nodes by diagram layer, sends layer-specific prompts to the LLM,
 * parses structured JSON responses, and returns review items keyed by graphId.
 *
 * Error handling:
 * - Retries transient failures (429, 500, 502, 503, timeout) up to 2 times with backoff
 * - Tracks failed batches in result.failures so callers can notify users
 * - Classifies timeout vs auth vs other errors for targeted notifications
 * - Partial results: successful batches return items even if others fail
 */

import type { OpenRouterConfig, OpenRouterResponse } from './openRouterClient';
import { sendOpenRouterRequest } from './openRouterClient';
import { redactSecrets } from './llmNamingService';
import { parseLlmJson } from './safeJson';
import type { DiagramGraph } from '../graph/graphTypes';
import { parseGraphId } from '../graph/graphIdBuilder';
import type { AiReviewItem, AiReviewResult, AiReviewCacheEntry, BatchFailure, ReviewSeverity } from './aiReviewTypes';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_NODES_PER_BATCH = 15;
const MAX_BODY_CHARS = 200;
const MAX_DIFF_DETAIL_CHARS = 150;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_SIZE = 5;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
/** Estimated input tokens per node (label + body + metadata) */
const EST_TOKENS_PER_NODE = 100;
/** Estimated fixed tokens per batch (system prompt + layer prefix) */
const EST_FIXED_TOKENS_PER_BATCH = 250;

// ── Layer classification ──────────────────────────────────────────────────────

type LayerKey = 'L1' | 'L2a' | 'L2b' | 'L3' | 'L4' | 'L5';

function graphIdToLayer(graphId: string): LayerKey | null {
    // Issue #362 Phase B (2026-06-07) — structured type guard.
    const parsed = parseGraphId(graphId);
    if (!parsed) return null;
    switch (parsed.type) {
        case 'microservice': return 'L1';
        case 'feature':      return 'L2a';
        case 'api-list':     return 'L2b';
        case 'sequence':     return 'L3';
        case 'file':         return 'L4';
        case 'flow':         return 'L5';
        default:             return null;
    }
}

// ── Error classification ──────────────────────────────────────────────────────

/** HTTP status codes that indicate transient failures worth retrying */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

function isRetryableError(err: any): boolean {
    if (!err) return false;
    const msg = String(err.message ?? '').toLowerCase();
    // Timeout (AbortController or explicit timeout error)
    if (msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out')) return true;
    // HTTP status codes in error message (e.g. "HTTP 429" or "status 503")
    for (const code of RETRYABLE_STATUS_CODES) {
        if (msg.includes(String(code))) return true;
    }
    // Network errors
    if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('fetch failed')) return true;
    return false;
}

function isTimeoutError(err: any): boolean {
    const msg = String(err?.message ?? '').toLowerCase();
    return msg.includes('abort') || msg.includes('timeout') || msg.includes('timed out');
}

function isAuthError(err: any): boolean {
    const msg = String(err?.message ?? '').toLowerCase();
    return msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('forbidden');
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior code reviewer analyzing a software diff visualization.
Each element has a label, optional code body, and diff status (added/modified/deleted).
Identify real, actionable issues — not style nitpicks.

Return ONLY a JSON array (no markdown, no explanation outside the JSON):
[{"nodeId":"the-node-id","severity":"info|warning|error","title":"Short one-line summary","body":"Detailed explanation with suggestion","category":"architecture|api-design|code-quality|logic-bug|security|performance"}]

Rules:
- Only include nodeIds from the provided list
- error: likely bugs, security vulnerabilities, data loss risks
- warning: potential issues, missing error handling, breaking changes
- info: suggestions, improvements, minor observations
- Maximum 3 review items per node
- Keep body under 100 words
- Return [] if no issues found`;

const LAYER_PREFIXES: Record<LayerKey, string> = {
    L1: `You are reviewing the SYSTEM ARCHITECTURE layer. Focus on:
- Service boundaries and coupling
- New infrastructure dependencies (databases, queues, caches)
- Breaking inter-service contracts
- Deployment and scaling implications`,

    L2a: `You are reviewing the FEATURE/DOMAIN layer. Focus on:
- Bounded context violations (features touching wrong domains)
- Cohesion changes (cluster modularity)
- Cross-cutting concerns leaking between domains`,

    L2b: `You are reviewing the API SURFACE layer. Focus on:
- Breaking API changes (removed routes, changed methods)
- RESTful design issues (wrong HTTP method, inconsistent naming)
- Missing versioning for breaking changes
- Authentication/authorization gaps`,

    L3: `You are reviewing the INTERACTION/SEQUENCE layer. Focus on:
- N+1 query patterns (repeated calls in loops)
- Missing error handling in call chains
- Circular dependency chains
- Race conditions in async flows`,

    L4: `You are reviewing the FILE DEPENDENCY layer. Focus on:
- God files (too many symbols, excessive responsibility)
- Circular imports between modules
- High coupling (file depends on too many others)
- Dead code (added but never imported)`,

    L5: `You are reviewing the FUNCTION FLOW layer. Focus on:
- Logic bugs in control flow (wrong conditions, missing branches)
- Missing edge cases in conditionals
- Unreachable code paths
- Resource leaks (unclosed handles, missing cleanup)
- Error swallowing (empty catch blocks)`,
};

// ── Cache ─────────────────────────────────────────────────────────────────────

const reviewCache = new Map<string, AiReviewCacheEntry>();

function getCachedResult(key: string): AiReviewResult | null {
    const entry = reviewCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        reviewCache.delete(key);
        return null;
    }
    return entry.result;
}

function setCachedResult(key: string, result: AiReviewResult): void {
    if (reviewCache.size >= CACHE_MAX_SIZE) {
        let oldestKey: string | null = null;
        let oldestTime = Infinity;
        for (const [k, v] of reviewCache) {
            if (v.timestamp < oldestTime) { oldestTime = v.timestamp; oldestKey = k; }
        }
        if (oldestKey) reviewCache.delete(oldestKey);
    }
    reviewCache.set(key, { key, result, timestamp: Date.now() });
}

export function clearReviewCache(): void {
    reviewCache.clear();
}

// ── Node extraction ───────────────────────────────────────────────────────────

function truncate(text: string | undefined, max: number): string {
    if (!text) return '';
    return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

interface ChangedNodeContext {
    nodeId: string;
    label: string;
    type: string;
    diff: string;
    body?: string;
    diffDetailDeleted?: string;
    diffDetailAdded?: string;
    filePath?: string;
    symbol?: string;
}

function extractChangedNodes(graph: DiagramGraph): ChangedNodeContext[] {
    const results: ChangedNodeContext[] = [];
    for (const node of graph.nodes) {
        if (!node.diff || node.diff === 'unchanged') continue;
        results.push({
            nodeId: node.id,
            label: node.label,
            type: node.type,
            diff: node.diff,
            body: truncate(redactSecrets(node.body ?? ''), MAX_BODY_CHARS) || undefined,
            diffDetailDeleted: truncate(redactSecrets((node as any).diffDetail?.deleted ?? ''), MAX_DIFF_DETAIL_CHARS) || undefined,
            diffDetailAdded: truncate(redactSecrets((node as any).diffDetail?.added ?? ''), MAX_DIFF_DETAIL_CHARS) || undefined,
            filePath: node.anchor?.filePath ?? graph.anchors[node.id]?.filePath,
            symbol: node.anchor?.symbol ?? graph.anchors[node.id]?.symbol,
        });
    }
    return results;
}

function buildUserPrompt(layerPrefix: string, nodes: ChangedNodeContext[]): string {
    const nodeDescriptions = nodes.map(n => {
        const parts = [`### Node: ${n.nodeId}`, `- Label: ${n.label}`, `- Type: ${n.type}`, `- Diff: ${n.diff}`];
        if (n.body) parts.push(`- Body: ${n.body}`);
        if (n.diffDetailDeleted) parts.push(`- Removed: ${n.diffDetailDeleted}`);
        if (n.diffDetailAdded) parts.push(`- Added: ${n.diffDetailAdded}`);
        if (n.filePath) parts.push(`- File: ${n.filePath}`);
        return parts.join('\n');
    }).join('\n\n');

    return `${layerPrefix}\n\n## Changed Elements\n\n${nodeDescriptions}`;
}

// ── Response parsing ──────────────────────────────────────────────────────────

const VALID_SEVERITIES = new Set<string>(['info', 'warning', 'error']);

function parseReviewResponse(
    text: string,
    graphId: string,
    layer: LayerKey,
    nodeContexts: ChangedNodeContext[],
    startIndex: number,
): AiReviewItem[] {
    const validNodeIds = new Set(nodeContexts.map(n => n.nodeId));
    let parsed: unknown[];

    try {
        parsed = parseLlmJson(text); // #891 — proto-pollution-safe
    } catch {
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            try { parsed = parseLlmJson(fenceMatch[1]); } catch { return []; }
        } else {
            const bracketMatch = text.match(/\[[\s\S]*\]/);
            if (bracketMatch) {
                try { parsed = parseLlmJson(bracketMatch[0]); } catch { return []; }
            } else {
                return [];
            }
        }
    }

    if (!Array.isArray(parsed)) return [];

    const items: AiReviewItem[] = [];
    let idx = startIndex;

    for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;

        const nodeId = String(r.nodeId ?? '');
        if (!validNodeIds.has(nodeId)) continue;

        const severity = VALID_SEVERITIES.has(String(r.severity ?? ''))
            ? String(r.severity) as ReviewSeverity
            : 'info';

        const title = String(r.title ?? '').slice(0, 120);
        const body = String(r.body ?? '').slice(0, 500);
        const category = String(r.category ?? 'code-quality').slice(0, 30);

        if (!title) continue;

        const nodeCtx = nodeContexts.find(n => n.nodeId === nodeId);

        items.push({
            id: `review_${idx++}_${graphId}_${nodeId}`,
            graphId,
            targetId: nodeId,
            targetType: 'node',
            severity,
            title,
            body,
            category,
            anchor: nodeCtx?.filePath
                ? { filePath: nodeCtx.filePath, symbol: nodeCtx.symbol }
                : undefined,
            status: 'open',
        });
    }

    return items;
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWithRetry(
    config: OpenRouterConfig,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
): Promise<OpenRouterResponse> {
    let lastError: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await sendOpenRouterRequest(config, messages);
        } catch (err: any) {
            lastError = err;
            // Don't retry auth errors or non-retryable errors
            if (isAuthError(err) || !isRetryableError(err)) throw err;
            if (attempt < MAX_RETRIES) {
                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s
                await sleep(delay);
            }
        }
    }
    throw lastError;
}

// ── Token estimation ──────────────────────────────────────────────────────────

/**
 * Estimate total input tokens for a set of batches.
 * Returns { inputTokens, outputTokens, totalTokens }.
 */
export function estimateTokenUsage(changedNodeCount: number, batchCount: number): { inputTokens: number; outputTokens: number; totalTokens: number } {
    const inputTokens = (batchCount * EST_FIXED_TOKENS_PER_BATCH) + (changedNodeCount * EST_TOKENS_PER_NODE);
    const outputTokens = batchCount * 500; // ~500 output tokens per batch
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface AiReviewOptions {
    /** Maximum total nodes to review (default: 100) */
    maxNodes?: number;
    /** Filter to specific layers */
    layerFilter?: LayerKey[];
    /** Progress callback: called after each batch with (completedBatches, totalBatches, message) */
    onProgress?: (message: string, completed: number, total: number) => void;
}

export async function executeAiReview(
    config: OpenRouterConfig,
    diffedGraphs: Record<string, DiagramGraph>,
    cacheKey?: string,
    options?: AiReviewOptions,
): Promise<AiReviewResult> {
    // Check cache
    if (cacheKey) {
        const cached = getCachedResult(cacheKey);
        if (cached) return cached;
    }

    const startTime = Date.now();
    const maxNodes = options?.maxNodes ?? 100;
    const layerFilter = options?.layerFilter ? new Set(options.layerFilter) : null;

    // Group changed nodes by layer
    const layerBatches = new Map<LayerKey, Array<{ graphId: string; nodes: ChangedNodeContext[] }>>();

    for (const [graphId, graph] of Object.entries(diffedGraphs)) {
        const layer = graphIdToLayer(graphId);
        if (!layer) continue;
        if (layerFilter && !layerFilter.has(layer)) continue;

        const changedNodes = extractChangedNodes(graph);
        if (changedNodes.length === 0) continue;

        if (!layerBatches.has(layer)) layerBatches.set(layer, []);
        layerBatches.get(layer)!.push({ graphId, nodes: changedNodes });
    }

    // Flatten and limit total nodes
    const allBatches: Array<{ graphId: string; layer: LayerKey; nodes: ChangedNodeContext[] }> = [];
    let totalNodeCount = 0;

    for (const [layer, graphs] of layerBatches) {
        for (const { graphId, nodes } of graphs) {
            for (let i = 0; i < nodes.length; i += MAX_NODES_PER_BATCH) {
                const batch = nodes.slice(i, i + MAX_NODES_PER_BATCH);
                if (totalNodeCount + batch.length > maxNodes) {
                    const remaining = maxNodes - totalNodeCount;
                    if (remaining > 0) {
                        allBatches.push({ graphId, layer, nodes: batch.slice(0, remaining) });
                        totalNodeCount += remaining;
                    }
                    break;
                }
                allBatches.push({ graphId, layer, nodes: batch });
                totalNodeCount += batch.length;
            }
            if (totalNodeCount >= maxNodes) break;
        }
        if (totalNodeCount >= maxNodes) break;
    }

    if (allBatches.length === 0) {
        const emptyResult: AiReviewResult = {
            items: [],
            byGraph: {},
            summary: { info: 0, warning: 0, error: 0, total: 0 },
            failures: [],
            meta: { model: config.model, totalTokens: 0, durationMs: 0 },
        };
        if (cacheKey) setCachedResult(cacheKey, emptyResult);
        return emptyResult;
    }

    // Execute batches concurrently with retry
    let globalIndex = 0;
    let totalTokens = 0;
    let completedBatches = 0;
    const totalBatchCount = allBatches.length;
    const allItems: AiReviewItem[] = [];
    const failures: BatchFailure[] = [];

    options?.onProgress?.(`Reviewing ${totalNodeCount} changed nodes across ${totalBatchCount} batches...`, 0, totalBatchCount);

    const batchPromises = allBatches.map(async (batch, batchIdx) => {
        const batchStartIndex = globalIndex;
        globalIndex += batch.nodes.length * 3;

        const layerPrefix = LAYER_PREFIXES[batch.layer];
        const userPrompt = buildUserPrompt(layerPrefix, batch.nodes);

        try {
            const response: OpenRouterResponse = await sendWithRetry(
                { ...config, maxTokens: config.maxTokens ?? 2048 },
                [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
            );

            if (response.usage) {
                totalTokens += (response.usage.prompt_tokens + response.usage.completion_tokens);
            }

            const items = parseReviewResponse(
                response.text,
                batch.graphId,
                batch.layer,
                batch.nodes,
                batchStartIndex,
            );

            completedBatches++;
            options?.onProgress?.(
                `Batch ${completedBatches}/${totalBatchCount}: ${batch.layer} — ${items.length} findings`,
                completedBatches,
                totalBatchCount,
            );

            return { items, failure: null };
        } catch (err: any) {
            completedBatches++;
            const timeout = isTimeoutError(err);
            const errorMsg = err?.message?.slice(0, 100) ?? 'unknown error';
            const failure: BatchFailure = {
                layer: batch.layer,
                error: timeout ? `Timed out reviewing ${batch.layer}` : errorMsg,
                isTimeout: timeout,
            };

            options?.onProgress?.(
                `Batch ${completedBatches}/${totalBatchCount}: ${batch.layer} failed${timeout ? ' (timeout)' : ''} — ${errorMsg}`,
                completedBatches,
                totalBatchCount,
            );

            return { items: [], failure };
        }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const result of batchResults) {
        if (result.status === 'fulfilled') {
            allItems.push(...result.value.items);
            if (result.value.failure) failures.push(result.value.failure);
        }
    }

    // Build result
    const byGraph: Record<string, AiReviewItem[]> = {};
    let infoCount = 0, warningCount = 0, errorCount = 0;

    for (const item of allItems) {
        if (!byGraph[item.graphId]) byGraph[item.graphId] = [];
        byGraph[item.graphId].push(item);

        if (item.severity === 'info') infoCount++;
        else if (item.severity === 'warning') warningCount++;
        else if (item.severity === 'error') errorCount++;
    }

    const reviewResult: AiReviewResult = {
        items: allItems,
        byGraph,
        summary: { info: infoCount, warning: warningCount, error: errorCount, total: allItems.length },
        failures,
        meta: { model: config.model, totalTokens, durationMs: Date.now() - startTime },
    };

    if (cacheKey) setCachedResult(cacheKey, reviewResult);
    return reviewResult;
}

// Re-export for use in extension.ts pre-flight check
export { isAuthError, isTimeoutError };
