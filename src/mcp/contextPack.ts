/**
 * contextPack.ts — pure functions that assemble LLM-ready context packs from
 * a CodeAtlas Snapshot.
 *
 * Purpose: an LLM asking "what handles GET /articles/:slug?" needs ALL the
 * facts to reason about it — the route, its middleware chain, the handler
 * body, the downstream calls (sequence edges), the feature cluster it lives
 * in, and any pending diff. Reading every file in the repo to assemble this
 * costs O(repo) tokens. CodeAtlas already produced this view at index time;
 * the pack just selects + serialises it.
 *
 * These functions are pure (no I/O) so they're trivial to test and can be
 * called from both the MCP server and the in-process extension.
 */
import type { Snapshot, ApiRecord, FeatureCluster, DiagramGraph, GraphNode, HealthReport } from '../core/graph/graphTypes';
import { unifiedDiffWindow } from '../core/diff/lineDiff';

// ─── Entry-point catalogue ──────────────────────────────────────────────────

/**
 * Every architectural entry point the workspace exposes. Not just HTTP — also
 * JOB, MQ_CONSUMER, CLI_COMMAND, SCREEN, NAV_ROUTE, DB_MIGRATION, DB_SEED,
 * SOCKET_EVENT, SUBSCRIPTION, HEALTH, FILTER, MODEL_HOOK, etc. The `method`
 * field is the entry-point's category (HTTP method like 'GET' or synthetic
 * like 'JOB' / 'CLI_COMMAND' — see CLAUDE.md Tier 1-3).
 */
export interface EntryPointSummary {
    /**
     * #MCP-AUDIT-2 (2026-06-07): the backing key in `snap.apiIndex`.
     * Tools downstream (`generate_request_body`, `generate_test_cases`,
     * `get_function_source`, …) look up the API by this key. Exposing it
     * here lets callers chain a row from `list_entrypoints` straight
     * into those tools without having to reconstruct an apiId by hand —
     * which broke for CDK / serverless routes whose apiId format
     * differs from the `<method>:<route>::<file>::<handler>` shape that
     * the JS/TS route extractor uses.
     */
    apiId: string;
    method: string;
    route: string;
    handlerName: string;
    filePath: string;
    /** The cluster this entry point belongs to (feature area). */
    clusterId?: string;
    clusterLabel?: string;
    /** The service this entry point belongs to (microservice / app). */
    serviceId?: string;
    /** Auth status derived during detection. */
    auth?: 'required' | 'optional';
    /** Middleware chain captured during detection. */
    middlewares?: string[];
    /** Error-handler flag. */
    error?: boolean;
    /** Webhook intent flag + provider, if any. */
    webhook?: boolean;
    webhookProvider?: string;
    /** Loop-registered route cardinality (e.g. /random/:i with ×25). */
    dynamicRangeCount?: number;
    /** Current diff status vs baseline. */
    diff?: string;
}

export interface EntryPointFilter {
    /** Match by method category — 'GET', 'POST', 'JOB', 'CLI_COMMAND', etc. */
    method?: string;
    /** Match by feature cluster id. */
    clusterId?: string;
    /** Match by service id. */
    serviceId?: string;
    /** Only entry points with auth.required. */
    authRequired?: boolean;
    /** Only entry points marked as changed in the current diff. */
    onlyChanged?: boolean;
    /** Substring match on route. */
    routeContains?: string;
}

export function listEntryPoints(snapshot: Snapshot, filter: EntryPointFilter = {}): EntryPointSummary[] {
    const apis = Object.values(snapshot.apiIndex ?? {});
    const fileToCluster = new Map<string, { id: string; label: string }>();
    const fileToService = new Map<string, string>();
    for (const c of Object.values(snapshot.clusters ?? {})) {
        for (const f of c.files) fileToCluster.set(f, { id: c.id, label: c.label });
    }
    for (const s of Object.values(snapshot.services ?? {})) {
        // ServiceRecord doesn't carry the file list explicitly — we use rootPath
        // as a prefix gate when serviceId is queried later. Skip for now;
        // clusters carry serviceId on themselves.
        void fileToService.set(s.id, s.id);
    }
    return apis
        .map((a): EntryPointSummary => {
            const c = fileToCluster.get(a.filePath);
            // Find the cluster's parent service (FeatureCluster.serviceId).
            let serviceId: string | undefined;
            if (c) {
                const cluster = snapshot.clusters?.[c.id];
                serviceId = cluster?.serviceId;
            }
            return {
                apiId: a.apiId,
                method: a.method,
                route: a.route,
                handlerName: a.handlerName,
                filePath: a.filePath,
                clusterId: c?.id,
                clusterLabel: c?.label,
                serviceId,
                auth: a.meta?.auth,
                middlewares: a.meta?.middlewares,
                error: a.meta?.error,
                webhook: a.meta?.webhook,
                webhookProvider: a.meta?.webhookProvider,
                dynamicRangeCount: a.meta?.dynamicRange?.count,
                diff: a.diff,
            };
        })
        .filter((ep) => {
            if (filter.method && ep.method !== filter.method) return false;
            if (filter.clusterId && ep.clusterId !== filter.clusterId) return false;
            if (filter.serviceId && ep.serviceId !== filter.serviceId) return false;
            if (filter.authRequired && ep.auth !== 'required') return false;
            if (filter.onlyChanged && (!ep.diff || ep.diff === 'unchanged')) return false;
            if (filter.routeContains && !ep.route.includes(filter.routeContains)) return false;
            return true;
        });
}

