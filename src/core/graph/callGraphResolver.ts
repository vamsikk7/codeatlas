/**
 * callGraphResolver.ts
 *
 * Builds a workspace-wide call graph across all files in a Snapshot.
 * Inspired by GitNexus's Resolution phase: resolves import chains and
 * cross-file call relationships to power community detection and impact analysis.
 *
 * Key: "<filePath>::<functionName>"
 * Edges: calls (outgoing) + calledBy (incoming)
 */

import * as path from 'path';
import { collectTopLevelEntities } from '../parser/symbolExtractor';
import type { Snapshot, FileRecord, SerializedCallGraph, SerializedCallGraphNode, SerializedCallEdge, SerializedFlatEdge, CallEdgeKind } from './graphTypes';
import type { ResolvedReceiver } from '../lsp/lspFallbackResolver';

export const CALL_GRAPH_VERSION = 2;

interface EdgeMeta { confidence: number; kind: CallEdgeKind }

/**
 * In-memory call graph used during build phase.
 * Converted to SerializedCallGraph for JSON storage.
 */
export class WorkspaceCallGraph {
    private nodes = new Map<string, SerializedCallGraphNode>();
    /** edgeMeta key = `${callerKey}→${calleeKey}` */
    private edgeMeta = new Map<string, EdgeMeta>();

    static makeKey(filePath: string, functionName: string): string {
        return `${filePath}::${functionName}`;
    }

    static edgeMetaKey(callerKey: string, calleeKey: string): string {
        return `${callerKey}→${calleeKey}`;
    }

    ensureNode(filePath: string, functionName: string): SerializedCallGraphNode {
        const key = WorkspaceCallGraph.makeKey(filePath, functionName);
        if (!this.nodes.has(key)) {
            this.nodes.set(key, { key, filePath, functionName, calls: [], calledBy: [] });
        }
        return this.nodes.get(key)!;
    }

    /**
     * Add a directed edge from caller to callee.
     * @param confidence 0.0–1.0 — how certain the resolution is
     * @param kind whether this is a function call or an import relationship
     */
    addEdge(
        callerKey: string,
        calleeKey: string,
        confidence = 0.9,
        kind: CallEdgeKind = 'calls',
    ): void {
        const caller = this.nodes.get(callerKey);
        const callee = this.nodes.get(calleeKey);
        if (!caller || !callee) return;
        if (!caller.calls.includes(calleeKey)) caller.calls.push(calleeKey);
        if (!callee.calledBy.includes(callerKey)) callee.calledBy.push(callerKey);
        const mk = WorkspaceCallGraph.edgeMetaKey(callerKey, calleeKey);
        if (!this.edgeMeta.has(mk)) {
            this.edgeMeta.set(mk, { confidence, kind });
        }
    }

    getEdgeMeta(callerKey: string, calleeKey: string): EdgeMeta | undefined {
        return this.edgeMeta.get(WorkspaceCallGraph.edgeMetaKey(callerKey, calleeKey));
    }

    getNode(key: string): SerializedCallGraphNode | undefined {
        return this.nodes.get(key);
    }

    getAllNodes(): SerializedCallGraphNode[] {
        return Array.from(this.nodes.values());
    }

    /**
     * BFS forward reachability: all functions reachable from fromKey (callees).
     */
    getReachable(fromKey: string, maxDepth = 5): Array<{ key: string; depth: number }> {
        const results: Array<{ key: string; depth: number }> = [];
        const visited = new Set<string>();
        const queue: Array<{ key: string; depth: number }> = [{ key: fromKey, depth: 0 }];
        while (queue.length > 0) {
            const { key, depth } = queue.shift()!;
            if (visited.has(key) || depth > maxDepth) continue;
            visited.add(key);
            if (key !== fromKey) results.push({ key, depth });
            const node = this.nodes.get(key);
            if (node) {
                for (const callee of node.calls) {
                    queue.push({ key: callee, depth: depth + 1 });
                }
            }
        }
        return results;
    }

    /**
     * BFS reverse reachability: all functions that (transitively) call any of the changedKeys.
     */
    getImpacted(changedKeys: string[], maxDepth = 5): Array<{ key: string; depth: number }> {
        const results: Array<{ key: string; depth: number }> = [];
        const visited = new Set<string>();
        const changedSet = new Set(changedKeys);
        const queue: Array<{ key: string; depth: number }> = changedKeys.map((k) => ({ key: k, depth: 0 }));
        while (queue.length > 0) {
            const { key, depth } = queue.shift()!;
            if (visited.has(key) || depth > maxDepth) continue;
            visited.add(key);
            if (!changedSet.has(key)) results.push({ key, depth });
            const node = this.nodes.get(key);
            if (node) {
                for (const caller of node.calledBy) {
                    queue.push({ key: caller, depth: depth + 1 });
                }
            }
        }
        return results;
    }

