/**
 * runVerify.ts
 *
 * Shared harness used by `verify.test.ts` to run the full CodeAtlas pipeline
 * (parser → framework detection → graph builders) against one cloned real-world
 * repo and return aggregate counts.
 *
 * Drives the existing SyncOrchestrator end-to-end so the verify suite exercises
 * the same code path as the real extension at workspace-init time.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SyncOrchestrator } from '../../src/core/sync/syncOrchestrator';
import { SnapshotStore } from '../../src/core/storage/snapshotStore';
import { CommentStore } from '../../src/core/storage/commentStore';
import { setGrammarsDir, resetTreeSitterForTesting } from '../../src/core/parser/treeSitterParser';
import { WorkspaceCallGraph } from '../../src/core/graph/callGraphResolver';
import type { DiagramGraph } from '../../src/core/graph/graphTypes';

export interface RepoSpec {
    id: string;
    language: string;
    framework: string;
    expectedFrameworks: string[];
    gitUrl: string;
    ref: string;
    /** When set, fetch.sh symlinks this absolute/tilde-prefixed path into e2e/real-repos/<id> instead of cloning. */
    localPath?: string;
    includeGlobs: string[];
    /**
     * Pinned upstream commit. `ref` is documentation; THIS is what the corpus
     * is reproduced from. Absent only for a newly added repo that has not been
     * baselined yet.
     */
    sha?: string;
}

export interface VerifyResult {
    initialized: boolean;
    error?: string;
    durationMs: number;

    // From SyncOrchestrator.initialize()
    fileCount: number;
    apiCount: number;
    graphCount: number;
    parseFailures: Record<string, number>;

    // Derived from store.getWorking()
    fileGraphs: number;
    flowGraphs: number;
    sequenceGraphs: number;
    flowGraphsWithDecision: number;
    flowGraphsWithLoop: number;
    featureClusters: number;
    microservices: number;

    // Anonymous-handler resolution (issue 253 follow-up)
    anonymousHandlers: number;
    anonymousResolved: number;
    anonymousUnresolved: number;

    // Integrity (issue 261-265 follow-up)
    parseFailureCount: number;
    apiListGraphs: number;
    fileGraphsWithEdges: number;
    sequenceGraphsWithMessages: number;
    healthReportPresent: boolean;
    callGraphEdgeCount: number;
    nodesWithoutLabel: number;
    duplicateNodeIdGraphs: number;

    // Layered diagram coverage (L1 / L2a / L2b / L3)
    microserviceGraphs: number;          // L1
    featureGraphs: number;               // L2a
    apiListWithMembers: number;          // L2b — api-list graphs whose meta carries APIs/screens/etc.
    sequenceParticipantsTotal: number;   // L3 — sum of participant nodes across all seq graphs
    sequenceMessagesTotal: number;       // L3 — sum of message edges
    // Diff sanity: both baseline and working should be the same on a fresh init
    baselineGraphCount: number;
    workingGraphCount: number;
    // L2b shape: meta.apis present and non-empty when route APIs detected
    apiListMetaApisCount: number;

    // L4 file diagrams
    fileGraphsWithImports: number;     // L4 — at least one node of type 'import'
    fileGraphsWithFunctions: number;   // L4 — at least one node representing a function
    fileGraphNodesTotal: number;       // L4 — sum of nodes across all file graphs
    // L5 flow diagrams
    flowGraphsWithStartEnd: number;    // L5 — has both Start and End terminal nodes
    flowGraphsWithMultipleStatements: number; // L5 — body is non-trivial (>2 inner nodes)
    flowGraphsTrivial: number;         // L5 — only Start + End (empty body)
    flowGraphAvgEdges: number;         // L5 — avg edges per flow graph
    flowGraphMaxNodes: number;         // L5 — max nodes seen in any flow graph
    flowGraphAvgBodyNodes: number;     // L5 — avg body nodes (excl. Start/End) per non-trivial graph

    // Issue 284: Anchor validity — count of nodes with valid file-range anchors.
    // anchorsValid + anchorsInvalid should sum to nodesWithAnchors.
    nodesWithAnchors: number;
    anchorsInvalid: number;            // span.start < 0 OR span.end < span.start

