/**
 * impactAnalyzer.ts
 *
 * Blast radius analysis — given a set of changed files, determine what else
 * is affected across all 5 diagram layers.
 *
 * Inspired by GitNexus's `impact` MCP tool which provides depth-grouped
 * blast radius with confidence scoring and relation-type filtering.
 */

import type {
    Snapshot,
    CallEdgeKind,
} from '../graph/graphTypes';
import { WorkspaceCallGraph, buildCallGraph, getFunctionKeysForFiles, resolveImportPath } from '../graph/callGraphResolver';
import { findClusterForFile } from './communityDetector';
import { getLazyGraphMap } from '../storage/lazyGraphMap';
import { parseGraphId } from '../graph/graphIdBuilder';

export type ImpactKind = 'direct' | 'transitive' | 'review-required';
/** @deprecated Use ImpactKind */
export type ImpactConfidence = ImpactKind;

/** Options for blast-radius analysis — all fields optional with sensible defaults */
export interface ImpactOptions {
    /** How many hops to follow in reverse call graph (default 4) */
    maxDepth?: number;
    /** Only include edges with confidence ≥ this value, 0–1 (default 0 = no filter) */
    minConfidence?: number;
    /** Limit traversal to specific edge kinds (default: both calls and imports) */
    relationTypes?: CallEdgeKind[];
    /** Include files whose path contains 'test' or 'spec' (default true) */
    includeTests?: boolean;
}

export interface ImpactedFunction {
    key: string;             // "<filePath>::<functionName>"
    filePath: string;
    functionName: string;
    depth: number;           // 0 = direct (own), 1 = immediate caller, 2+ = transitive
    impactKind: ImpactKind;  // 'direct' | 'transitive' | 'review-required'
    edgeConfidence?: number; // numeric confidence of the traversed edge (0.0–1.0)
    edgeKind?: CallEdgeKind; // relation kind of the traversed edge
}

export interface ImpactResult {
    changedFiles: string[];
    changedFunctionKeys: string[];
    impactedFunctions: ImpactedFunction[];
    affectedClusterIds: string[];
    affectedServiceIds: string[];
    affectedSequenceGraphIds: string[];
    affectedFileGraphIds: string[];
    affectedFlowGraphIds: string[];
    options: Required<ImpactOptions>;
    summary: {
        directImpacts: number;     // functions in the changed files themselves
        transitiveImpacts: number; // functions reachable via call edges
        reviewRequired: number;    // functions in import-only dependents
        clustersAffected: number;
        servicesAffected: number;
    };
}

const TEST_PATH_PATTERN = /[/\\](tests?|__tests?__|spec)[/\\]|\.test\.|\.spec\./i;

/**
 * Analyze the blast radius of a set of changed files.
 *
 * @param changedFilePaths - workspace-relative paths of changed files
 * @param snapshot - working snapshot with call graph, clusters, services
 * @param options - filtering options (maxDepth, minConfidence, relationTypes, includeTests)
 */