    /**
     * Confidence/kind-filtered BFS reverse reachability.
     * Falls back to unfiltered behaviour when edgeMeta is empty.
     */
    getImpactedFiltered(
        changedKeys: string[],
        opts: { maxDepth: number; minConfidence: number; kinds: CallEdgeKind[] },
    ): Array<{ key: string; depth: number; confidence: number; kind: CallEdgeKind }> {
        const { maxDepth, minConfidence, kinds } = opts;
        const kindSet = new Set(kinds);
        const results: Array<{ key: string; depth: number; confidence: number; kind: CallEdgeKind }> = [];
        const visited = new Set<string>();
        const changedSet = new Set(changedKeys);
        const queue: Array<{ key: string; depth: number; confidence: number; kind: CallEdgeKind }> =
            changedKeys.map((k) => ({ key: k, depth: 0, confidence: 1, kind: 'calls' as CallEdgeKind }));

        while (queue.length > 0) {
            const item = queue.shift()!;
            if (visited.has(item.key) || item.depth > maxDepth) continue;
            visited.add(item.key);
            if (!changedSet.has(item.key)) {
                results.push(item);
            }
            const node = this.nodes.get(item.key);
            if (!node) continue;
            for (const callerKey of node.calledBy) {
                const meta = this.edgeMeta.get(WorkspaceCallGraph.edgeMetaKey(callerKey, item.key));
                const conf = meta?.confidence ?? 1.0;
                const kind = meta?.kind ?? 'calls';
                if (conf < minConfidence) continue;
                if (!kindSet.has(kind)) continue;
                queue.push({ key: callerKey, depth: item.depth + 1, confidence: conf, kind });
            }
        }
        return results;
    }

    serialize(): SerializedCallGraph {
        const result: SerializedCallGraph = { nodes: {}, edges: [], version: CALL_GRAPH_VERSION };
        for (const [key, node] of this.nodes.entries()) {
            // Build callEdges array from edgeMeta
            const callEdges: SerializedCallEdge[] = node.calls.map((calleeKey) => {
                const meta = this.edgeMeta.get(WorkspaceCallGraph.edgeMetaKey(key, calleeKey));
                return { key: calleeKey, confidence: meta?.confidence ?? 1.0, kind: meta?.kind ?? 'calls' };
            });
            result.nodes[key] = { ...node, callEdges };
            // Also flatten into top-level edges array
            for (const ce of callEdges) {
                result.edges.push({ callerKey: key, calleeKey: ce.key, confidence: ce.confidence, kind: ce.kind });
            }
        }
        return result;
    }

    static deserialize(data: SerializedCallGraph): WorkspaceCallGraph {
        const graph = new WorkspaceCallGraph();
        for (const [key, node] of Object.entries(data.nodes)) {
            graph.nodes.set(key, { ...node });
            // Restore edgeMeta from callEdges if present
            if (node.callEdges) {
                for (const ce of node.callEdges) {
                    graph.edgeMeta.set(WorkspaceCallGraph.edgeMetaKey(key, ce.key), {
                        confidence: ce.confidence,
                        kind: ce.kind,
                    });
                }
            }
        }
        return graph;
    }
}

/**
 * Resolve an import path like './userService' or '../auth/jwt' to
 * a workspace-relative file path that exists in the snapshot.
 */
export function resolveImportPath(
    importPath: string,
    currentFilePath: string,
    snapshotFiles: Record<string, unknown>
): string | undefined {
    // Only resolve relative imports — skip package imports
    if (!importPath.startsWith('.')) return undefined;

    const currentDir = path.dirname(currentFilePath);
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];

    // Strip any existing extension from the import path
    let base = importPath;
    for (const ext of ['.ts', '.js', '.tsx', '.jsx']) {
        if (base.endsWith(ext)) {
            base = base.slice(0, -ext.length);
            break;
        }
    }

    for (const ext of extensions) {
        // path.join normalizes '..' and '.' segments
        const resolved = path.join(currentDir, base + ext).replace(/\\/g, '/');
        if (snapshotFiles[resolved] !== undefined) {
            return resolved;
        }
    }
    return undefined;
}