    // Issue 286: Mobile items in clusters (screensInCluster / navRoutesInCluster /
    // networkCallsInCluster). For mobile repos these should be > 0.
    clusterScreensTotal: number;
    clusterNavRoutesTotal: number;
    clusterNetworkCallsTotal: number;

    // Issue 288: Sub-cluster api-list content
    subClusterApiListGraphs: number;          // api-list:* graphs whose meta.clusterId is a sub-cluster
    subClusterApiListWithMembers: number;     // sub-cluster api-list with at least one populated member array

    // Issue 287: Path-traversal / security smoke. The orchestrator should
    // refuse to scan files with absolute paths or `..` traversals; we count
    // any FileRecord with a suspect path.
    suspectFilePaths: number;

    // Issue 280: Separate route APIs from mobile UI items so callers can tell
    // a 50-route backend from a 50-screen mobile app.
    routeApiCount: number;     // apis with non-mobile method (GET/POST/PUT/etc.)
    mobileItemCount: number;   // apis with method in {SCREEN, NAV_ROUTE, NETWORK, DI_BINDING}

    // Issue 301: health report content
    healthReportFieldsPresent: boolean;  // working.health has all required arrays defined (not undefined)
    healthDeadCodeCount: number;
    healthCyclicDependenciesCount: number;
    healthHighCouplingFilesCount: number;

    // Issue 308 / user request: per-framework summary stats
    classCount: number;                // entities of kind 'class' across all files
    functionCount: number;             // entities of kind 'function' across all files
    avgClassesPerFile: number;
    avgFunctionsPerFile: number;

    // Issue 306: WorkspaceCallGraph round-trip integrity.
    // serialize → deserialize → serialize should produce stable edge counts.
    callGraphRoundTripEdges: number;

    // Issue 315: mobile content quality. Counts of distinctly-named SCREEN
    // entries — 0 here for a mobile repo means the detector saw items but
    // dropped their names.
    distinctScreenNames: number;
    distinctNavRouteNames: number;

    // Issue 369: handler-name dedup tracking. The sequence-graph builder
    // dedupes by `(filePath, handlerName)` because one method body should
    // only get one sequence diagram, even if multiple decorators target it
    // (e.g. Spring `@KafkaListener` × N topics on a single Java method).
    // The expected sequence count is `apiCount - dedupedHandlerCollapses`.
    // Any deviation indicates a regression in the sequence-build path
    // (empty-body skip, parser failure, missing handler resolution).
    dedupedHandlerCollapses: number;

    // Issue 496: cross-cluster api-list contamination guard. Count of
    // api-list:cluster:<id> graphs whose meta.apis array contains at least
    // one ApiRecord whose `filePath` is NOT in the cluster's `files` set.
    // Pre-#496 the user reported the auth panel showing article routes
    // (4 + 15 = 19) on node-express-realworld-example-app after a small
    // log edit. The defensive guard in apiListGraphBuilder + commitDiffer
    // should keep this metric at 0 on every repo, on init AND on cascade.
    apiListsWithForeignApis: number;
    // Total count of foreign api records observed across all api-list graphs.
    // Useful for "how badly contaminated" diagnostics in regression triage.
    foreignApiTotal: number;

    // Issue #426: cluster-service orphan guard. Counts clusters whose
    // `serviceId` is undefined OR doesn't reference any existing service.id.
    // Both cases sever the L2a → L1 cascade chain (orphan clusters disappear
    // from feature graphs and microservice rollups). Should be 0 on every
    // repo after the workspace-wide `service:main` fallback in serviceDetector.
    clusterOrphanCount: number;
}