export function analyzeImpact(
    changedFilePaths: string[],
    snapshot: Snapshot,
    options: ImpactOptions | number = {}
): ImpactResult {
    // Backwards compat: old callers may pass maxDepth as a number
    const opts: Required<ImpactOptions> = typeof options === 'number'
        ? { maxDepth: options, minConfidence: 0, relationTypes: ['calls', 'imports'], includeTests: true }
        : {
            maxDepth: options.maxDepth ?? 4,
            minConfidence: options.minConfidence ?? 0,
            relationTypes: options.relationTypes ?? ['calls', 'imports'],
            includeTests: options.includeTests ?? true,
        };

    // Rebuild or reuse call graph (accept both version 1 and 2)
    let graph: WorkspaceCallGraph;
    if (snapshot.callGraph) {
        graph = WorkspaceCallGraph.deserialize(snapshot.callGraph);
    } else {
        graph = buildCallGraph(snapshot);
    }

    const changedFileSet = new Set(changedFilePaths);

    // All function keys defined in changed files
    const changedFunctionKeys = getFunctionKeysForFiles(changedFilePaths, graph);

    // --- Direct entries: functions in the changed files themselves (depth 0) ---
    const directEntries: ImpactedFunction[] = changedFunctionKeys.map((key) => {
        const sep = key.indexOf('::');
        const filePath = sep >= 0 ? key.slice(0, sep) : key;
        const functionName = sep >= 0 ? key.slice(sep + 2) : key;
        return { key, filePath, functionName, depth: 0, impactKind: 'direct' };
    });

    // --- BFS transitive entries: callers reachable via call/import edges ---
    // Choose BFS strategy: filtered (when edgeMeta available) vs plain
    const hasEdgeMeta = (snapshot.callGraph?.edges?.length ?? 0) > 0 ||
        (snapshot.callGraph?.nodes &&
            Object.values(snapshot.callGraph.nodes).some((n) => (n.callEdges?.length ?? 0) > 0));

    let bfsImpacted: ImpactedFunction[];

    if (hasEdgeMeta && (opts.minConfidence > 0 || opts.relationTypes.length < 2)) {
        // Use confidence/kind-filtered BFS
        const rawFiltered = graph.getImpactedFiltered(changedFunctionKeys, {
            maxDepth: opts.maxDepth,
            minConfidence: opts.minConfidence,
            kinds: opts.relationTypes,
        });
        bfsImpacted = rawFiltered.map(({ key, depth, confidence, kind }) => {
            const sep = key.indexOf('::');
            const filePath = sep >= 0 ? key.slice(0, sep) : key;
            const functionName = sep >= 0 ? key.slice(sep + 2) : key;
            return { key, filePath, functionName, depth, impactKind: 'transitive' as ImpactKind, edgeConfidence: confidence, edgeKind: kind };
        });
    } else {
        // Plain BFS (no filtering needed or no edgeMeta)
        const impactedRaw = graph.getImpacted(changedFunctionKeys, opts.maxDepth);
        bfsImpacted = impactedRaw.map(({ key, depth }) => {
            const sep = key.indexOf('::');
            const filePath = sep >= 0 ? key.slice(0, sep) : key;
            const functionName = sep >= 0 ? key.slice(sep + 2) : key;
            return { key, filePath, functionName, depth, impactKind: 'transitive' as ImpactKind };
        });
    }

    // --- Review-required entries: files that import changed files but have no call-path ---
    const bfsKeySet = new Set(bfsImpacted.map((f) => f.key));
    const directKeySet = new Set(changedFunctionKeys);
    const reviewRequiredEntries: ImpactedFunction[] = [];

    // Build a map of filePath → call-graph nodes for efficient lookup
    const nodesByFile = new Map<string, Array<{ key: string; functionName: string }>>();
    for (const node of graph.getAllNodes()) {
        if (!nodesByFile.has(node.filePath)) nodesByFile.set(node.filePath, []);
        nodesByFile.get(node.filePath)!.push({ key: node.key, functionName: node.functionName });
    }

    // Issue 219: Build transitive import chain — files that import changed files,
    // AND files that import those files (up to 3 hops)
    const affectedFiles = new Set<string>(changedFileSet);
    for (let hop = 0; hop < 3; hop++) {
        const newAffected: string[] = [];
        for (const [fp, rec] of Object.entries(snapshot.files)) {
            if (affectedFiles.has(fp)) continue;
            const importsAffected = (rec.symbols?.imports ?? []).some((imp) => {
                const resolved = resolveImportPath(imp.source, fp, snapshot.files);
                return resolved !== undefined && affectedFiles.has(resolved);
            });
            if (importsAffected) newAffected.push(fp);
        }
        if (newAffected.length === 0) break;
        newAffected.forEach(f => affectedFiles.add(f));
    }

    const seenReview = new Set<string>();
    for (const [filePath, fileRecord] of Object.entries(snapshot.files)) {
        if (changedFileSet.has(filePath)) continue;
        const importsAffectedFile = (fileRecord.symbols?.imports ?? []).some((imp) => {
            const resolved = resolveImportPath(imp.source, filePath, snapshot.files);
            return resolved !== undefined && affectedFiles.has(resolved);
        });
        if (!importsAffectedFile) continue;

        for (const node of nodesByFile.get(filePath) ?? []) {
            if (directKeySet.has(node.key) || bfsKeySet.has(node.key) || seenReview.has(node.key)) continue;
            reviewRequiredEntries.push({
                key: node.key,
                filePath,
                functionName: node.functionName,
                depth: 1,
                impactKind: 'review-required',
            });
            seenReview.add(node.key);
        }
    }

    // Combine all entries and apply test-file filter
    let impactedFunctions: ImpactedFunction[] = [...directEntries, ...bfsImpacted, ...reviewRequiredEntries];

    if (!opts.includeTests) {
        impactedFunctions = impactedFunctions.filter(
            (f) => !TEST_PATH_PATTERN.test(f.filePath)
        );
    }

    // Collect all affected file paths (changed + impacted)
    const allAffectedFiles = new Set<string>([
        ...changedFilePaths,
        ...impactedFunctions.map((f) => f.filePath),
    ]);

    // Map to affected clusters
    const affectedClusterIds = new Set<string>();
    if (snapshot.clusters) {
        for (const fp of allAffectedFiles) {
            const cluster = findClusterForFile(fp, snapshot.clusters);
            if (cluster) affectedClusterIds.add(cluster.id);
        }
    }

    // Map to affected services
    const affectedServiceIds = new Set<string>();
    if (snapshot.services) {
        for (const service of Object.values(snapshot.services)) {
            const serviceRoot = service.rootPath;
            for (const fp of allAffectedFiles) {
                if (fp.startsWith(serviceRoot) || serviceRoot === '' || serviceRoot === '.') {
                    affectedServiceIds.add(service.id);
                    break;
                }
            }
        }
    }

    // Map to affected graph IDs
    const affectedSequenceGraphIds: string[] = [];
    const affectedFileGraphIds: string[] = [];
    const affectedFlowGraphIds: string[] = [];

    // Optimization (#355 — Telemetry not gated on `vscode.env.isTelemetryEnabled`): file:/flow: graphs only need the graphId (no body
    // fetch). sequence: graphs need `g.nodes` for anchor checks. When the
    // graphs Map is lazy-backed, iterate keys without fetching, then pull
    // bodies only for sequence candidates.
    const lazyMap = getLazyGraphMap(snapshot.graphs);
    const allGraphIds = lazyMap ? lazyMap.keys() : Object.keys(snapshot.graphs);
    for (const graphId of allGraphIds) {
        // Issue #362 Phase B (2026-06-07) — structured parse.
        const parsed = parseGraphId(graphId);
        if (!parsed) continue;
        if (parsed.type === 'sequence') {
            const seqFilePath = parsed.parts[0] ?? '';
            const matchesFilePath = changedFileSet.has(seqFilePath);
            if (matchesFilePath) {
                affectedSequenceGraphIds.push(graphId);
                continue;
            }
            // Need body for anchor check.
            const g = lazyMap ? lazyMap.get(graphId) : snapshot.graphs[graphId];
            if (g && g.nodes.some((n: any) => allAffectedFiles.has(n.anchor?.filePath))) {
                affectedSequenceGraphIds.push(graphId);
            }
        } else if (parsed.type === 'file') {
            const fp = parsed.parts[0] ?? '';
            if (allAffectedFiles.has(fp)) affectedFileGraphIds.push(graphId);
        } else if (parsed.type === 'flow') {
            const fp = parsed.parts[0] ?? '';
            if (allAffectedFiles.has(fp)) affectedFlowGraphIds.push(graphId);
        }
    }

    const directImpacts = impactedFunctions.filter((f) => f.impactKind === 'direct').length;
    const transitiveImpacts = impactedFunctions.filter((f) => f.impactKind === 'transitive').length;
    const reviewRequired = impactedFunctions.filter((f) => f.impactKind === 'review-required').length;

    return {
        changedFiles: changedFilePaths,
        changedFunctionKeys,
        impactedFunctions,
        affectedClusterIds: [...affectedClusterIds],
        affectedServiceIds: [...affectedServiceIds],
        affectedSequenceGraphIds,
        affectedFileGraphIds,
        affectedFlowGraphIds,
        options: opts,
        summary: {
            directImpacts,
            transitiveImpacts,
            reviewRequired,
            clustersAffected: affectedClusterIds.size,
            servicesAffected: affectedServiceIds.size,
        },
    };
}

/**
 * Lightweight version: just returns which graph IDs need rebuilding.
 */
export function getGraphIdsToRebuild(
    changedFilePaths: string[],
    snapshot: Snapshot
): string[] {
    const impact = analyzeImpact(changedFilePaths, snapshot, { maxDepth: 3 });
    return [
        ...impact.affectedSequenceGraphIds,
        ...impact.affectedFileGraphIds,
        ...impact.affectedFlowGraphIds,
    ];
}