/** Strip a source-file extension (`.py`, `.rb`, …) from a path segment. */
function stripSourceExt(name: string): string {
    return name.replace(/\.(py|rb|go|java|kt|php|rs|cs|swift|dart|ts|js|tsx|jsx|mjs|cjs|mts|cts)$/, '');
}

/**
 * BUG-L5-WRONGFILE: resolve a non-JS module import (Python dotted `polar.authz.service`,
 * Go/PHP slash paths, Java packages) to a concrete workspace-relative file.
 *
 * The previous inline resolver matched purely on the LAST path segment
 * (`service`) and returned the FIRST file with that basename — so in a repo with
 * dozens of same-basename files (`polar/account/service.py`,
 * `polar/authz/service.py`, `polar/customer/service.py`, …) an import of
 * `polar.authz.service` could resolve to `polar/account/service.py`, sending L5
 * navigation to the wrong file ("Function get_accessible_org_ids not found").
 *
 * The import path already disambiguates the collision — `polar.authz.service`
 * uniquely names `polar/authz/service.py`. We honour it by converting the dotted
 * / slashed module path to a `/`-separated suffix and preferring the file whose
 * path ends with that qualified suffix. Bare-basename matching is kept only as a
 * last-resort fallback so previously-resolving single-basename repos are
 * unaffected.
 *
 * @param importPath  The import `source` (e.g. `polar.authz.service`, `.factors`, `pkg/sub/mod`)
 * @param currentFilePath  The importing file's workspace-relative path (for relative imports)
 * @param files  All workspace-relative file paths in the snapshot
 * @returns the matched workspace-relative file path, or undefined
 */
export function resolveNonJsModulePath(
    importPath: string,
    currentFilePath: string | undefined,
    files: string[],
): string | undefined {
    // Split the import into path segments. Slash-style paths (Go/PHP) split on
    // '/', dotted modules (Python/Java) split on '.'. A leading-dot relative
    // Python import (`.factors`, `..models.user`) also uses dotted segments.
    const isSlashPath = importPath.includes('/');
    const rawSegments = (isSlashPath ? importPath.split('/') : importPath.split('.')).filter(Boolean);
    const lastSegment = rawSegments.length ? rawSegments[rawSegments.length - 1] : undefined;
    if (!lastSegment) return undefined;

    // Relative Python imports (starting with '.') — resolve relative to the
    // importing file's directory. Honour intermediate segments too (`..a.b` →
    // parent dir + a/ + b) so a deep relative import doesn't collide on basename.
    if (importPath.startsWith('.') && currentFilePath) {
        const currentDir = currentFilePath.includes('/') ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/')) : '';
        for (const f of files) {
            const fDir = f.includes('/') ? f.substring(0, f.lastIndexOf('/')) : '';
            if (fDir !== currentDir) continue;
            const nameWithoutExt = stripSourceExt(f.split('/').pop() || f);
            if (nameWithoutExt === lastSegment) return f;
        }
    }

    // Path-qualified match: prefer a file whose path ends with the FULL module
    // suffix (`polar/authz/service`), not just its basename. This disambiguates
    // same-basename collisions using the import's package path.
    if (rawSegments.length > 1) {
        const suffix = '/' + rawSegments.join('/');
        let best: string | undefined;
        for (const f of files) {
            const noExt = stripSourceExt(f);
            if (noExt === rawSegments.join('/') || noExt.endsWith(suffix)) {
                // Longest file path among suffix matches wins (most specific).
                if (!best || f.length > best.length) best = f;
            }
        }
        if (best) return best;

        // Progressive shortening: some layouts drop leading package roots
        // (a `src/` prefix, an app root). Try successively shorter tails
        // (`authz/service`) before giving up, still preferring path context
        // over a bare basename.
        for (let start = 1; start < rawSegments.length - 1; start++) {
            const tail = rawSegments.slice(start).join('/');
            const tailSuffix = '/' + tail;
            let tailBest: string | undefined;
            for (const f of files) {
                const noExt = stripSourceExt(f);
                if (noExt.endsWith(tailSuffix)) {
                    if (!tailBest || f.length > tailBest.length) tailBest = f;
                }
            }
            if (tailBest) return tailBest;
        }
    }

    // Last resort: bare-basename match (first file whose basename matches). Kept
    // for backwards compatibility with single-basename repos and single-segment
    // imports where no path context is available to disambiguate.
    for (const f of files) {
        const nameWithoutExt = stripSourceExt(f.split('/').pop() || f);
        if (nameWithoutExt === lastSegment) return f;
    }
    return undefined;
}