// ─── Single-entry context pack ──────────────────────────────────────────────

/**
 * Everything an LLM needs to answer "what does this entry point do?":
 *   - route + method + handler metadata
 *   - middleware chain (auth, validation, rate-limit, etc.)
 *   - feature cluster + service membership
 *   - sequence-graph edges (downstream calls) and participants (modules
 *     visited by the call chain)
 *   - flow-graph node summaries (control flow inside the handler)
 *   - the handler source slice (so the LLM can quote / suggest edits)
 *   - the entry point's diff status if non-unchanged
 *
 * Designed to fit in a single 2-5KB JSON blob — orders of magnitude smaller
 * than the equivalent file-by-file read of the workspace.
 */
export interface EntryPointPack {
    entryPoint: EntryPointSummary;
    /** Inline handler source slice (when an `anchor.span` is available). */
    handlerSource?: string;
    /** Downstream participants reached via sequence-graph BFS. */
    callsInto: Array<{
        participant: string;
        kind: string;
        filePath?: string;
        /** Diff status if this participant was added/modified/deleted in the current snapshot. */
        diff?: string;
    }>;
    /** Sequence messages from API Client → handler → downstream. */
    messages: Array<{
        from: string;
        to: string;
        label: string;
        diff?: string;
    }>;
    /** Flow-graph node labels — terse control-flow summary. */
    flowNodes: Array<{ kind: string; label: string; diff?: string }>;
    /** Sibling routes in the same cluster (helps the LLM judge scope). */
    siblings: Array<{ method: string; route: string }>;
    /** If the snapshot has unmerged diff, what changed inside this pack. */
    diff?: {
        modifiedFunctions: string[];
        modifiedMessages: string[];
        modifiedFlowNodes: number;
    };
    /**
     * #865 — source of the SPECIFIC downstream functions reached in the resolved
     * interactions (NOT whole participant files): for each cross-file message the
     * handler makes, the called method's body from the participant's file, so the
     * model can quote a callee line (validate-here-use-there, unawaited downstream,
     * contract mismatch) and the finding survives the evidence gate. Modified
     * interactions first; capped by count + lines so deep chains stay lean.
     */
    participantSources?: Array<{
        participant: string;
        filePath: string;
        functionName: string;
        source: string;
        diff?: string;
    }>;
}

/**
 * #866 — lean-pack defaults. When `getEntryPointPack` is asked for a lean pack
 * (the per-entry AI-review path), the handler source is windowed to the changed
 * lines and the graph metadata is trimmed to diff-relevant + top-K, so the
 * model sees the changed code + the impact chain without a full-handler / full-
 * graph dump that a slow local model can't process.
 */
export interface LeanPackOptions {
    /** Lines of context kept on each side of a changed line. */
    contextLines: number;
    /** Hard cap on windowed handler-source lines. */
    maxSourceLines: number;
    maxMessages: number;
    maxFlowNodes: number;
    maxCallsInto: number;
    maxSiblings: number;
    /** #865 — max distinct downstream callee functions whose source is included. */
    maxParticipantSources: number;
    /** #865 — per-callee source line cap. */
    maxParticipantSourceLines: number;
}

const LEAN_DEFAULTS: LeanPackOptions = {
    contextLines: 6,
    maxSourceLines: 80,
    maxMessages: 40,
    maxFlowNodes: 40,
    maxCallsInto: 24,
    maxSiblings: 8,
    maxParticipantSources: 6,
    maxParticipantSourceLines: 40,
};