const ZERO: Omit<VerifyResult, 'initialized' | 'durationMs'> = {
    fileCount: 0, apiCount: 0, graphCount: 0, parseFailures: {},
    fileGraphs: 0, flowGraphs: 0, sequenceGraphs: 0,
    flowGraphsWithDecision: 0, flowGraphsWithLoop: 0,
    featureClusters: 0, microservices: 0,
    anonymousHandlers: 0, anonymousResolved: 0, anonymousUnresolved: 0,
    parseFailureCount: 0, apiListGraphs: 0,
    fileGraphsWithEdges: 0, sequenceGraphsWithMessages: 0,
    healthReportPresent: false, callGraphEdgeCount: 0,
    nodesWithoutLabel: 0, duplicateNodeIdGraphs: 0,
    microserviceGraphs: 0, featureGraphs: 0,
    apiListWithMembers: 0, apiListMetaApisCount: 0,
    sequenceParticipantsTotal: 0, sequenceMessagesTotal: 0,
    baselineGraphCount: 0, workingGraphCount: 0,
    fileGraphsWithImports: 0, fileGraphsWithFunctions: 0,
    fileGraphNodesTotal: 0,
    flowGraphsWithStartEnd: 0, flowGraphsWithMultipleStatements: 0,
    flowGraphsTrivial: 0, flowGraphAvgEdges: 0, flowGraphMaxNodes: 0,
    flowGraphAvgBodyNodes: 0,
    nodesWithAnchors: 0, anchorsInvalid: 0,
    clusterScreensTotal: 0, clusterNavRoutesTotal: 0, clusterNetworkCallsTotal: 0,
    subClusterApiListGraphs: 0, subClusterApiListWithMembers: 0,
    suspectFilePaths: 0,
    routeApiCount: 0, mobileItemCount: 0,
    healthReportFieldsPresent: false,
    healthDeadCodeCount: 0,
    healthCyclicDependenciesCount: 0,
    healthHighCouplingFilesCount: 0,
    classCount: 0, functionCount: 0,
    avgClassesPerFile: 0, avgFunctionsPerFile: 0,
    callGraphRoundTripEdges: 0,
    distinctScreenNames: 0, distinctNavRouteNames: 0,
    dedupedHandlerCollapses: 0,
    apiListsWithForeignApis: 0,
    foreignApiTotal: 0,
    clusterOrphanCount: 0,
};

/**
 * Run the full CodeAtlas pipeline against a cloned repo and return aggregate stats.
 *
 * @param repoPath  absolute path to the cloned repo
 * @param spec      manifest entry from repos.json (language/framework/etc.)
 */
