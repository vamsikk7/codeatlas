import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { WorkspaceScanner } from '../scanner/workspaceScanner';
import { collectTopLevelEntities } from '../parser/symbolExtractor';
import { detectApis, applyMountPrefixes } from '../parser/apiDetector';
import { WorkspaceRouterTracker } from '../parser/workspaceRouterTracker';
import { detectLanguage } from '../parser/treeSitterParser';
import { extractFileSymbolsMultiLang } from '../parser/treeSitterExtractor';
import { detectFrameworkApis } from '../parser/frameworkDetector';
import { detectMobileItems, detectAndroidManifestItems } from '../parser/mobileDetector';
import { buildFileGraph, buildFileGraphFromAnalysis, recomputeFileGraphDiffFromAuthoritativeSymbols, type BaselineSymbols } from '../graph/fileGraphBuilder';
import { buildFlowGraph, buildFlowGraphFromNode, buildFlowGraphFromBody, buildFlowGraphFromBodyText, appendNonJsDeletedNodes } from '../graph/flowGraphBuilder';
import { findAnonymousRouteBody } from '../parser/anonRouteFinder';
import { findJsCallbackRange } from '../parser/jsCallbackRange';
import { buildSequenceGraph, buildSequenceGraphFromAnalysis, buildSyntheticSequenceGraph } from '../graph/sequenceGraphBuilder';
import { buildFeatureGraph } from '../graph/featureGraphBuilder';
import { buildMicroserviceGraph } from '../graph/microserviceGraphBuilder';
import { buildMapGraph } from '../graph/mapGraphBuilder';
import { buildDomainGraph } from '../graph/domainGraphBuilder';
import { detectDomains } from '../analysis/domainAnalyzer';
import { buildApiListGraph } from '../graph/apiListGraphBuilder';
import {
    upgradeSequenceDiffAnnotations,
    upgradeServiceClusterDiffAnnotations,
} from '../git/commitDiffer';
import { buildCallGraph, resolveNonJsModulePath } from '../graph/callGraphResolver';
import { parseGraphId } from '../graph/graphIdBuilder';
import { GraphMutationQueue } from './graphMutationQueue';
// #830 follow-up (2026-06-11): these were late-bind `require()` calls that
// resolve fine in the esbuild bundle but FAIL under the vitest T3 harness
// (modules never registered in the require cache → "Cannot find module").
// Every T3 run since Phase 1.6 / the IaC extractors landed silently lost
// sequence re-weave + serverless route extraction, which surfaced as
// "0 sequence graphs" / parse-failure invariant breaks. All four modules
// import only types + stdlib — no cycle risk in a static import.
import { weaveMiddlewareParticipants } from '../graph/sequenceMiddlewareWeaver';
import { applyDjangoGlobalMiddleware } from '../parser/djangoMiddleware';
import { resolveRailsControllerAnchors } from '../parser/railsControllerAnchor';
import { resolveDjangoViewAnchors } from '../parser/djangoViewAnchor';
import { resolveGoHandlerAnchors } from '../parser/goHandlerAnchor';
import { collectComposableNavTargets, reclassifyMobileScreens } from '../parser/mobileScreenReclassifier';
import { isTestPath, isVendoredPath } from '../parser/testPathFilter';
import { isSamTemplatePath, parseSamTemplate } from '../parser/samRouteExtractor';
import { isServerlessFrameworkPath, parseServerlessFrameworkTemplate } from '../parser/serverlessFrameworkRouteExtractor';
import { isCdkLikely, parseCdkConstructs } from '../parser/cdkConstructExtractor';
import { detectCommunities } from '../analysis/communityDetector';
import { mergeEnrichedClusterNames } from '../analysis/clusterNameMerge';
import { detectServices } from '../analysis/serviceDetector';
import { detectScreens } from '../parser/screenDetector';
import { extractScreenContents } from '../parser/screenContentExtractor';
import { buildScreenContentGraph } from '../graph/screenContentGraphBuilder';
import { buildFrontendDataFlowGraph } from '../graph/frontendDataFlowBuilder';
import { buildMobileDataFlowGraph } from '../graph/mobileDataFlowBuilder';
import { enrichFileGraphForCategory } from '../graph/fileGraphEnricher';
import { forEachGraph, getLazyGraphMap } from '../storage/lazyGraphMap';
import { analyzeHealth } from '../analysis/healthAnalyzer';
import type { LlmNamingService } from '../llm/llmNamingService';
import { refineDomainsWithLlm, mergeRefinedDomainNames, type DomainLlmCall } from '../llm/domainLlmRefiner';
import { SnapshotStore } from '../storage/snapshotStore';
import { CommentStore } from '../storage/commentStore';
import type { FileRecord, DiagramGraph, FeatureCluster } from '../graph/graphTypes';

const JS_TS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

/**
 * Issue #720 helper — extract the source path from an `import::source::local`
 * stableKey produced by `treeSitterExtractor`. Mirrors the logic in
 * `fileGraphBuilder.extractImportSource` so we don't have to cross-import.
 * The local part is the suffix after the LAST `::`; source is everything
 * before it. Falls back to the stableKey itself for legacy shapes.
 */
function extractImportSourceFromKey(entityKey: string): string {
    if (entityKey.startsWith('import::')) {
        const trimmed = entityKey.slice('import::'.length);
        const lastSep = trimmed.lastIndexOf('::');
        if (lastSep > 0) return trimmed.slice(0, lastSep);
        return trimmed;
    }
    return entityKey.replace(/^import:/, '');
}

/**
 * MULTI-REPO-HANG perf fix (polar) — compute a cheap, stable "structural
 * surface" key for a single file. The surface is the exact set that feeds the
 * whole-repo detection steps (services / clusters / microservice / domain /
 * health):
 *   - the file's API records (sorted `method:route:handler`),
 *   - its top-level function/class names (sorted),
 *   - its import module specifiers (sorted).
 *
 * A pure body edit (or adding a PRIVATE local helper that exposes no new API)
 * leaves this key UNCHANGED → `rebuildFile` can skip the CPU-bound whole-repo
 * cascade and only run the per-file L3/L4/L5 rebuild + diff propagation. Adding
 * or removing an endpoint, a top-level class/function, or an import edge flips
 * the key → the heavy detection re-runs.
 *
 * Note: local/nested helpers do NOT surface here because `symbolExtractor` /
 * `treeSitterExtractor` only record TOP-LEVEL functions/vars/classes into
 * `record.symbols.functions`. That is exactly the granularity clustering cares
 * about, so a nested `probe()` inside an existing function is invisible → skip.
 *
 * @param relativePath workspace-relative file path (kept out of the hash so
 *   the key is comparable OLD-vs-NEW for the same file).
 * @param symbols the file record's `symbols` (functions + variables + imports).
 * @param apisForFile ApiRecords whose `filePath === relativePath`.
 */
export function computeStructuralKey(
    relativePath: string,
    symbols: FileRecord['symbols'] | undefined,
    apisForFile: Array<{ method: string; route: string; handlerName: string }>,
): string {
    // API surface: method:route:handler, sorted + deduped.
    const apiParts = Array.from(new Set(
        (apisForFile ?? []).map(a => `${a.method}:${a.route}:${a.handlerName}`),
    )).sort();

    // Top-level function + class names (classes are stored under variables with
    // kind:'class' in some paths and functions in others — include both, plus
    // any variable explicitly marked class).
    const nameParts = Array.from(new Set([
        ...((symbols?.functions ?? []).map(f => f.name)),
        ...((symbols?.variables ?? [])
            .filter(v => v.kind === 'class' || v.kind === 'function')
            .map(v => v.name)),
    ])).sort();

    // Import module specifiers, sorted + deduped (drives clustering edges).
    const importParts = Array.from(new Set(
        (symbols?.imports ?? []).map(i => i.source),
    )).sort();

    return [
        'api', ...apiParts,
        '|fn', ...nameParts,
        '|imp', ...importParts,
    ].join('');
}

// Issue 195: bumped from 1 MB → 5 MB. Real codebases legitimately have
// large generated files (Prisma schema TS, GraphQL codegen output, large
// Vue single-file components, generated routers). 1 MB silently skipped
// these and produced incomplete diagrams. Tree-sitter parses 5 MB JS/TS
// in ~200 ms on the dev box, which fits within the 500 ms save→render
// budget. Overridable per-instance via the constructor option, and
// configurable workspace-wide via `codeatlas.maxFileSize` in settings.
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;
function isJsOrTs(filePath: string): boolean {
    return JS_TS_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * Read multiple files concurrently with a concurrency limit.
 * Returns a Map of filePath → content. Files that fail to read are omitted.
 */
async function readFilesBatch(
    filePaths: string[],
    concurrency: number = 10,
    maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    for (let i = 0; i < filePaths.length; i += concurrency) {
        const batch = filePaths.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
            batch.map(async (fp) => {
                const stat = await fsp.stat(fp).catch(() => null);
                if (!stat || stat.size > maxFileSize) return { fp, code: null as string | null };
                const code = await fsp.readFile(fp, 'utf-8');
                return { fp, code };
            })
        );
        for (const result of settled) {
            if (result.status === 'fulfilled' && result.value.code !== null) {
                results.set(result.value.fp, result.value.code!);
            }
        }
    }
    return results;
}

/**
 * Create a ghost version of a graph where all nodes and edges are marked diff:'deleted'.
 * Used when a handler, function, or entire file is removed — keeps the old diagram
 * visible in the webview with red coloring so developers can see what was lost.
 */
function makeDeletedGraph(graph: DiagramGraph): DiagramGraph {
    return {
        ...graph,
        nodes: graph.nodes.map(n => ({ ...n, diff: 'deleted' as const })),
        edges: graph.edges.map(e => ({ ...e, diff: 'deleted' as const })),
    };
}

export interface SyncEvent {
    type: 'file-changed' | 'file-created' | 'file-deleted';
    filePath: string;
    content?: string;  // in-memory content from editor (avoids disk read)
}

export type RefreshCallback = (graphIds: string[]) => void;

export interface ChangeDetail {
    filePath: string;
    changedFunctions: string[];
    newFunctions: string[];
    deletedFunctions: string[];
    updatedGraphIds: string[];
}
export type ChangeDetailCallback = (details: ChangeDetail[]) => void;

/**
 * Orchestrates incremental updates when files are saved.
 * Rebuilds only impacted artifacts and triggers webview refreshes.
 */
export class SyncOrchestrator {
    /** Cross-file router tracker (#357 — Silent catches obscure real failures). Populated during initialize() pre-pass and
     *  re-scanned per-file on rebuildFile(). Drives cross-file route emission. */
    private routerTracker: WorkspaceRouterTracker = new WorkspaceRouterTracker();
    private workspaceRoot: string;
    /**
     * ADR-034 Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — repo-scope root, distinct from `workspaceRoot`
     * in multi-repo mode. Defaults to `workspaceRoot` so single-repo
     * workspaces are byte-identical to pre-Phase-B behaviour. Multi-repo
     * dispatch (Pass 3) constructs one `SyncOrchestrator` per detected
     * repo with `repoRoot` set to that repo's absolute path.
     *
     * Today (Pass 2) it's used by the workspace scan only. Phase C/J widen
     * the usage as cross-repo state becomes a thing.
     */
    private repoRoot: string;
    private scanner: WorkspaceScanner;
    private store: SnapshotStore;
    private commentStore: CommentStore;
    private autoUpdate: boolean = true;
    private refreshCallbacks: RefreshCallback[] = [];

    /** #842 — true while initialize() is repopulating in-memory state.
     *  On-demand graph rebuilds (Knowledge Map et al.) must serve the
     *  persisted copy during this window instead of building from a
     *  half-populated snapshot; see the buildMapGraphCached guard. */
    public initInFlight = false;

    /** #844 — monotonically increasing state generation, bumped at the
     *  start of every initialize() and rebuildFile. Fire-and-forget
     *  enrichment callbacks (LLM naming) capture it at schedule time and
     *  bail when a newer generation has superseded them — a stale callback
     *  once wholesale-replaced the baseline cluster set with an earlier
     *  partial map (1 of 6 clusters), turning every later L2a diff into
     *  phantom "+ ADDED" badges; see ADR-041. */
    private stateGeneration = 0;

    /**
     * #824 — ensure every HTTP-class api record has SOME L3 sequence graph.
     * IaC-extracted routes (Serverless/SAM/CDK) and handlers without a
     * parsed call chain are skipped by the real builders; give them the
     * minimal synthetic API-Client→module sequence so the L2b click, tours,
     * and deep links land on a consistent L3 instead of the fallback chain.
     * Returns the graphIds it created.
     */
    private ensureSyntheticSequences(): string[] {
        const HTTP_CLASS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY', 'ROUTE']);
        const made: string[] = [];
        try {
            const w = this.store.getWorking();
            for (const api of Object.values(w.apiIndex ?? {})) {
                if (!api?.filePath || !api?.handlerName) continue;
                if (!HTTP_CLASS.has(String(api.method).toUpperCase())) continue;
                const gid = `sequence:${api.filePath}:${api.handlerName}`;
                const existing = w.graphs[gid];
                if (existing && Array.isArray(existing.nodes) && existing.nodes.length > 0) continue;
                const g = buildSyntheticSequenceGraph(api);
                this.store.updateWorkingGraph(g.graphId, g);
                made.push(g.graphId);
            }
            if (made.length > 0) this.log(`[syntheticSequences] built ${made.length} one-participant sequence(s) for routes without a call chain`);
        } catch (err: any) {
            this.log(`[syntheticSequences] skipped: ${err?.message ?? err}`);
        }
        return made;
    }

    /**
     * #844 — apply an async naming enrichment SAFELY:
     *  - drop it when the state generation moved on (stale pass);
     *  - merge NAMES by cluster id only — a naming pass may never change
     *    cluster membership or cardinality, in either snapshot.
     * Returns false when the enrichment was dropped.
     */
    private applyClusterNameEnrichment(
        enriched: Record<string, FeatureCluster>,
        scheduledGeneration: number,
    ): boolean {
        if (scheduledGeneration !== this.stateGeneration) {
            this.log(`[LLM naming] dropped stale enrichment (generation ${scheduledGeneration} superseded by ${this.stateGeneration})`);
            return false;
        }
        const working = this.store.getWorking().clusters ?? {};
        const baseline = this.store.getBaseline().clusters ?? {};
        this.store.updateWorkingClusters(mergeEnrichedClusterNames(working, enriched));
        this.store.updateBaselineClusters(mergeEnrichedClusterNames(baseline, enriched));
        return true;
    }
    private changeDetailCallbacks: ChangeDetailCallback[] = [];
    private _lastChangedFnNames = new Set<string>();
    private _lastNewFnNames = new Set<string>();
    private _lastDeletedFnNames = new Set<string>();
    private progressCallbacks: Array<(phase: string, progress: number, message: string) => void> = [];
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingEvents: SyncEvent[] = [];
    private processing: boolean = false;
    // PERF (2026-07-15): the VSIX `requestRoute` handler cascades live diff
    // annotations before serving EVERY navigation (extension.ts / ADR-019).
    // On a warm, unchanged snapshot that full re-cascade (rebuild every
    // api-list + Map + Domain graph, re-walk all sequence/service graphs) is
    // pure waste — it added ~1s to every drill-down (the MCP standalone path,
    // which never cascades on read, was ~3ms for the same repo). This flag
    // gates it: set on any working-state mutation (file save / resync), cleared
    // when the cascade runs, so read-only navigation skips the redundant pass.
    // Starts dirty so the first navigation after init cascades once.
    private _liveGraphsCascadeDirty = true;
    private log: (msg: string) => void = () => {};
    private lspFallbackResolver: { resolveFromSnapshot: (typeName: string, snapshotFiles: Record<string, FileRecord>) => { filePath: string; typeName: string } | null } | null = null;
    private llmNamingService: LlmNamingService | null = null;
    /** Whether the user opted into automatic LLM cluster naming (codeatlas.llmNaming). */
    private llmNamingEnabled = false;
    /**
     * Issue #733 — optional Domain LLM refiner. Wired via
     * `setDomainLlmRefiner` from the extension host / standalone server
     * once the LLM provider is configured. The deterministic
     * `detectDomains` heuristic ALWAYS runs; this refiner runs after,
     * asynchronously, and only when its `isEnabled()` returns true.
     */
    private domainLlmRefiner: { isEnabled: () => boolean; call: DomainLlmCall } | null = null;
    /**
     * Single-writer queue for cascade calls. ADR-020 / Issue 359 — concurrent
     * cascade requests (rebuildFile + back-button + replay click) used to
     * interleave on shared snapshot state. The queue serializes them; reads
     * remain free.
     */
    private mutationQueue = new GraphMutationQueue();

    /** Issue 195: Per-instance max file size — overridable from extension.ts
     *  via the `codeatlas.maxFileSize` setting. Defaults to DEFAULT_MAX_FILE_SIZE. */
    private maxFileSize: number;

    constructor(
        workspaceRoot: string,
        store: SnapshotStore,
        commentStore: CommentStore,
        ignorePatterns?: string[],
        maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
        /**
         * ADR-034 Phase B — distinct repo scope. When omitted (single-repo
         * mode) it falls back to `workspaceRoot`, preserving today's behaviour.
         * Multi-repo dispatch passes the per-repo absolute path.
         */
        repoRoot?: string,
    ) {
        this.workspaceRoot = workspaceRoot;
        this.repoRoot = repoRoot ?? workspaceRoot;
        this.store = store;
        this.commentStore = commentStore;
        this.scanner = new WorkspaceScanner(ignorePatterns);
        this.maxFileSize = maxFileSize;
    }

    /**
     * MULTI-REPO-HANG perf fix — compute the structural-surface key for the
     * edited file against a given snapshot (`baseline` or `working`). Pulls the
     * file's ApiRecords out of the snapshot's apiIndex + reads its symbols from
     * either the passed `symbols` (post-rebuild NEW record, whose symbols are
     * populated in memory) or the snapshot's file record (OLD state before the
     * rebuild overwrote it).
     */
    private structuralKeyFor(
        snapshot: import('../graph/graphTypes').Snapshot,
        relativePath: string,
        symbols: FileRecord['symbols'] | undefined,
    ): string {
        const apisForFile = Object.values(snapshot.apiIndex ?? {})
            .filter((a) => a.filePath === relativePath);
        return computeStructuralKey(relativePath, symbols, apisForFile);
    }

    /** ADR-034 Phase B — repo-scope root (= workspaceRoot in single-repo mode). */
    getRepoRoot(): string { return this.repoRoot; }
    getWorkspaceRoot(): string { return this.workspaceRoot; }
    /** UX-17 (2026-06-03 v2) — expose the orchestrator's snapshot store so
     *  the multi-repo home-info aggregator can read working state across
     *  every per-repo orchestrator. */
    getStore(): SnapshotStore { return this.store; }

    /**
     * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — emit the cross-repo `RepoSummary` for this
     * orchestrator's repo. Called by the `WorkspaceOrchestrator`'s
     * per-repo runner once `initialize()` (or a `rebuildFile`) settles,
     * so the aggregator can union shared externals / schemas / HTTP edges
     * across the workspace.
     *
     * Today's per-repo state.db already carries every signal the summary
     * needs:
     *   - `working.apiIndex` → `summary.apis`
     *   - `working.services[*].consumedUrls` → `summary.httpClientPaths`
     *   - Files' import lists fed to `detectSdks` → `summary.sdks`
     *   - Files fed to `detectDbSchemas` → `summary.schemas`
     *
     * The summary is INTENTIONALLY narrow — it carries the cross-repo
     * signal only. Per-repo internals (graphs, comments, flow nodes)
     * stay in `state.db`.
     */
    produceSummary(repoId: string): import('./repoSummary').RepoSummary {
        // Late-bind imports to avoid a circular module load and keep the
        // top-of-file import block stable.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SUMMARY_SCHEMA_VERSION } = require('./repoSummary');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { detectSdks } = require('../parser/sdkDetector');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { detectDbSchemas } = require('../analysis/dbSchemaDetector');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { detectLanguage } = require('../parser/treeSitterParser');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const path = require('path');

        const working = this.store.getWorking();

        // APIs — minimal projection, deduped per (method, route). The JS
        // rebuild path can leave a duplicate apiIndex record with a generic
        // framework token as handlerName (#830); without the dedupe the
        // duplicate's hash overwrote the real one in `apiHashes` and every
        // consumer edge flipped `modified` after ANY producer save (#817).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { dedupeApiSurfaces } = require('./repoSummary');
        const apis = dedupeApiSurfaces(Object.values(working.apiIndex ?? {}).map((a: any) => ({
            apiId: a.id ?? `${a.method}:${a.route}`,
            method: String(a.method ?? ''),
            route: String(a.route ?? ''),
            filePath: String(a.filePath ?? ''),
            handlerName: String(a.handlerName ?? ''),
        })));

        // HTTP client paths from this repo's services' consumedUrls
        // (already extracted during detectServices). The per-repo
        // state.db's services table carries this repo's own service +
        // stubs for siblings (Phase B data duplication note). The own
        // service is the only one with populated consumedUrls; stubs
        // have empty arrays. So we union all without filtering by repoId
        // (services.repoId is the rootPath, while the parameter is the
        // realpath-hash — different keys).
        const httpClientPaths = Array.from(new Set(
            Object.values(working.services ?? {})
                .flatMap((s: any) => (s.consumedUrls ?? []) as string[]),
        ));

        // SDKs — invoke detectSdks across this repo's files.
        let sdks: import('./repoSummary').SummarySdk[] = [];
        try {
            const files = working.files ?? {};
            const fileLanguageMap: Record<string, any> = {};
            const repoPrefix = this.repoRoot.length > 0 && this.repoRoot !== this.workspaceRoot
                ? path.relative(this.workspaceRoot, this.repoRoot) + '/'
                : '';
            const ownFiles: Record<string, any> = {};
            for (const [fp, rec] of Object.entries(files)) {
                if (repoPrefix && !fp.startsWith(repoPrefix)) continue;
                ownFiles[fp] = rec;
                const lang = detectLanguage(path.join(this.workspaceRoot, fp));
                if (lang) fileLanguageMap[fp] = lang;
            }
            const detected = detectSdks(
                ownFiles,
                fileLanguageMap,
                (fp: string) => this.store.getFileContent('working', fp),
            );
            sdks = detected.map((d: any) => ({
                sdkId: d.sdkId,
                name: d.name,
                category: d.category,
            }));
        } catch (err: any) {
            this.log(`[produceSummary] sdkDetector failed for ${repoId}: ${err?.message ?? err}`);
        }

        // DB schemas — invoke detectDbSchemas across this repo's files.
        // Most ORM markers (TypeORM @Entity in .ts, SQLAlchemy in .py,
        // Django models.py, Rails *.rb, etc.) already reach working.files
        // through the normal parse pipeline. The `.prisma` files don't —
        // multiple downstream parser-language allowlists drop them before
        // they hit working.files. We compensate with a targeted fs walk
        // here that synthesises FileRecords for any *.prisma files under
        // the repo root, reading their content inline. detectDbSchemas
        // sees them via the same getContent path it already uses for
        // every other file.
        let schemas: import('./repoSummary').SummarySchema[] = [];
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fsLocal = require('fs');
            const files = working.files ?? {};
            const repoPrefix = this.repoRoot.length > 0 && this.repoRoot !== this.workspaceRoot
                ? path.relative(this.workspaceRoot, this.repoRoot) + '/'
                : '';
            const ownFiles: Record<string, any> = {};
            for (const [fp, rec] of Object.entries(files)) {
                if (repoPrefix && !fp.startsWith(repoPrefix)) continue;
                ownFiles[fp] = rec;
            }
            // Targeted .prisma walk (depth-3 — covers `prisma/schema.prisma`,
            // `apps/web/prisma/schema.prisma`). Each match becomes a synthetic
            // FileRecord with content populated so readContent() hits it.
            const walkForPrisma = (dir: string, depth: number): void => {
                if (depth < 0) return;
                let entries: any[] = [];
                try { entries = fsLocal.readdirSync(dir, { withFileTypes: true }); }
                catch { return; }
                for (const e of entries) {
                    if (e.name.startsWith('.')) continue;
                    if (e.name === 'node_modules' || e.name === '.codeatlas') continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) {
                        walkForPrisma(full, depth - 1);
                    } else if (e.isFile() && e.name.endsWith('.prisma')) {
                        try {
                            const content = fsLocal.readFileSync(full, 'utf8');
                            const relFromWs = path.relative(this.workspaceRoot, full).replace(/\\/g, '/');
                            ownFiles[relFromWs] = {
                                path: relFromWs,
                                hash: '',
                                mtime: 0,
                                content,
                                symbols: { functions: [], variables: [], imports: [] },
                            };
                        } catch (err: any) {
                            this.log(`[produceSummary] read .prisma at ${full} failed: ${err?.message ?? err}`);
                        }
                    }
                }
            };
            walkForPrisma(this.repoRoot, 4);