/**
 * #444-A-cohesion: build intra-file edges for non-JS files from the
 * `symbols.functions[].calls` array that the tree-sitter extractor
 * populated. The raw call names are unqualified (`Send`) while the
 * function entity names may be class-prefixed (`ArticlesController.Send`),
 * so we match by either exact name OR by the `.<call>` suffix.
 */
/**
 * Workspace-wide index: short function name → every (filePath, FQN) that
 * defines it. Class methods are indexed under BOTH their FQN (`Class.method`)
 * and their bare method name (`method`) so a `receiver.method()` call can find
 * the method in another file. Used by MCP-EVAL-1/2 cross-file resolution.
 */
/** Above this many definitions a name is too ambiguous to resolve cross-file
 *  (and filtering it per call site is quadratic on huge repos). */
const MAX_CROSS_FILE_CANDIDATES = 20;

export function buildWorkspaceFnIndex(files: Record<string, FileRecord>): Map<string, Array<{ filePath: string; fnName: string }>> {
    const index = new Map<string, Array<{ filePath: string; fnName: string }>>();
    const add = (name: string, filePath: string, fnName: string) => {
        let arr = index.get(name);
        if (!arr) { arr = []; index.set(name, arr); }
        arr.push({ filePath, fnName });
    };
    for (const [filePath, rec] of Object.entries(files)) {
        for (const fn of rec.symbols?.functions ?? []) {
            if (!fn?.name || fn.kind === 'class') continue;
            add(fn.name, filePath, fn.name);
            const dot = fn.name.lastIndexOf('.');
            if (dot >= 0) add(fn.name.slice(dot + 1), filePath, fn.name);
        }
    }
    return index;
}