/** 1-based line number containing the char at `offset` in `content`. */
function lineOfOffset(content: string, offset: number): number {
    let n = 1;
    const end = Math.min(offset, content.length);
    for (let i = 0; i < end; i++) if (content.charCodeAt(i) === 10) n++;
    return n;
}

/**
 * Working line numbers (1-based) that have no matching baseline line — i.e.
 * added or modified by the diff. Order-insensitive multiset match: cheap (O(n))
 * and good enough to *window* changed regions (the ± context margin absorbs
 * the imprecision from identical lines appearing elsewhere).
 */
export function changedLineNumbers(baseline: string, working: string): Set<number> {
    const remaining = new Map<string, number>();
    for (const l of baseline.split('\n')) remaining.set(l, (remaining.get(l) ?? 0) + 1);
    const w = working.split('\n');
    const changed = new Set<number>();
    for (let i = 0; i < w.length; i++) {
        const c = remaining.get(w[i]) ?? 0;
        if (c > 0) remaining.set(w[i], c - 1);
        else changed.add(i + 1);
    }
    return changed;
}

/**
 * Diff-windowed handler source: the handler's lines that are changed (or within
 * `contextLines` of a change), line-numbered, with `… N unchanged …` gap
 * markers, capped at `maxSourceLines`. Falls back to the (capped) whole handler
 * when the handler is small or no baseline is available.
 */
export function windowChangedSource(
    working: string,
    baseline: string | undefined,
    span: { start: number; end: number },
    opts: LeanPackOptions = LEAN_DEFAULTS,
): string | undefined {
    // #925 — with a baseline, show the actual UNIFIED DIFF of the file (`+`/`-`
    // hunks, affected areas only) so the reviewer sees what the PR CHANGED, not
    // the head code with no change markers. Falls through to the handler head only
    // when there's no baseline or the content is identical (diff = '').
    if (baseline !== undefined) {
        const diff = unifiedDiffWindow(working, baseline, { contextLines: opts.contextLines, maxLines: opts.maxSourceLines });
        if (diff) return diff;
    }
    const lines = working.split('\n');
    const startLine = lineOfOffset(working, span.start);
    const endLine = lineOfOffset(working, span.end);
    if (endLine < startLine) return undefined;
    // #930 — no baseline means this handler's file is NEW in the PR: mark every
    // line `+` (it's all added) under a banner, instead of a markerless `N: `
    // dump the model reads as pre-existing code.
    const newFile = baseline === undefined;
    const out: string[] = newFile ? ['        … NEW FILE — handler is newly added …'] : [];
    const prefix = newFile ? '+' : ' ';
    for (let ln = startLine; ln <= endLine && out.length < opts.maxSourceLines; ln++) out.push(`${prefix}${ln}: ${lines[ln - 1] ?? ''}`);
    return out.join('\n');
}

/** Keep all diff-relevant items, then fill up to `cap` with the rest (order-preserving). */
function trimToRelevant<T>(arr: T[], isRelevant: (t: T) => boolean, cap: number): T[] {
    if (arr.length <= cap) return arr;
    const relevant = arr.filter(isRelevant);
    if (relevant.length >= cap) return relevant.slice(0, cap);
    const rest = arr.filter((t) => !isRelevant(t)).slice(0, cap - relevant.length);
    return [...relevant, ...rest];
}

const isModified = (x: { diff?: string }): boolean => !!x.diff && x.diff !== 'unchanged';

/**
 * #865 — char-offset span of a named function in a file's symbol table. Tries an
 * exact name match, then a receiver-stripped match (`obj.method` → `method`).
 */
function findFunctionSpan(snapshot: Snapshot, filePath: string, fnName: string): { start: number; end: number } | null {
    const fns = snapshot.files?.[filePath]?.symbols?.functions ?? [];
    const bare = fnName.replace(/^.*\./, '');
    const hit = fns.find((f) => f.name === fnName) ?? fns.find((f) => f.name === bare);
    return hit?.span ?? null;
}