export async function runVerifyForRepo(repoPath: string, _spec: RepoSpec): Promise<VerifyResult> {
    const start = Date.now();

    // Boot tree-sitter against the repo's grammars directory.
    // setGrammarsDir is idempotent per-process; we still call resetTreeSitterForTesting
    // because each repo may parse a fresh language set.
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));

    // Use a tmp .codeatlas dir so we don't pollute the cloned repo
    // (and don't accidentally race two verify runs against the same path).
    const codeatlasDir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-${_spec.id}-`));

    try {
        const store = new SnapshotStore(codeatlasDir);
        const commentStore = new CommentStore([]);
        const sync = new SyncOrchestrator(repoPath, store, commentStore);

        let initStats: Awaited<ReturnType<typeof sync.initialize>>;
        try {
            initStats = await sync.initialize();
        } catch (e: any) {
            return {
                initialized: false, error: String(e?.message ?? e),
                durationMs: Date.now() - start, ...ZERO,
            };
        }

        const working = store.getWorking();

        let fileGraphs = 0, flowGraphs = 0, sequenceGraphs = 0, apiListGraphs = 0;
        let flowGraphsWithDecision = 0, flowGraphsWithLoop = 0;
        let anonymousHandlers = 0, anonymousResolved = 0;
        let fileGraphsWithEdges = 0, sequenceGraphsWithMessages = 0;
        let nodesWithoutLabel = 0, duplicateNodeIdGraphs = 0;
        let microserviceGraphs = 0, featureGraphs = 0;
        let apiListWithMembers = 0, apiListMetaApisCount = 0;
        let apiListsWithForeignApis = 0, foreignApiTotal = 0;
        let sequenceParticipantsTotal = 0, sequenceMessagesTotal = 0;
        let fileGraphsWithImports = 0, fileGraphsWithFunctions = 0;
        let fileGraphNodesTotal = 0;
        let flowGraphsWithStartEnd = 0, flowGraphsWithMultipleStatements = 0;
        let flowGraphsTrivial = 0, flowGraphEdgeSum = 0, flowGraphMaxNodes = 0;
        let flowGraphBodyNodeSum = 0, flowGraphsNonTrivial = 0;
        let nodesWithAnchors = 0, anchorsInvalid = 0;
        let subClusterApiListGraphs = 0, subClusterApiListWithMembers = 0;

        // Index flow graphs by id for anonymous-handler lookup
        const flowGraphIds = new Set<string>();
        for (const [graphId, graph] of Object.entries(working.graphs)) {
            const g = graph as DiagramGraph;

            // Per-graph integrity: empty labels, duplicate node IDs, anchor validity
            const idsSeen = new Set<string>();
            let dupInThisGraph = false;
            for (const n of g.nodes ?? []) {
                if (n.label == null || String(n.label).trim() === '') nodesWithoutLabel++;
                if (idsSeen.has(n.id)) dupInThisGraph = true;
                idsSeen.add(n.id);
                const anchor = (n as any).anchor;
                if (anchor && typeof anchor === 'object') {
                    const sp = anchor.span;
                    if (sp && typeof sp.start === 'number' && typeof sp.end === 'number') {
                        nodesWithAnchors++;
                        if (sp.start < 0 || sp.end < sp.start) anchorsInvalid++;
                    }
                }
            }
            if (dupInThisGraph) duplicateNodeIdGraphs++;

            if (graphId.startsWith('file:')) {
                fileGraphs++;
                if ((g.edges?.length ?? 0) > 0) fileGraphsWithEdges++;
                const ns = g.nodes ?? [];
                fileGraphNodesTotal += ns.length;
                if (ns.some(n => n.type === 'import')) fileGraphsWithImports++;
                // File graphs use 'function' / 'class' / 'method' types depending on
                // language and whether the file has any callable entities.
                if (ns.some(n => n.type === 'function' || n.type === 'class' || n.type === 'method')) {
                    fileGraphsWithFunctions++;
                }
            } else if (graphId.startsWith('flow:')) {
                flowGraphs++;
                flowGraphIds.add(graphId);
                const ns = g.nodes ?? [];
                const es = g.edges ?? [];
                flowGraphEdgeSum += es.length;
                if (ns.length > flowGraphMaxNodes) flowGraphMaxNodes = ns.length;
                if (ns.some(n => n.type === 'decision')) flowGraphsWithDecision++;
                if (ns.some(n => n.type === 'loop')) flowGraphsWithLoop++;
                const terminals = ns.filter(n => n.type === 'terminal');
                if (terminals.length >= 2) flowGraphsWithStartEnd++;
                // Non-trivial body: more than just start + end + (optional one stmt).
                if (ns.length > 3) flowGraphsWithMultipleStatements++;
                // Trivial: only start + end (no body — should be rare).
                if (ns.length <= 2) flowGraphsTrivial++;
                // Body-statement count = total nodes minus terminals, but each
                // consolidated block counts as len(meta.statements) (consolidation
                // collapses linear runs for the renderer; meta preserves the
                // original statement count). Issues 276-278: this is the metric
                // that reflects extraction depth, not raw `nodes.length`.
                let bodyStmts = 0;
                for (const n of ns) {
                    if (n.type === 'terminal') continue;
                    const stmts = (n as any).meta?.statements;
                    bodyStmts += Array.isArray(stmts) && stmts.length > 0 ? stmts.length : 1;
                }
                if (bodyStmts > 0) {
                    flowGraphBodyNodeSum += bodyStmts;
                    flowGraphsNonTrivial++;
                }
            } else if (graphId.startsWith('sequence:')) {
                sequenceGraphs++;
                const edgeCount = g.edges?.length ?? 0;
                if (edgeCount > 0) sequenceGraphsWithMessages++;
                sequenceMessagesTotal += edgeCount;
                sequenceParticipantsTotal += (g.nodes ?? []).filter(n => n.type === 'participant').length;
            } else if (graphId.startsWith('api-list:')) {
                apiListGraphs++;
                const meta: any = (g as any).meta ?? {};
                const apis = Array.isArray(meta.apis) ? meta.apis.length : 0;
                const screens = Array.isArray(meta.screens) ? meta.screens.length : 0;
                const navs = Array.isArray(meta.navRoutes) ? meta.navRoutes.length : 0;
                const nets = Array.isArray(meta.networkCalls) ? meta.networkCalls.length : 0;
                const populated = apis + screens + navs + nets > 0;
                if (populated) apiListWithMembers++;
                apiListMetaApisCount += apis;
                // Issue #496: detect cross-cluster contamination. If meta.files
                // is set, every api/screen/nav/net's filePath must live in it.
                // Sub-cluster graphs may omit meta.files — skip them.
                if (Array.isArray(meta.files) && meta.files.length > 0) {
                    const fileSet = new Set<string>(meta.files);
                    const checkArr = (arr: any[]) => arr.reduce((sum, x) =>
                        sum + (x?.filePath && !fileSet.has(x.filePath) ? 1 : 0), 0);
                    let foreign = 0;
                    if (Array.isArray(meta.apis)) foreign += checkArr(meta.apis);
                    if (Array.isArray(meta.screens)) foreign += checkArr(meta.screens);
                    if (Array.isArray(meta.navRoutes)) foreign += checkArr(meta.navRoutes);
                    if (Array.isArray(meta.networkCalls)) foreign += checkArr(meta.networkCalls);
                    if (foreign > 0) {
                        apiListsWithForeignApis++;
                        foreignApiTotal += foreign;
                    }
                }
                // Sub-cluster id contains a hyphen path or special prefix; we approximate
                // as "clusterId not present in working.clusters" since sub-clusters live
                // inside parent.subClusters.
                const cid: string | undefined = meta.clusterId;
                if (cid && !(working.clusters && working.clusters[cid])) {
                    subClusterApiListGraphs++;
                    if (populated) subClusterApiListWithMembers++;
                }
            } else if (graphId.startsWith('microservice:')) {
                microserviceGraphs++;
            } else if (graphId.startsWith('feature:')) {
                featureGraphs++;
            }
        }

        // Anonymous handler accounting: any apiIndex entry whose handlerName starts with
        // `anonymous@` should have a corresponding flow graph. Failure here means
        // findAnonymousRouteBody returned null (unresolved).
        // Issue 353: Rails RESOURCE handlers (`anonymous@RESOURCE:/<name>`) are
        // route DSL declarations, not closure bodies. They resolve when the
        // matching controller exists per Rails convention:
        // `resource :user` → `UsersController` in `users_controller.rb`,
        // `resources :articles` → `ArticlesController` in `articles_controller.rb`.
        for (const api of Object.values(working.apiIndex ?? {})) {
            if (api.handlerName?.startsWith('anonymous@')) {
                anonymousHandlers++;
                const expectedKey = `flow:${api.filePath}:${api.handlerName}`;
                if (flowGraphIds.has(expectedKey)) {
                    anonymousResolved++;
                    continue;
                }
                // Rails RESOURCE convention check.
                // Issue 339: handler shape is now `anonymous@RESOURCE:/users#index`
                // (per-action), but earlier was `anonymous@RESOURCE:/users` (one
                // record per resource). Strip the optional `#<action>` suffix
                // before resolving — both shapes use the same Rails convention
                // (`UsersController` in `users_controller.rb`).
                const resMatch = api.handlerName.match(/^anonymous@RESOURCE:\/([\w-]+)(?:#\w+)?$/);
                if (resMatch) {
                    const name = resMatch[1];
                    // Naive English pluralisation: ends in 'y' → 'ies', ends in 's' → unchanged, else add 's'.
                    const plural = /s$/.test(name)
                        ? name
                        : /[^aeiou]y$/.test(name)
                            ? name.slice(0, -1) + 'ies'
                            : name + 's';
                    // PascalCase: capitalise first letter.
                    const pascal = plural.charAt(0).toUpperCase() + plural.slice(1);
                    const fileSuffix = `/${plural}_controller.rb`;
                    const classPrefix = `${pascal}Controller.`;
                    const railsMatch = [...flowGraphIds].some(k => {
                        // flow:<...>/users_controller.rb:UsersController.<method>
                        if (!k.startsWith('flow:')) return false;
                        const lastColon = k.lastIndexOf(':');
                        if (lastColon < 5) return false;
                        const path = k.slice(5, lastColon);
                        const tail = k.slice(lastColon + 1);
                        return (path.endsWith(fileSuffix) || path.endsWith(`/${name}_controller.rb`))
                            && (tail.startsWith(classPrefix) || tail.startsWith(`${name.charAt(0).toUpperCase()}${name.slice(1)}Controller.`));
                    });
                    if (railsMatch) anonymousResolved++;
                }
            }
        }
        const anonymousUnresolved = anonymousHandlers - anonymousResolved;

        const featureClusters = Object.keys(working.clusters ?? {}).length;
        const microservices = Object.keys(working.services ?? {}).length;

        // #426 — count clusters whose serviceId is missing OR references a
        // service that doesn't exist in working.services. Each orphan is a
        // L2a → L1 break: the feature graph drops the cluster, microservice
        // rollups undercount, and per-cluster api-list lookups by service
        // mis-attribute.
        const serviceIdSet = new Set(Object.keys(working.services ?? {}));
        let clusterOrphanCount = 0;
        for (const c of Object.values(working.clusters ?? {})) {
            const sid = (c as any).serviceId;
            if (!sid || !serviceIdSet.has(sid)) clusterOrphanCount++;
        }
        const parseFailureCount = Object.values(initStats.parseFailures ?? {})
            .reduce((s, n) => s + (n ?? 0), 0);
        const callGraphEdgeCount = working.callGraph?.edges?.length ?? 0;
        const healthReportPresent = !!working.health;
        const h: any = working.health ?? {};
        const healthReportFieldsPresent = !!working.health
            && Array.isArray(h.deadFunctions)
            && Array.isArray(h.godFiles)
            && Array.isArray(h.highCouplingFiles)
            && Array.isArray(h.cyclicDependencies)
            && Array.isArray(h.orphanedClusters);
        const healthDeadCodeCount = Array.isArray(h.deadFunctions) ? h.deadFunctions.length : 0;
        const healthCyclicDependenciesCount = Array.isArray(h.cyclicDependencies) ? h.cyclicDependencies.length : 0;
        const healthHighCouplingFilesCount = Array.isArray(h.highCouplingFiles) ? h.highCouplingFiles.length : 0;

        // Class/function totals across all FileRecord.symbols.functions entries.
        // (kind: 'class' is also stored under symbols.functions because the
        // tree-sitter extractor treats classes as a function-like entity for
        // call-graph purposes.)
        let classCount = 0, functionCount = 0;
        for (const fr of Object.values(working.files ?? {})) {
            for (const s of fr.symbols?.functions ?? []) {
                if ((s as any).kind === 'class') classCount++;
                else functionCount++;
            }
        }
        const fileCountForAvg = Math.max(1, initStats.fileCount);
        const avgClassesPerFile = classCount / fileCountForAvg;
        const avgFunctionsPerFile = functionCount / fileCountForAvg;

        // Issue 315: distinct screen / nav-route names from apiIndex
        const screenNames = new Set<string>();
        const navNames = new Set<string>();
        for (const a of Object.values(working.apiIndex ?? {})) {
            if (a.method === 'SCREEN' && a.handlerName) screenNames.add(a.handlerName);
            else if (a.method === 'NAV_ROUTE' && a.handlerName) navNames.add(a.handlerName);
        }
        const distinctScreenNames = screenNames.size;
        const distinctNavRouteNames = navNames.size;

        // Issue 306: round-trip the call graph to catch serialization regressions.
        let callGraphRoundTripEdges = 0;
        if (working.callGraph) {
            try {
                const round1 = WorkspaceCallGraph.deserialize(working.callGraph).serialize();
                callGraphRoundTripEdges = round1.edges.length;
            } catch {
                callGraphRoundTripEdges = -1; // signals deserialize failed
            }
        }

        const baseline = store.getBaseline();
        const baselineGraphCount = Object.keys(baseline.graphs ?? {}).length;
        const workingGraphCount = Object.keys(working.graphs ?? {}).length;

        // Mobile-item totals across all clusters (Issue 286).
        let clusterScreensTotal = 0, clusterNavRoutesTotal = 0, clusterNetworkCallsTotal = 0;
        for (const c of Object.values(working.clusters ?? {})) {
            clusterScreensTotal += (c.screensInCluster?.length ?? 0);
            clusterNavRoutesTotal += (c.navRoutesInCluster?.length ?? 0);
            clusterNetworkCallsTotal += (c.networkCallsInCluster?.length ?? 0);
        }

        // Path-traversal smoke (Issue 287). All FileRecord paths should be
        // workspace-relative (no leading `/` or `..` segments).
        let suspectFilePaths = 0;
        for (const fp of Object.keys(working.files)) {
            if (fp.startsWith('/') || fp.split('/').some(seg => seg === '..')) suspectFilePaths++;
        }

        // Route vs mobile item split (Issue 280).
        const MOBILE_METHODS = new Set(['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING']);
        let routeApiCount = 0, mobileItemCount = 0;
        for (const a of Object.values(working.apiIndex ?? {})) {
            if (MOBILE_METHODS.has(a.method)) mobileItemCount++;
            else routeApiCount++;
        }

        // Issue 369: handler-name dedup tracking. The sequence-graph builder
        // emits one graph per `(filePath, handlerName)` pair regardless of
        // how many ApiRecords share that pair (e.g. Spring `@KafkaListener`
        // × N topics on a single Java method → N records, 1 sequence graph).
        // We compute the collapse count here so an invariant test can lock
        // the relationship `apiCount - dedupedHandlerCollapses == sequenceGraphs`.
        // Mobile records don't get sequence graphs, so we exclude them from
        // both sides of the equation.
        const handlerKeyCounts = new Map<string, number>();
        for (const a of Object.values(working.apiIndex ?? {})) {
            if (MOBILE_METHODS.has(a.method)) continue;
            const key = `${a.filePath}::${a.handlerName}`;
            handlerKeyCounts.set(key, (handlerKeyCounts.get(key) ?? 0) + 1);
        }
        let dedupedHandlerCollapses = 0;
        for (const count of handlerKeyCounts.values()) {
            if (count > 1) dedupedHandlerCollapses += count - 1;
        }

        return {
            initialized: true,
            durationMs: Date.now() - start,
            fileCount: initStats.fileCount,
            apiCount: initStats.apiCount,
            graphCount: initStats.graphCount,
            parseFailures: initStats.parseFailures,
            fileGraphs, flowGraphs, sequenceGraphs,
            flowGraphsWithDecision, flowGraphsWithLoop,
            featureClusters, microservices,
            anonymousHandlers, anonymousResolved, anonymousUnresolved,
            parseFailureCount, apiListGraphs,
            fileGraphsWithEdges, sequenceGraphsWithMessages,
            healthReportPresent, callGraphEdgeCount,
            nodesWithoutLabel, duplicateNodeIdGraphs,
            microserviceGraphs, featureGraphs,
            apiListWithMembers, apiListMetaApisCount,
            sequenceParticipantsTotal, sequenceMessagesTotal,
            baselineGraphCount, workingGraphCount,
            fileGraphsWithImports, fileGraphsWithFunctions,
            fileGraphNodesTotal,
            flowGraphsWithStartEnd, flowGraphsWithMultipleStatements,
            flowGraphsTrivial,
            flowGraphAvgEdges: flowGraphs > 0 ? flowGraphEdgeSum / flowGraphs : 0,
            flowGraphMaxNodes,
            flowGraphAvgBodyNodes: flowGraphsNonTrivial > 0 ? flowGraphBodyNodeSum / flowGraphsNonTrivial : 0,
            nodesWithAnchors, anchorsInvalid,
            clusterScreensTotal, clusterNavRoutesTotal, clusterNetworkCallsTotal,
            subClusterApiListGraphs, subClusterApiListWithMembers,
            suspectFilePaths,
            routeApiCount, mobileItemCount,
            healthReportFieldsPresent,
            healthDeadCodeCount, healthCyclicDependenciesCount, healthHighCouplingFilesCount,
            classCount, functionCount, avgClassesPerFile, avgFunctionsPerFile,
            callGraphRoundTripEdges,
            distinctScreenNames, distinctNavRouteNames,
            dedupedHandlerCollapses,
            apiListsWithForeignApis,
            foreignApiTotal,
            clusterOrphanCount,
        };
    } finally {
        try { fs.rmSync(codeatlasDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