/** Last meaningful segment of an import source: `.utils`→`utils`, `polar.customer.service`→`service`, `./a/b`→`b`. */
function lastModuleSegment(source: string): string {
    const cleaned = source.replace(/^[.\/]+/, '').replace(/\.(py|rb|go|java|kt|php|rs|cs|swift|dart)$/, '');
    const segs = cleaned.split(/[/.]/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : '';
}

/** Does `filePath`'s basename (no extension) equal the import source segment? */
function fileBaseMatchesSource(filePath: string, srcSegment: string): boolean {
    if (!srcSegment) return false;
    const base = (filePath.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    return base === srcSegment;
}

function buildNonJsEdges(
    filePath: string,
    fileRecord: FileRecord,
    graph: WorkspaceCallGraph,
    fnIndex?: Map<string, Array<{ filePath: string; fnName: string }>>,
): void {
    const functions = fileRecord.symbols?.functions ?? [];
    if (functions.length === 0) return;

    // Build a quick lookup: raw call name → FQN function name in this file.
    // Prefer exact match; fall back to suffix match (`.<name>`) for class methods.
    const nameToFqn = new Map<string, string>();
    for (const fn of functions) {
        if (!fn || !fn.name) continue;
        nameToFqn.set(fn.name, fn.name);
        const dotIdx = fn.name.lastIndexOf('.');
        if (dotIdx >= 0) {
            const suffix = fn.name.slice(dotIdx + 1);
            // Don't overwrite an existing exact match.
            if (!nameToFqn.has(suffix)) nameToFqn.set(suffix, fn.name);
        }
    }

    // MCP-EVAL-1/2: imported name → source module, for import-gated cross-file
    // resolution. Non-JS files previously got INTRA-file edges only, so Python
    // endpoints calling imported free functions / service methods in another
    // file had zero downstream edges (get_function_dependencies / trace_call_path
    // returned empty). We resolve a call ONLY when the file actually imports the
    // name — no blind name-matching — and prefer a definition whose file matches
    // the import source (`.utils` → …/utils.py) to disambiguate.
    const importedNameToSource = new Map<string, string>();
    for (const imp of fileRecord.symbols?.imports ?? []) {
        for (const spec of imp.specifiers ?? []) {
            if (spec.local) importedNameToSource.set(spec.local, imp.source);
            if (spec.imported) importedNameToSource.set(spec.imported, imp.source);
        }
    }

    const addCrossFileEdges = (callerKey: string, name: string, source: string): void => {
        if (!fnIndex) return;
        const raw = fnIndex.get(name);
        if (!raw || raw.length === 0) return;
        // PERF/O(n²) guard — a name defined in MANY files (a common method like
        // `get` / `create` / `list` / `__init__`) is too ambiguous to resolve to a
        // single call target, and filtering a huge candidate list per call site is
        // quadratic on large repos (polar's server: 1705 files, thousands of
        // `obj.get()` calls). This blocked the event loop for minutes on the
        // post-init aggregate call-graph build. Skip over-common names entirely.
        if (raw.length > MAX_CROSS_FILE_CANDIDATES) return;
        const candidates = raw.filter((c) => c.filePath !== filePath);
        if (candidates.length === 0) return;
        const seg = lastModuleSegment(source);
        const preferred = candidates.filter((c) => fileBaseMatchesSource(c.filePath, seg));
        const chosen = preferred.length ? preferred : candidates;
        // Cap to avoid an edge explosion on very common names in huge repos.
        for (const c of chosen.slice(0, 4)) {
            const calleeKey = WorkspaceCallGraph.makeKey(c.filePath, c.fnName);
            graph.ensureNode(c.filePath, c.fnName);
            graph.addEdge(callerKey, calleeKey, 0.7, 'calls');
        }
    };

    for (const fn of functions) {
        if (!fn?.name || fn.kind === 'class') continue;
        const callerKey = WorkspaceCallGraph.makeKey(filePath, fn.name);
        graph.ensureNode(filePath, fn.name);

        const calls: string[] = Array.isArray((fn as any).calls) ? (fn as any).calls : [];
        for (const rawName of calls) {
            const resolved = nameToFqn.get(rawName);
            // Intra-file — but skip a spurious self-edge (a member-call method
            // whose name happens to match the caller's own name, e.g.
            // `customer_service.add_payment_method` inside `add_payment_method`).
            if (resolved && resolved !== fn.name) {
                const calleeKey = WorkspaceCallGraph.makeKey(filePath, resolved);
                graph.ensureNode(filePath, resolved);
                graph.addEdge(callerKey, calleeKey, 0.85, 'calls');
                continue;
            }
            // Cross-file: only if the file IMPORTS this exact name.
            const source = importedNameToSource.get(rawName);
            if (source) addCrossFileEdges(callerKey, rawName, source);
        }

        // Member calls `receiver.method()` — resolve the method cross-file when
        // the receiver is an imported symbol (e.g. `customer_service` from
        // `.service`). `self`/`this`/`cls` receivers resolve intra-file via the
        // flat `calls` above, so we only handle imported receivers here.
        const memberCalls = (fn as any).memberCalls as Record<string, string[]> | undefined;
        if (memberCalls) {
            for (const [receiver, methods] of Object.entries(memberCalls)) {
                const source = importedNameToSource.get(receiver);
                if (!source) continue;
                for (const method of methods ?? []) {
                    addCrossFileEdges(callerKey, method, source);
                }
            }
        }
    }
}

/**
 * Build a workspace-wide call graph from all files in the snapshot.
 * Re-parses file content (stored in FileRecord.content) to extract
 * precise intra- and cross-file function call relationships.
 */
export function buildCallGraph(
    snapshot: Snapshot,
    importFallbackResolver?: { resolveFromSnapshot: (typeName: string, snapshotFiles: Record<string, FileRecord>) => ResolvedReceiver | null },
    // #775 (2026-06-06) — lazy-content fallback. Snapshot files lose
    // their inline `.content` after every save (`SnapshotStore`
    // optimisation #354/#355). On every rebuild the call-graph builder
    // saw `fileRecord.content === undefined` and skipped every file →
    // zero cross-file edges → every cluster reported 0% cohesion. The
    // caller now passes its `store.getFileContent('working', fp)` so
    // we can re-hydrate content when the snapshot has dropped it.
    getFileContent?: (filePath: string) => string | undefined,
): WorkspaceCallGraph {
    const graph = new WorkspaceCallGraph();
    const files = snapshot.files;

    // Phase 1: Register all known functions as nodes
    for (const [filePath, fileRecord] of Object.entries(files)) {
        for (const fn of fileRecord.symbols?.functions ?? []) {
            graph.ensureNode(filePath, fn.name);
        }
    }

    // MCP-EVAL-1/2: workspace-wide function-name index for non-JS cross-file
    // call resolution (see buildNonJsEdges). Built once after all nodes exist.
    const fnIndex = buildWorkspaceFnIndex(files);

    // Phase 2: Build edges
    //
    // #444-A-cohesion: for non-JS files, the JS-only `collectTopLevelEntities`
    // throws and was being silently swallowed — so C# / Java / Python / Go /
    // Rust / Kotlin / PHP / Ruby / Swift / Dart files contributed zero edges
    // to the workspace call graph. That made every non-JS cluster's cohesion
    // metric `0 / external = 0%`. For non-JS files, fall back to the pre-
    // extracted `fileRecord.symbols.functions[].calls` array which the tree-
    // sitter `extractCalls` walker already populated.
    const isJsLike = (fp: string) => /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(fp);

    for (const [filePath, fileRecord] of Object.entries(files)) {
        if (!isJsLike(filePath)) {
            buildNonJsEdges(filePath, fileRecord, graph, fnIndex);
            continue;
        }

        const content = fileRecord.content ?? getFileContent?.(filePath);
        if (!content) continue;

        let analysis;
        try {
            analysis = collectTopLevelEntities(content, filePath);
        } catch {
            continue;
        }

        // importsByLocal: localName → source module path
        const importsByLocal = analysis.importsByLocal;

        // Resolve import paths to actual workspace-relative file paths
        const resolvedImports = new Map<string, string>(); // localName → resolvedFilePath
        for (const [localName, importSrc] of importsByLocal.entries()) {
            let resolved = resolveImportPath(importSrc, filePath, files);
            // LSP fallback: try snapshot scan when path resolution fails
            if (!resolved && importFallbackResolver) {
                const fallback = importFallbackResolver.resolveFromSnapshot(localName, files);
                if (fallback) resolved = fallback.filePath;
            }
            if (resolved) resolvedImports.set(localName, resolved);
        }

        for (const fn of analysis.funcs.values()) {
            const callerKey = WorkspaceCallGraph.makeKey(filePath, fn.name);
            // Ensure caller exists
            graph.ensureNode(filePath, fn.name);

            // Intra-file calls — high confidence direct resolution
            if (fn.calls) {
                for (const calleeName of fn.calls) {
                    const calleeKey = WorkspaceCallGraph.makeKey(filePath, calleeName);
                    graph.ensureNode(filePath, calleeName);
                    graph.addEdge(callerKey, calleeKey, 0.9, 'calls');
                }
            }

            // Cross-file calls via imports
            if (fn.usesImports) {
                for (const localName of fn.usesImports) {
                    const resolvedFile = resolvedImports.get(localName);
                    if (!resolvedFile) continue;

                    const targetFile = files[resolvedFile];
                    if (!targetFile) continue;

                    // Match the local import name to a function in the target file
                    let directMatched = false;
                    for (const targetFn of targetFile.symbols?.functions ?? []) {
                        // Direct name match: import { foo } from './bar' → bar::foo  (confidence 0.85)
                        if (targetFn.name === localName) {
                            const calleeKey = WorkspaceCallGraph.makeKey(resolvedFile, targetFn.name);
                            graph.ensureNode(resolvedFile, targetFn.name);
                            graph.addEdge(callerKey, calleeKey, 0.85, 'calls');
                            directMatched = true;
                        }
                    }

                    // Default-export heuristic: lower confidence (0.6) since we're guessing
                    if (!directMatched && (targetFile.symbols?.functions?.length ?? 0) > 0) {
                        const defaultFn = targetFile.symbols!.functions[0];
                        const calleeKey = WorkspaceCallGraph.makeKey(resolvedFile, defaultFn.name);
                        graph.ensureNode(resolvedFile, defaultFn.name);
                        graph.addEdge(callerKey, calleeKey, 0.6, 'calls');
                        directMatched = true;
                    }

                    // Issue 265 follow-up: target file has no function symbols
                    // but does have a `module.exports = <expr>` variable (CJS
                    // expression-export, common in koa/express demo apps). Use
                    // the local import name itself as a synthetic callee so
                    // the call graph reflects the import dependency.
                    if (!directMatched) {
                        const hasModuleExports = (targetFile.symbols?.variables ?? [])
                            .some(v => v.name === 'module.exports' || v.name === 'default');
                        if (hasModuleExports) {
                            const calleeKey = WorkspaceCallGraph.makeKey(resolvedFile, localName);
                            graph.ensureNode(resolvedFile, localName);
                            graph.addEdge(callerKey, calleeKey, 0.5, 'imports');
                        }
                    }
                }
            }
        }
    }

    return graph;
}

/**
 * Get all function keys belonging to a set of file paths.
 */
export function getFunctionKeysForFiles(
    filePaths: string[],
    graph: WorkspaceCallGraph
): string[] {
    const fileSet = new Set(filePaths);
    return graph.getAllNodes()
        .filter((n) => fileSet.has(n.filePath))
        .map((n) => n.key);
}