/** #865 — cap a source slice to `maxLines`, appending a truncation marker. */
function capLines(s: string, maxLines: number): string {
    const lines = s.split('\n');
    if (lines.length <= maxLines) return s;
    return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines)`;
}

export function getEntryPointPack(
    snapshot: Snapshot,
    method: string,
    route: string,
    options: {
        workspaceFileContent?: (filePath: string) => string | undefined;
        /** #866 — baseline content resolver; enables diff-windowing of the handler source. */
        baselineFileContent?: (filePath: string) => string | undefined;
        /** #866 — produce a lean pack (windowed source + diff-relevant/top-K graph). */
        lean?: boolean | Partial<LeanPackOptions>;
    } = {},
): EntryPointPack | null {
    const apis = Object.values(snapshot.apiIndex ?? {});
    const target = apis.find((a) => a.method === method && a.route === route);
    if (!target) return null;

    const summary = listEntryPoints(snapshot, { method, routeContains: route }).find((ep) => ep.method === method && ep.route === route);
    const fallback: EntryPointSummary = summary ?? {
        apiId: target.apiId,
        method: target.method,
        route: target.route,
        handlerName: target.handlerName,
        filePath: target.filePath,
        auth: target.meta?.auth,
        middlewares: target.meta?.middlewares,
        error: target.meta?.error,
        webhook: target.meta?.webhook,
        webhookProvider: target.meta?.webhookProvider,
        dynamicRangeCount: target.meta?.dynamicRange?.count,
        diff: target.diff,
    };

    // Sequence + flow graph IDs follow a well-known convention.
    const seqId = `sequence:${target.filePath}:${target.handlerName}`;
    const flowId = `flow:${target.filePath}:${target.handlerName}`;
    const seq: DiagramGraph | undefined = snapshot.graphs?.[seqId];
    const flow: DiagramGraph | undefined = snapshot.graphs?.[flowId];

    const callsInto: EntryPointPack['callsInto'] = [];
    const messages: EntryPointPack['messages'] = [];
    const modifiedMessages: string[] = [];
    const modifiedFunctions = new Set<string>();
    if (seq) {
        const nodeById = new Map<string, GraphNode>();
        for (const n of seq.nodes) nodeById.set(n.id, n);
        for (const n of seq.nodes) {
            if (n.type !== 'participant') continue;
            if (n.label === 'API Client') continue;
            callsInto.push({
                participant: n.label,
                kind: (n.subtitle ?? '«module»').replace(/«|»/g, '').trim(),
                filePath: n.anchor?.filePath,
                diff: n.diff,
            });
            if (n.diff && n.diff !== 'unchanged') modifiedFunctions.add(n.label);
        }
        for (const e of seq.edges) {
            if (e.edgeType !== 'message') continue;
            const fromNode = nodeById.get(e.source);
            const toNode = nodeById.get(e.target);
            const fromLabel = fromNode?.label ?? e.source;
            const toLabel = toNode?.label ?? e.target;
            messages.push({ from: fromLabel, to: toLabel, label: e.label ?? '', diff: e.diff });
            if (e.diff && e.diff !== 'unchanged') modifiedMessages.push(`${fromLabel} → ${toLabel}: ${e.label}`);
        }
    }

    const flowNodes: EntryPointPack['flowNodes'] = [];
    let modifiedFlowNodes = 0;
    if (flow) {
        for (const n of flow.nodes) {
            flowNodes.push({ kind: n.type, label: n.label, diff: n.diff });
            if (n.diff && n.diff !== 'unchanged') modifiedFlowNodes++;
        }
    }

    // Sibling routes in the same cluster: helps the LLM weigh scope.
    const fileToCluster = new Map<string, FeatureCluster>();
    for (const c of Object.values(snapshot.clusters ?? {})) {
        for (const f of c.files) fileToCluster.set(f, c);
    }
    const myCluster = fileToCluster.get(target.filePath);
    const siblings: EntryPointPack['siblings'] = [];
    if (myCluster) {
        for (const a of apis) {
            if (myCluster.files.includes(a.filePath) && !(a.method === method && a.route === route)) {
                siblings.push({ method: a.method, route: a.route });
            }
        }
    }

    // Handler source slice — only if the caller passed a content resolver
    // (the in-process extension has it via store.getFileContent('working', …);
    // the standalone MCP CLI can pass fs.readFileSync).
    // #866: when `lean`, window the source to the diff (changed lines ± context)
    // so the per-entry review actually sees the changed code without shipping a
    // whole 200-line handler.
    const lean = options.lean ? { ...LEAN_DEFAULTS, ...(typeof options.lean === 'object' ? options.lean : {}) } : null;
    let handlerSource: string | undefined;
    if (options.workspaceFileContent && target.anchor?.span) {
        const fileContent = options.workspaceFileContent(target.filePath);
        const start = target.anchor.span.start ?? 0;
        const end = target.anchor.span.end ?? start;
        if (fileContent && end > start && end <= fileContent.length) {
            handlerSource = lean
                ? windowChangedSource(fileContent, options.baselineFileContent?.(target.filePath), { start, end }, lean)
                : fileContent.slice(start, end);
        }
    }

    // #866: trim the graph metadata to diff-relevant + top-K when lean — keep
    // ALL modified items (the cross-layer impact, the whole point of CodeAtlas)
    // and cap the unchanged noise, so adding source nets leaner than today's
    // full graph dump on deep chains.
    // #865 — downstream participant source, scoped to the called functions in
    // the resolved interactions (NOT whole files). For each message (modified
    // first), resolve the called method in the target participant's file and
    // slice that function's body. Lean-only + needs a content resolver; capped
    // by count + lines so deep chains stay lean.
    let participantSources: EntryPointPack['participantSources'];
    if (lean && options.workspaceFileContent) {
        const participantFile = new Map<string, string | undefined>();
        for (const c of callsInto) participantFile.set(c.participant, c.filePath);
        const ordered = [...messages].sort((a, b) => (isModified(b) ? 1 : 0) - (isModified(a) ? 1 : 0));
        const seen = new Set<string>();
        const out: NonNullable<EntryPointPack['participantSources']> = [];
        for (const msg of ordered) {
            if (out.length >= lean.maxParticipantSources) break;
            const fp = participantFile.get(msg.to);
            // The interaction's called method (strip args + any receiver prefix).
            const fnName = (msg.label || '').replace(/\s*\(.*$/, '').trim();
            if (!fp || !fnName) continue;
            const key = `${fp}::${fnName}`;
            if (seen.has(key)) continue;
            const span = findFunctionSpan(snapshot, fp, fnName);
            if (!span) continue;
            const content = options.workspaceFileContent(fp);
            if (!content || span.end <= span.start || span.end > content.length) continue;
            const slice = capLines(content.slice(span.start, span.end), lean.maxParticipantSourceLines);
            if (!slice.trim()) continue;
            seen.add(key);
            out.push({ participant: msg.to, filePath: fp, functionName: fnName, source: slice, diff: msg.diff });
        }
        if (out.length > 0) participantSources = out;
    }

    const pack: EntryPointPack = {
        entryPoint: fallback,
        handlerSource,
        callsInto: lean ? trimToRelevant(callsInto, isModified, lean.maxCallsInto) : callsInto,
        messages: lean ? trimToRelevant(messages, isModified, lean.maxMessages) : messages,
        flowNodes: lean ? trimToRelevant(flowNodes, isModified, lean.maxFlowNodes) : flowNodes,
        siblings: lean ? siblings.slice(0, lean.maxSiblings) : siblings,
        ...(participantSources ? { participantSources } : {}),
    };
    if (modifiedFunctions.size > 0 || modifiedMessages.length > 0 || modifiedFlowNodes > 0) {
        pack.diff = {
            modifiedFunctions: [...modifiedFunctions],
            modifiedMessages,
            modifiedFlowNodes,
        };
    }
    return pack;
}

// ─── Diff summary ──────────────────────────────────────────────────────────

export interface DiffSummary {
    /** Files whose hash differs between baseline and working. */
    changedFiles: string[];
    /** Entry points added since baseline (in working, not in baseline). */
    addedEntryPoints: EntryPointSummary[];
    /** Entry points deleted (in baseline, not in working). */
    deletedEntryPoints: EntryPointSummary[];
    /** Entry points whose sequence graph carries modified nodes/edges. */
    modifiedEntryPoints: EntryPointSummary[];
    /** Clusters with at least one modified file. */
    modifiedClusters: Array<{ id: string; label: string }>;
}

export function getDiffSummary(snapshot: Snapshot, baseline: Snapshot): DiffSummary {
    const changedFiles: string[] = [];
    for (const [path, working] of Object.entries(snapshot.files ?? {})) {
        const base = baseline.files?.[path];
        if (!base || base.hash !== working.hash) changedFiles.push(path);
    }
    for (const path of Object.keys(baseline.files ?? {})) {
        if (!(path in (snapshot.files ?? {}))) changedFiles.push(path);
    }

    const workingApis = listEntryPoints(snapshot);
    const baselineApis = listEntryPoints(baseline);
    const byId = (ep: EntryPointSummary) => `${ep.method}:${ep.route}::${ep.filePath}`;
    const baselineIds = new Set(baselineApis.map(byId));
    const workingIds = new Set(workingApis.map(byId));

    const addedEntryPoints = workingApis.filter((ep) => !baselineIds.has(byId(ep)));
    const deletedEntryPoints = baselineApis.filter((ep) => !workingIds.has(byId(ep)));

    // Modified: same id, but the sequence-graph for the working snapshot has
    // any modified node/edge. Using the seq graph directly catches the
    // L3-cascade signal that the file-hash diff might miss when an
    // imported dependency changed.
    const modifiedEntryPoints: EntryPointSummary[] = [];
    for (const ep of workingApis) {
        if (!baselineIds.has(byId(ep))) continue;
        const seq = snapshot.graphs?.[`sequence:${ep.filePath}:${ep.handlerName}`];
        if (!seq) continue;
        const hasMod = seq.nodes.some((n) => n.diff && n.diff !== 'unchanged') ||
            seq.edges.some((e) => e.diff && e.diff !== 'unchanged');
        if (hasMod) modifiedEntryPoints.push(ep);
    }

    const modifiedClusters: DiffSummary['modifiedClusters'] = [];
    for (const c of Object.values(snapshot.clusters ?? {})) {
        if (c.diff && c.diff !== 'unchanged') {
            modifiedClusters.push({ id: c.id, label: c.label });
        }
    }

    return { changedFiles, addedEntryPoints, deletedEntryPoints, modifiedEntryPoints, modifiedClusters };
}

// ─── Impact-of-change ──────────────────────────────────────────────────────

/**
 * Given a file (and optionally a function within it), list every entry point
 * whose handler / call chain reaches it. The inverse of `getEntryPointPack` —
 * useful for "if I touch this, what gets affected?" questions.
 */
export interface ImpactOfChange {
    entryPoints: EntryPointSummary[];
    /** The seq graphs that contain the changed file/function as a participant. */
    affectedSequenceIds: string[];
}

export function getImpactOfChange(snapshot: Snapshot, filePath: string, functionName?: string): ImpactOfChange {
    const affectedSequenceIds: string[] = [];
    const apis = Object.values(snapshot.apiIndex ?? {});
    const matchedEntryPoints: EntryPointSummary[] = [];

    for (const a of apis) {
        const seqId = `sequence:${a.filePath}:${a.handlerName}`;
        const seq = snapshot.graphs?.[seqId];
        if (!seq) continue;
        const containsFile = seq.nodes.some((n) =>
            n.type === 'participant' &&
            (n.anchor?.filePath === filePath ||
                (functionName && n.label === functionName)));
        if (containsFile) {
            affectedSequenceIds.push(seqId);
            matchedEntryPoints.push({
                apiId: a.apiId,
                method: a.method,
                route: a.route,
                handlerName: a.handlerName,
                filePath: a.filePath,
                auth: a.meta?.auth,
            });
        }
    }
    return { entryPoints: matchedEntryPoints, affectedSequenceIds };
}

// ─── Feature pack ──────────────────────────────────────────────────────────

export interface FeaturePack {
    cluster: { id: string; label: string; files: string[]; serviceId?: string };
    entryPoints: EntryPointSummary[];
    /** Subsystems this cluster talks to (other clusters / external services). */
    subsystems: string[];
    diff?: { changedFiles: string[]; modifiedEntryPoints: number };
}

export function getFeaturePack(snapshot: Snapshot, clusterId: string, baseline?: Snapshot): FeaturePack | null {
    const cluster = snapshot.clusters?.[clusterId];
    if (!cluster) return null;
    let entryPoints = listEntryPoints(snapshot, { clusterId });
    // #FEATURE-PACK-FALLBACK (2026-06-07) — Louvain can place a
    // controller in a sibling cluster while the cluster the user
    // expects (named after the domain) ends up holding only the
    // service / model files. Direct `clusterId` filtering then
    // returns zero entry points and the MCP `get_feature_pack` call
    // returns an empty list. Fallback: walk the call graph from each
    // API's handler and surface APIs whose downstream reaches a
    // function inside the cluster's files. Deduped against the strict
    // walk so we never emit the same `method:route` twice.
    if (entryPoints.length === 0) {
        const fileSet = new Set(cluster.files);
        const callGraph: any = (snapshot as any).callGraph;
        if (callGraph?.nodes && fileSet.size > 0) {
            const reachesFile = (callerKey: string, visited = new Set<string>()): boolean => {
                if (visited.has(callerKey)) return false;
                visited.add(callerKey);
                const node = callGraph.nodes[callerKey];
                if (!node) return false;
                for (const calleeKey of node.calls ?? []) {
                    const sep = calleeKey.lastIndexOf('::');
                    const calleeFile = sep > 0 ? calleeKey.slice(0, sep) : '';
                    if (fileSet.has(calleeFile)) return true;
                    if (reachesFile(calleeKey, visited)) return true;
                }
                return false;
            };
            const seen = new Set<string>();
            const fallback: ReturnType<typeof listEntryPoints> = [];
            for (const api of Object.values(snapshot.apiIndex ?? {})) {
                if (fileSet.has(api.filePath)) continue;
                const callerKey = `${api.filePath}::${api.handlerName}`;
                if (!reachesFile(callerKey)) continue;
                const id = `${api.method}:${api.route}`;
                if (seen.has(id)) continue;
                seen.add(id);
                const hit = listEntryPoints(snapshot).find(ep =>
                    ep.method === api.method && ep.route === api.route && ep.filePath === api.filePath,
                );
                if (hit) fallback.push({ ...hit, clusterId: cluster.id, clusterLabel: cluster.label });
            }
            entryPoints = fallback;
        }
    }
    const apiListGraph = snapshot.graphs?.[`api-list:${clusterId}`];
    const subsystems: string[] = [];
    if (apiListGraph) {
        const meta = (apiListGraph.meta ?? {}) as { subsystems?: Array<{ label: string }> };
        for (const s of (meta.subsystems ?? [])) subsystems.push(s.label);
    }
    const pack: FeaturePack = {
        cluster: { id: cluster.id, label: cluster.label, files: cluster.files, serviceId: cluster.serviceId },
        entryPoints,
        subsystems,
    };
    if (baseline) {
        const summary = getDiffSummary(snapshot, baseline);
        const changedFilesInCluster = summary.changedFiles.filter((f) => cluster.files.includes(f));
        const modifiedEntryPoints = summary.modifiedEntryPoints.filter((ep) => ep.clusterId === clusterId).length;
        if (changedFilesInCluster.length > 0 || modifiedEntryPoints > 0) {
            pack.diff = { changedFiles: changedFilesInCluster, modifiedEntryPoints };
        }
    }
    return pack;
}

// ─── Tier 1: function source slice ─────────────────────────────────────────

export interface FunctionSource {
    filePath: string;
    name: string;
    kind: 'function' | 'class' | 'variable';
    signature: string;
    span: { start: number; end: number };
    /** The raw source slice for the function body (signature + body if available). */
    source: string;
    /** Approximate line range (1-indexed) for IDE-style links. */
    lineRange?: { startLine: number; endLine: number };
}

/**
 * Return a single function's source slice by file path + symbol name. Cheaper
 * than `get_entrypoint_pack` for the common "show me the impl" case — typical
 * response is 200-2000 tokens vs 2-20KB for a full file read.
 */
export function getFunctionSource(
    snapshot: Snapshot,
    filePath: string,
    symbolName: string,
    resolveContent: (path: string) => string | undefined,
): FunctionSource | null {
    const file = snapshot.files?.[filePath];
    if (!file) return null;
    const fn = file.symbols?.functions?.find((f) => f.name === symbolName);
    if (!fn) return null;
    const content = resolveContent(filePath);
    if (!content) {
        // Fall back to stored bodyText so the caller still gets the body even
        // when the lazy-content column has been dropped (#354/#355).
        return {
            filePath,
            name: fn.name,
            kind: fn.kind,
            signature: fn.signature,
            span: fn.span,
            source: `${fn.signature} {\n${fn.bodyText}\n}`,
        };
    }
    const source = content.slice(fn.span.start, fn.span.end);
    // Best-effort line range — count newlines in the preceding chunk.
    const before = content.slice(0, fn.span.start);
    const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
    const endLine = startLine + (source.match(/\n/g)?.length ?? 0);
    return {
        filePath,
        name: fn.name,
        kind: fn.kind,
        signature: fn.signature,
        span: fn.span,
        source,
        lineRange: { startLine, endLine },
    };
}

// ─── Tier 1: API surface diff ──────────────────────────────────────────────

export interface ApiSurfaceDiff {
    /** Routes added since baseline (method + route + cluster + auth flag). */
    added: Array<{ method: string; route: string; clusterLabel?: string; auth?: 'required' | 'optional' }>;
    /** Routes removed since baseline. */
    removed: Array<{ method: string; route: string; clusterLabel?: string }>;
    /** Routes whose middleware/auth flag changed across snapshots. */
    contractChanges: Array<{
        method: string;
        route: string;
        clusterLabel?: string;
        previousAuth?: string;
        currentAuth?: string;
        addedMiddlewares?: string[];
        removedMiddlewares?: string[];
    }>;
    /** Aggregate counters for quick PR-summary lines. */
    counts: { added: number; removed: number; contractChanges: number };
}

export function getApiSurfaceDiff(snapshot: Snapshot, baseline: Snapshot): ApiSurfaceDiff {
    const fileToCluster = new Map<string, string>();
    for (const c of Object.values(snapshot.clusters ?? {})) {
        for (const f of c.files) fileToCluster.set(f, c.name ?? c.label);
    }

    const workingById = new Map<string, ApiRecord>();
    for (const a of Object.values(snapshot.apiIndex ?? {})) {
        workingById.set(`${a.method}:${a.route}::${a.filePath}`, a);
    }
    const baselineById = new Map<string, ApiRecord>();
    for (const a of Object.values(baseline.apiIndex ?? {})) {
        baselineById.set(`${a.method}:${a.route}::${a.filePath}`, a);
    }

    const added: ApiSurfaceDiff['added'] = [];
    const removed: ApiSurfaceDiff['removed'] = [];
    const contractChanges: ApiSurfaceDiff['contractChanges'] = [];

    for (const [id, a] of workingById) {
        if (!baselineById.has(id)) {
            added.push({
                method: a.method,
                route: a.route,
                clusterLabel: fileToCluster.get(a.filePath),
                auth: a.meta?.auth,
            });
        } else {
            const b = baselineById.get(id)!;
            const prevAuth = b.meta?.auth;
            const curAuth = a.meta?.auth;
            const prevMws = new Set(b.meta?.middlewares ?? []);
            const curMws = new Set(a.meta?.middlewares ?? []);
            const addedMws = [...curMws].filter((m) => !prevMws.has(m));
            const removedMws = [...prevMws].filter((m) => !curMws.has(m));
            if (prevAuth !== curAuth || addedMws.length > 0 || removedMws.length > 0) {
                contractChanges.push({
                    method: a.method,
                    route: a.route,
                    clusterLabel: fileToCluster.get(a.filePath),
                    previousAuth: prevAuth,
                    currentAuth: curAuth,
                    addedMiddlewares: addedMws.length > 0 ? addedMws : undefined,
                    removedMiddlewares: removedMws.length > 0 ? removedMws : undefined,
                });
            }
        }
    }
    for (const [id, a] of baselineById) {
        if (!workingById.has(id)) {
            removed.push({
                method: a.method,
                route: a.route,
                clusterLabel: fileToCluster.get(a.filePath),
            });
        }
    }

    return { added, removed, contractChanges, counts: { added: added.length, removed: removed.length, contractChanges: contractChanges.length } };
}

// ─── Tier 1: pre-edit briefing ─────────────────────────────────────────────

export interface PreEditBrief {
    target: { filePath: string; symbolName?: string };
    /** Function source (when symbolName is supplied). */
    source?: FunctionSource | null;
    /** Entry points reached BY this function (downstream). */
    impactedEntryPoints: EntryPointSummary[];
    /** Sibling functions defined in the same file. */
    siblingFunctions: string[];
    /** Imports / external modules this file uses. */
    importsUsed: string[];
    /** Recent diff state — has this file been touched in the current working snapshot? */
    diff?: { fileChanged: boolean; hash?: string; baselineHash?: string };
    /** Total tokens of the brief (rough), so the LLM can budget. */
    approximateTokens: number;
}

export function getPreEditBrief(
    snapshot: Snapshot,
    baseline: Snapshot,
    filePath: string,
    symbolName: string | undefined,
    resolveContent: (path: string) => string | undefined,
): PreEditBrief | null {
    const file = snapshot.files?.[filePath];
    if (!file) return null;

    const source = symbolName ? getFunctionSource(snapshot, filePath, symbolName, resolveContent) ?? null : undefined;
    const impact = getImpactOfChange(snapshot, filePath, symbolName);

    const siblingFunctions = (file.symbols?.functions ?? [])
        .filter((f) => f.name !== symbolName)
        .map((f) => f.name);
    const importsUsed = (file.symbols?.imports ?? []).map((i) => i.source);

    const baselineFile = baseline.files?.[filePath];
    const fileChanged = !baselineFile || baselineFile.hash !== file.hash;
    const diff = fileChanged
        ? { fileChanged, hash: file.hash, baselineHash: baselineFile?.hash }
        : undefined;

    const brief: PreEditBrief = {
        target: { filePath, symbolName },
        source,
        impactedEntryPoints: impact.entryPoints,
        siblingFunctions,
        importsUsed,
        diff,
        approximateTokens: 0,
    };
    brief.approximateTokens = Math.ceil(Buffer.byteLength(JSON.stringify(brief), 'utf8') / 4);
    return brief;
}

// ─── Tier 1: health report ─────────────────────────────────────────────────

export function getHealthReport(snapshot: Snapshot): HealthReport | null {
    return snapshot.health ?? null;
}