            const detected = detectDbSchemas(
                ownFiles,
                (fp: string) => this.store.getFileContent('working', fp),
            );
            // Dedupe by (engine, tableName) — Prisma can emit duplicates.
            const seen = new Set<string>();
            for (const entry of detected) {
                const key = `${entry.engine}|${entry.tableName}`;
                if (seen.has(key)) continue;
                seen.add(key);
                schemas.push({
                    engine: entry.engine,
                    tableName: entry.tableName,
                    displayName: entry.displayName,
                    source: entry.source,
                });
            }
        } catch (err: any) {
            this.log(`[produceSummary] dbSchemaDetector failed for ${repoId}: ${err?.message ?? err}`);
        }

        // Coarse technology from the dominant SDK / service category.
        // 2026-06-09 — the legacy lookup compared `service.repoId === repoId`
        // but `repoId` here is the realpath hash while `service.repoId` is
        // the topRepoFor name; the mismatch silently fell through to
        // 'unknown' for every multi-repo summary (132/132 in
        // serverless-examples). Match by rootPath instead: in multi-repo
        // mode the per-repo SyncOrchestrator's `this.repoRoot` is the
        // sub-repo's absolute path, so the workspace-relative rootPath
        // of the OWN service equals `path.relative(workspaceRoot, repoRoot)`.
        const technology: import('./repoSummary').ServiceTechnology = (() => {
            const svcs = Object.values(working.services ?? {});
            const ownRelRoot = (this.repoRoot && this.repoRoot !== this.workspaceRoot)
                ? path.relative(this.workspaceRoot, this.repoRoot).replace(/\\/g, '/')
                : '';
            // Look for the service whose rootPath matches our repo root.
            // Fall back to the legacy `repoId` match for back-compat with
            // single-repo workspaces where rootPath is empty.
            const own = svcs.find((s: any) => s.rootPath === ownRelRoot)
                ?? svcs.find((s: any) => s.repoId === repoId);
            const tech = (own as any)?.technology;
            if (tech === 'express' || tech === 'nestjs' || tech === 'fastify' || tech === 'koa' || tech === 'serverless') return 'nodejs';
            if (tech === 'django' || tech === 'flask' || tech === 'fastapi') return 'python';
            if (tech === 'spring' || tech === 'micronaut') return 'java';
            if (tech === 'ktor') return 'kotlin';
            if (tech === 'gin' || tech === 'echo' || tech === 'fiber' || tech === 'chi') return 'go';
            if (tech === 'actix' || tech === 'axum' || tech === 'rocket') return 'rust';
            return 'unknown';
        })();

        // UX-67c (2026-06-09) — per-API surface hash for cross-repo
        // staleness. Cross-repo analyzer + consumer-side analyzers use
        // these to decide whether a downstream consumer is stale. Hash
        // inputs: method, route, handlerName. The hash is intentionally
        // narrow (excludes anchor / filePath) so cosmetic file moves
        // don't ripple as "modified" through consumer graphs.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const crypto = require('crypto');
        const apiHashes: Record<string, string> = {};
        for (const a of apis) {
            const surface = `${a.method.toUpperCase()}|${a.route}|${a.handlerName ?? ''}`;
            apiHashes[a.apiId] = crypto.createHash('sha256').update(surface).digest('hex').slice(0, 16);
        }

        return {
            repoId,
            schemaVersion: SUMMARY_SCHEMA_VERSION,
            technology,
            apis,
            sdks,
            schemas,
            httpClientPaths,
            apiHashes,
        };
    }

    /**
     * Issue 260: Build flow graphs for anonymous route handlers eagerly at init.
     *
     * `apis` may contain entries with `handlerName` of the form `anonymous@METHOD:/route`
     * (Express/Fastify/Hono/Apollo callbacks, Go/Rust/Kotlin/Ruby/PHP closures). The
     * lazy click-time path that builds these on demand leaves the L5 layer empty
     * for ~5 framework repos in the verification suite. Doing it at init parallels
     * the named-function flow graph loop above.
     *
     * Returns the number of flow graphs created.
     */
    private async buildAnonymousFlowGraphs(
        code: string,
        filePath: string,
        language: 'javascript' | 'typescript' | 'go' | 'rust' | 'kotlin' | 'ruby' | 'php' | 'swift',
        apis: Array<{ handlerName: string }>,
    ): Promise<number> {
        let built = 0;
        const seen = new Set<string>();
        const isJsTs = language === 'javascript' || language === 'typescript';
        for (const api of apis) {
            if (!api.handlerName?.startsWith('anonymous@')) continue;
            if (seen.has(api.handlerName)) continue;
            seen.add(api.handlerName);
            const m = api.handlerName.match(/^anonymous@(\w+):(.+)$/);
            if (!m) continue;
            const [, method, route] = m;
            try {
                // Path A: tree-sitter for non-JS langs (Go/Rust/Kotlin/Ruby/PHP) and
                // most JS/TS files. tree-sitter-typescript doesn't parse JSX, so .tsx
                // with JSX in the handler body returns null — fall through to Path B.
                const bodyNode = await findAnonymousRouteBody(code, language, method, route);
                if (bodyNode) {
                    const flowGraph = buildFlowGraphFromBody(bodyNode, code, filePath, api.handlerName);
                    this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                    built++;
                    continue;
                }
                // Path B: Babel fallback for JS/TS — handles JSX and other syntax
                // that tree-sitter-typescript can't parse. Extract the callback
                // source range via regex+brace-count, wrap as `const __h = <cb>`,
                // and reuse the existing JS flow-graph builder.
                if (!isJsTs) continue;
                const cbInfo = findJsCallbackRange(code, method, route);
                if (!cbInfo) continue;
                const wrapped = `const __handler = ${cbInfo.text}`;
                const flowGraph = buildFlowGraph(wrapped, filePath, api.handlerName, undefined, undefined, cbInfo.startIndex);
                this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                built++;
            } catch (err: any) {
                this.log(`[Initialize] Anon flow graph skipped for ${api.handlerName} in ${filePath}: ${err?.message ?? err}`);
            }
        }
        return built;
    }

    private sequenceResolver = (importPath: string, currentFilePath: string) => {
        try {
            let base = importPath;
            if (base.endsWith('.js') || base.endsWith('.ts')) {
                base = base.substring(0, base.lastIndexOf('.'));
            }

            const dir = path.dirname(path.join(this.workspaceRoot, currentFilePath));
            const exts = ['.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];

            for (const ext of exts) {
                const fullPath = path.resolve(dir, base + ext);
                const relPath = fullPath.replace(this.workspaceRoot + '/', '');

                // First try getting from in-memory working state
                const workingFile = this.store.getWorking().files[relPath];
                if (workingFile && typeof workingFile.content === 'string') {
                    return { code: workingFile.content, filePath: relPath };
                }

                if (fs.existsSync(fullPath)) {
                    const code = fs.readFileSync(fullPath, 'utf-8');
                    return { code, filePath: relPath };
                }
            }
        } catch {
            // ignore
        }
        return undefined;
    };

    private oldSequenceResolver = (importPath: string, currentFilePath: string) => {
        try {
            let base = importPath;
            if (base.endsWith('.js') || base.endsWith('.ts')) {
                base = base.substring(0, base.lastIndexOf('.'));
            }

            const dir = path.dirname(path.join(this.workspaceRoot, currentFilePath));
            const exts = ['.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];

            for (const ext of exts) {
                const fullPath = path.resolve(dir, base + ext);
                const relPath = fullPath.replace(this.workspaceRoot + '/', '');

                // Try the baseline content from the DB first (the in-memory
                // FileRecord no longer holds content — see #354 memory fix).
                const baselineContent = this.store.getFileContent('baseline', relPath);
                if (typeof baselineContent === 'string') {
                    return { code: baselineContent, filePath: relPath };
                }

                if (fs.existsSync(fullPath)) {
                    const code = fs.readFileSync(fullPath, 'utf-8');
                    return { code, filePath: relPath };
                }
            }
        } catch {
            // ignore
        }
        return undefined;
    };

    /**
     * Set a logger function (e.g. VS Code output channel append).
     * Called with human-readable status lines and error details.
     */
    setLogger(logger: (msg: string) => void): void {
        this.log = logger;
    }

    /**
     * Register a callback to be notified when diagrams are refreshed
     */
    onRefresh(callback: RefreshCallback): void {
        this.refreshCallbacks.push(callback);
    }

    onChangeDetail(callback: ChangeDetailCallback): void {
        this.changeDetailCallbacks.push(callback);
    }

    onProgress(callback: (phase: string, progress: number, message: string) => void): void {
        this.progressCallbacks.push(callback);
    }

    private emitProgress(phase: string, progress: number, message: string): void {
        for (const cb of this.progressCallbacks) cb(phase, progress, message);
    }

    /**
     * Toggle auto-update on/off
     */
    setAutoUpdate(enabled: boolean): void {
        this.autoUpdate = enabled;
    }

    setLspFallbackResolver(resolver: { resolveFromSnapshot: (typeName: string, snapshotFiles: Record<string, FileRecord>) => { filePath: string; typeName: string } | null }): void {
        this.lspFallbackResolver = resolver;
    }

    setLlmNamingService(service: LlmNamingService): void {
        this.llmNamingService = service;
    }

    /**
     * Gate for the AUTOMATIC cluster-naming pass that runs on init + cascade.
     * The LLM service is `configure()`d whenever a provider is selected (so
     * on-demand NL queries work), which makes `isConfigured` true even for a
     * user who never opted into naming. Keying the auto-naming pass on
     * `isConfigured` alone therefore fired `nameClusters` on every load — and
     * spammed `fetch failed` when e.g. a globally-selected `ollama` provider
     * wasn't running. Auto-naming now additionally requires the user's explicit
     * `codeatlas.llmNaming` opt-in (default false), set by the host.
     */
    setLlmNamingEnabled(enabled: boolean): void {
        this.llmNamingEnabled = enabled;
    }

    /**
     * Issue #733 — register an optional Domain LLM refiner. The
     * deterministic `detectDomains` heuristic always runs first; if
     * `isEnabled()` returns true at refinement time, the refiner gets
     * the heuristic output + a compact evidence pack and produces
     * renames + confidence adjustments + merges that update the same
     * `domain:workspace` graph asynchronously.
     */
    setDomainLlmRefiner(opts: { isEnabled: () => boolean; call: DomainLlmCall }): void {
        this.domainLlmRefiner = opts;
    }

    /**
     * Run the Domain LLM refinement pass against the current working
     * snapshot. Idempotent — calling it twice with the same heuristic
     * input produces the same refined output (mod LLM determinism).
     * Returns the list of refreshed graphIds so the caller can broadcast.
     *
     * Public so the standalone HomePage toggle (Issue #733) can invoke
     * the refinement immediately when the user flips the chip ON,
     * instead of waiting for the next file-save cascade.
     */
    async refineDomainsAndRebuildGraph(reason: string = 'manual'): Promise<string[]> {
        const refiner = this.domainLlmRefiner;
        if (!refiner || !refiner.isEnabled()) return [];
        try {
            const working = this.store.getWorking();
            const heuristic = detectDomains(working);
            const refined = await refineDomainsWithLlm(heuristic, working, refiner.call, {
                log: (m) => this.log(`[${reason}] ${m}`),
            });
            // Issue #734 — persist the refined domain set to sqlite so the
            // LLM-touched names survive across VS Code reloads. Without
            // this, the optional refinement pass would have to re-call the
            // LLM on every session, defeating the cache + the
            // "deterministic system is the core" guarantee.
            this.store.updateWorkingDomains(refined);
            const graph = buildDomainGraph(refined, working);
            this.store.updateWorkingGraph(graph.graphId, graph);
            return [graph.graphId];
        } catch (err: any) {
            this.log(`[${reason}] domain LLM refinement failed: ${err?.message ?? err}`);
            return [];
        }
    }

    /**
     * Issue 99: Clear all callbacks and timers to prevent stale references on extension reload.
     */
    dispose(): void {
        this.refreshCallbacks = [];
        this.progressCallbacks = [];
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingEvents = [];
        this.processing = false;
    }

    isAutoUpdateEnabled(): boolean {
        return this.autoUpdate;
    }

    /**
     * Handle a file change event (VS Code save or external disk write).
     * Pass `content` when calling from onDidChangeTextDocument to use in-memory
     * text directly without a disk read (unsaved changes).
     */
    handleFileSave(filePath: string, content?: string): void {
        if (!this.autoUpdate) return;
        this.queueEvent({ type: 'file-changed', filePath, content });
    }

    /**
     * Handle a new file being created on disk
     */
    handleFileCreated(filePath: string): void {
        if (!this.autoUpdate) return;
        this.queueEvent({ type: 'file-created', filePath });
    }

    /**
     * Handle a file being deleted from disk
     */
    handleFileDeleted(filePath: string): void {
        if (!this.autoUpdate) return;
        this.queueEvent({ type: 'file-deleted', filePath });
    }

    /**
     * Handle a file rename (e.g. via VS Code explorer or external tool)
     */
    handleFileRenamed(oldPath: string, newPath: string): void {
        if (!this.autoUpdate) return;
        this.queueEvent({ type: 'file-deleted', filePath: oldPath });
        this.queueEvent({ type: 'file-created', filePath: newPath });
    }

    private queueEvent(event: SyncEvent): void {
        // Any file save/create/delete may shift diff annotations → the next
        // navigation must re-cascade before serving (see _liveGraphsCascadeDirty).
        this._liveGraphsCascadeDirty = true;
        // For change events, keep only the most recent content snapshot
        if (event.type === 'file-changed') {
            this.pendingEvents = this.pendingEvents.filter(
                (e) => !(e.type === 'file-changed' && e.filePath === event.filePath)
            );
        }
        this.pendingEvents.push(event);
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.processPendingEvents().catch((err: any) => this.log(`[Sync] Event processing error: ${err?.message ?? err}`));
        }, 500);
    }

    /**
     * Process all pending file change events
     */
    private async processPendingEvents(): Promise<void> {
        // Issue 98: Mutex guard — prevent concurrent processing
        if (this.processing) {
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.processPendingEvents().catch((err: any) => this.log(`[Sync] Deferred event processing error: ${err?.message ?? err}`));
            }, 200);
            return;
        }
        this.processing = true;
        try {
            const events = [...this.pendingEvents];
            this.pendingEvents = [];

            const updatedGraphIds: string[] = [];
            const deletedFiles = new Set<string>();
            const changedOrCreatedFiles = new Set<string>();

            for (const event of events) {
                if (event.type === 'file-deleted') {
                    deletedFiles.add(event.filePath);
                    changedOrCreatedFiles.delete(event.filePath);
                } else {
                    changedOrCreatedFiles.add(event.filePath);
                    deletedFiles.delete(event.filePath);
                }
            }

            for (const filePath of deletedFiles) {
                const ids = this.removeFile(filePath);
                updatedGraphIds.push(...ids);
            }

            const changeDetails: ChangeDetail[] = [];
            for (const filePath of changedOrCreatedFiles) {
                const event = [...events].reverse().find(
                    (e) => e.filePath === filePath && e.type !== 'file-deleted'
                );
                const result = await this.rebuildFile(filePath, event?.content);
                updatedGraphIds.push(...result.graphIds);
                if (result.changeDetail && (result.changeDetail.changedFunctions.length > 0 || result.changeDetail.newFunctions.length > 0 || result.changeDetail.deletedFunctions.length > 0)) {
                    changeDetails.push(result.changeDetail);
                }
            }

            if (updatedGraphIds.length > 0 || deletedFiles.size > 0) {
                this.store.save();
                this.notifyRefresh(updatedGraphIds);
                if (changeDetails.length > 0) {
                    this.notifyChangeDetail(changeDetails);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Remove all working-state artifacts for a deleted file.
     * Graphs that exist in baseline are preserved as ghost graphs (all nodes/edges diff:'deleted')
     * so the webview can show them in red, indicating the file was removed.
     */
    private removeFile(filePath: string): string[] {
        const relativePath = filePath.replace(this.workspaceRoot + '/', '');
        const removedGraphIds: string[] = [];

        const baseline = this.store.getBaseline();
        const working = this.store.getWorking();

        // Collect all graph IDs associated with this file from both baseline and working
        const fileGraphIds = new Set<string>([`file:${relativePath}`]);
        
        // Add flow graphs
        [baseline.files[relativePath], working.files[relativePath]].forEach(f => {
            f?.symbols?.functions?.forEach(func => {
                fileGraphIds.add(`flow:${relativePath}:${func.name}`);
            });
        });

        // Add sequence graphs
        [...Object.values(baseline.apiIndex), ...Object.values(working.apiIndex)].forEach(api => {
            if (api.filePath === relativePath) {
                fileGraphIds.add(`sequence:${relativePath}:${api.handlerName}`);
            }
        });

        // Replace each graph with a ghost (all nodes/edges diff:'deleted') if it was in baseline
        for (const graphId of fileGraphIds) {
            const baselineGraph = baseline.graphs[graphId];
            if (baselineGraph) {
                this.store.updateWorkingGraph(graphId, makeDeletedGraph(baselineGraph));
            } else {
                this.store.removeWorkingGraph(graphId);
            }
            removedGraphIds.push(graphId);
        }

        // Remove all APIs defined in this file (they surface as deleted in L2b via baseline diff)
        for (const [apiId, api] of Object.entries(working.apiIndex)) {
            if (api.filePath === relativePath) {
                this.store.removeWorkingApi(apiId);
            }
        }

        // Remove the file record itself
        this.store.removeWorkingFile(relativePath);

        return removedGraphIds;
    }

    /**
     * Full initialization: scan workspace and build all diagrams
     */
    async initialize(): Promise<{ fileCount: number; apiCount: number; graphCount: number; truncated: boolean; totalFound: number; parseFailures: Record<string, number>; durations: { total_ms: number; scan_ms: number; parse_ms: number; build_ms: number; build_phases?: { callgraph_ms: number; services_ms: number; communities_ms: number; feature_ms: number; graphs_ms: number } } }> {
        // #842 — flag the init window so on-demand graph rebuilds
        // (buildMapGraphCached et al.) can serve the persisted copy
        // instead of building from a half-populated in-memory snapshot
        // (live repro: Knowledge Map rendered 1 of 6 clusters when the
        // route was requested mid-init). Cleared in the finally below.
        this.initInFlight = true;
        // #844 — supersede any in-flight async enrichment from a prior
        // generation; its callback will bail instead of clobbering state.
        this.stateGeneration++;
        try {
        // Per-phase timing — surfaced via the return value so analytics can
        // attribute slowness to a specific phase (ADR-030 / Issue 364 — Same TS file parsed up to 5× per save
        // validation). Reset on every call.
        const t0 = Date.now();
        // Clean slate: delete all .codeatlas/ files and reset in-memory state
        this.store.clearAllFiles();

        // Earliest possible L1 broadcast — runs BEFORE the workspace scan
        // (which on huge folders is the longest single step, often 20+s
        // for 30k+ files). Service detection only needs manifests on
        // disk, NOT the scanned file list, so this gives the browser a
        // navigable skeleton inside a second or two of init starting.
        try {
            this.emitEarlyL1Skeleton([]);
        } catch (err: any) {
            this.log(`[Initialize] earliest-L1 broadcast skipped: ${err?.message ?? err}`);
        }

        // ADR-034 Phase B — scan the repo's subtree, emit workspace-relative
        // paths. In single-repo mode `this.repoRoot === this.workspaceRoot`,
        // so this is byte-identical to the old `scan(workspaceRoot)` call.
        // In multi-repo mode the scanner walks ONLY this repo's files but
        // emits paths under `workspaceRoot` so the per-repo state.db's
        // graphIds (`file:svc-alpha/src/server.js`) match the webview hash
        // routes 1:1 — no boundary translation needed.
        const scanResults = this.scanner.scanRepo(this.repoRoot, this.workspaceRoot);
        const tAfterScan = Date.now();
        let apiCount = 0;
        let graphCount = 0;

        // Collect non-JS API files for Phase 1B (sequence graphs built after all files are stored)
        type NonJsSeqWork = { analysis: import('../parser/treeSitterExtractor').FileAnalysis; apis: import('../graph/graphTypes').ApiRecord[]; relPath: string };
        const nonJsSeqWork: NonJsSeqWork[] = [];

        const truncated = (scanResults as any).__truncated === true;
        const totalFound = (scanResults as any).__totalFound ?? scanResults.length;
        this.log(`[Initialize] Scanning ${scanResults.length} files in ${this.workspaceRoot}${truncated ? ` (truncated from ${totalFound} — limit 2000)` : ''}`);
        this.emitProgress('scanning', 0.05, `Scanning files (${scanResults.length} found)...`);

        // Issue 105: Track parse failures by file extension for aggregated warnings
        const parseFailures = new Map<string, number>();

        // Pre-read all files concurrently (10 at a time) for faster initialization
        const fileContents = await readFilesBatch(scanResults.map(r => r.filePath), 10, this.maxFileSize);
        this.emitProgress('scanning', 0.2, `Read ${fileContents.size} files, parsing...`);

        // #357 cross-file router pre-pass: TWO passes over Go/Kotlin so the
        // call-site resolution in pass 2 sees the complete decls map from
        // pass 1. Single-pass would miss calls that appear before their
        // function decl in scanResults order.
        this.routerTracker.clear();
        const trackerCandidates: Array<{ relativePath: string; code: string; lang: 'go' | 'kotlin' }> = [];
        for (const result of scanResults) {
            const lang: 'go' | 'kotlin' | null = result.filePath.endsWith('.go')
                ? 'go'
                : (result.filePath.endsWith('.kt') || result.filePath.endsWith('.kts')) ? 'kotlin' : null;
            if (!lang) continue;
            const code = fileContents.get(result.filePath);
            if (code === undefined) continue;
            trackerCandidates.push({ relativePath: result.relativePath, code, lang });
        }
        for (const c of trackerCandidates) this.routerTracker.scanDecls(c.relativePath, c.code, c.lang);
        for (const c of trackerCandidates) this.routerTracker.scanCalls(c.relativePath, c.code, c.lang);

        // TICKET-PERF-1 — the per-file parse+graph-build below is the dominant,
        // CPU-bound cost of init and its `await`s resolve via microtasks, so on
        // a 10k+ file repo the (server-first–bound) HTTP/WS server can't service
        // a browser for the whole build. Yield a MACROTASK every N files so the
        // event loop's I/O phase runs and the browser connects + shows a loading
        // state during init instead of hanging. N is large enough that the yield
        // overhead is negligible on small repos.
        let fileBuildCounter = 0;
        for (const result of scanResults) {
            if ((++fileBuildCounter % 200) === 0) await new Promise((r) => setImmediate(r));
            try {
                const code = fileContents.get(result.filePath);
                if (code === undefined) continue; // skipped (too large, unreadable, etc.)
                const fileRecord: FileRecord = {
                    path: result.relativePath,
                    hash: result.hash,
                    mtime: result.mtime,
                    content: code,            // store source for incremental diff
                    symbols: { functions: [], variables: [], imports: [] },
                };

                // BUG-EXP-12 — test files' route-like patterns are scaffolding, not
                // production entry points; skip entry-point detection so L1/L2a/L2b agree.
                // TICKET-DETECT-1 — also skip vendored/bundled code (`compiled/`,
                // `vendor/`, `*.min.js`) so a repo that vendors its deps in-tree
                // (Next.js `packages/next/src/compiled/**`) doesn't inflate the surface.
                const isTest = isTestPath(result.relativePath) || isVendoredPath(result.relativePath);
                if (isJsOrTs(result.filePath)) {
                    // ── JS/TS: Babel pipeline ──────────────────────────────────────
                    const apis = isTest ? [] : detectApis(code, result.relativePath);
                    const jsLang: 'typescript' | 'javascript' = /\.tsx?$/.test(result.filePath) ? 'typescript' : 'javascript';
                    // Issues 257/258/259: detectApis only picks up Express-style call
                    // patterns. Next.js App Router exports / Nuxt defineEventHandler /
                    // tRPC procedures live in META_FRAMEWORK_PATTERNS inside
                    // detectFrameworkApis. Without this, meta-framework server routes
                    // never get sequence graphs.
                    //
                    // Dedup is by (method, route, filePath) — NOT full apiId — because
                    // the two detectors disagree on handler names for inline arrows.
                    // Babel's detectApis labels them `anonymous@GET:/tags`; the regex
                    // detector resolves the nearest preceding identifier (e.g. `router`).
                    // Same logical route, different handler string = a duplicate row in
                    // the L2b API list. Tuple-keyed dedup fixes it.
                    const frameworkApis = isTest ? [] : detectFrameworkApis(code, result.relativePath, jsLang);
                    const routeKey = (a: { method: string; route: string; filePath: string }) =>
                        `${a.method}:${a.route}::${a.filePath}`;
                    const knownRouteKeys = new Set(apis.map(routeKey));
                    // Issue 414: the regex-based framework detector captures
                    // template-literal routes as their raw text (`/random/${index}`).
                    // Babel's `detectApis` already emits the parameterized form
                    // (`/random/:index`) when the call sits in a constant-bound
                    // for-loop, so any framework-route containing `${…}` text is
                    // a duplicate of an already-emitted parameterized record.
                    const newFrameworkApis = frameworkApis.filter(a =>
                        !knownRouteKeys.has(routeKey(a)) && !/\$\{/.test(a.route),
                    );
                    for (const a of newFrameworkApis) apis.push(a);
                    const jsMobileItems = detectMobileItems(code, result.relativePath, jsLang);
                    for (const api of [...apis, ...jsMobileItems]) {
                        this.store.updateWorkingApi(api.apiId, api);
                        apiCount++;
                    }

                    const fileGraph = buildFileGraph(code, result.relativePath);
                    this.store.updateWorkingGraph(fileGraph.graphId, fileGraph);
                    graphCount++;

                    const analysis = collectTopLevelEntities(code, result.relativePath);

                    for (const entity of analysis.entities) {
                        if (entity.kind === 'function') {
                            fileRecord.symbols.functions.push({
                                name: entity.name,
                                kind: entity.kind,
                                span: { start: entity.node?.start ?? 0, end: entity.node?.end ?? 0 },
                                signature: entity.signature,
                                bodyText: entity.bodyText,
                                bodySrc: entity.bodySrc,
                                stableKey: entity.key,
                            });
                        } else if (entity.kind === 'variable') {
                            fileRecord.symbols.variables.push({
                                name: entity.name,
                                kind: entity.kind,
                                span: { start: entity.node?.start ?? 0, end: entity.node?.end ?? 0 },
                                signature: entity.signature,
                                bodyText: entity.bodyText,
                                stableKey: entity.key,
                            });
                        }
                    }
                    for (const [source, specifiers] of analysis.importsByLocal.entries()) {
                        fileRecord.symbols.imports.push({
                            source: specifiers,
                            specifiers: [{ local: source, imported: source }],
                            span: { start: 0, end: 0 },
                            stableKey: `import:${specifiers}`,
                        });
                    }

                    this.store.updateWorkingFile(result.relativePath, fileRecord);

                    for (const fn of analysis.funcs.values()) {
                        if (fn.node) {
                            try {
                                let fnCode = code.slice(fn.node.start, fn.node.end);
                                // Issue 347: ClassMethod's `start` includes any
                                // leading decorators (`@Get() async findAll(...)`),
                                // so slicing from `start` gives `@Get()\n…method`
                                // which Babel can't parse when prefixed by
                                // `function`. Slice from the method's key
                                // identifier and reconstruct the prefix from the
                                // node flags. Same handling for static/get/set.
                                if (fn.node.type === 'ClassMethod' || fn.node.type === 'ClassPrivateMethod') {
                                    const keyStart = fn.node.key?.start;
                                    const sliceFrom = typeof keyStart === 'number' ? keyStart : fn.node.start;
                                    const methodSlice = code.slice(sliceFrom, fn.node.end);
                                    const prefix = (fn.node.async ? 'async ' : '') + 'function ' + (fn.node.generator ? '*' : '');
                                    fnCode = prefix + methodSlice;
                                }
                                const flowGraph = buildFlowGraph(fnCode, result.relativePath, fn.name, undefined, undefined, fn.node.start);
                                this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                                graphCount++;
                            } catch (err: any) {
                                this.log(`[Initialize] Flow graph skipped for ${fn.name} in ${result.relativePath}: ${err?.message ?? err}`);
                            }
                        }
                    }

                    if (apis.length > 0) {
                        const handlersSeen = new Set<string>();
                        for (const api of apis) {
                            if (handlersSeen.has(api.handlerName)) continue;
                            handlersSeen.add(api.handlerName);
                            let seqGraph = buildSequenceGraph(code, result.relativePath, undefined, this.sequenceResolver, this.oldSequenceResolver, api.handlerName, this.store.getWorking().files, this.lspFallbackResolver ?? undefined);
                            // Issue 335: skip empty sequence graphs of either
                            // shape — the JS/TS orphan-pruning pass can leave
                            // both file-level (`sequence:<file>`) and
                            // per-handler (`sequence:<file>:<handler>`)
                            // graphs with zero nodes. Empty graphs render as
                            // a blank diagram and offer no diff signal.
                            if (seqGraph.nodes.length === 0) continue;
                            // UX-30 (2026-06-04): weave the route's
                            // middleware chain (cors → auth → rateLimit →
                            // handler) into the sequence so security /
                            // observability hops are visible in L3.
                            const mws = api.meta?.middlewares;
                            if (mws && mws.length > 0) {
                                seqGraph = weaveMiddlewareParticipants(seqGraph, mws, { routeKey: api.apiId });
                            }
                            this.store.updateWorkingGraph(seqGraph.graphId, seqGraph);
                            graphCount++;
                        }

                        // Issue 260: Eager flow graphs for anonymous JS/TS handlers
                        graphCount += await this.buildAnonymousFlowGraphs(code, result.relativePath, jsLang, apis);
                    }
                } else {
                    // ── Non-JS: tree-sitter pipeline ───────────────────────────────
                    // (BUG-EXP-12 `isTest` guard applied on the detectFrameworkApis call below)
                    const language = detectLanguage(result.filePath);
                    if (language) {
                        const analysis = await extractFileSymbolsMultiLang(code, result.relativePath, language);
                        const apis = isTest ? [] : detectFrameworkApis(code, result.relativePath, language); // BUG-EXP-12
                        const mobileItems = isTest ? [] : detectMobileItems(code, result.relativePath, language);

                        for (const api of [...apis, ...mobileItems]) {
                            this.store.updateWorkingApi(api.apiId, api);
                            apiCount++;
                        }

                        const fileGraph = buildFileGraphFromAnalysis(analysis, result.relativePath);
                        this.store.updateWorkingGraph(fileGraph.graphId, fileGraph);
                        graphCount++;

                        for (const entity of analysis.entities) {
                            if (entity.kind === 'function' || entity.kind === 'class') {
                                fileRecord.symbols.functions.push({
                                    name: entity.name,
                                    kind: entity.kind === 'class' ? 'class' : 'function',
                                    span: { start: 0, end: 0 },
                                    signature: entity.signature,
                                    bodyText: entity.bodyText,
                                    bodySrc: entity.bodySrc,
                                    stableKey: entity.key,
                                    calls: Array.from(entity.calls || []),
                                    memberCalls: entity.memberCalls
                                        ? Object.fromEntries([...entity.memberCalls.entries()].map(([k, v]) => [k, Array.from(v)]))
                                        : undefined,
                                    localVarTypes: entity.localVarTypes
                                        ? Object.fromEntries(entity.localVarTypes.entries())
                                        : undefined,
                                    extendsClass: entity.extendsClass,
                                    implementsInterfaces: entity.implementsInterfaces,
                                    // MCP-EVAL-4 — framework-registration decorators for dead-code reachability.
                                    decorators: entity.decorators,
                                });
                            } else if (entity.kind === 'variable') {
                                fileRecord.symbols.variables.push({
                                    name: entity.name,
                                    kind: entity.kind,
                                    span: { start: 0, end: 0 },
                                    signature: entity.signature,
                                    bodyText: entity.bodyText,
                                    stableKey: entity.key,
                                });
                            }
                        }
                        // Issue #720: when two imports share the same local
                        // alias (e.g. Go's `github.com/golang-jwt/jwt/v5` and
                        // `github.com/labstack/echo/v5` both extract `v5`),
                        // `importsByLocal` overwrites silently and the baseline
                        // file record stores only the survivor. On every
                        // subsequent rebuild, `computeNonJsDiff` iterates the
                        // full `analysis.entities` list (which preserves all
                        // imports) and the dropped one fails baseline lookup
                        // → marked 'added' forever → cascades to L4/L3/L2b/L1
                        // and never clears on revert. Iterate entities so
                        // duplicates survive.
                        for (const entity of analysis.entities) {
                            if (entity.kind !== 'import') continue;
                            const source = extractImportSourceFromKey(entity.key);
                            fileRecord.symbols.imports.push({
                                source,
                                specifiers: [{ local: entity.name, imported: entity.name }],
                                span: { start: 0, end: 0 },
                                stableKey: entity.key,
                            });
                        }

                        fileRecord.symbols.injectedDeps = analysis.injectedDeps
                            ? Object.fromEntries(analysis.injectedDeps.entries())
                            : undefined;
                        // MCP-EVAL-4 — Depends()/Security() provider references so
                        // those providers aren't flagged as dead code.
                        fileRecord.symbols.frameworkRefs = analysis.frameworkRefs && analysis.frameworkRefs.size > 0
                            ? Array.from(analysis.frameworkRefs)
                            : undefined;
                        this.store.updateWorkingFile(result.relativePath, fileRecord);

                        // Defer sequence graph building to Phase 1B (after all files are stored)
                        if (apis.length > 0) {
                            nonJsSeqWork.push({ analysis, apis, relPath: result.relativePath });
                        }

                        // Build per-method flow graphs for non-JS files.
                        // #445-A: when the extractor produced a function entity
                        // WITHOUT a tree-sitter node (Dart regex fallback —
                        // tree-sitter-dart 0.1.13 can't parse Dart 3.x), use
                        // the body-text builder so Flutter / Dart files still
                        // get L5 flow graphs.
                        for (const entity of analysis.entities) {
                            if (entity.kind !== 'function') continue;
                            try {
                                let flowGraph;
                                if (entity.node) {
                                    flowGraph = buildFlowGraphFromNode(entity.node, code, result.relativePath, entity.name);
                                } else if (entity.bodyText) {
                                    flowGraph = buildFlowGraphFromBodyText(entity.bodyText, result.relativePath, entity.name);
                                } else {
                                    continue;
                                }
                                this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                                graphCount++;
                            } catch (err: any) {
                                this.log(`[Initialize] Flow graph skipped for ${entity.name} in ${result.relativePath}: ${err?.message ?? err}`);
                            }
                        }

                        // Issue 260: Eager flow graphs for anonymous handlers
                        // (Go/Rust/Kotlin/Ruby/PHP/Swift closures registered as routes).
                        if (apis.length > 0 && (
                            language === 'go' || language === 'rust' || language === 'kotlin'
                            || language === 'ruby' || language === 'php' || language === 'swift'
                        )) {
                            graphCount += await this.buildAnonymousFlowGraphs(code, result.relativePath, language, apis);
                        }
                    }
                }
            } catch (err: any) {
                this.log(`[Initialize] Skipped ${result.relativePath}: ${err?.message ?? err}`);
                // Issue 105: Track parse failure by extension
                const ext = result.relativePath.match(/\.(\w+)$/)?.[1] ?? 'unknown';
                parseFailures.set(ext, (parseFailures.get(ext) ?? 0) + 1);
            }
        }

        const tAfterParse = Date.now();
        this.log(`[Initialize] Phase 1 done — ${apiCount} APIs, ${graphCount} graphs`);
        this.emitProgress('parsing', 0.5, `Parsed ${scanResults.length} files — ${apiCount} APIs found`);

        // Phase 1.5: Apply mount-point prefixes to JS/TS API routes
        // Scans entry files for app.use('/prefix', router) and patches sub-router routes
        try {
            const working = this.store.getWorking();
            const jsFileContents = new Map<string, string>();
            for (const [relPath, rec] of Object.entries(working.files)) {
                if (!isJsOrTs(relPath)) continue;
                // Content is fresh at init, but fall back to the lazily-persisted
                // copy for parity with the rebuild path (BUG-EXPLORE-1) so mount
                // detection never silently loses an entry file whose content was
                // already dropped.
                const content = rec.content ?? this.store.getFileContent('working', relPath);
                if (content) jsFileContents.set(relPath, content);
            }
            const patchedIndex = applyMountPrefixes(working.apiIndex, jsFileContents, this.workspaceRoot);
            this.store.replaceWorkingApiIndex(patchedIndex);
        } catch (err: any) {
            this.log(`[Initialize] Mount-prefix patching failed: ${err?.message ?? err}`);
        }

        // UX-36 (2026-06-04) — Django global MIDDLEWARE cross-file pass.
        // Reads settings.py from the workspace, parses its MIDDLEWARE
        // list, and prepends to every Django-shaped route's
        // meta.middlewares. Scoped to the settings.py project dir so
        // sibling Express services in the same workspace aren't polluted.
        try {
            const working = this.store.getWorking();
            const pyFileContents = new Map<string, string>();
            for (const [relPath, rec] of Object.entries(working.files)) {
                if (relPath.endsWith('.py') && rec.content) {
                    pyFileContents.set(relPath, rec.content);
                }
            }
            if (pyFileContents.size > 0) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const patchedIndex = applyDjangoGlobalMiddleware(working.apiIndex, pyFileContents);
                this.store.replaceWorkingApiIndex(patchedIndex);
            }
        } catch (err: any) {
            this.log(`[Initialize] Django MIDDLEWARE pass failed: ${err?.message ?? err}`);
        }

        // #880 — re-anchor Rails resource routes (declared in config/routes.rb)
        // onto their controller files so a controller-only PR is attributed to
        // its route entry point. Deterministic + self-gating (no-op off Rails).
        try {
            const working = this.store.getWorking();
            const fileKeys = Object.keys(working.files);
            let reanchored = resolveRailsControllerAnchors(working.apiIndex, fileKeys);
            reanchored = resolveDjangoViewAnchors(reanchored, fileKeys); // BUG-EXP-11
            reanchored = resolveGoHandlerAnchors(reanchored, working.files); // TICKET-DETECT-3
            if (reanchored !== working.apiIndex) this.store.replaceWorkingApiIndex(reanchored);
        } catch (err: any) {
            this.log(`[Initialize] Rails/Django controller-anchor pass failed: ${err?.message ?? err}`);
        }

        // TICKET-MOBILE-1 — reclassify Compose SCREENs: keep only NavHost
        // destinations / *Screen composables (+ Activity/Fragment classes),
        // dropping pure UI components from the entry-point index. Runs here (Phase
        // 1.5) so non-JS sequence graphs (Phase 1B) + feature/api-list (Phase 2)
        // build from the reduced set — no orphaned graphs. Self-gating (no-op
        // unless composable SCREENs exist). Content is available pre-save.
        try {
            const working = this.store.getWorking();
            const hasComposableScreens = Object.values(working.apiIndex).some(
                (a) => a.method === 'SCREEN' && (a.meta as Record<string, unknown> | undefined)?.composable,
            );
            if (hasComposableScreens) {
                const ktSources: string[] = [];
                for (const [fp, rec] of Object.entries(working.files)) {
                    if (!fp.endsWith('.kt')) continue;
                    const content = (rec as { content?: string }).content
                        ?? this.store.getFileContent('working', fp);
                    if (content) ktSources.push(content);
                }
                const navTargets = collectComposableNavTargets(ktSources);
                const reclassified = reclassifyMobileScreens(working.apiIndex, navTargets);
                if (reclassified !== working.apiIndex) {
                    const before = Object.values(working.apiIndex).filter((a) => a.method === 'SCREEN').length;
                    const after = Object.values(reclassified).filter((a) => a.method === 'SCREEN').length;
                    this.store.replaceWorkingApiIndex(reclassified);
                    this.log(`[Initialize] MOBILE-1 screen reclassify — SCREEN ${before} → ${after} (${navTargets.size} nav targets)`);
                }
            }
        } catch (err: any) {
            this.log(`[Initialize] MOBILE-1 screen reclassify failed: ${err?.message ?? err}`);
        }

        // UX-30 follow-up (2026-06-05) — re-weave middleware participants
        // into JS/TS sequence graphs AFTER Phase 1.5 cross-file middleware
        // propagation. Phase 1 builds sequence graphs from the per-file
        // detection result, before `applyMountPrefixes` / `applyDjangoGlobalMiddleware`
        // populate `meta.middlewares` for routes whose middleware comes from
        // app-level / cross-file declarations (the dominant Express +
        // Django pattern). Without this re-weave, `meta.middlewares` is
        // populated in `apiIndex` but the sequence graphs that L3 renders
        // never see it — so L3 stays empty of middleware participants in
        // the very fixtures the master plan was designed to surface.
        try {
            const working = this.store.getWorking();
            let reWoven = 0;

            // UX-31 Phase 2 (2026-06-05): build Map<filePath, errorHandlerNames[]>
            // from MIDDLEWARE records that carry `meta.error: true` (Issue 418 — `main.ts` error-handling middleware (`app.use((err,req,res,next)=>{})`) not surfaced
            // detected 4-arg `app.use((err, req, res, next) => …)`). The
            // weaver will attach these as the 4xx/5xx terminator participant
            // after the handler.
            const errorHandlersByFile = new Map<string, string[]>();
            for (const api of Object.values(working.apiIndex)) {
                if (api.method !== 'MIDDLEWARE') continue;
                if (!(api.meta as any)?.error) continue;
                if (!api.filePath || !api.handlerName) continue;
                const list = errorHandlersByFile.get(api.filePath) ?? [];
                if (!list.includes(api.handlerName)) list.push(api.handlerName);
                errorHandlersByFile.set(api.filePath, list);
            }

            // Iterate APIs (not graphs) — apiId / filePath / handlerName are
            // authoritative, and the corresponding sequence graphId is
            // deterministic: `sequence:<filePath>:<handlerName>`. Splitting
            // the graphId by colon is fragile because handlerNames can
            // contain colons (e.g. `anonymous@GET:/user`).
            for (const api of Object.values(working.apiIndex)) {
                if (api.method === 'MIDDLEWARE') continue; // these have no sequence graph of their own
                const mws = api.meta?.middlewares;
                const errs = api.filePath ? (errorHandlersByFile.get(api.filePath) ?? []) : [];
                if ((!mws || mws.length === 0) && errs.length === 0) continue;
                if (!api.filePath || !api.handlerName) continue;
                const graphId = `sequence:${api.filePath}:${api.handlerName}`;
                const graph = working.graphs?.[graphId];
                if (!graph) continue;
                const alreadyMw = !!(graph as any).meta?.wovenMiddlewareCount;
                const alreadyErr = !!(graph as any).meta?.wovenErrorHandlerCount;
                if (alreadyMw && (errs.length === 0 || alreadyErr)) continue;
                const woven = weaveMiddlewareParticipants(graph, mws ?? [], {
                    routeKey: api.apiId,
                    errorHandlers: errs,
                });
                if ((woven as any).meta?.wovenMiddlewareCount || (woven as any).meta?.wovenErrorHandlerCount) {
                    this.store.updateWorkingGraph(graphId, woven);
                    reWoven++;
                }
            }
            this.log(`[Initialize] Phase 1.6 done — re-wove middleware into ${reWoven} sequence graphs (${errorHandlersByFile.size} files contribute error handlers)`);
        } catch (err: any) {
            this.log(`[Initialize] Phase 1.6 (sequence re-weave) failed: ${err?.message ?? err}`);
        }

        // #357 cross-file router resolution: emit routes for functions whose
        // effective prefix only becomes known once we've seen every file.
        //
        // Two-stage de-dup:
        //  (a) drop the UNPREFIXED twin emitted by per-file extraction when
        //      the same handler appears in this file (Go register-fn case:
        //      per-file emits `/feed`, cross-file emits `/api/articles/feed`).
        //  (b) drop any per-file emission with the same `(method, route, file)`
        //      tuple as the cross-file emission, regardless of handlerName
        //      (Ktor extension-fn case: per-file emits via the route-block
        //      composer, cross-file emits via the tracker — same final route
        //      but different synthetic handler names).
        try {
            const apiIndex = this.store.getWorking().apiIndex;
            const seen = new Set<string>(Object.keys(apiIndex));
            // Index existing apis by handler-key and route-key so we can
            // find both kinds of twin.
            const handlerKeyToApiId = new Map<string, string>();
            const routeKeyToApiId = new Map<string, string>();
            for (const [apiId, api] of Object.entries(apiIndex)) {
                if (!api.handlerName.startsWith('anonymous@')) {
                    handlerKeyToApiId.set(`${api.method}::${api.handlerName}::${api.filePath}`, apiId);
                }
                routeKeyToApiId.set(`${api.method}::${api.route}::${api.filePath}`, apiId);
            }
            const dropApi = (id: string): void => {
                this.store.removeWorkingApi(id);
                seen.delete(id);
                handlerKeyToApiId.forEach((v, k) => { if (v === id) handlerKeyToApiId.delete(k); });
                routeKeyToApiId.forEach((v, k) => { if (v === id) routeKeyToApiId.delete(k); });
                apiCount = Math.max(0, apiCount - 1);
            };
            for (const r of this.routerTracker.resolvedRoutes()) {
                const apiId = `${r.method}:${r.path}@${r.filePath}`;
                if (seen.has(apiId)) continue;

                // (a) Unprefixed-twin drop — same handler+file+method with a
                // shorter route the cross-file emission supersedes.
                const handlerKey = `${r.method}::${r.handlerName}::${r.filePath}`;
                const handlerTwin = handlerKeyToApiId.get(handlerKey);
                if (handlerTwin) {
                    const twinApi = apiIndex[handlerTwin];
                    if (twinApi && (r.path.endsWith(twinApi.route) || r.path === twinApi.route)) {
                        dropApi(handlerTwin);
                    }
                }

                // (b) Same-route twin — Ktor / synthetic-handler case.
                const routeKey = `${r.method}::${r.path}::${r.filePath}`;
                const routeTwin = routeKeyToApiId.get(routeKey);
                if (routeTwin && routeTwin !== apiId) {
                    dropApi(routeTwin);
                }

                seen.add(apiId);
                this.store.updateWorkingApi(apiId, {
                    apiId,
                    method: r.method,
                    route: r.path,
                    rawRoute: r.path,
                    handlerName: r.handlerName,
                    filePath: r.filePath,
                    anchor: { filePath: r.filePath },
                });
                apiCount++;
            }
        } catch (err: any) {
            this.log(`[Initialize] Cross-file router resolution failed: ${err?.message ?? err}`);
        }

        // Phase 1B: Build non-JS sequence graphs now that ALL files are in the store
        // (resolver can find any file by class name since the full file list is available)
        const nonJsResolver = (importPath: string, currentFilePath?: string) => {
            // BUG-L5-WRONGFILE: honour the FULL module path (e.g. `polar.authz.service`)
            // to disambiguate same-basename files, instead of first-basename-wins.
            const files = Object.keys(this.store.getWorking().files);
            const filePath = resolveNonJsModulePath(importPath, currentFilePath, files);
            return filePath ? { code: '', filePath } : undefined;
        };
        for (const { analysis, apis, relPath } of nonJsSeqWork) {
            const handlersSeen = new Set<string>();
            for (const api of apis) {
                if (handlersSeen.has(api.handlerName)) continue;
                handlersSeen.add(api.handlerName);
                const seqGraph = buildSequenceGraphFromAnalysis(
                    { ...analysis, funcs: analysis.funcs },
                    relPath,
                    apis,
                    api.handlerName,
                    undefined,
                    undefined,
                    nonJsResolver,
                    this.store.getWorking().files,
                    undefined,
                    this.lspFallbackResolver ?? undefined,
                );
                // Issue 335: skip empty sequence graphs (see JS/TS path).
                if (seqGraph.nodes.length === 0) continue;
                this.store.updateWorkingGraph(seqGraph.graphId, seqGraph);
                graphCount++;
            }
        }

        // Tier 3 (Issue 366 — In-flight LLM requests not aborted on supersede) — AndroidManifest.xml deep-link / receiver / service /
        // provider scan. XML files aren't picked up by the source-file scanner, so
        // we walk the workspace once for `AndroidManifest.xml` and merge the
        // detected entry points into apiIndex before Phase 2 (so clusters /
        // services can pick them up).
        try {
            const manifestItems = await this.scanAndroidManifests();
            if (manifestItems.length > 0) {
                for (const item of manifestItems) {
                    this.store.updateWorkingApi(item.apiId, item);
                }
                apiCount += manifestItems.length;
                this.log(`[Initialize] Android manifests: +${manifestItems.length} entry points (deep links / receivers / services / providers)`);
            }
        } catch (err: any) {
            this.log(`[Initialize] AndroidManifest scan failed: ${err?.message ?? err}`);
        }

        // UX-24 / UX-25 (2026-06-04) — Infrastructure-as-Code route
        // extraction. AWS SAM (`template.yaml`/`.yml`) and Serverless
        // Framework (`serverless.yml`/`.yaml`) declare HTTP routes that
        // CodeAtlas's framework detectors can't see. Walk the workspace,
        // parse every matching template, and inject the detected routes
        // into apiIndex BEFORE Phase 2 so clusters / sequence graphs /
        // L2b can pick them up.
        try {
            const iacItems = await this.scanIacTemplates();
            this.log(`[Initialize] IaC scan (root=${this.repoRoot || this.workspaceRoot}): ${iacItems.length} HTTP routes detected`);
            if (iacItems.length > 0) {
                for (const item of iacItems) {
                    this.store.updateWorkingApi(item.apiId, item);
                }
                apiCount += iacItems.length;
                this.log(`[Initialize] IaC templates: +${iacItems.length} HTTP routes (SAM + Serverless Framework)`);
            }
        } catch (err: any) {
            this.log(`[Initialize] IaC template scan failed: ${err?.message ?? err}`);
        }

        // Issue 369 — prune ORPHAN sequence graphs before Phase 2. A sequence
        // graph is `sequence:<filePath>:<handlerName>` built from an ApiRecord.
        // Some detectors emit a sequence at a handler's REFERENCE site that no
        // surviving apiIndex record backs — e.g. Django/DRF references a view
        // class in `urls.py` (→ `sequence:.../urls.py:ArticleViewSet`) while the
        // authoritative record lives at `views.py`, so the urls.py sequence is
        // an orphan double-emit. Build the valid id set from the FINAL apiIndex
        // (after all cross-file / manifest / IaC merges above) and drop any
        // sequence graph not in it. This keeps the sequence-count upper bound
        // (`sequences <= routeApis - dedupCollapses`) honest and prevents the
        // phantom graphs from feeding clusters / L2b in Phase 2.
        try {
            const finalApiIndex = this.store.getWorking().apiIndex ?? {};
            // handlerName -> files that OWN an apiIndex record for it.
            const recordFilesByHandler = new Map<string, Set<string>>();
            for (const api of Object.values(finalApiIndex)) {
                if (!api.handlerName || !api.filePath) continue;
                let s = recordFilesByHandler.get(api.handlerName);
                if (!s) { s = new Set(); recordFilesByHandler.set(api.handlerName, s); }
                s.add(api.filePath);
            }
            // handlerName -> files that have a SEQUENCE graph for it. Parse ids once:
            // `sequence:<filePath>:<handler>` (relative filePaths never contain ':',
            // so the first ':' after the prefix is the separator; the handler MAY
            // contain ':', e.g. `anonymous@GET:/user`). File-level `sequence:<file>`
            // has no handler → skipped.
            const seqFilesByHandler = new Map<string, Set<string>>();
            const seqParsed: Array<{ gid: string; filePath: string; handler: string }> = [];
            for (const gid of Object.keys(this.store.getWorking().graphs)) {
                if (!gid.startsWith('sequence:')) continue;
                const rest = gid.slice('sequence:'.length);
                const sep = rest.indexOf(':');
                if (sep < 0) continue;
                const filePath = rest.slice(0, sep);
                const handler = rest.slice(sep + 1);
                seqParsed.push({ gid, filePath, handler });
                let s = seqFilesByHandler.get(handler);
                if (!s) { s = new Set(); seqFilesByHandler.set(handler, s); }
                s.add(filePath);
            }
            let prunedSeq = 0;
            for (const { gid, filePath, handler } of seqParsed) {
                // Prune ONLY a true cross-file DUPLICATE: this file is NOT a record
                // owner for the handler, AND the handler ALSO has a sequence at a file
                // that IS a record owner (the authoritative twin). That is exactly the
                // Django/DRF phantom — `sequence:<app>/urls.py:<ViewClass>` coexisting
                // with the authoritative `sequence:<app>/views.py:<ViewClass>`. A handler
                // whose only sequence is at a non-record file (Go/Ktor router-composer
                // handlers, unique synthetic names) has NO authoritative twin → LEFT
                // ALONE, so a legit single sequence is never pruned.
                const recFiles = recordFilesByHandler.get(handler);
                if (!recFiles || recFiles.has(filePath)) continue;
                const seqFiles = seqFilesByHandler.get(handler);
                const hasAuthoritativeTwin = !!seqFiles && [...recFiles].some(rf => seqFiles.has(rf));
                // Django URL config (`urls.py`) is a pure routing file that REFERENCES
                // view classes defined in `views.py`. Its emitted sequence is always
                // phantom — the authoritative record + view body live in views.py —
                // even when the views.py twin sequence was empty-body-skipped (so the
                // `hasAuthoritativeTwin` test alone misses those). No non-Django repo
                // has a `urls.py`, so this can never touch go-fiber/js-express/etc.
                const isDjangoUrlConf = filePath.endsWith('/urls.py') || filePath === 'urls.py';
                if (hasAuthoritativeTwin || isDjangoUrlConf) {
                    this.store.removeWorkingGraph(gid);
                    prunedSeq++;
                }
            }
            if (prunedSeq > 0) {
                graphCount = Math.max(0, graphCount - prunedSeq);
                this.log(`[Initialize] Pruned ${prunedSeq} phantom sequence graph(s) — route-reference duplicate whose authoritative twin lives at the record file (Issue 369).`);
            }
        } catch (err: any) {
            this.log(`[Initialize] Orphan sequence prune failed: ${err?.message ?? err}`);
        }

        // Phase 2: Build knowledge graph (call graph, clusters, services)
        // #874 — time each build phase so the init wall-clock is attributable
        // (was one opaque `build_ms`). On monorepo-scale repos the cost is
        // dominated by one or two phases (callgraph resolution / Louvain
        // clustering); surfacing the split turns "init is slow" from a guess
        // into a measurement (`[review-pr] build phases:` line).
        this.emitProgress('building', 0.7, 'Building call graph, services, clusters...');
        const tBuildStart = Date.now();
        let buildPhases: { callgraph_ms: number; services_ms: number; communities_ms: number; feature_ms: number; graphs_ms: number } | undefined;
        try {
            const working = this.store.getWorking();

            // Build cross-file call graph (with LSP fallback for unresolved imports)
            // #775 (2026-06-06) — pass a content provider so the call-graph
            // builder can re-hydrate files whose inline `.content` was
            // dropped by the lazy-content optimisation. Without this,
            // every cluster's `internalCallCount` was zero on cascade
            // rebuilds.
            const callGraph = buildCallGraph(
                working,
                this.lspFallbackResolver ?? undefined,
                (fp) => this.store.getFileContent('working', fp),
            );
            this.store.updateWorkingCallGraph(callGraph.serialize());
            graphCount++;
            const tCallgraph = Date.now();
            // #918 — surface the #874 build sub-phases live, not just in the
            // post-init `durations.build_phases` return value. Each sub-step
            // updates the same 'building' phase (so the phase-step UI stays on
            // "Building") with a fresh message + progress fraction.
            this.emitProgress('building', 0.76, 'Detecting services...');

            // Detect microservices first so clusters can be tagged with serviceId.
            // Pass a DB-backed content provider — at init time records still
            // hold .content in RAM, but threading the fallback here keeps the
            // detector resilient if that invariant ever breaks.
            const getWorkingContent = (fp: string) => this.store.getFileContent('working', fp);
            const getBaselineContent = (fp: string) => this.store.getFileContent('baseline', fp);
            // #816 Phase 5 (2026-06-10) — pass `this.repoRoot` instead of
            // `this.workspaceRoot` so detectServices' internal
            // `detectMultiRepoMode` call scopes to THIS sub-repo's tree.
            // Pre-#816 each per-repo init re-detected every sibling sub-
            // repo and populated all of them into this sub-repo's
            // services table. Picker step-1 implicitly depended on this
            // leak; #816 (extension.ts + standalone messageHandler.ts)
            // sources the picker from `aggregator.listRepos()` instead,
            // so the leak is no longer needed for UX. In single-repo
            // mode `this.repoRoot === this.workspaceRoot` so behaviour
            // is byte-identical.
            const services = detectServices(this.repoRoot, working, getWorkingContent);
            this.store.updateWorkingServices(services);

            // v2 phase 3 #484 — per-screen records for FE/mobile services.
            // No-ops on backend-only repos (the detector early-returns
            // on every backend service); on FE/mobile services emits
            // screen records that feed the L2a flat-list renderer.
            const screens = detectScreens(working, services, getWorkingContent);
            this.store.updateWorkingScreens(screens);
            // v2 phase 4 #485 — per-screen L2b content items + one
            // screen-content:<screenId> graph per screen so the L2b
            // panel can fetch items via the standard graph delivery
            // pipeline. Backend-only repos emit zero screens →
            // zero items → zero graphs (no-op).
            const getXmlLayout = this.buildAndroidXmlLayoutResolver();
            const screenItems = extractScreenContents(working, screens, getWorkingContent, getXmlLayout);
            this.store.updateWorkingScreenItems(screenItems);
            for (const screen of Object.values(screens)) {
                const itemsForScreen = screenItems[screen.screenId] ?? [];
                const scg = buildScreenContentGraph(screen, itemsForScreen);
                this.store.updateWorkingGraph(scg.graphId, scg);
                graphCount++;
                // v2 phase 5 #486 — one L3 sequence-style data-flow
                // graph per L2b item, dispatched on the owning
                // service's category. Backend services don't reach
                // here (their screens record is empty), so
                // sequenceGraphBuilder.ts keeps owning HTTP routes.
                const owningService = services[screen.serviceId];
                const isMobile = owningService?.category === 'mobile';
                const builder = isMobile ? buildMobileDataFlowGraph : buildFrontendDataFlowGraph;
                const screenContent = working.files[screen.filePath]?.content
                    ?? getWorkingContent(screen.filePath) ?? '';
                for (const item of itemsForScreen) {
                    const flow = builder(screen, item, { content: screenContent, apiIndex: working.apiIndex });
                    if (flow) {
                        this.store.updateWorkingGraph(flow.graphId, flow);
                        graphCount++;
                    }
                }
            }

            // v2 phase 6 #487 — L4 kinds taxonomy expansion. Re-tag
            // entity nodes in FE/mobile file graphs with category-
            // specific kinds (component / hook / store / fetcher /
            // route-config / view / viewmodel / repository /
            // network-client / persistence). Backend file graphs
            // stay byte-identical because the enricher early-returns
            // on `category === 'backend' | 'unknown'`.
            //
            // Walks every `file:` graph, finds the owning service via
            // longest-rootPath match, and enriches when category is
            // frontend / mobile. Services without a rootPath match
            // fall through unchanged.
            const serviceByPath = (fp: string): typeof services[string] | undefined => {
                let best: typeof services[string] | undefined = undefined;
                let bestLen = -1;
                for (const svc of Object.values(services)) {
                    if (svc.rootPath === '' && bestLen < 0) {
                        // Workspace-wide catch-all — only used when no
                        // more specific match exists.
                        best = svc;
                        bestLen = 0;
                    } else if (svc.rootPath !== '' && (fp === svc.rootPath || fp.startsWith(svc.rootPath + '/'))) {
                        if (svc.rootPath.length > bestLen) {
                            best = svc;
                            bestLen = svc.rootPath.length;
                        }
                    }
                }
                return best;
            };
            const workingForEnrich = this.store.getWorking();
            for (const [graphId, graph] of Object.entries(workingForEnrich.graphs ?? {})) {
                // Issue #362 Phase B (2026-06-07) — structured parse.
                const parsed = parseGraphId(graphId);
                if (parsed?.type !== 'file') continue;
                const filePath = parsed.parts[0] ?? '';
                const svc = serviceByPath(filePath);
                if (!svc || (svc.category !== 'frontend' && svc.category !== 'mobile')) continue;
                const content = workingForEnrich.files[filePath]?.content ?? getWorkingContent(filePath);
                enrichFileGraphForCategory(graph, {
                    category: svc.category,
                    filePath,
                    content,
                });
            }

            const tServices = Date.now();
            this.emitProgress('building', 0.82, 'Clustering features...');

            // Detect feature clusters via community detection (services needed for serviceId tagging)
            // First run: no baseline clusters available
            const clusters = detectCommunities(working, callGraph, services, undefined);
            this.store.updateWorkingClusters(clusters);
            const tCommunities = Date.now();
            this.emitProgress('building', 0.88, 'Building feature diagrams...');

            // Build feature diagrams: per-service for multi-service repos, workspace-wide for single-service
            const serviceIds = Object.keys(services);
            if (serviceIds.length > 1) {
                for (const serviceId of serviceIds) {
                    const svcFeatureGraph = buildFeatureGraph(working, undefined, serviceId);
                    this.store.updateWorkingGraph(svcFeatureGraph.graphId, svcFeatureGraph);
                    graphCount++;
                }
            } else {
                const featureGraph = buildFeatureGraph(working);
                this.store.updateWorkingGraph(featureGraph.graphId, featureGraph);
                graphCount++;
            }
            const tFeature = Date.now();
            this.emitProgress('building', 0.92, 'Assembling diagrams...');

            // Build microservice diagram.
            // #492: pass `working` as its own baseline at init (same pattern as
            // #446-A api-list fix). Passing `undefined` makes
            // `baselineExternalKeys` empty so every external node (e.g.
            // `localhost`, `127.0.0.1`) is marked `added` on the first build.
            // `setBaselineFromWorking()` then snapshots that "added" state into
            // baseline, while the next cascade rebuild correctly computes
            // `unchanged` against a real baseline — leaving the
            // microservice:workspace graph permanently divergent (baseline-ext
            // node `added` + `meta.hasChanges: true` vs working `unchanged` +
            // `hasChanges: false`).
            const msGraph = buildMicroserviceGraph(this.workspaceRoot, working, working, getWorkingContent, getWorkingContent);
            this.store.updateWorkingGraph(msGraph.graphId, msGraph);
            graphCount++;

            // Issue #700 — Knowledge Map: single-canvas unified diagram
            // composed from services + clusters + APIs + infrastructure.
            // Built last so it picks up the freshly-updated workspace state
            // from this initialize() pass. Like the L1 graph this is cheap
            // (iterates already-detected records); no second AST pass.
            const mapGraph = buildMapGraph(working, undefined, {
                workspaceRoot: this.workspaceRoot,
                contentProvider: getWorkingContent,
            });
            this.store.updateWorkingGraph(mapGraph.graphId, mapGraph);
            graphCount++;

            // Issue #701 — Domain graph: heuristic business-intent
            // clusters derived from route paths + Louvain cluster labels.
            // Pure transform; no LLM in the MVP. Persisted to the v9
            // `domains` table (Issue #734) so LLM-refined names survive
            // VS Code reload.
            try {
                // #913 — merge prior LLM-refined names so a cascade doesn't wipe them.
                const domains = mergeRefinedDomainNames(detectDomains(working), working.domains);
                this.store.updateWorkingDomains(domains);
                const domainGraph = buildDomainGraph(domains, working);
                this.store.updateWorkingGraph(domainGraph.graphId, domainGraph);
                graphCount++;
            } catch (domErr: any) {
                this.log(`[Init] Domain graph build failed: ${domErr?.message ?? domErr}`);
            }

            // Issue #733 — optional LLM refinement runs ASYNC on top of
            // the heuristic graph above. The heuristic graph is already
            // persisted + visible by the time we get here; the LLM call
            // can take seconds without blocking init. When it finishes,
            // we re-broadcast `domain:workspace` so any open panel
            // re-renders with the refined names.
            if (this.domainLlmRefiner?.isEnabled()) {
                this.refineDomainsAndRebuildGraph('Init').then((ids) => {
                    if (ids.length > 0) {
                        this.store.save();
                        this.notifyRefresh(ids);
                    }
                }).catch((err: any) => {
                    this.log(`[Init] domain LLM refinement scheduling failed: ${err?.message ?? err}`);
                });
            }

            // Issue 261: build api-list graphs eagerly so the L2b layer is
            // populated at workspace init (was previously lazy-built on click).
            // Use the just-updated working snapshot so apiIndex / sequence graphs
            // built earlier this initialize() are visible to the diff computation.
            //
            // #446-A / #447-C: at init, baseline has not yet been copied from
            // working (`setBaselineFromWorking()` runs below at the end of
            // initialize). Passing the empty baseline makes `computeApiDiff`
            // return `'added'` for every API — that stale annotation then
            // gets copied into baseline as the initial state and never
            // resets, so the working/baseline cleanliness probe never goes
            // to zero after edit+revert cycles. At init time the working
            // snapshot IS the reference, so pass it as both arguments.
            const workingForApiList = this.store.getWorking();
            const baselineForApiList = workingForApiList;
            for (const cluster of Object.values(clusters)) {
                const apiListGraph = buildApiListGraph(cluster, workingForApiList, baselineForApiList);
                this.store.updateWorkingGraph(apiListGraph.graphId, apiListGraph);
                graphCount++;
                // Also build per-sub-cluster api-list graphs so click-down
                // navigation lands in a populated L2b panel.
                for (const sub of Object.values(cluster.subClusters ?? {})) {
                    const subListGraph = buildApiListGraph(sub, workingForApiList, baselineForApiList);
                    this.store.updateWorkingGraph(subListGraph.graphId, subListGraph);
                    graphCount++;
                }
            }

            const tGraphs = Date.now();
            buildPhases = {
                callgraph_ms: tCallgraph - tBuildStart,
                services_ms: tServices - tCallgraph,
                communities_ms: tCommunities - tServices,
                feature_ms: tFeature - tCommunities,
                graphs_ms: tGraphs - tFeature,
            };

            // Phase 2b: Code health analysis
            const health = analyzeHealth(this.store.getWorking());
            this.store.updateWorkingHealth(health);

            // Phase 2c: LLM semantic naming (non-blocking background pass)
            // After naming completes, rebuild feature graphs with enriched names and notify webview.
            if (this.llmNamingEnabled && this.llmNamingService?.isConfigured) {
                const fileContents: Record<string, string> = {};
                for (const [fp, rec] of Object.entries(working.files)) {
                    fileContents[fp] = rec.content ?? '';
                }
                // #844 — capture the generation at schedule time; the
                // callback bails if a newer init/rebuild superseded it,
                // and merges NAMES only (never membership/cardinality).
                const namingGeneration = this.stateGeneration;
                this.llmNamingService.nameClusters(clusters, fileContents).then((enriched) => {
                    // #488 baseline mirroring now happens inside the guarded
                    // merge — see applyClusterNameEnrichment.
                    if (!this.applyClusterNameEnrichment(enriched, namingGeneration)) return;

                    // Rebuild feature graphs with LLM-enriched cluster names
                    const refreshedGraphIds: string[] = [];
                    const latestWorking = this.store.getWorking();
                    const svcIds = Object.keys(latestWorking.services ?? {});
                    if (svcIds.length > 1) {
                        for (const svcId of svcIds) {
                            const fg = buildFeatureGraph(latestWorking, undefined, svcId);
                            this.store.updateWorkingGraph(fg.graphId, fg);
                            // #488: keep baseline copy of feature graphs in sync.
                            this.store.updateBaselineGraph(fg.graphId, fg);
                            refreshedGraphIds.push(fg.graphId);
                        }
                    } else {
                        const fg = buildFeatureGraph(latestWorking);
                        this.store.updateWorkingGraph(fg.graphId, fg);
                        this.store.updateBaselineGraph(fg.graphId, fg);
                        refreshedGraphIds.push(fg.graphId);
                    }

                    // #497: rebuild api-list graphs into BOTH baseline and
                    // working using the LLM-enriched cluster data. Without
                    // this, baseline `api-list:cluster:X.meta.files` carries
                    // a stale snapshot from the pre-LLM-naming cluster object,
                    // while working refreshes during cascade rebuild — the
                    // diff probe then fires post-revert with `meta.files`
                    // mismatching on every cluster that the LLM callback
                    // re-shaped. Use working as its own baseline so the api
                    // diffs land as 'unchanged'.
                    for (const cluster of Object.values(enriched)) {
                        const al = buildApiListGraph(cluster, latestWorking, latestWorking);
                        this.store.updateWorkingGraph(al.graphId, al);
                        this.store.updateBaselineGraph(al.graphId, al);
                        refreshedGraphIds.push(al.graphId);
                    }

                    this.store.save();
                    this.notifyRefresh(refreshedGraphIds);
                    this.log(`[Initialize] LLM naming enriched ${Object.keys(enriched).length} clusters — feature graphs rebuilt`);
                }).catch((err: any) => {
                    this.log(`[Initialize] LLM naming failed: ${err?.message ?? err}`);
                });
            }

            this.log(`[Initialize] Phase 2 done — ${Object.keys(services).length} services, ${Object.keys(clusters).length} clusters`);
            this.emitProgress('finalizing', 0.95, 'Finalizing diagrams...');
        } catch (err: any) {
            this.log(`[Initialize] Phase 2 (knowledge graph) failed: ${err?.message ?? err}`);
        }

        // Prune orphaned graphs before saving
        const pruned = this.store.pruneStaleGraphs();
        if (pruned > 0) this.log(`[Initialize] Pruned ${pruned} orphaned graphs`);

        // Issue 105: Log aggregated parse failure warnings
        for (const [ext, count] of parseFailures) {
            if (count > 3) {
                this.log(`[Initialize] WARNING: ${count} .${ext} files failed to parse`);
            }
        }

        // #824 — fill sequence gaps (IaC / unresolved handlers) BEFORE the
        // baseline rotation so the synthetic graphs are part of baseline.
        graphCount += this.ensureSyntheticSequences().length;

        // Set baseline from working
        this.store.setBaselineFromWorking();
        this.store.save();
        const tComplete = Date.now();
        this.emitProgress('complete', 1.0, `Ready — ${scanResults.length} files, ${apiCount} APIs, ${graphCount} diagrams`);

        return {
            fileCount: scanResults.length, apiCount, graphCount, truncated, totalFound,
            parseFailures: Object.fromEntries(parseFailures),
            durations: {
                total_ms: tComplete - t0,
                scan_ms: tAfterScan - t0,
                parse_ms: tAfterParse - tAfterScan,
                build_ms: tComplete - tAfterParse,
                build_phases: buildPhases,
            },
        };
        } finally {
            this.initInFlight = false;
        }
    }

    /**
     * Rebuild diagrams for a single changed file.
     * `content` may be provided when the file is being edited live (unsaved);
     * falls back to reading from disk when not provided.
     */
    async rebuildFile(filePath: string, content?: string, opts?: { deferCascade?: boolean }): Promise<{ graphIds: string[]; changeDetail?: ChangeDetail; durationMs?: number; skippedHeavyCascade?: boolean }> {
        const updatedGraphIds: string[] = [];
        // MULTI-REPO-HANG perf fix — set true when the edited file's structural
        // surface was unchanged and the CPU-bound whole-repo cascade was skipped.
        let skippedHeavyCascade = false;
        // ADR-030: per-rebuild timing for perf observability.
        const tStart = Date.now();
        // #844 — supersede any in-flight async enrichment scheduled by an
        // earlier generation (see applyClusterNameEnrichment).
        this.stateGeneration++;

        // #833 (2026-06-11) — on workspaces with more sub-repos than the
        // RepoStoreRegistry LRU cap, eviction flushes + CLOSES this
        // orchestrator's store while the orchestrator stays referenced by
        // `perRepoOrchestrators`. Every downstream `save()` /
        // `getFileContent()` then silently no-ops against the closed
        // sql.js handle — the live cascade looked dead on the 132-repo
        // serverless monorepo. `reopenIfClosed()` re-inits the handle
        // WITHOUT rehydrating (in-memory state stays the truth) and is a
        // no-op for open or never-loaded stores.
        try {
            await (this.store as { reopenIfClosed?: () => Promise<void> }).reopenIfClosed?.();
        } catch (err: any) {
            this.log(`[Rebuild] store re-open failed (continuing in-memory): ${err?.message ?? err}`);
        }

        try {
            // Skip oversized files unless content is provided (in-memory edits are already bounded).
            // Issue 195: configurable via `codeatlas.maxFileSize`; defaults to 5 MB.
            if (!content) {
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size > this.maxFileSize) {
                        this.log(`[Rebuild] Skipping large file (${Math.round(stat.size / 1024)}KB > ${Math.round(this.maxFileSize / 1024)}KB cap): ${filePath}`);
                        return { graphIds: updatedGraphIds };
                    }
                } catch { return { graphIds: updatedGraphIds }; }
            }
            const code = content ?? fs.readFileSync(filePath, 'utf-8');
            const relativePath = filePath.replace(this.workspaceRoot + '/', '');
            const hash = WorkspaceScanner.hashContent(code);

            // For disk-based events and live in-memory events, skip rebuild if hash unchanged.
            const existing = this.store.getWorking().files[relativePath];
            if (existing && existing.hash === hash) return { graphIds: [] };

            // MULTI-REPO-HANG perf fix (polar) — snapshot the edited file's
            // OLD structural surface key (API records + top-level fn/class set
            // + import specifiers) from the pre-rebuild working snapshot. After
            // the per-file rebuild lands the NEW symbols + apiIndex we recompute
            // it; if unchanged the CPU-bound whole-repo cascade is skipped.
            const oldStructuralKey = this.structuralKeyFor(
                this.store.getWorking(), relativePath, existing?.symbols,
            );

            // #357 keep the workspace router tracker in sync on every rebuild
            // so cross-file route emission stays accurate after edits.
            const trackerLang = filePath.endsWith('.go')
                ? 'go'
                : (filePath.endsWith('.kt') || filePath.endsWith('.kts')) ? 'kotlin' : null;
            if (trackerLang) this.routerTracker.scan(relativePath, code, trackerLang);

            // Update file record
            const fileRecord: FileRecord = {
                path: relativePath,
                hash,
                mtime: Date.now(),
                content: code,            // store updated source
                symbols: { functions: [], variables: [], imports: [] },
            };
            this.store.updateWorkingFile(relativePath, fileRecord);

            // Get old code from baseline for diff (content stored during initialize)
            const baselineFile = this.store.getBaseline().files[relativePath];

            if (isJsOrTs(filePath)) {
                // ── JS/TS: Babel pipeline ──────────────────────────────────────
                // #376: `baselineFile?.content` is undefined after the first
                // save (#354/#355 lazy-content design drops `record.content`
                // from RAM after every save). The actual baseline source still
                // lives in SQLite — fetch via `getFileContent` with the
                // in-memory record as a fast path. Without this fallback,
                // `buildFileGraph` ran in non-diff mode for every cascade
                // rebuild and the L4 file graph never showed function-body
                // edits on its nodes — getCurrentUser stayed `unchanged` even
                // when its body grew by 2 log lines.
                const oldCode: string | undefined =
                    baselineFile?.content
                    ?? this.store.getFileContent('baseline', relativePath);

                const fileGraph = buildFileGraph(code, relativePath, oldCode);

                // #381: `buildFileGraph` re-parses `oldCode` to compute the
                // baseline bodyText for each function. When the baseline
                // content has been redacted at persistence time (#377 turns
                // `password: hashedPassword` into `password: "[REDACTED]"`),
                // the bodyText extracted from the redacted source has the
                // sanitized form. The fresh working bodyText has the
                // original `hashedPassword`. They differ → every function
                // containing a protected property is marked `modified` even
                // when its real body was never edited. The fix: re-evaluate
                // function-node diff status against the AUTHORITATIVE
                // bodyText/signature stored in `baselineFile.symbols` —
                // those were captured at scan time against the original
                // un-redacted source and survive every redaction pass.
                const analysis = collectTopLevelEntities(code, relativePath);
                recomputeFileGraphDiffFromAuthoritativeSymbols(fileGraph, baselineFile, analysis);

                this.store.updateWorkingGraph(fileGraph.graphId, fileGraph);
                updatedGraphIds.push(fileGraph.graphId);

                for (const entity of analysis.entities) {
                    if (entity.kind === 'function') {
                        fileRecord.symbols.functions.push({
                            name: entity.name,
                            kind: entity.kind,
                            span: { start: entity.node?.start ?? 0, end: entity.node?.end ?? 0 },
                            signature: entity.signature,
                            bodyText: entity.bodyText,
                            bodySrc: entity.bodySrc,
                            stableKey: entity.key,
                        });
                    } else if (entity.kind === 'variable') {
                        fileRecord.symbols.variables.push({
                            name: entity.name,
                            kind: entity.kind,
                            span: { start: entity.node?.start ?? 0, end: entity.node?.end ?? 0 },
                            signature: entity.signature,
                            bodyText: entity.bodyText,
                            stableKey: entity.key,
                        });
                    }
                }
                for (const [local, source] of analysis.importsByLocal.entries()) {
                    fileRecord.symbols.imports.push({
                        source,
                        specifiers: [{ local, imported: local }],
                        span: { start: 0, end: 0 },
                        stableKey: `import:${source}`,
                    });
                }
                this.store.updateWorkingFile(relativePath, fileRecord);

                // Track which functions changed (body differs from baseline)
                const changedFnNames = new Set<string>();
                const newFnNames = new Set<string>();
                const liveJsFuncNames = new Set<string>();

                for (const fn of analysis.funcs.values()) {
                    liveJsFuncNames.add(fn.name);
                    if (fn.node) {
                        try {
                            // Issue 347: same class-method slicing as Phase 1 above —
                            // skip past leading decorators by starting at the method's
                            // key identifier and reconstructing the prefix.
                            let fnCode = code.slice(fn.node.start, fn.node.end);
                            if (fn.node.type === 'ClassMethod' || fn.node.type === 'ClassPrivateMethod') {
                                const keyStart = fn.node.key?.start;
                                const sliceFrom = typeof keyStart === 'number' ? keyStart : fn.node.start;
                                const methodSlice = code.slice(sliceFrom, fn.node.end);
                                const prefix = (fn.node.async ? 'async ' : '') + 'function ' + (fn.node.generator ? '*' : '');
                                fnCode = prefix + methodSlice;
                            }
                            const baselineFn = baselineFile?.symbols?.functions?.find(
                                f => f.stableKey === fn.key
                            );
                            // Issue 372: the stored baseline `content` column is REDACTED
                            // (#353 redacts secrets at write time). Function spans, however,
                            // were computed against the original unredacted source. Slicing
                            // redacted content at original spans yields misaligned text —
                            // every byte after the first redaction is shifted by the
                            // length-delta. `buildDiffMap` then fails to parse the
                            // malformed slice, returns null, and the rebuilt flow graph
                            // ends up with every node marked `unchanged` regardless of
                            // what actually changed. Prefer the reconstructed
                            // `signature { bodyText }` form, which is captured at scan
                            // time against the same redacted-source-relative offsets and
                            // is always valid JS/TS. Fall back to slicing only when the
                            // bodyText was not captured (rare edge cases).
                            const baselineContent = baselineFile
                                ? this.store.getFileContent('baseline', relativePath)
                                : undefined;
                            // Issue #423 (ts-apollo): class-method signatures stored by
                            // symbolExtractor lack the `function` keyword. Prepend it so
                            // the reconstructed oldCode parses; bodyText already includes
                            // its braces in some paths so wrap once.
                            // #837 — prefer the raw newline-preserving `bodySrc`
                            // captured at scan time. The bodyText+signature
                            // reconstruction collapses whitespace (normalizeSpace),
                            // which is UNPARSEABLE for semicolon-less code —
                            // buildDiffMap silently returned null and the L5 badge
                            // never appeared for `module.exports.X = (…) => {…}`
                            // handlers. Legacy baselines lack bodySrc → fall through.
                            const oldFnSrcRaw = baselineFn?.bodySrc;
                            const oldFromSrc = oldFnSrcRaw
                                ? (/(\bfunction\b|=>)/.test(oldFnSrcRaw) ? oldFnSrcRaw : `function ${oldFnSrcRaw}`)
                                : undefined;
                            const oldFnCode = oldFromSrc ?? (baselineFn
                                ? ((baselineFn.bodyText && baselineFn.signature)
                                    ? (() => {
                                        let sig = baselineFn.signature;
                                        if (!/\bfunction\b/.test(sig)) {
                                            const asyncMatch = sig.match(/^(\s*async\s+)/);
                                            const rest = asyncMatch ? sig.slice(asyncMatch[0].length) : sig;
                                            sig = (asyncMatch ? 'async ' : '') + 'function ' + rest;
                                        }
                                        const body = baselineFn.bodyText.trim().startsWith('{')
                                            ? baselineFn.bodyText
                                            : `{\n${baselineFn.bodyText}\n}`;
                                        return `${sig} ${body}`;
                                    })()
                                    : (baselineContent && baselineFn.span.start < baselineFn.span.end
                                        ? baselineContent.slice(baselineFn.span.start, baselineFn.span.end)
                                        : undefined))
                                : undefined);
                            // #837 diagnostic — when the L5 badge can't be
                            // computed, say WHY (silent unchanged-stamping
                            // cost a full live-verify cycle to localise).
                            if (!oldFnCode && baselineFn) {
                                this.log(`[rebuildFile] flow diff ${fn.name}: baselineFn matched but oldFnCode irrecoverable (bodyText=${!!baselineFn.bodyText} sig=${!!baselineFn.signature} baselineContent=${!!baselineContent})`);
                            }
                            const flowGraph = buildFlowGraph(fnCode, relativePath, fn.name, oldFnCode, undefined, fn.node.start);
                            const stamped = flowGraph.nodes.some(n => n.diff && n.diff !== 'unchanged');
                            if (oldFnCode && !stamped && fnCode !== oldFnCode) {
                                this.log(`[rebuildFile] flow diff ${fn.name}: oldFnCode present + code differs but ZERO stamped nodes (diff map likely failed to parse)`);
                            }
                            this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                            updatedGraphIds.push(flowGraph.graphId);

                            // Record if function body changed (compare raw slices when possible)
                            const baselineRaw = baselineFn && baselineContent && baselineFn.span.start < baselineFn.span.end
                                ? baselineContent.slice(baselineFn.span.start, baselineFn.span.end)
                                : baselineFn?.bodyText;
                            if (!baselineFn) {
                                newFnNames.add(fn.name);
                                changedFnNames.add(fn.name);
                            } else if (fnCode !== baselineRaw) {
                                changedFnNames.add(fn.name);
                            }
                        } catch {
                            // Skip
                        }
                    }
                }

                // Ghost flow graphs for JS functions that were deleted vs baseline
                const liveJsFlowIds = new Set([...liveJsFuncNames].map(n => `flow:${relativePath}:${n}`));
                const candidateJsFlowIds = new Set<string>();
                baselineFile?.symbols?.functions?.forEach(f => candidateJsFlowIds.add(`flow:${relativePath}:${f.name}`));
                existing?.symbols?.functions?.forEach(f => candidateJsFlowIds.add(`flow:${relativePath}:${f.name}`));

                for (const graphId of candidateJsFlowIds) {
                    if (!liveJsFlowIds.has(graphId) && this.store.getWorking().graphs[graphId]) {
                        const baselineGraph = this.store.getBaseline().graphs[graphId];
                        if (baselineGraph) {
                            this.store.updateWorkingGraph(graphId, makeDeletedGraph(baselineGraph));
                        } else {
                            this.store.removeWorkingGraph(graphId);
                        }
                        updatedGraphIds.push(graphId);
                    }
                }

                // Track deleted functions (in baseline but not in live)
                const deletedFnNames = new Set<string>();
                for (const fn of baselineFile?.symbols?.functions ?? []) {
                    if (!liveJsFuncNames.has(fn.name)) deletedFnNames.add(fn.name);
                }
                // Store for ChangeDetail return
                this._lastChangedFnNames = changedFnNames;
                this._lastNewFnNames = newFnNames;
                this._lastDeletedFnNames = deletedFnNames;

                // Propagate cross-file modifications: rebuild flow graphs in files that
                // import from this file and call any of the changed functions
                if (changedFnNames.size > 0) {
                    const changedBasename = path.basename(relativePath).replace(/\.[^.]+$/, '');
                    const workingFiles = this.store.getWorking().files;
                    for (const [otherPath, otherFile] of Object.entries(workingFiles)) {
                        if (otherPath === relativePath || !isJsOrTs(otherPath)) continue;
                        const importsFromChanged = otherFile.symbols.imports.some((imp) => {
                            const srcNoExt = imp.source.replace(/\.[^.]+$/, '');
                            return srcNoExt.endsWith('/' + changedBasename) || srcNoExt === changedBasename;
                        });
                        if (!importsFromChanged) continue;
                        try {
                            const otherCode = otherFile.content
                                ?? fs.readFileSync(path.join(this.workspaceRoot, otherPath), 'utf-8');
                            const otherAnalysis = collectTopLevelEntities(otherCode, otherPath);
                            const otherBaselineFile = this.store.getBaseline().files[otherPath];
                            // #905 — `.content` is dropped from the in-RAM baseline after
                            // save() (lazy-content); the working file is still on disk (head
                            // checkout) but the baseline is NOT, so a bare `.content` read
                            // yields undefined → the baseline-flat set is empty → EVERY
                            // statement in B's flow marks `added` and the cross-file
                            // propagation diff degrades to non-diff. Re-hydrate from SQLite.
                            const otherBaselineContent = otherBaselineFile?.content
                                ?? this.store.getFileContent('baseline', otherPath);
                            for (const fn of otherAnalysis.funcs.values()) {
                                if (!fn.node) continue;
                                try {
                                    // Issue 347: same class-method slicing as primary path.
                                    let fnCode = otherCode.slice(fn.node.start, fn.node.end);
                                    if (fn.node.type === 'ClassMethod' || fn.node.type === 'ClassPrivateMethod') {
                                        const keyStart = fn.node.key?.start;
                                        const sliceFrom = typeof keyStart === 'number' ? keyStart : fn.node.start;
                                        const methodSlice = otherCode.slice(sliceFrom, fn.node.end);
                                        const prefix = (fn.node.async ? 'async ' : '') + 'function ' + (fn.node.generator ? '*' : '');
                                        fnCode = prefix + methodSlice;
                                    }
                                    const baselineFn = otherBaselineFile?.symbols?.functions?.find(
                                        f => f.stableKey === fn.key
                                    );
                                    // Issue 372: prefer reconstructed signature+bodyText —
                                    // see the primary rebuildFile path comment.
                                    //
                                    // Issue #423 (ts-apollo residual): for class methods, the
                                    // stored `signature` is method-shape ("async reportSchema(args)")
                                    // with NO `function` keyword. The raw reconstruction yields
                                    // invalid JS at the top level — parseFirstFunction can't find
                                    // a function, the baseline-flat set is empty, and EVERY working
                                    // statement gets marked `added`. Mirror the working `fnCode`
                                    // reconstruction (line 1310) by prepending `function` when the
                                    // signature lacks the keyword. Preserves any `async ` prefix.
                                    // #837 — same raw-source preference as the
                                    // primary path above; collapsed bodyText is
                                    // unparseable for semicolon-less code.
                                    const otherOldSrc = baselineFn?.bodySrc;
                                    const otherFromSrc = otherOldSrc
                                        ? (/(\bfunction\b|=>)/.test(otherOldSrc) ? otherOldSrc : `function ${otherOldSrc}`)
                                        : undefined;
                                    const oldFnCode = otherFromSrc ?? (baselineFn
                                        ? ((baselineFn.bodyText && baselineFn.signature)
                                            ? (() => {
                                                let sig = baselineFn.signature;
                                                if (!/\bfunction\b/.test(sig)) {
                                                    const asyncMatch = sig.match(/^(\s*async\s+)/);
                                                    const rest = asyncMatch ? sig.slice(asyncMatch[0].length) : sig;
                                                    sig = (asyncMatch ? 'async ' : '') + 'function ' + rest;
                                                }
                                                // bodyText already includes its braces — wrap once.
                                                const body = baselineFn.bodyText.trim().startsWith('{')
                                                    ? baselineFn.bodyText
                                                    : `{\n${baselineFn.bodyText}\n}`;
                                                return `${sig} ${body}`;
                                            })()
                                            : (otherBaselineContent && baselineFn.span.start < baselineFn.span.end
                                                ? otherBaselineContent.slice(baselineFn.span.start, baselineFn.span.end)
                                                : undefined))
                                        : undefined);
                                    const flowGraph = buildFlowGraph(fnCode, otherPath, fn.name, oldFnCode, changedFnNames, fn.node.start);
                                    this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                                    updatedGraphIds.push(flowGraph.graphId);
                                } catch {
                                    // Skip
                                }
                            }
                        } catch {
                            // Skip
                        }
                    }
                }

                const apis = detectApis(code, relativePath);
                const rebuildLang: 'typescript' | 'javascript' = /\.tsx?$/.test(filePath) ? 'typescript' : 'javascript';
                // #830 (2026-06-11): mirror the INIT path's tuple-keyed dedup
                // (init pipeline above — "Dedup is by (method, route,
                // filePath)") + the Issue-414 `${…}` template-route filter.
                // Without it, every rebuild of an Express file added a
                // phantom sibling record per route whose handlerName is the
                // regex detector's nearest-identifier fallback ('express'),
                // and the duplicate's surface hash poisoned the cross-repo
                // edge diff (#817) on every producer save.
                const rebuildRouteKey = (a: { method: string; route: string; filePath: string }) =>
                    `${a.method}:${a.route}::${a.filePath}`;
                const rebuildKnownRouteKeys = new Set(apis.map(rebuildRouteKey));
                const rebuildFrameworkApis = detectFrameworkApis(code, relativePath, rebuildLang)
                    .filter(a => !rebuildKnownRouteKeys.has(rebuildRouteKey(a)) && !/\$\{/.test(a.route));
                const rebuildMobileItems = detectMobileItems(code, relativePath, rebuildLang);
                // Issue #423 Pattern A: ALL three detectors (Express + framework
                // + mobile) ran during the initial scan (syncOrchestrator.ts:577,
                // 591) and seeded working.apiIndex. The rebuild path historically
                // only kept `apis` (Express output) and used IT alone for the
                // removal-loop comparison below — so any api added by the
                // framework or mobile detector got silently REMOVED on every
                // rebuildFile. That dropped one api per cascade for repos like
                // js-nextjs (SCREEN apis from layout.tsx vanish on edit),
                // js-fastify (auto-Hono routes), ts-nestjs (decorator routes),
                // etc., which then bubbled up as L1 service.exposedApiCount
                // differing baseline↔working → L1 microservice graph stuck at
                // `modified` post-revert.
                //
                // Fix: union all three detector outputs into `allRebuiltApis`
                // and use that as the source-of-truth for the removal loop.
                const allRebuiltApis: import('../graph/graphTypes').ApiRecord[] = [...apis, ...rebuildFrameworkApis, ...rebuildMobileItems];
                for (const item of rebuildMobileItems) {
                    this.store.updateWorkingApi(item.apiId, item);
                }
                for (const item of rebuildFrameworkApis) {
                    this.store.updateWorkingApi(item.apiId, item);
                }
                const working = this.store.getWorking();
                // Map from graphId → { seqFilePath, handlerName? }
                const seqGraphsToRebuild = new Map<string, { seqFilePath: string; handlerName?: string }>();
                const candidateJsSeqIds = new Set<string>();

                // Add baseline APIs to candidate sequences
                for (const api of Object.values(this.store.getBaseline().apiIndex)) {
                    if (api.filePath === relativePath) candidateJsSeqIds.add(`sequence:${relativePath}:${api.handlerName}`);
                }

                // Remove APIs no longer in this file.
                // Compare by handlerName (not apiId) so patched routes don't block removal.
                // Issue #423: compare against the UNION of all detectors — Express,
                // framework, and mobile — so an api added by one detector isn't
                // falsely "missing" because it wasn't in another detector's output.
                //
                // Issue #423 (anon-handler offset dedup): anonymous-handler apiIds
                // encode the byte offset (`anonymous@GET:/@1227`). When an edit
                // shifts offsets, a SAME-shape handler reappears at a new apiId
                // (`anonymous@GET:/@1251`) while the OLD entry stays in
                // working.apiIndex (handlerName matches → not removed). After
                // revert, both the @oldoffset (genuine) AND @midoffset (phantom
                // from edit step) entries persist → working count > baseline
                // count → L2b shows phantom 'added' → L2a/L1 bubble. For
                // anonymous handlers, match by FULL apiId (which includes the
                // offset) so phantoms get cleaned up. Named handlers keep the
                // handlerName-only match for mount-prefix patch survival.
                for (const [apiId, api] of Object.entries(working.apiIndex)) {
                    if (api.filePath === relativePath) {
                        candidateJsSeqIds.add(`sequence:${relativePath}:${api.handlerName}`);
                        const isAnonymous = typeof api.handlerName === 'string' && api.handlerName.startsWith('anonymous@');
                        const stillPresent = isAnonymous
                            ? allRebuiltApis.some(a => a.apiId === apiId)
                            : allRebuiltApis.some(a => a.handlerName === api.handlerName);
                        if (!stillPresent) {
                            this.store.removeWorkingApi(apiId);
                        }
                    }
                }

                if (apis.length > 0) {
                    for (const api of apis) {
                        this.store.updateWorkingApi(api.apiId, api);
                    }
                }

                // Re-apply mount-prefix patching across entire apiIndex after any JS file changes
                // (the changed file may be an entry file whose app.use() mounts changed, or a
                // sub-router whose routes need to be re-prefixed from a sibling entry file)
                try {
                    const latestWorking = this.store.getWorking();
                    const jsFileContents = new Map<string, string>();
                    for (const [relPath, rec] of Object.entries(latestWorking.files)) {
                        if (!isJsOrTs(relPath)) continue;
                        // BUG-EXPLORE-1 / lazy-content trap (#354/#355): `rec.content`
                        // is dropped after every save, so during a single-file rebuild
                        // ONLY the just-rebuilt file still has it in memory. The
                        // mount-declaring entry file (e.g. `app.ts` with
                        // `app.use('/api', router)`) would be missing → applyMountPrefixes
                        // can't see the mount → the rebuilt sub-router's routes lose their
                        // prefix (`/api/tags` → `/tags`), so their apiId no longer matches
                        // the prefixed baseline and every route in the edited file is
                        // falsely flagged `added` (and never returns to clean on revert).
                        // Fall back to the lazily-persisted content.
                        const content = rec.content ?? this.store.getFileContent('working', relPath);
                        if (content) jsFileContents.set(relPath, content);
                    }
                    const patchedIndex = applyMountPrefixes(latestWorking.apiIndex, jsFileContents, this.workspaceRoot);
                    this.store.replaceWorkingApiIndex(patchedIndex);
                } catch {
                    // Mount prefix patching is best-effort — continue without it
                }

                // #880 — re-anchor Rails resource routes onto their controllers
                // (same pass as init) so the HEAD/working snapshot matches the
                // baseline re-anchoring → no diff churn, and a controller-only
                // PR's changed file matches its route entry point.
                try {
                    const lw = this.store.getWorking();
                    const lwKeys = Object.keys(lw.files);
                    let reanchored = resolveRailsControllerAnchors(lw.apiIndex, lwKeys);
                    reanchored = resolveDjangoViewAnchors(reanchored, lwKeys); // BUG-EXP-11
                    reanchored = resolveGoHandlerAnchors(reanchored, lw.files); // TICKET-DETECT-3
                    if (reanchored !== lw.apiIndex) this.store.replaceWorkingApiIndex(reanchored);
                } catch {
                    // best-effort
                }

                // Use patched apiIndex for sequence graph rebuild decisions
                const patchedApis = apis.length > 0
                    ? apis.map(a => this.store.getWorking().apiIndex[a.apiId]
                        ?? Object.values(this.store.getWorking().apiIndex).find(p => p.filePath === a.filePath && p.handlerName === a.handlerName)
                        ?? a)
                    : [];

                if (patchedApis.length > 0) {
                    const handlersSeen = new Set<string>();
                    for (const api of patchedApis) {
                        if (handlersSeen.has(api.handlerName)) continue;
                        handlersSeen.add(api.handlerName);
                        const graphId = `sequence:${relativePath}:${api.handlerName}`;
                        seqGraphsToRebuild.set(graphId, { seqFilePath: relativePath, handlerName: api.handlerName });
                    }
                }

                // Ghost sequence graphs for handlers no longer detected in this JS file
                const liveHandlers = new Set(apis.map(a => `sequence:${relativePath}:${a.handlerName}`));
                for (const graphId of candidateJsSeqIds) {
                    if (!liveHandlers.has(graphId) && working.graphs[graphId]) {
                        const baselineGraph = this.store.getBaseline().graphs[graphId];
                        if (baselineGraph) {
                            // Preserve as ghost so webview shows the deleted diagram in red
                            this.store.updateWorkingGraph(graphId, makeDeletedGraph(baselineGraph));
                        } else {
                            this.store.removeWorkingGraph(graphId);
                        }
                        updatedGraphIds.push(graphId);
                    }
                }

                // #907 — only `sequence:` graphs can carry a cross-file node
                // dependency on the changed file. The old `forEachGraph` JSON.parsed
                // EVERY working graph (the whole corpus) on each debounced save just
                // to filter by `type === 'sequence'` — so the lazy-graph memory win
                // was paid back as CPU/GC per keystroke on large repos. Enumerate ids
                // via the underlying LazyGraphMap's `.keys()` (NO hydration — note
                // `Object.keys()` on the proxy hydrates every key through the
                // `getOwnPropertyDescriptor` trap, so it can't be used here), gate on
                // the `sequence:` prefix, and hydrate ONLY the candidate sequence
                // graphs (indexed proxy access materializes one row at a time).
                const lazyMap = getLazyGraphMap(working.graphs);
                const allGraphIds = lazyMap ? lazyMap.keys() : Object.keys(working.graphs);
                for (const graphId of allGraphIds) {
                    if (!graphId.startsWith('sequence:')) continue;
                    // Skip sequence graphs owned by this file — they were already
                    // ghosted or rebuilt above (don't overwrite the new ghost graphs).
                    if (seqGraphsToRebuild.has(graphId)) continue;
                    if (graphId.startsWith(`sequence:${relativePath}:`)) continue;
                    const graph = working.graphs[graphId];
                    if (!graph || graph.type !== 'sequence') continue;
                    const dependsOnFile = graph.nodes.some(n => n.anchor?.filePath === relativePath);
                    if (!dependsOnFile) continue;
                    const meta = graph.meta as { filePath?: string; handlerName?: string } | undefined;
                    // Extract file path from graphId — handler names may contain colons (e.g. anonymous@GET:/route)
                    let seqFilePath = meta?.filePath || '';
                    if (!seqFilePath) {
                        const rest = graphId.replace(/^sequence:/, '');
                        const extMatch = rest.match(/^(.+\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyw|java|kt|kts|go|rs|cs|php|rb|swift|dart)):/);
                        seqFilePath = extMatch ? extMatch[1] : rest.split(':')[0];
                    }
                    seqGraphsToRebuild.set(graphId, { seqFilePath, handlerName: meta?.handlerName });
                }

                for (const [, { seqFilePath, handlerName }] of seqGraphsToRebuild) {
                    let seqCode = seqFilePath === relativePath ? code : this.store.getFileContent('working', seqFilePath);

                    if (!seqCode) {
                        try {
                            const fullPath = path.join(this.workspaceRoot, seqFilePath);
                            if (fs.existsSync(fullPath)) {
                                seqCode = fs.readFileSync(fullPath, 'utf-8');
                            }
                        } catch {
                            // Disk read failed (file deleted between exists()
                            // and readFileSync, permissions, etc.). The
                            // sequence build below skips when seqCode is
                            // undefined — silent recovery is intentional.
                        }
                    }

                    if (seqCode) {
                        const seqOldCode = this.store.getFileContent('baseline', seqFilePath);
                        let seqGraph = buildSequenceGraph(seqCode, seqFilePath, seqOldCode, this.sequenceResolver, this.oldSequenceResolver, handlerName, this.store.getWorking().files, this.lspFallbackResolver ?? undefined);
                        // Issue 335: skip empty sequence graphs.
                        if (seqGraph.nodes.length === 0) continue;
                        // UX-30: weave middleware participants for the
                        // matching api (if any). Re-resolve the api via
                        // handlerName because this branch doesn't have a
                        // direct `api` handle.
                        const matchedApi = Object.values(this.store.getWorking().apiIndex ?? {}).find(
                            (a: any) => a.handlerName === handlerName && a.filePath === seqFilePath,
                        ) as any;
                        const mws2 = matchedApi?.meta?.middlewares;
                        if (mws2 && mws2.length > 0) {
                            seqGraph = weaveMiddlewareParticipants(seqGraph, mws2, { routeKey: matchedApi.apiId });
                        }
                        this.store.updateWorkingGraph(seqGraph.graphId, seqGraph);
                        updatedGraphIds.push(seqGraph.graphId);
                    }
                }
            } else {
                // ── Non-JS: tree-sitter pipeline ───────────────────────────────
                const language = detectLanguage(filePath);
                if (language) {
                    const analysis = await extractFileSymbolsMultiLang(code, relativePath, language);
                    const apis = detectFrameworkApis(code, relativePath, language);
                    const mobileItems = detectMobileItems(code, relativePath, language);

                    for (const api of [...apis, ...mobileItems]) {
                        this.store.updateWorkingApi(api.apiId, api);
                    }

                    // Issue #423 (non-JS anon-handler offset dedup): mirror the JS
                    // path's removal step. Without this, Go/Ruby/etc. files with
                    // anonymous-handler routes (`@<offset>` in apiId) accumulate
                    // phantom apis as edits shift byte offsets — never cleaned up
                    // because nothing in the non-JS path removed stale entries.
                    // Same heuristic as JS: anonymous handlers match by full apiId
                    // (offset-aware); named handlers match by handlerName (mount-
                    // prefix-patch friendly).
                    const allRebuiltNonJsApis = [...apis, ...mobileItems];
                    for (const [apiId, api] of Object.entries(this.store.getWorking().apiIndex)) {
                        if (api.filePath !== relativePath) continue;
                        const isAnonymous = typeof api.handlerName === 'string' && api.handlerName.startsWith('anonymous@');
                        const stillPresent = isAnonymous
                            ? allRebuiltNonJsApis.some(a => a.apiId === apiId)
                            : allRebuiltNonJsApis.some(a => a.handlerName === api.handlerName);
                        if (!stillPresent) {
                            this.store.removeWorkingApi(apiId);
                        }
                    }

                    // #452-A: re-emit cross-file router-tracker routes for the
                    // edited file (Go/Kotlin). The per-file detector above
                    // produces bare per-file routes (e.g., `/feed`, `/:cityID`),
                    // but the workspace tracker also resolves cross-file
                    // mount-prefix routes (e.g., `/api/v1/cities/:cityID@handler.go`
                    // because `app.Mount("/api/v1/cities", cityRouter)` lives
                    // in main.go). At init both forms get emitted in the
                    // resolved-routes pass and the per-file unprefixed twin
                    // gets dropped. On cascade, the non-JS rebuild's
                    // removal loop (above) drops the cross-file form
                    // (handlerName matched but not in per-file output) and
                    // re-adds only the per-file form. Net: working diverges
                    // from baseline on every Go/Kotlin file edit even after
                    // revert. Mirror init's resolve+drop here.
                    const trackerLangForFile = filePath.endsWith('.go')
                        ? 'go'
                        : (filePath.endsWith('.kt') || filePath.endsWith('.kts')) ? 'kotlin' : null;
                    if (trackerLangForFile) {
                        const handlerKeyToApiId = new Map<string, string>();
                        for (const api of Object.values(this.store.getWorking().apiIndex)) {
                            if (api.filePath !== relativePath) continue;
                            handlerKeyToApiId.set(`${api.method}::${api.handlerName}::${api.filePath}`, api.apiId);
                        }
                        for (const r of this.routerTracker.resolvedRoutes()) {
                            if (r.filePath !== relativePath) continue;
                            const apiId = `${r.method}:${r.path}@${r.filePath}`;
                            const handlerKey = `${r.method}::${r.handlerName}::${r.filePath}`;
                            const twinId = handlerKeyToApiId.get(handlerKey);
                            if (twinId && twinId !== apiId) {
                                const twin = this.store.getWorking().apiIndex[twinId];
                                if (twin && (r.path.endsWith(twin.route) || r.path === twin.route)) {
                                    this.store.removeWorkingApi(twinId);
                                }
                            }
                            if (this.store.getWorking().apiIndex[apiId]) continue;
                            this.store.updateWorkingApi(apiId, {
                                apiId,
                                method: r.method,
                                route: r.path,
                                rawRoute: r.path,
                                handlerName: r.handlerName,
                                filePath: r.filePath,
                                anchor: { filePath: r.filePath },
                            });
                        }
                    }

                    // Build baseline lookup for non-JS diff
                    const baselineFile = this.store.getBaseline().files[relativePath];
                    const baselineSymbols: BaselineSymbols | undefined = baselineFile ? {
                        functions: (baselineFile.symbols.functions ?? []).map(f => ({
                            name: f.name,
                            signature: f.signature,
                            bodyText: f.bodyText,
                            stableKey: f.stableKey || `function:${f.name}`,
                        })),
                        variables: (baselineFile.symbols.variables ?? []).map(v => ({
                            name: v.name,
                            bodyText: v.bodyText,
                            stableKey: v.stableKey || `variable:${v.name}`,
                        })),
                        imports: (baselineFile.symbols.imports ?? []).map(i => ({
                            source: i.source,
                            stableKey: i.stableKey || `import:${i.source}`,
                        })),
                    } : undefined;

                    const fileGraph = buildFileGraphFromAnalysis(analysis, relativePath, baselineSymbols);
                    // Issue #395: apply the same authoritative-symbols recompute
                    // pass to tree-sitter-built file graphs that the JS path
                    // runs at line 1146. Without this, non-JS section labels
                    // stay bare ("Functions") instead of carrying the
                    // "(N changed + M)" count the JS path produces.
                    // `recomputeFileGraphDiffFromAuthoritativeSymbols` accepts
                    // any analysis with an `entities[]` field — both JS
                    // (symbolExtractor) and tree-sitter (treeSitterExtractor)
                    // FileAnalysis types match structurally.
                    recomputeFileGraphDiffFromAuthoritativeSymbols(
                        fileGraph,
                        baselineFile,
                        analysis as any,
                    );
                    this.store.updateWorkingGraph(fileGraph.graphId, fileGraph);
                    updatedGraphIds.push(fileGraph.graphId);

                    for (const entity of analysis.entities) {
                        if (entity.kind === 'function' || entity.kind === 'class') {
                            fileRecord.symbols.functions.push({
                                name: entity.name,
                                kind: entity.kind === 'class' ? 'class' : 'function',
                                span: { start: 0, end: 0 },
                                signature: entity.signature,
                                bodyText: entity.bodyText,
                                bodySrc: entity.bodySrc,
                                stableKey: entity.key,
                                calls: Array.from(entity.calls || []),
                                memberCalls: entity.memberCalls
                                    ? Object.fromEntries([...entity.memberCalls.entries()].map(([k, v]) => [k, Array.from(v)]))
                                    : undefined,
                                localVarTypes: entity.localVarTypes
                                    ? Object.fromEntries(entity.localVarTypes.entries())
                                    : undefined,
                                extendsClass: entity.extendsClass,
                                implementsInterfaces: entity.implementsInterfaces,
                            });
                        } else if (entity.kind === 'variable') {
                            fileRecord.symbols.variables.push({
                                name: entity.name,
                                kind: entity.kind,
                                span: { start: 0, end: 0 },
                                signature: entity.signature,
                                bodyText: entity.bodyText,
                                stableKey: entity.key,
                            });
                        }
                    }
                    // Issue #720 — see init path for the same fix. Iterate
                    // `analysis.entities` so duplicate-local imports survive.
                    for (const entity of analysis.entities) {
                        if (entity.kind !== 'import') continue;
                        const source = extractImportSourceFromKey(entity.key);
                        fileRecord.symbols.imports.push({
                            source,
                            specifiers: [{ local: entity.name, imported: entity.name }],
                            span: { start: 0, end: 0 },
                            stableKey: entity.key,
                        });
                    }
                    fileRecord.symbols.injectedDeps = analysis.injectedDeps
                        ? Object.fromEntries(analysis.injectedDeps.entries())
                        : undefined;
                    this.store.updateWorkingFile(relativePath, fileRecord);

                    // Build baseline import map for non-JS sequence diff (used for deleted-participant detection)
                    const baselineImportMap = baselineFile
                        ? new Map([
                            ...(baselineFile.symbols.imports ?? []).map(i => {
                                const local = i.specifiers?.[0]?.local ?? i.source;
                                return [local, i.source] as [string, string];
                            }),
                            ...Object.entries(baselineFile.symbols.injectedDeps ?? {}),
                        ])
                        : undefined;

                    // Build the set of ALL participant body-paths from the baseline sequence graph.
                    // This covers injected-dep participants and BFS-discovered participants from
                    // deeper service files, which are NOT in the file's own imports/injectedDeps.
                    const buildBaselineParticipantBodies = (handlerName: string): Set<string> | undefined => {
                        const baselineGraphId = `sequence:${relativePath}:${handlerName}`;
                        const baselineSeqGraph = this.store.getBaseline().graphs[baselineGraphId];
                        if (!baselineSeqGraph) return undefined;
                        return new Set(
                            baselineSeqGraph.nodes
                                .filter(n => n.type === 'participant' && n.body)
                                .map(n => n.body!)
                        );
                    };

                    // Build set of handler names whose body changed vs baseline
                    const modifiedHandlerNames = new Set<string>();
                    if (baselineFile) {
                        for (const entity of analysis.entities) {
                            if (entity.kind !== 'function' && entity.kind !== 'class') continue;
                            const baselineFunc = baselineSymbols?.functions.find(f => f.stableKey === entity.key);
                            if (baselineFunc && baselineFunc.bodyText !== entity.bodyText) {
                                modifiedHandlerNames.add(entity.name);
                            }
                        }
                    }

                    // Build per-handler sequence graphs for non-JS files
                    const nonJsHandlersSeen = new Set<string>();
                    if (apis.length > 0) {
                        for (const api of apis) {
                            if (nonJsHandlersSeen.has(api.handlerName)) continue;
                            nonJsHandlersSeen.add(api.handlerName);
                            const resolver = (importPath: string, currentFilePath?: string) => {
                                // BUG-L5-WRONGFILE: honour the FULL module path to
                                // disambiguate same-basename files (see resolveNonJsModulePath).
                                const files = Object.keys(this.store.getWorking().files);
                                const filePath = resolveNonJsModulePath(importPath, currentFilePath, files);
                                return filePath ? { code: '', filePath } : undefined;
                            };

                            const seqGraph = buildSequenceGraphFromAnalysis(
                                { ...analysis, funcs: analysis.funcs }, relativePath, apis, api.handlerName,
                                baselineImportMap,
                                modifiedHandlerNames.size > 0 ? modifiedHandlerNames : undefined,
                                resolver,
                                this.store.getWorking().files,
                                buildBaselineParticipantBodies(api.handlerName),
                                this.lspFallbackResolver ?? undefined,
                            );
                            // Issue 335: skip empty sequence graphs.
                            if (seqGraph.nodes.length === 0) continue;
                            this.store.updateWorkingGraph(seqGraph.graphId, seqGraph);
                            updatedGraphIds.push(seqGraph.graphId);
                        }
                    }

                    // Ghost sequence graphs for non-JS handlers removed from this file
                    const liveNonJsSeqIds = new Set(
                        [...nonJsHandlersSeen].map(h => `sequence:${relativePath}:${h}`)
                    );
                    const candidateNonJsSeqIds = new Set<string>();
                    for (const api of Object.values(this.store.getBaseline().apiIndex)) {
                        if (api.filePath === relativePath) candidateNonJsSeqIds.add(`sequence:${relativePath}:${api.handlerName}`);
                    }
                    for (const api of Object.values(this.store.getWorking().apiIndex)) {
                        if (api.filePath === relativePath) candidateNonJsSeqIds.add(`sequence:${relativePath}:${api.handlerName}`);
                    }

                    for (const graphId of candidateNonJsSeqIds) {
                        if (!liveNonJsSeqIds.has(graphId) && this.store.getWorking().graphs[graphId]) {
                            const baselineGraph = this.store.getBaseline().graphs[graphId];
                            if (baselineGraph) {
                                this.store.updateWorkingGraph(graphId, makeDeletedGraph(baselineGraph));
                            } else {
                                this.store.removeWorkingGraph(graphId);
                            }
                            updatedGraphIds.push(graphId);
                        }
                    }

                    // Build per-method flow graphs for non-JS files
                    const liveNonJsFuncNames = new Set<string>();
                    for (const entity of analysis.entities) {
                        if (entity.kind === 'function' || entity.kind === 'class') {
                            liveNonJsFuncNames.add(entity.name);
                        }
                        if (entity.kind !== 'function') continue;
                        try {
                            const baselineFunc = baselineSymbols?.functions.find(f => f.stableKey === entity.key);
                            const baselineBodyText = baselineFunc?.bodyText;
                            // #445-A: Dart regex fallback emits entities without tree-sitter
                            // nodes — use the body-text builder so Flutter files still get
                            // per-function L5 flow graphs on cascade rebuild.
                            let flowGraph;
                            if (entity.node) {
                                flowGraph = buildFlowGraphFromNode(entity.node, code, relativePath, entity.name, baselineBodyText);
                            } else if (entity.bodyText) {
                                flowGraph = buildFlowGraphFromBodyText(entity.bodyText, relativePath, entity.name, baselineBodyText);
                            } else {
                                continue;
                            }
                            // Append ghost nodes for statements deleted vs baseline
                            const baselineFlowGraph = this.store.getBaseline().graphs[flowGraph.graphId];
                            if (baselineFlowGraph) {
                                appendNonJsDeletedNodes(flowGraph, baselineFlowGraph);
                            }
                            this.store.updateWorkingGraph(flowGraph.graphId, flowGraph);
                            updatedGraphIds.push(flowGraph.graphId);
                        } catch {
                            // Skip
                        }
                    }

                    // Ghost flow graphs for non-JS functions deleted vs baseline
                    const liveNonJsFlowIds = new Set(
                        [...liveNonJsFuncNames].map(n => `flow:${relativePath}:${n}`)
                    );
                    const candidateNonJsFlowIds = new Set<string>();
                    baselineSymbols?.functions?.forEach(f => candidateNonJsFlowIds.add(`flow:${relativePath}:${f.name}`));
                    existing?.symbols?.functions?.forEach(f => candidateNonJsFlowIds.add(`flow:${relativePath}:${f.name}`));

                    for (const graphId of candidateNonJsFlowIds) {
                        if (!liveNonJsFlowIds.has(graphId) && this.store.getWorking().graphs[graphId]) {
                            const baselineGraph = this.store.getBaseline().graphs[graphId];
                            if (baselineGraph) {
                                this.store.updateWorkingGraph(graphId, makeDeletedGraph(baselineGraph));
                            } else {
                                this.store.removeWorkingGraph(graphId);
                            }
                            updatedGraphIds.push(graphId);
                        }
                    }
                }
            }

            // Rebuild feature and microservice diagrams. The 500ms debounce
            // in `queueEvent` already throttles per-keystroke runs, so it's
            // safe to always cascade — including for in-editor live-edit
            // events that pass content. L2B-4 (2026-06-07): previously this
            // block was gated on `!content`, so VS Code's
            // `onDidChangeTextDocument` (which always provides content)
            // skipped the L2b/L2a/L1 cascade. The L4 file graph would mark
            // a modified function but the cluster + service nodes stayed
            // stuck at unchanged until the user manually re-init'd.
            // #871 — `deferCascade` skips this whole-workspace recompute
            // (callgraph + services + Louvain clusters + L2a feature + L1
            // microservice + sequence/api-list cascade). Callers resyncing a
            // BATCH of files (review-pr) defer it on every file but the last,
            // so the recompute runs ONCE instead of per-file (~12× → 1× on a
            // multi-file PR). The final non-deferred call re-annotates ALL live
            // graphs, so the deferred files' sequence diffs are still correct.
            // Default false → the live extension's per-save cascade is unchanged.
            //
            // MULTI-REPO-HANG (polar): the whole-(sub)repo cascade below
            // (buildCallGraph + detectServices + Louvain detectCommunities +
            // per-file getFileContent SQLite reads + microservice/domain/health
            // rebuilds) is CPU-bound and runs synchronously on the event loop.
            // On a large sub-repo (e.g. polar/server ≈ 1.6k Python files) it can
            // peg a core for minutes. The ONLY durable persistence of the edited
            // file's working record + L4/L5 graphs happens in the caller's
            // `store.save()` AFTER `rebuildFile()` resolves, so a slow/hung
            // cascade meant the on-disk `working` snapshot kept the pre-edit hash
            // → the L1 showed "No changes" for a real edit. Persist the edited
            // file's working state NOW (before the heavy whole-repo recompute) so
            // the edit is durable regardless of how long the cascade takes.
            // Skipped on the batched `deferCascade` path (review-pr) to avoid a
            // per-file save; that path saves once at the end.
            if (!opts?.deferCascade) {
                try { this.store.save(); }
                catch (saveErr: any) { this.log(`[Rebuild] pre-cascade save failed: ${saveErr?.message ?? saveErr}`); }
            }

            // MULTI-REPO-HANG perf fix (polar) — recompute the edited file's
            // structural surface key from the NOW-updated working snapshot (its
            // symbols + apiIndex landed in the per-file rebuild above). If it
            // equals the pre-edit key, the set that feeds services / clusters /
            // microservice / domain / health did NOT change for this file, so
            // the whole-repo detection would produce an identical result at
            // ~2-min CPU cost. Skip it. A pure body edit or a new PRIVATE local
            // helper (no new top-level symbol / API / import) hits this path;
            // adding an endpoint / top-level class / import edge does not.
            // The `deferCascade` batch path (review-pr) always runs the heavy
            // recompute once at the end, so we only gate the live per-save path.
            if (!opts?.deferCascade) {
                const newWorking = this.store.getWorking();
                const newStructuralKey = this.structuralKeyFor(
                    newWorking, relativePath, newWorking.files[relativePath]?.symbols,
                );
                skippedHeavyCascade = newStructuralKey === oldStructuralKey;
                if (skippedHeavyCascade) {
                    this.log(`[Rebuild] structural surface unchanged for ${relativePath} — skipping whole-repo cascade`);
                }
            }

            if (!opts?.deferCascade && !skippedHeavyCascade) {
                try {
                    // Yield a macrotask so the pre-cascade save flushes and the
                    // event loop drains queued I/O (browser reads, other repos'
                    // saves) before the CPU-bound whole-repo recompute begins.
                    await new Promise((r) => setImmediate(r));
                    const latestWorking = this.store.getWorking();
                    const baselineSnapshot = this.store.getBaseline();

                    // #775 (2026-06-06) — pass content provider for call-graph
                    // rebuild so cluster `internalCallCount` reflects real
                    // cross-file edges (otherwise zero post-save).
                    const getWorkingContent = (fp: string) => this.store.getFileContent('working', fp);
                    const callGraph = buildCallGraph(latestWorking, this.lspFallbackResolver ?? undefined, getWorkingContent);
                    this.store.updateWorkingCallGraph(callGraph.serialize());

                    // Services first so clusters can be tagged with serviceId.
                    // Cascade rebuild runs AFTER save, so FileRecord.content is dropped
                    // (#354 — Body-finder gap closure for kotlin-ktor / rust-actix / rust-axum / rust-rocket). Pass DB-backed providers so DB / queue / cache infra is
                    // still detected — otherwise the L1 infra layer disappears post-save.
                    const getBaselineContent = (fp: string) => this.store.getFileContent('baseline', fp);
                    // #816 Phase 5 — scope to this sub-repo's tree (same
                    // rationale as Phase 2 init). Single-repo unchanged.
                    const services = detectServices(this.repoRoot, latestWorking, getWorkingContent);
                    this.store.updateWorkingServices(services);

                    // v2 phase 3 #484 — refresh per-screen records on every
                    // cascade rebuild so renames/additions/deletions land in L2a.
                    const screens = detectScreens(latestWorking, services, getWorkingContent);
                    this.store.updateWorkingScreens(screens);
                    // v2 phase 4 #485 — refresh per-screen L2b content
                    // alongside the screen list. Same screen-content
                    // graph builder runs here so the L2b panel sees
                    // additions / removals from edits in the cascade.
                    const getXmlLayout = this.buildAndroidXmlLayoutResolver();
                    const screenItems = extractScreenContents(latestWorking, screens, getWorkingContent, getXmlLayout);
                    this.store.updateWorkingScreenItems(screenItems);
                    for (const screen of Object.values(screens)) {
                        const itemsForScreen = screenItems[screen.screenId] ?? [];
                        const scg = buildScreenContentGraph(screen, itemsForScreen);
                        this.store.updateWorkingGraph(scg.graphId, scg);
                        // v2 phase 5 #486 — refresh per-item L3 graphs
                        // on cascade so handler edits flip from
                        // unchanged → modified in the L3 view.
                        const owningService = services[screen.serviceId];
                        const isMobile = owningService?.category === 'mobile';
                        const builder = isMobile ? buildMobileDataFlowGraph : buildFrontendDataFlowGraph;
                        const screenContent = latestWorking.files[screen.filePath]?.content
                            ?? getWorkingContent(screen.filePath) ?? '';
                        for (const item of itemsForScreen) {
                            const flow = builder(screen, item, { content: screenContent, apiIndex: latestWorking.apiIndex });
                            if (flow) this.store.updateWorkingGraph(flow.graphId, flow);
                        }
                    }

                    const baselineClusters = this.store.getBaseline().clusters;
                    const clusters = detectCommunities(latestWorking, callGraph, services, baselineClusters);
                    this.store.updateWorkingClusters(clusters);

                    // LLM naming for new/changed clusters (non-blocking)
                    if (this.llmNamingEnabled && this.llmNamingService?.isConfigured) {
                        const fileContents: Record<string, string> = {};
                        for (const [fp, rec] of Object.entries(latestWorking.files)) {
                            if (rec.content) fileContents[fp] = rec.content;
                        }
                        // #844 — same generation guard + names-only merge as
                        // the init path; see applyClusterNameEnrichment.
                        const cascadeNamingGeneration = this.stateGeneration;
                        this.llmNamingService.nameClusters(clusters, fileContents).then((enriched) => {
                            if (!this.applyClusterNameEnrichment(enriched, cascadeNamingGeneration)) return;

                            // Rebuild feature graphs with enriched names
                            const refreshIds: string[] = [];
                            const w = this.store.getWorking();
                            const sIds = Object.keys(w.services ?? {});
                            if (sIds.length > 1) {
                                for (const sId of sIds) {
                                    const fg = buildFeatureGraph(w, this.store.getBaseline(), sId);
                                    this.store.updateWorkingGraph(fg.graphId, fg);
                                    this.store.updateBaselineGraph(fg.graphId, fg);
                                    refreshIds.push(fg.graphId);
                                }
                            } else {
                                const fg = buildFeatureGraph(w, this.store.getBaseline());
                                this.store.updateWorkingGraph(fg.graphId, fg);
                                this.store.updateBaselineGraph(fg.graphId, fg);
                                refreshIds.push(fg.graphId);
                            }
                            // #497: rebuild api-list graphs into baseline so
                            // `meta.files` matches the enriched cluster's
                            // `files[]`. Working api-list was already refreshed
                            // earlier in the cascade rebuild (line ~1988); the
                            // baseline copy stayed at the pre-LLM snapshot
                            // (file count drifts by 1-2 entries depending on
                            // how Louvain reshuffled). Without this refresh,
                            // post-revert baseline-vs-working diff fires on
                            // every cluster the LLM callback touched.
                            const latestWorking = this.store.getWorking();
                            const realBaseline = this.store.getBaseline();
                            for (const cluster of Object.values(enriched)) {
                                // L1-C2 (2026-06-07): build TWO graphs — one
                                // for working (against the REAL baseline so
                                // per-API diff annotations land) and one for
                                // baseline (against working=working so post-
                                // revert it byte-equals the working copy). The
                                // prior single-graph approach wiped the L2b
                                // diff state, which suppressed the L2b → L2a
                                // → L1 cascade and left the user staring at
                                // an unchanged L1 chip after editing an
                                // entity whose cluster had no member-file hash
                                // change of its own (auth.service.ts, etc.).
                                const alWorking = buildApiListGraph(cluster, latestWorking, realBaseline);
                                const alBaseline = buildApiListGraph(cluster, latestWorking, latestWorking);
                                this.store.updateWorkingGraph(alWorking.graphId, alWorking);
                                this.store.updateBaselineGraph(alBaseline.graphId, alBaseline);
                                refreshIds.push(alWorking.graphId);
                            }
                            // #384: re-cascade L2b → L2a → L1 AFTER the LLM
                            // naming rebuild because `buildFeatureGraph` runs
                            // `diffClusters` which (post-#373) returns every
                            // cluster as `unchanged` unless its member files'
                            // hashes changed. That OVERWRITES the modified
                            // annotations the earlier cascade applied to
                            // feature:workspace via `clustersWithApiChanges`.
                            // Without this re-cascade the LLM async rebuild
                            // silently regresses L2a workspace diff state.
                            // L1-C2 (2026-06-07): include every graphId the
                            // cascade mutated in `refreshIds` so the WS
                            // broadcast catches the L1 reset; before this
                            // the function mutated `microservice:workspace`
                            // in place but the broadcast list never included
                            // it, leaving the L1 chip stuck on `~ modified`
                            // until manual reload.
                            const cascadeTouched = upgradeServiceClusterDiffAnnotations(this.store.getWorking().graphs);
                            for (const id of cascadeTouched) {
                                if (!refreshIds.includes(id)) refreshIds.push(id);
                            }
                            // Issue #730 — rebuild the Knowledge Map so it
                            // reflects LLM-enriched cluster names. Without
                            // this, the Map keeps the raw Louvain labels
                            // until the next init().
                            try {
                                const mg = buildMapGraph(this.store.getWorking(), this.store.getBaseline(), {
                                    workspaceRoot: this.workspaceRoot,
                                    contentProvider: getWorkingContent,
                                });
                                this.store.updateWorkingGraph(mg.graphId, mg);
                                this.store.updateBaselineGraph(mg.graphId, mg);
                                refreshIds.push(mg.graphId);
                            } catch (mapErr: any) {
                                this.log(`[Rebuild] Map graph rebuild failed (LLM-naming path): ${mapErr?.message ?? mapErr}`);
                            }
                            this.store.save();
                            this.notifyRefresh(refreshIds);
                        }).catch((err: any) => {
                            this.log(`[Rebuild] LLM naming failed: ${err?.message ?? err}`);
                        });
                    }

                    // Bug 5: rebuild api-list graphs for clusters in scope rather than just
                    // invalidating them. Without this, the L2b panel keeps the old api-list
                    // graph (or nothing) until the user manually navigates back.
                    const previousClusters = Object.keys(this.store.getWorking().clusters || {});
                    const newClusters = Object.keys(clusters || {});
                    const allClusterIds = new Set([...previousClusters, ...newClusters]);
                    for (const clusterId of allClusterIds) {
                        const cluster = clusters?.[clusterId];
                        if (!cluster) {
                            // Cluster gone — drop the stale api-list graph.
                            if (this.store.getWorking().graphs[`api-list:${clusterId}`]) {
                                this.store.removeWorkingGraph(`api-list:${clusterId}`);
                                updatedGraphIds.push(`api-list:${clusterId}`);
                            }
                            continue;
                        }
                        const apiListGraph = buildApiListGraph(cluster, latestWorking, baselineSnapshot);
                        this.store.updateWorkingGraph(apiListGraph.graphId, apiListGraph);
                        updatedGraphIds.push(apiListGraph.graphId);
                    }

                    // Build feature diagrams: per-service for multi-service repos, workspace-wide for single-service
                    const currentServiceIds = Object.keys(services);
                    if (currentServiceIds.length > 1) {
                        for (const serviceId of currentServiceIds) {
                            const svcGraph = buildFeatureGraph(latestWorking, baselineSnapshot, serviceId);
                            this.store.updateWorkingGraph(svcGraph.graphId, svcGraph);
                            updatedGraphIds.push(svcGraph.graphId);
                        }
                    } else {
                        const featureGraph = buildFeatureGraph(latestWorking, baselineSnapshot);
                        this.store.updateWorkingGraph(featureGraph.graphId, featureGraph);
                        updatedGraphIds.push(featureGraph.graphId);
                    }

                    const msGraph = buildMicroserviceGraph(this.workspaceRoot, latestWorking, baselineSnapshot, getWorkingContent, getBaselineContent);
                    this.store.updateWorkingGraph(msGraph.graphId, msGraph);
                    updatedGraphIds.push(msGraph.graphId);

                    // INVARIANT: cascade L4/L5 inline diff annotations up
                    // through L3 → L2b → L2a → L1 after every rebuildFile.
                    // Without this, a function-body-only edit leaves cluster
                    // member files unchanged (so diffClusters marks the
                    // cluster `unchanged`) and the user sees no orange
                    // highlight on L2a even though L4 correctly shows the
                    // modified function. See ADR-019 (Issue 365 — Cascade rebuilds every api-list when one file changes).
                    const liveGraphs = this.store.getWorking().graphs;
                    upgradeSequenceDiffAnnotations(liveGraphs);
                    // #386: rebuild ALL api-list graphs after the sequence
                    // cascade resets stale edge annotations. Previously the
                    // rebuild was scoped to clusters whose files include the
                    // edited file (Issue 365 perf optimization) — but for
                    // service-layer edits (e.g. `auth.service.ts` which is
                    // not a member of any cluster), the cluster's api-list
                    // never got refreshed and kept the pre-cascade over-marked
                    // state. `buildApiListGraph` derives `api.diff` from each
                    // route's sequence graph; if those still have leftover
                    // `styleKind: 'changed'` from `buildSequenceDiff`'s raw-
                    // text comparison (which fires for any call site whose
                    // surrounding source content shifts), the api-list
                    // mistakenly marks unrelated routes as `modified`.
                    // Rebuild every cluster's api-list using the now-correctly
                    // cascaded sequence state. Cost: ~10 cheap builds.
                    for (const cluster of Object.values(clusters || {})) {
                        const refreshed = buildApiListGraph(cluster, latestWorking, baselineSnapshot);
                        this.store.updateWorkingGraph(refreshed.graphId, refreshed);
                        if (!updatedGraphIds.includes(refreshed.graphId)) {
                            updatedGraphIds.push(refreshed.graphId);
                        }
                    }
                    // L1-C2 (2026-06-07): same union as the LLM-naming path.
                    const cascadeTouched = upgradeServiceClusterDiffAnnotations(this.store.getWorking().graphs);
                    for (const id of cascadeTouched) {
                        if (!updatedGraphIds.includes(id)) updatedGraphIds.push(id);
                    }

                    // #824 — keep sequence coverage complete after edits:
                    // any (new) HTTP api without a real sequence graph gets
                    // the synthetic shell so the L2b/tour gesture stays
                    // consistent post-cascade too.
                    for (const sid of this.ensureSyntheticSequences()) {
                        if (!updatedGraphIds.includes(sid)) updatedGraphIds.push(sid);
                    }

                    // Issue #730 — refresh the Knowledge Map after the
                    // L2b → L2a → L1 cascade so an open Map panel shows the
                    // post-edit state without requiring a re-open. The
                    // builder is composition-only (no AST), so the cost is
                    // bounded by `services + clusters + APIs`.
                    try {
                        const mg = buildMapGraph(this.store.getWorking(), this.store.getBaseline(), {
                            workspaceRoot: this.workspaceRoot,
                            contentProvider: getWorkingContent,
                        });
                        this.store.updateWorkingGraph(mg.graphId, mg);
                        if (!updatedGraphIds.includes(mg.graphId)) {
                            updatedGraphIds.push(mg.graphId);
                        }
                    } catch (mapErr: any) {
                        this.log(`[Rebuild] Map graph rebuild failed (cascade path): ${mapErr?.message ?? mapErr}`);
                    }

                    // Issue #740 — refresh the Domain graph too so the
                    // bubbled per-route modified state surfaces on the
                    // L2-companion view. Same composition-only cost
                    // profile as the Map rebuild above.
                    try {
                        const w = this.store.getWorking();
                        // #913 — preserve LLM-refined names across the cascade.
                        const heuristic = mergeRefinedDomainNames(detectDomains(w), w.domains);
                        this.store.updateWorkingDomains(heuristic);
                        const dg = buildDomainGraph(heuristic, w);
                        this.store.updateWorkingGraph(dg.graphId, dg);
                        if (!updatedGraphIds.includes(dg.graphId)) {
                            updatedGraphIds.push(dg.graphId);
                        }
                    } catch (domErr: any) {
                        this.log(`[Rebuild] Domain graph rebuild failed (cascade path): ${domErr?.message ?? domErr}`);
                    }

                    // Refresh health analysis
                    const health = analyzeHealth(this.store.getWorking());
                    this.store.updateWorkingHealth(health);
                } catch (err: any) {
                    this.log(`[Rebuild] Feature/microservice graph rebuild failed: ${err?.message ?? err}`);
                }
            }

            // MULTI-REPO-HANG perf fix (polar) — LIGHT, SCOPED diff propagation
            // that must run when the heavy cascade was skipped. The per-file
            // file/flow/sequence graphs were still rebuilt above (with correct
            // baseline-vs-working diff annotations), but the L2b api-list / L2a
            // feature / L1 service annotations still need the inline L4/L5 → L3
            // → L2b → L2a → L1 upgrade so a body-only edit (e.g. a route handler
            // whose signature is unchanged) shows as `~modified` all the way up.
            // `applyDiffCascadeToLiveGraphs` is the canonical scoped cascade
            // (ADR-019 / Issue 365): it re-annotates sequence graphs, rebuilds
            // ONLY the api-list graphs for clusters containing the edited file,
            // and bubbles cluster/microservice/map/domain annotations — all
            // composition-only, NO detectServices / detectCommunities /
            // buildCallGraph. Scoping to `[relativePath]` keeps it O(edited
            // file's clusters) instead of O(all clusters). On the heavy path the
            // full cascade above already did this, so we only run it here on the
            // skip path.
            if (!opts?.deferCascade && skippedHeavyCascade) {
                try {
                    const refreshed = this.applyDiffCascadeToLiveGraphs(new Set([relativePath]));
                    for (const id of refreshed) {
                        if (!updatedGraphIds.includes(id)) updatedGraphIds.push(id);
                    }
                } catch (propErr: any) {
                    this.log(`[Rebuild] light diff propagation (skip path) failed: ${propErr?.message ?? propErr}`);
                }
            }

            if (!opts?.deferCascade) {
                // #904 — re-anchor comments after the INCREMENTAL cascade too, not
                // just on full resync(). rebuildFile regenerates node IDs/spans for
                // the edited file's L4/L5/L3 graphs; without re-anchoring, a comment
                // on a flow/file node silently detached after any edit until the
                // next full re-init. Scope the anchor map to the graphs this rebuild
                // touched (`updatedGraphIds`) — `reanchor` leaves comments it can't
                // match in the scoped map untouched (it only lists them as orphaned
                // in its return), so comments on un-rebuilt graphs keep their anchor.
                // Only runs on the non-deferred path so a batched review-pr resync
                // re-anchors once at the end, mirroring the cascade gate above.
                try {
                    if (this.commentStore.getAll().length > 0 && updatedGraphIds.length > 0) {
                        const anchors = new Map<string, any>();
                        const liveGraphs = this.store.getWorking().graphs;
                        for (const gid of updatedGraphIds) {
                            const g = liveGraphs[gid];
                            if (!g?.anchors) continue;
                            for (const [aid, anchor] of Object.entries(g.anchors)) {
                                anchors.set(`${gid}::${aid}`, anchor);
                            }
                        }
                        if (anchors.size > 0) {
                            this.commentStore.reanchor(anchors);
                            this.store.setComments(this.commentStore.toJSON());
                        }
                    }
                } catch (reErr: any) {
                    this.log(`[Rebuild] comment re-anchor (incremental) failed: ${reErr?.message ?? reErr}`);
                }
            }
        } catch (err: any) {
            this.log(`[Rebuild] Failed for ${filePath}: ${err?.message ?? err}`);
            // Issue #724 — phone home for crash analysis. No-op when
            // Sentry isn't installed / DSN is missing / user opted out.
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { captureException } = require('../../errors/sentryNode');
                captureException(err, { filePath, surface: 'rebuildFile' });
            } catch { /* shim missing — silent */ }
        }

        const relativePath = path.relative(this.workspaceRoot, filePath);
        const changeDetail: ChangeDetail = {
            filePath: relativePath,
            changedFunctions: [...this._lastChangedFnNames],
            newFunctions: [...this._lastNewFnNames],
            deletedFunctions: [...this._lastDeletedFnNames],
            updatedGraphIds,
        };
        this._lastChangedFnNames.clear();
        this._lastNewFnNames.clear();
        this._lastDeletedFnNames.clear();

        const durationMs = Date.now() - tStart;
        // (2026-08) The per-rebuild `file_rebuilt_perf` telemetry — which fired on
        // every debounced auto-save — was removed. The web dashboard is the
        // primary analytics surface now; the editor no longer emits high-volume
        // per-save events. Timing is still returned for local logging.
        return { graphIds: updatedGraphIds, changeDetail, durationMs, skippedHeavyCascade };
    }

    /**
     * Bug 7 (live drift on reload): when the window is reloaded after the
     * user edited tracked files outside the active file-watcher window
     * (extension was inactive, hot-reload, etc.), the persisted working
     * snapshot still carries the OLD content. We detect any drift between
     * disk content and `working.files[fp].content` and trigger
     * `rebuildFile` for each, so inline file/flow diffs appear and the
     * downstream cascade can propagate them through L3/L2b/L2a/L1.
     *
     * Returns the list of files for which rebuildFile fired.
     */
    async syncDriftedFilesFromDisk(): Promise<string[]> {
        const drifted: string[] = [];
        try {
            const working = this.store.getWorking();
            const baseline = this.store.getBaseline();
            // Lazy-import git reader so non-git workspaces don't fail.
            const { getFileContentAtCommit, resolveRef } = await import('../git/gitReader');
            // Resolve HEAD to a commit hash once — getFileContentAtCommit
            // requires a hex hash (it rejects symbolic refs like 'HEAD'
            // for command-injection safety).
            let headHash: string | null = null;
            try { headHash = resolveRef(this.workspaceRoot, 'HEAD'); } catch { /* not a git repo */ }
            for (const [relPath, rec] of Object.entries(working.files ?? {})) {
                // Issue 394: rec.content is dropped from memory after every
                // save (lazy-content). Fall through to the SQLite-backed
                // accessor so drift detection survives a VS Code restart.
                const cachedContent: string | undefined =
                    typeof rec.content === 'string'
                        ? rec.content
                        : this.store.getFileContent('working', relPath);
                if (typeof cachedContent !== 'string') continue;
                const absPath = path.join(this.workspaceRoot, relPath);
                let diskContent: string;
                try { diskContent = await fsp.readFile(absPath, 'utf-8'); }
                catch { continue; /* file deleted on disk — ignore in this pass */ }
                if (diskContent !== cachedContent) {
                    drifted.push(relPath);
                    // Bug 7 follow-up A: invalidate stale hash so
                    // rebuildFile's hash-equality short-circuit doesn't fire.
                    this.store.updateWorkingFile(relPath, { ...rec, hash: '__drift__' + Date.now() });
                    // Bug 7 follow-up B: the persisted baseline may have
                    // been corrupted by an over-aggressive secret-redaction
                    // pass (e.g. `password: ["can't be blank"]` →
                    // `password= [REDACTED]`) which would parse-fail and
                    // poison the inline diff. Refresh baseline content
                    // from git HEAD for this file before rebuilding so
                    // `buildDiffMap`/`buildEntityDiff` get a clean source
                    // to compare against. Falls back silently when the
                    // workspace isn't a git repo or the file isn't in HEAD.
                    if (headHash) {
                        try {
                            const headContent = getFileContentAtCommit(this.workspaceRoot, headHash, relPath);
                            if (typeof headContent === 'string' && headContent.length > 0) {
                                const baselineRec = baseline.files[relPath];
                                if (baselineRec) baselineRec.content = headContent;
                            }
                        } catch { /* not in git / not committed — leave baseline as-is */ }
                    }
                    try { await this.rebuildFile(absPath, diskContent); }
                    catch (err: any) { this.log(`[syncDrift] rebuild failed for ${relPath}: ${err?.message ?? err}`); }
                }
            }
        } catch (err: any) {
            this.log(`[syncDrift] failed: ${err?.message ?? err}`);
        }
        return drifted;
    }

    /**
     * INVARIANT: cascade is idempotent and safe to call any time the live
     * working snapshot may have changed. Pushes inline L4/L5 diff
     * annotations up through L3 → L2b → L2a → L1.
     *
     * @param affectedFiles If provided, only api-list graphs for clusters
     *   containing these files are rebuilt — O(changed files) instead of
     *   O(all clusters). Pass undefined to rebuild every api-list (full
     *   refresh after init / drift sync). See ADR-019 / Issue 365 — Cascade rebuilds every api-list when one file changes.
     *
     * Returns the list of graph IDs whose annotations changed.
     */
    /**
     * Async/queued variant of `applyDiffCascadeToLiveGraphs`. Recommended
     * entry point for handlers that may fire concurrently (navigation,
     * replay, drift-sync). Existing sync callers can keep using the sync
     * variant for now — see ADR-020 for migration plan.
     */
    enqueueCascade(affectedFiles?: ReadonlySet<string>): Promise<string[]> {
        return this.mutationQueue.enqueue({
            key: 'cascade',  // coalesce concurrent calls to a single pass
            run: () => this.applyDiffCascadeToLiveGraphs(affectedFiles),
        });
    }

    /** Drain pending mutations — useful for tests + before-shutdown hooks. */
    waitForMutationQueueIdle(): Promise<void> {
        return this.mutationQueue.waitForIdle();
    }

    /**
     * Tier 3 (Issue 366 — In-flight LLM requests not aborted on supersede) — walk the workspace for `AndroidManifest.xml` files
     * and extract DEEP_LINK / WIDGET / BG_TASK / CONTENT_PROVIDER entries.
     * XML isn't a tree-sitter language so it stays out of the main scanner;
     * this helper does a small bounded recursive walk and merges results.
     */
    /**
     * UX-24 / UX-25 (2026-06-04) - Scan the workspace for AWS SAM + Serverless
     * Framework YAML templates and extract their HTTP routes as ApiRecord
     * rows. Mirrors `scanAndroidManifests`'s bounded-walk pattern so init
     * time stays bounded on large monorepos (MAX_DEPTH=8, cap=5000 files
     * inspected). Skips the usual ignore-dirs (node_modules, .git, etc.).
     */
    private async scanIacTemplates(): Promise<import('../graph/graphTypes').ApiRecord[]> {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        // UX-26 (2026-06-05) — AWS CDK construct chains in TS / Python.
        // Same scan loop, gated by content probe so unrelated TS/JS/Py
        // files don't pay the regex cost.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const out: import('../graph/graphTypes').ApiRecord[] = [];
        const root = this.repoRoot || this.workspaceRoot;
        const IGNORE = /(?:^|\/)(?:node_modules|\.git|build|dist|coverage|out|bin|obj|\.aws-sam|\.serverless|cdk\.out)(?:\/|$)/;
        const MAX_DEPTH = 8;
        const MAX_FILES_INSPECTED = 8000;
        let inspected = 0;

        const walk = (dir: string, depth: number): void => {
            if (depth > MAX_DEPTH) return;
            if (inspected > MAX_FILES_INSPECTED) return;
            let entries: import('fs').Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { return; }
            for (const e of entries) {
                inspected++;
                if (inspected > MAX_FILES_INSPECTED) return;
                const full = path.join(dir, e.name);
                const rel = path.relative(this.workspaceRoot, full);
                if (IGNORE.test(rel)) continue;
                if (e.isDirectory()) {
                    walk(full, depth + 1);
                    continue;
                }
                if (!e.isFile()) continue;
                const lowerName = e.name.toLowerCase();
                const isYaml = lowerName.endsWith('.yaml') || lowerName.endsWith('.yml');
                // UX-26 Phase 2 (2026-06-05) — also scan `.java` for CDK
                // construct chains (`api.getRoot().addMethod(...)`).
                const isCdkCandidate = lowerName.endsWith('.ts') || lowerName.endsWith('.js') || lowerName.endsWith('.py') || lowerName.endsWith('.java');
                if (!isYaml && !isCdkCandidate) continue;
                try {
                    const content = fs.readFileSync(full, 'utf-8');
                    if (isYaml) {
                        // First try the dedicated extractors for the canonical
                        // template names. For non-canonical YAML names
                        // (`reportingv1.yaml`, `admin.yaml`, etc.) fall through
                        // to a content-based probe: each extractor returns [] if
                        // the file isn't actually a SAM / Serverless Framework
                        // template, so running both on every YAML is cheap and
                        // catches nested SAM templates.
                        if (isSamTemplatePath(e.name)) {
                            out.push(...parseSamTemplate(content, rel));
                        } else if (isServerlessFrameworkPath(e.name)) {
                            out.push(...parseServerlessFrameworkTemplate(content, rel));
                        } else {
                            // Content-based probe — cheap because js-yaml exits
                            // early on a non-matching root structure.
                            if (/AWS::Serverless|Transform:\s*AWS::Serverless/.test(content)) {
                                out.push(...parseSamTemplate(content, rel));
                            } else if (/^\s*service\s*:/m.test(content) && /^\s*functions\s*:/m.test(content)) {
                                out.push(...parseServerlessFrameworkTemplate(content, rel));
                            }
                        }
                    } else if (isCdkCandidate && isCdkLikely(content)) {
                        // UX-26: CDK construct chains. Content-probed so
                        // unrelated TS/JS/Python files cost only a single
                        // regex test before being skipped.
                        out.push(...parseCdkConstructs(content, rel));
                    }
                } catch {
                    // skip unreadable / malformed templates — extractors
                    // return [] on parse errors, so we never throw out.
                }
            }
        };
        walk(root, 0);
        return out;
    }

    private async scanAndroidManifests(): Promise<import('../graph/graphTypes').ApiRecord[] > {
        const fs = await import('fs');
        const path = await import('path');
        const out: import('../graph/graphTypes').ApiRecord[] = [];
        const root = this.workspaceRoot;
        const IGNORE = /(?:^|\/)(?:node_modules|\.git|build|dist|coverage|out|bin|obj)(?:\/|$)/;
        const MAX_DEPTH = 8;
        const MAX_FILES_INSPECTED = 5000;
        let inspected = 0;

        const walk = (dir: string, depth: number): void => {
            if (depth > MAX_DEPTH) return;
            if (inspected > MAX_FILES_INSPECTED) return;
            let entries: import('fs').Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
            catch { return; }
            for (const e of entries) {
                inspected++;
                if (inspected > MAX_FILES_INSPECTED) return;
                const full = path.join(dir, e.name);
                const rel = path.relative(root, full);
                if (IGNORE.test(rel)) continue;
                if (e.isDirectory()) {
                    walk(full, depth + 1);
                } else if (e.isFile() && e.name === 'AndroidManifest.xml') {
                    try {
                        const content = fs.readFileSync(full, 'utf-8');
                        out.push(...detectAndroidManifestItems(content, rel));
                    } catch {
                        // skip unreadable manifest
                    }
                }
            }
        };
        walk(root, 0);
        return out;
    }

    /**
     * v2 follow-up #718 — Build an XmlLayoutResolver that lazily
     * scans the workspace for `res/layout/<name>.xml` files and caches
     * them by simple layout name. Same bounded-walk pattern as
     * `scanAndroidManifests`. Cache is computed on first call; if no
     * Android screen ever asks for a layout, no fs work happens.
     */
    private buildAndroidXmlLayoutResolver(): import('../parser/screenContentExtractor').XmlLayoutResolver {
        let cache: Map<string, string> | null = null;
        const ensureScanned = () => {
            if (cache !== null) return cache;
            cache = new Map<string, string>();
            try {
                const fs = require('fs') as typeof import('fs');
                const path = require('path') as typeof import('path');
                const root = this.workspaceRoot;
                const IGNORE = /(?:^|\/)(?:node_modules|\.git|build|dist|coverage|out|bin|obj)(?:\/|$)/;
                const MAX_DEPTH = 10;
                const MAX_FILES_INSPECTED = 8000;
                let inspected = 0;
                const walk = (dir: string, depth: number, inLayoutDir: boolean): void => {
                    if (depth > MAX_DEPTH) return;
                    if (inspected > MAX_FILES_INSPECTED) return;
                    let entries: import('fs').Dirent[];
                    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
                    catch { return; }
                    for (const e of entries) {
                        inspected++;
                        if (inspected > MAX_FILES_INSPECTED) return;
                        const full = path.join(dir, e.name);
                        const rel = path.relative(root, full);
                        if (IGNORE.test(rel)) continue;
                        if (e.isDirectory()) {
                            // Layouts can live in `res/layout/` or qualified
                            // variants like `res/layout-land/` or
                            // `res/layout-sw600dp/`. Treat any `layout*`
                            // child of a `res/` ancestor as a layout dir.
                            const isLayoutChild = inLayoutDir || e.name.startsWith('layout');
                            walk(full, depth + 1, isLayoutChild && (e.name === 'res' || inLayoutDir || e.name.startsWith('layout')));
                        } else if (e.isFile() && inLayoutDir && e.name.endsWith('.xml')) {
                            try {
                                const content = fs.readFileSync(full, 'utf-8');
                                const simple = e.name.replace(/\.xml$/, '');
                                // First-write wins so qualified variants
                                // don't shadow the default `res/layout/X.xml`.
                                if (!cache!.has(simple)) cache!.set(simple, content);
                            } catch {
                                // skip unreadable
                            }
                        }
                    }
                };
                walk(root, 0, false);
            } catch (err: any) {
                this.log(`[XmlLayout] scan failed: ${err?.message ?? err}`);
            }
            return cache;
        };
        return (layoutName: string) => {
            const c = ensureScanned();
            return c.get(layoutName);
        };
    }

    /**
     * True when the working state changed since the last cascade, so the live
     * graphs' diff annotations may be stale and a `requestRoute` handler should
     * re-cascade before serving. False on a warm, unchanged snapshot — the
     * caller can then skip the expensive full re-cascade (PERF fix). Cleared
     * inside `applyDiffCascadeToLiveGraphs`.
     */
    get needsLiveGraphCascade(): boolean {
        return this._liveGraphsCascadeDirty;
    }

    applyDiffCascadeToLiveGraphs(
        affectedFiles?: ReadonlySet<string>,
        opts?: { force?: boolean },
    ): string[] {
        // PERF (2026-07-20) — navigation-open latency. The FULL, unscoped
        // cascade below re-annotates every sequence graph, rebuilds the whole
        // Map (`buildMapGraph` scans file content), and re-clusters ALL domains
        // (`detectDomains` runs Louvain). Those Map/Domain rebuilds are
        // FIXED-cost — they cost the same on a 10-file fixture as on polar — so
        // running them on EVERY diagram open (6 call sites, some twice) added a
        // constant ~1-2s tax even when NOTHING changed since the last cascade.
        //
        // Early-return when the snapshot is clean: `_liveGraphsCascadeDirty` is
        // set on any file save/create/delete (queueEvent) and on resync/init, so
        // `!_liveGraphsCascadeDirty` means "no working-state mutation since the
        // last cascade → the live graphs' annotations are already correct → this
        // full pass would be byte-identical waste." Repeat navigations with no
        // edit become instant.
        //
        // Guards on the early-return, any of which forces the pass to run:
        //   - `affectedFiles` present → the caller has a concrete file scope to
        //     re-annotate (the scoped `rebuildFile` skip path); never suppress.
        //   - `opts.force` → the caller KNOWS the annotations are stale even
        //     though no file changed (leaving git-diff mode overwrote the live
        //     baseline-vs-working annotations with a commit-diff; clearGitDiff
        //     must recompute — see extension.ts handleClearGitDiff).
        // The flag is seeded `true` (field default + resync) so the very first
        // cascade after `initialize()` always runs and establishes annotations.
        if (!this._liveGraphsCascadeDirty && !affectedFiles && !opts?.force) {
            return [];
        }
        // Clear at the START so any mutation that lands DURING this pass re-arms
        // the flag and the next navigation cascades again (concurrency-safe).
        this._liveGraphsCascadeDirty = false;
        const refreshedIds: string[] = [];
        try {
            const working = this.store.getWorking();
            const baseline = this.store.getBaseline();
            const liveGraphs = working.graphs;

            // Step 1: walk every sequence graph and bump participant/edge
            // annotations based on whether the underlying flow graph is modified.
            //
            // Issue #365 (Round-4 perf, polar 3588 sequence graphs): when the
            // caller supplies `affectedFiles`, only re-annotate sequences that
            // REFERENCE an affected file instead of iterating every sequence
            // (the internal `findGraphByPath` scan is O(sequences × graphs) —
            // it pegged CPU ~60s per keystroke-burst). We build a SCOPED subset
            // object containing (a) only the affected sequence graphs plus (b)
            // the `flow:`/`file:` graphs those sequences read (for the affected
            // files AND every file their participants anchor into — cross-file
            // participants live elsewhere). `upgradeSequenceDiffAnnotations`
            // writes mutated graphs back via `diffedGraphs[id] = g`; those are
            // the same object references we read, so after the call we persist
            // exactly the affected sequence ids. The full-resync path
            // (`affectedFiles === undefined`) still passes the whole record.
            // The Step-2 api-list rebuild scope. On the scoped path this is the
            // sequence NEIGHBOURHOOD of the edited file (its file(s) + every file
            // the sequences referencing it touch), NOT just the edited file —
            // otherwise a body edit in a service/helper file (which owns no route
            // and belongs to no cluster) would never rebuild the api-list of the
            // cluster whose route REACHES it through a sequence, and L2b/L2a/L1
            // would keep their init-time `unchanged` state (the ts-express
            // getCurrentUser regression). Undefined ⇒ full-resync path (all).
            let apiListScope: ReadonlySet<string> | undefined;
            if (affectedFiles) {
                const scoped = this.buildScopedSequenceSubset(liveGraphs, affectedFiles);
                upgradeSequenceDiffAnnotations(scoped.subset);
                for (const gid of scoped.sequenceIds) {
                    this.store.updateWorkingGraph(gid, scoped.subset[gid]);
                    refreshedIds.push(gid);
                }
                apiListScope = scoped.relevantFiles;
            } else {
                upgradeSequenceDiffAnnotations(liveGraphs);
                for (const gid of Object.keys(liveGraphs)) {
                    if (gid.startsWith('sequence:')) refreshedIds.push(gid);
                }
            }

            // Step 2: rebuild api-list graphs so apis[].diff is current.
            // Issue 365: when caller supplies affectedFiles, scope rebuilds
            // to clusters that contain at least one affected file. Falls
            // back to full rebuild when affectedFiles is undefined.
            const clustersToRebuild = apiListScope
                ? (() => {
                    // `apiListScope` may carry absolute participant-anchor paths
                    // (#858) while cluster.files are workspace-relative — match
                    // with the same suffix tolerance as `fileMatchesRelevant`.
                    const scopeNorm = Array.from(apiListScope, f => f.replace(/\\/g, '/'));
                    const inScope = (rel: string): boolean => {
                        const n = rel.replace(/\\/g, '/');
                        return scopeNorm.some(s => s === n || s.endsWith('/' + n));
                    };
                    return Object.values(working.clusters ?? {}).filter(c => (c.files ?? []).some(inScope));
                })()
                : Object.values(working.clusters ?? {});
            for (const cluster of clustersToRebuild) {
                const fresh = buildApiListGraph(cluster, working, baseline);
                this.store.updateWorkingGraph(fresh.graphId, fresh);
                refreshedIds.push(fresh.graphId);
            }

            // Step 3: cluster + microservice nodes pick up `modified` from
            // their child api-lists. The returned ids are the feature/
            // microservice graphs whose node diffs ACTUALLY flipped this
            // pass — the signal used below to decide whether the Map / Domain
            // graphs (composed over clusters + services) need recomposing.
            const clusterDiffTouched = upgradeServiceClusterDiffAnnotations(this.store.getWorking().graphs);
            for (const gid of Object.keys(this.store.getWorking().graphs)) {
                if (gid.startsWith('feature:') || gid.startsWith('microservice:')) {
                    refreshedIds.push(gid);
                }
            }

            // Issue #365 (Round-4 perf): the Map + Domain graphs are pure
            // compositions over the clusters / services / apiIndex. On a
            // scoped cascade they only need rebuilding when Step 2 rebuilt a
            // cluster whose diff shifted OR Step 3 flipped a feature/
            // microservice node diff. If nothing structural changed for the
            // affected clusters, the Map / Domain are byte-identical to their
            // last state and we skip the full recompose (buildMapGraph scans
            // file content; detectDomains re-clusters). The full-resync path
            // (`affectedFiles === undefined`) ALWAYS rebuilds, unchanged.
            const clusterDiffChanged = clusterDiffTouched.length > 0;
            const rebuildMapDomain = !affectedFiles || clusterDiffChanged;

            // Issue #730 — rebuild the Knowledge Map at the end of the
            // cascade. The Map composes services + clusters + APIs +
            // infra, all of which may have shifted diffs by step 3.
            // Without this push, an open Map panel keeps pre-edit state
            // through the next file save. Issue #365: skipped on a scoped
            // cascade when no cluster/service diff flipped (nothing the Map
            // composes over changed).
            if (rebuildMapDomain) try {
                const getContent = (fp: string) => this.store.getFileContent('working', fp);
                const mg = buildMapGraph(this.store.getWorking(), this.store.getBaseline(), {
                    workspaceRoot: this.workspaceRoot,
                    contentProvider: getContent,
                });
                this.store.updateWorkingGraph(mg.graphId, mg);
                refreshedIds.push(mg.graphId);
            } catch (mapErr: any) {
                this.log(`[applyDiffCascade] map graph rebuild failed: ${mapErr?.message ?? mapErr}`);
            }

            // Issue #701 — rebuild the Domain graph at cascade end. Like
            // the Map, this is composition-only over the just-updated
            // clusters + apiIndex. Also re-persist via the v9 `domains`
            // table (Issue #734) so the working snapshot's stored
            // domains stay in sync with the live graph.
            //
            // Issue #365: skipped when no cluster/service diff flipped. When
            // it DOES rebuild on the scoped path we REUSE the existing
            // `w.domains` membership rather than calling `detectDomains`
            // (the Louvain re-cluster is the expensive part and cluster
            // MEMBERSHIP can't shift on a non-structural edit — only node
            // diffs do); the full-resync path still re-clusters from scratch.
            if (rebuildMapDomain) try {
                const w = this.store.getWorking();
                // #913 — preserve LLM-refined names across resync.
                const existingDomains = w.domains;
                const heuristic = affectedFiles && existingDomains && Object.keys(existingDomains).length > 0
                    ? existingDomains
                    : mergeRefinedDomainNames(detectDomains(w), existingDomains);
                this.store.updateWorkingDomains(heuristic);
                const domainGraph = buildDomainGraph(heuristic, w);
                this.store.updateWorkingGraph(domainGraph.graphId, domainGraph);
                refreshedIds.push(domainGraph.graphId);
            } catch (domErr: any) {
                this.log(`[applyDiffCascade] domain graph rebuild failed: ${domErr?.message ?? domErr}`);
            }

            this.store.save();

            // Issue #733 — schedule the optional LLM refinement on a
            // microtask AFTER the deterministic cascade has been
            // persisted + the synchronous refreshIds have been returned
            // to the caller. The refiner re-broadcasts `domain:workspace`
            // independently when it finishes; we don't want to block
            // the cascade waiting on a multi-second LLM call.
            if (this.domainLlmRefiner?.isEnabled()) {
                this.refineDomainsAndRebuildGraph('applyDiffCascade').then((ids) => {
                    if (ids.length > 0) {
                        this.store.save();
                        this.notifyRefresh(ids);
                    }
                }).catch((err: any) => {
                    this.log(`[applyDiffCascade] domain LLM refinement scheduling failed: ${err?.message ?? err}`);
                });
            }
        } catch (err: any) {
            this.log(`[applyDiffCascade] failed: ${err?.message ?? err}`);
        }
        return Array.from(new Set(refreshedIds));
    }

    /**
     * PERF (2026-07-20) — LIGHT cluster/service annotation upgrade, for the
     * caller that has just built a FRESH feature graph and only needs its
     * cluster nodes to pick up the `modified` badge derived from the ALREADY
     * cascaded api-list state — WITHOUT re-running the expensive sequence
     * re-annotation + Map + Domain rework.
     *
     * `buildFeatureGraphForService` used to call the full cascade TWICE per
     * L2a open (once to freshen api-list diffs, once to re-annotate the newly
     * stored feature graph). The second full pass was pure waste: nothing had
     * changed except that a single feature graph was written. This method runs
     * ONLY `upgradeServiceClusterDiffAnnotations` (composition-only, reads the
     * current api-list diffs) over the live working graphs and persists, so the
     * fresh feature graph's cluster nodes get their `~` badges. Returns the
     * graphIds it touched.
     */
    upgradeClusterServiceAnnotationsLight(): string[] {
        try {
            const touched = upgradeServiceClusterDiffAnnotations(this.store.getWorking().graphs);
            if (touched.length > 0) this.store.save();
            return touched;
        } catch (err: any) {
            this.log(`[upgradeClusterServiceAnnotationsLight] failed: ${err?.message ?? err}`);
            return [];
        }
    }

    /**
     * Issue #365 (Round-4 perf) — build the SCOPED input for Step 1 of the
     * light cascade. Returns a plain-object subset of `liveGraphs` containing:
     *   - only the `sequence:` graphs that REFERENCE an affected file, and
     *   - the `flow:`/`file:` graphs those sequences read (for every file the
     *     scoped sequences' entry/participants anchor into — cross-file
     *     participants live outside `affectedFiles`).
     *
     * `upgradeSequenceDiffAnnotations` reads the flow/file graphs (by exact key
     * AND by a full `Object.entries` scan in `findGraphByPath`) and writes each
     * touched sequence back via `subset[id] = g`. Because the subset holds the
     * SAME graph object references we read from the store, the caller persists
     * exactly `sequenceIds` afterward. Only the tiny neighborhood is hydrated
     * instead of every one of the (up to thousands of) sequence graphs.
     *
     * A sequence `g` (`sequence:<filePath>:<handler>`) references an affected
     * file when: the entry filePath parsed from its graphId ∈ affectedFiles, OR
     * `g.meta?.filePath` ∈ affectedFiles, OR any participant node's
     * `anchor?.filePath` (or `g.anchors[node.id]?.filePath`) ∈ affectedFiles.
     */
    private buildScopedSequenceSubset(
        liveGraphs: Record<string, DiagramGraph>,
        affectedFiles: ReadonlySet<string>,
    ): { subset: Record<string, DiagramGraph>; sequenceIds: string[]; relevantFiles: Set<string> } {
        const subset: Record<string, DiagramGraph> = {};
        const sequenceIds: string[] = [];
        // Files whose flow:/file: graphs the scoped sequences will read.
        const relevantFiles = new Set<string>(affectedFiles);

        // `Object.keys` over the LazyGraphMap proxy enumerates ids only (no
        // hydration). We hydrate a sequence graph only to test its
        // participant anchors when the cheap graphId parse didn't already
        // accept it.
        for (const gid of Object.keys(liveGraphs)) {
            if (!gid.startsWith('sequence:')) continue;
            const m = /^sequence:(.+):([^:]+)$/.exec(gid);
            const entryFile = m?.[1];

            let referencesAffected = entryFile !== undefined && affectedFiles.has(entryFile);
            const g = liveGraphs[gid];
            if (!g) continue;

            if (!referencesAffected) {
                const metaFile = (g.meta as { filePath?: string } | undefined)?.filePath;
                if (metaFile && affectedFiles.has(metaFile)) referencesAffected = true;
            }
            if (!referencesAffected) {
                for (const node of g.nodes) {
                    if (node.type !== 'participant') continue;
                    const fp = node.anchor?.filePath ?? g.anchors[node.id]?.filePath;
                    if (fp && affectedFiles.has(fp)) { referencesAffected = true; break; }
                }
            }
            if (!referencesAffected) continue;

            subset[gid] = g;
            sequenceIds.push(gid);
            // Collect every file this sequence's entry + participants touch so
            // the matching flow:/file: graphs come along for the diff checks.
            if (entryFile) relevantFiles.add(entryFile);
            const metaFile = (g.meta as { filePath?: string } | undefined)?.filePath;
            if (metaFile) relevantFiles.add(metaFile);
            for (const node of g.nodes) {
                const fp = node.anchor?.filePath ?? g.anchors[node.id]?.filePath;
                if (fp) relevantFiles.add(fp);
            }
        }

        // Pull in the flow:/file: graphs for the relevant files. flow ids are
        // `flow:<filePath>:<fn>` and file ids are `file:<filePath>`. Match by
        // the parsed (workspace-relative) filePath so cross-file participant
        // graphs are included. #858: participant anchors can carry an ABSOLUTE
        // filePath while graph keys stay relative, so accept a suffix match
        // (relevant.endsWith('/' + relPath)) mirroring `findGraphByPath`.
        const relevantList = Array.from(relevantFiles, f => f.replace(/\\/g, '/'));
        const fileMatchesRelevant = (relPath: string): boolean => {
            const norm = relPath.replace(/\\/g, '/');
            return relevantList.some(r => r === norm || r.endsWith('/' + norm));
        };
        for (const gid of Object.keys(liveGraphs)) {
            if (gid.startsWith('flow:')) {
                const fm = /^flow:(.+):([^:]+)$/.exec(gid);
                if (fm && fileMatchesRelevant(fm[1])) {
                    const g = liveGraphs[gid];
                    if (g) subset[gid] = g;
                }
            } else if (gid.startsWith('file:')) {
                if (fileMatchesRelevant(gid.slice('file:'.length))) {
                    const g = liveGraphs[gid];
                    if (g) subset[gid] = g;
                }
            }
        }

        return { subset, sequenceIds, relevantFiles };
    }

    /**
     * Full resync: rebuild everything and reset baseline.
     *
     * #353: All cleanup now routes through `SnapshotStore.clearAllFiles()`
     * which performs a single FK-cascade DELETE on the SQLite store and
     * removes every legacy JSON file so nothing can re-seed the DB on
     * next load. This is the unified clear contract — same path for
     * resync / reinitialize / reset.
     */
    async resync(): Promise<void> {
        this._liveGraphsCascadeDirty = true; // full reset → next navigation re-cascades
        this.store.clearAllFiles();
        this.log('[Resync] Cleared SQLite store + legacy files before reinit');
        await this.initialize();

        // Re-anchor comments. Streaming over graphs keeps the lazy-graph
        // memory bound from #355: one graph in RAM at a time, anchors map
        // collects only the per-graph keys.
        // Issue #403: namespace the map keys by graph id (`${graphId}::${nodeId}`)
        // so cross-graph node-ID collisions can't silently clobber L4 entries
        // with L3/L5 entries that share the same node id. `commentStore.reanchor`
        // strips the namespace prefix before assigning `comment.targetId`.
        const anchors = new Map<string, any>();
        const working = this.store.getWorking();
        forEachGraph(working.graphs, (graphId, graph) => {
            for (const [aid, anchor] of Object.entries(graph.anchors)) {
                anchors.set(`${graphId}::${aid}`, anchor);
            }
        });
        this.commentStore.reanchor(anchors);
        this.store.setComments(this.commentStore.toJSON());
        this.store.save();
    }

    private notifyChangeDetail(details: ChangeDetail[]): void {
        for (const cb of this.changeDetailCallbacks) {
            cb(details);
        }
    }

    private notifyRefresh(graphIds: string[]): void {
        for (const cb of this.refreshCallbacks) {
            cb(graphIds);
        }
    }

    /**
     * Build a skeletal L1 graph from `detectServices()` output alone — no
     * file-content iteration, no infrastructure detection, no inter-service
     * edges. Lets the browser render the system-design view within seconds
     * of init starting; the regular full rebuild downstream replaces this
     * graph in-place via the normal cascade refresh path.
     *
     * Why this works incrementally: `detectServices` does manifest reads
     * + a shallow file scan, both ~seconds even on 34k-file mega-workspaces.
     * The expensive per-file AST passes (Babel / tree-sitter / API
     * detection / call-graph) are what take minutes — they run AFTER
     * this returns.
     */
    private emitEarlyL1Skeleton(
        scanResults: Array<{ filePath: string; relativePath: string; hash: string; mtime: number }>,
    ): void {
        // Build a synthetic snapshot for detectServices. `files` holds path-
        // only stubs (no content) — detectServices reads manifests directly
        // from disk for the heavy lifting (multi-repo detection, monorepo
        // root scan, package.json/pom.xml/go.mod deps for tech detection).
        // Source-content tech patterns won't fire here; if a service can't
        // be classified by manifest alone it shows as `«unknown»` in the
        // skeleton and gets the right tech label once the full rebuild
        // completes downstream.
        const earlyFiles: Record<string, FileRecord> = {};
        for (const r of scanResults) {
            earlyFiles[r.relativePath] = {
                path: r.relativePath,
                hash: r.hash,
                mtime: r.mtime,
                content: '',
                symbols: { functions: [], variables: [], imports: [] },
            };
        }
        const earlySnapshot: import('../graph/graphTypes').Snapshot = {
            files: earlyFiles,
            apiIndex: {},
            graphs: {},
        };
        const getContent = (_fp: string): string | undefined => undefined;

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { detectServices } = require('../analysis/serviceDetector');
        // #816 Phase 5 — scope to this sub-repo's tree. Single-repo
        // unchanged because `repoRoot === workspaceRoot` then.
        const services: Record<string, import('../graph/graphTypes').ServiceRecord> =
            detectServices(this.repoRoot, earlySnapshot, getContent);
        const serviceList = Object.values(services);
        if (serviceList.length === 0) return;            // single-service repo with no detectable shape — skip

        // Persist services so the regular cascade sees the early result
        // (and the homepage stat row can light up immediately).
        this.store.updateWorkingServices(services);

        // UX-27 (2026-06-05) — when there are > 50 services (serverless-
        // patterns has 796), the per-service skeletal graph renders an
        // unreadable wall of cards. Bucket by AWS service-of-interest
        // so the user gets a tractable view from second one of init.
        const SKELETAL_BUCKET_THRESHOLD = 50;
        let nodes: any[];
        let extraMeta: Record<string, any> = {};
        if (serviceList.length > SKELETAL_BUCKET_THRESHOLD) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { bucketServicesByAwsService } = require('../analysis/awsServiceBucketing');
                const flat = serviceList.map((s: any) => ({ id: s.id, name: s.name }));
                const buckets = bucketServicesByAwsService(flat) as Array<{ awsService: string; label: string; members: Array<{ id: string; name: string }> }>;
                nodes = buckets.map((b, i) => ({
                    id: `service-${i}`,
                    type: 'service' as const,
                    label: b.label,
                    subtitle: `«aws» ${b.members.length} pattern${b.members.length !== 1 ? 's' : ''}`,
                    body: '',
                    diff: 'unchanged' as const,
                    serviceId: `aws:${b.awsService}`,
                    anchor: { filePath: '' },
                    meta: {
                        awsBucket: b.awsService,
                        bucketedFrom: b.members.map((m) => m.id),
                        patternCount: b.members.length,
                        exposedApiCount: 0,
                    },
                }));
                extraMeta = { bucketed: true, bucketReason: 'aws-services', originalServiceCount: serviceList.length, bucketCount: nodes.length };
            } catch (err: any) {
                this.log(`[Initialize] early-L1 AWS bucketing failed (falling back): ${err?.message ?? err}`);
                nodes = serviceList.map((svc: any, i: number) => ({
                    id: `service-${i}`, type: 'service' as const,
                    label: svc.name, subtitle: `«${svc.technology}»`,
                    body: svc.rootPath || '.', diff: 'unchanged' as const,
                    serviceId: svc.id, anchor: { filePath: svc.rootPath || '' },
                    meta: { serviceId: svc.id, rootPath: svc.rootPath, technology: svc.technology, exposedApiCount: 0, consumedUrls: [], consumedServices: [], repoId: svc.repoId },
                }));
            }
        } else {
            nodes = serviceList.map((svc: any, i: number) => ({
                id: `service-${i}`, type: 'service' as const,
                label: svc.name, subtitle: `«${svc.technology}»`,
                body: svc.rootPath || '.', diff: 'unchanged' as const,
                serviceId: svc.id, anchor: { filePath: svc.rootPath || '' },
                meta: { serviceId: svc.id, rootPath: svc.rootPath, technology: svc.technology, exposedApiCount: 0, consumedUrls: [], consumedServices: [], repoId: svc.repoId },
            }));
        }
        const skeletalGraph: DiagramGraph = {
            graphId: 'microservice:workspace',
            type: 'microservice',
            nodes,
            edges: [],
            anchors: {},
            meta: {
                repoName: path.basename(this.workspaceRoot) || 'workspace',
                skeletal: true,
                ...extraMeta,
            },
        };
        this.store.updateWorkingGraph(skeletalGraph.graphId, skeletalGraph);

        // Persist the skeleton immediately so the L1 graph survives a
        // browser refresh while init is still running (the extension's
        // `getInitialData` hook reads from the saved DB on reconnect).
        // The flush is tiny — N service records + one graph — so it's
        // essentially free on the wall clock.
        try { this.store.save(); } catch (err: any) {
            this.log(`[Initialize] early-L1 save failed (non-fatal): ${err?.message ?? err}`);
        }

        const label = serviceList.length === 1 ? 'service' : 'services';
        this.emitProgress(
            'scanning',
            0.25,
            `Detected ${serviceList.length} ${label} — L1 ready, parsing files…`,
        );
        this.notifyRefresh([skeletalGraph.graphId]);
        this.log(`[Initialize] early-L1 broadcast: ${serviceList.length} services (skeletal)`);
    }
}
