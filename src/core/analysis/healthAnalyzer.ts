/**
 * healthAnalyzer.ts
 *
 * Analyzes code health signals from a Snapshot + call graph:
 *   - Dead code: functions with no callers that are not API handlers or exports
 *   - God files: files with too many symbols (configurable threshold)
 *   - High coupling: files with too many incoming or outgoing edges
 *   - Cyclic dependencies: import cycles (A → B → C → A)
 *   - Orphaned clusters: clusters with zero cross-cluster call edges
 */

import type { Snapshot, FeatureCluster, SerializedCallGraph } from '../graph/graphTypes';

export interface HealthReport {
    deadFunctions: string[];           // function keys never called
    godFiles: string[];                // file paths with > threshold symbols
    highCouplingFiles: string[];       // file paths with > threshold edges
    cyclicDependencies: string[][];    // each inner array is one cycle (file paths)
    orphanedClusters: string[];        // cluster IDs with no cross-cluster calls
}

export interface HealthOptions {
    /** Minimum symbol count to flag a file as a "god file". Default: 15 */
    godFileThreshold: number;
    /** Edge count (per direction) to flag high coupling. Default: 10 */
    highCouplingThreshold: number;
    /** Whether to detect dead code. Default: true */
    deadCodeEnabled: boolean;
}

export const DEFAULT_HEALTH_OPTIONS: HealthOptions = {
    godFileThreshold: 15,
    highCouplingThreshold: 10,
    deadCodeEnabled: true,
};

/**
 * Analyze code health from the current snapshot and serialized call graph.
 */
export function analyzeHealth(
    snapshot: Snapshot,
    options?: Partial<HealthOptions>,
): HealthReport {
    const opts = { ...DEFAULT_HEALTH_OPTIONS, ...options };
    const callGraph = snapshot.callGraph;
    const files = snapshot.files;
    const clusters = snapshot.clusters ?? {};

    const deadFunctions = opts.deadCodeEnabled ? findDeadFunctions(snapshot, callGraph) : [];
    const godFiles = findGodFiles(files, opts.godFileThreshold);
    const highCouplingFiles = findHighCouplingFiles(callGraph, opts.highCouplingThreshold);
    const cyclicDependencies = findCyclicDependencies(files);
    const orphanedClusters = findOrphanedClusters(clusters, callGraph, snapshot);

    return {
        deadFunctions,
        godFiles,
        highCouplingFiles,
        cyclicDependencies,
        orphanedClusters,
    };
}

// ─── Dead Code ─────────────────────────────────────────────────────────────

/**
 * Functions that have no incoming call edges and are NOT:
 *   - API handlers (appear in apiIndex)
 *   - Exported from their module
 *   - Entry points (e.g. 'main', 'activate', etc.)
 */
function findDeadFunctions(
    snapshot: Snapshot,
    callGraph?: SerializedCallGraph,
): string[] {
    if (!callGraph) return [];

    // Build set of API handler function names per file
    const bareLeaf = (n: string) => (n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : n);
    const baseFile = (p: string) => (p.split('/').pop() ?? p);
    const apiHandlerKeys = new Set<string>();
    // BUG-HEALTH-DEADCODE: decorator-registered route handlers (FastAPI `@router.*`,
    // NestJS `@Controller`) ARE in the apiIndex, but the callGraph key can differ by
    // path-prefix or class-qualification (`ArticleController.findAll` vs `findAll`,
    // `server/…/endpoints.py` vs `…/endpoints.py`) so the exact-key match misses and
    // the handler is wrongly reported dead. A tolerant `basename::bareName` set closes
    // that gap while staying file-scoped.
    const apiHandlerLooseKeys = new Set<string>();
    for (const api of Object.values(snapshot.apiIndex ?? {})) {
        if (api.filePath && api.handlerName) {
            apiHandlerKeys.add(`${api.filePath}::${api.handlerName}`);
            apiHandlerLooseKeys.add(`${baseFile(api.filePath)}::${bareLeaf(api.handlerName)}`);
        }
    }

    // Issue 140: Build set of function names that are imported by other files.
    // Functions imported from another file are "used" even if the call graph doesn't
    // trace through anonymous callbacks (e.g., Express route handlers).
    const importedFunctionNames = new Set<string>();
    for (const record of Object.values(snapshot.files)) {
        for (const imp of record.symbols?.imports ?? []) {
            for (const spec of imp.specifiers ?? []) {
                if (spec.imported) importedFunctionNames.add(spec.imported);
                if (spec.local && spec.local !== spec.imported) importedFunctionNames.add(spec.local);
            }
        }
    }

    // Common entry point names that should never be flagged as dead
    const entryPointNames = new Set([
        'main', 'activate', 'deactivate', 'init', 'setup', 'bootstrap',
        'configure', 'register', 'default',
    ]);

    // MCP-EVAL-4: framework-reachability. Functions the framework invokes (not a
    // traceable call) dominate the Python dead-code false positives. We treat as
    // reachable: (a) functions referenced by a framework wrapper elsewhere
    // (`Depends(get_db_session)` → symbols.frameworkRefs), and (b) functions
    // carrying a framework-REGISTRATION decorator (Celery task, pytest fixture,
    // CLI command, validator, signal receiver, scheduled job) — NOT plain
    // utility decorators (`@lru_cache`, `@property`, `@staticmethod`).
    const frameworkReachableNames = new Set<string>();
    const frameworkDecoratedKeys = new Set<string>();
    for (const [filePath, record] of Object.entries(snapshot.files)) {
        for (const ref of record.symbols?.frameworkRefs ?? []) frameworkReachableNames.add(ref);
        for (const fn of record.symbols?.functions ?? []) {
            if ((fn.decorators ?? []).some(isFrameworkRegistrationDecorator)) {
                frameworkDecoratedKeys.add(`${filePath}::${fn.name}`);
            }
        }
    }

    const dead: string[] = [];
    for (const [key, node] of Object.entries(callGraph.nodes)) {
        // Has callers → not dead
        if (node.calledBy && node.calledBy.length > 0) continue;

        // BUG-POLAR-22: functions defined in TEST files are not dead code —
        // they're test cases (run by the test runner) or per-file test helpers
        // used inside `it()`/`describe()` closures the call graph can't trace.
        // On polar these were 456 of 1,218 (37%) of the remaining report. Test
        // files have no place in a production dead-code audit.
        if (isTestOrSpecFile(node.filePath)) continue;

        // Is an API handler → not dead
        if (apiHandlerKeys.has(key)) continue;
        // BUG-HEALTH-DEADCODE: same handler under a differing path-prefix / class-qualified key.
        if (apiHandlerLooseKeys.has(`${baseFile(node.filePath)}::${bareLeaf(node.functionName)}`)) continue;

        // Is a known entry point → not dead
        if (entryPointNames.has(node.functionName)) continue;

        // Is a class constructor or lifecycle hook → not dead (leaf-name check so a
        // class-qualified `ArticleController.constructor` is caught too).
        const leaf = bareLeaf(node.functionName);
        if (leaf === 'constructor' || leaf.startsWith('ngOn')) continue;

        // Issue 140: Is imported by another file → not dead
        // Express anonymous handlers import service functions but the call graph
        // doesn't trace through the anonymous callback. The import proves usage.
        if (importedFunctionNames.has(node.functionName)) continue;

        // BUG-POLAR-8: framework entry points are invoked by the framework
        // (Next.js routing, React JSX), not by a traceable call — so the static
        // call graph always sees 0 callers and floods the report with false
        // positives (polar: 11.2k "dead" fns, ~77%, incl. RootLayout/Providers/
        // page components). Exclude them.
        if (isFrameworkEntryPoint(node.functionName, node.filePath)) continue;

        // BUG-POLAR-8 (round 2): the Python call graph does NOT resolve
        // instance/class method dispatch (`self.m()`, `obj.m()`) or class
        // instantiation, so EVERY method, dunder and class definition shows 0
        // callers. On polar that was 9,515 of 10,608 Python "dead" entries
        // (7,313 methods + 1,796 classes + 406 dunders) — pure noise that made
        // the report useless. Until proper method-dispatch resolution exists we
        // suppress the categories we cannot prove unreachable (see helper).
        if (isUnresolvedDispatch(node.functionName, node.filePath)) continue;

        // MCP-EVAL-4: framework-invoked (Depends provider or registration-decorated).
        if (frameworkReachableNames.has(node.functionName)) continue;
        if (frameworkDecoratedKeys.has(key)) continue;

        dead.push(key);
    }

    return dead;
}

/** Next.js App/Pages Router special files whose default export is a framework entry point. */
const NEXTJS_SPECIAL_FILES = new Set([
    'layout', 'page', 'template', 'loading', 'error', 'global-error', 'not-found',
    'route', 'default', 'sitemap', 'robots', 'manifest', 'middleware',
    'opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'favicon',
]);

/**
 * BUG-POLAR-8: a symbol that a framework invokes (not a traceable call) and so
 * should never be flagged dead: Next.js special-file exports, React components
 * (PascalCase in a .tsx/.jsx file, rendered via JSX), and React hooks (`use*`).
 */
export function isFrameworkEntryPoint(functionName: string, filePath: string): boolean {
    const base = (filePath.split('/').pop() ?? '').replace(/\.[cm]?[jt]sx?$/, '');
    if (NEXTJS_SPECIAL_FILES.has(base)) return true;
    const isJsxFile = /\.[jt]sx$/.test(filePath);
    if (isJsxFile && /^[A-Z]/.test(functionName)) return true; // React component
    if (/^use[A-Z0-9]/.test(functionName)) return true;         // React hook
    return false;
}

/**
 * BUG-POLAR-22: is this a test / spec file? Functions in test files must be
 * excluded from dead-code analysis. Self-contained (mirrors the parser's
 * `isTestFile` plus pytest `test_*.py` / `conftest.py`) to avoid an
 * analysis→parser import dependency.
 */
export function isTestOrSpecFile(filePath: string): boolean {
    return /(?:^|\/)__tests?__\//.test(filePath)                         // __tests__/ __test__/
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)              // *.test.ts / *.spec.tsx
        || /(?:^|\/)tests?\//.test(filePath)                            // test/ or tests/ dir
        || /(?:Tests?|TestSuite)\.(?:java|kt|cs|py|rb|go|rs|swift)$/.test(filePath) // *Test.kt etc.
        || /(?:^|\/)(?:test_[^/]*|conftest)\.py$/.test(filePath)        // pytest test_*.py / conftest.py
        || /(?:^|\/)[^/]*_test\.(?:py|go|rb)$/.test(filePath);          // *_test.py / *_test.go
}

/** Alembic migration hooks the framework invokes by name (never a traceable call). */
const PY_FRAMEWORK_FREE_HOOKS = new Set([
    'upgrade', 'downgrade', 'run_migrations_online', 'run_migrations_offline',
    'do_run_migrations', 'include_object', 'include_name', 'process_revision_directives',
    // BUG-HEALTH-DEADCODE: FastAPI/ASGI app lifecycle — invoked by the server, not a call.
    'lifespan', 'on_startup', 'on_shutdown', 'startup', 'shutdown',
]);

/**
 * MCP-EVAL-4 — a decorator that REGISTERS a function with a framework, so the
 * framework (not a traceable call) will invoke it: Celery/RQ tasks, pytest
 * fixtures, Click/Typer CLI commands, Pydantic validators, SQLAlchemy / Django
 * signal receivers, scheduled jobs, Flask lifecycle hooks. Plain utility
 * decorators (`@lru_cache`, `@cache`, `@property`, `@staticmethod`,
 * `@classmethod`, `@dataclass`, `@abstractmethod`, `@wraps`) are NOT registration
 * — a function decorated only with those can still be genuinely dead.
 */
const FRAMEWORK_REGISTRATION_DECORATOR_RE =
    /^@\s*(?:[\w]+\s*\.\s*)*(?:shared_task|celery_task|instrumented_task|task|fixture|command|group|field_validator|root_validator|model_validator|validator|listens_for|on_event|before_request|after_request|before_first_request|teardown_appcontext|scheduled|periodic_task|hookimpl|receiver|register_command|cli|step|given|when|then|websocket_route|route|BeforeInsert|BeforeUpdate|AfterInsert|AfterUpdate|BeforeRemove|AfterRemove|AfterLoad)\b/;

export function isFrameworkRegistrationDecorator(decorator: string): boolean {
    return FRAMEWORK_REGISTRATION_DECORATOR_RE.test((decorator ?? '').trim());
}

/**
 * BUG-POLAR-8 (round 2): a Python call-graph node whose reachability the static
 * resolver CANNOT determine, so flagging it dead is noise rather than signal.
 *
 * The Python call graph (tree-sitter, no type inference) does not resolve
 * instance/class method dispatch or class instantiation. Consequently every
 * method (`Class.method`), dunder and class definition shows zero callers.
 * Scoped strictly to `.py` — JS/TS keeps full dead-method detection (Babel
 * resolves its dispatch). We deliberately trade recall for precision here:
 * under-reporting Python method-level dead code beats a report that is ~98%
 * false positives. Module-level free functions (snake_case, no receiver) are
 * NOT suppressed — the call graph resolves direct `foo()` calls, so they remain
 * the reliable, reported category.
 */
export function isUnresolvedDispatch(functionName: string, filePath: string): boolean {
    if (!/\.py$/.test(filePath)) return false;
    const leaf = functionName.includes('.')
        ? functionName.slice(functionName.lastIndexOf('.') + 1)
        : functionName;
    if (/^__\w+__$/.test(leaf)) return true;         // dunder — invoked by the language
    if (functionName.includes('.')) return true;      // Class.method — dispatch not traced
    if (/^[A-Z]/.test(functionName)) return true;     // class definition — instantiation not traced
    if (PY_FRAMEWORK_FREE_HOOKS.has(functionName)) return true; // Alembic-style framework hooks
    return false;
}

// ─── God Files ─────────────────────────────────────────────────────────────

function findGodFiles(
    files: Record<string, { symbols?: { functions?: any[]; variables?: any[] } }>,
    threshold: number,
): string[] {
    const result: string[] = [];
    for (const [filePath, record] of Object.entries(files)) {
        const fnCount = record.symbols?.functions?.length ?? 0;
        const varCount = record.symbols?.variables?.length ?? 0;
        if (fnCount + varCount > threshold) {
            result.push(filePath);
        }
    }
    return result;
}

// ─── High Coupling ─────────────────────────────────────────────────────────

function findHighCouplingFiles(
    callGraph?: SerializedCallGraph,
    threshold?: number,
): string[] {
    if (!callGraph || !threshold) return [];

    // Count incoming and outgoing edges per file (not per function)
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();

    for (const edge of callGraph.edges ?? []) {
        const callerFile = edge.callerKey.split('::')[0];
        const calleeFile = edge.calleeKey.split('::')[0];
        if (callerFile === calleeFile) continue; // skip intra-file edges

        if (!outgoing.has(callerFile)) outgoing.set(callerFile, new Set());
        outgoing.get(callerFile)!.add(calleeFile);

        if (!incoming.has(calleeFile)) incoming.set(calleeFile, new Set());
        incoming.get(calleeFile)!.add(callerFile);
    }

    const result = new Set<string>();
    for (const [file, targets] of outgoing) {
        if (targets.size > threshold) result.add(file);
    }
    for (const [file, sources] of incoming) {
        if (sources.size > threshold) result.add(file);
    }

    return [...result];
}

// ─── Cyclic Dependencies ───────────────────────────────────────────────────

/**
 * Detect import cycles by building a directed file-level import graph
 * and running DFS-based cycle detection.
 */
function findCyclicDependencies(
    files: Record<string, { symbols?: { imports?: Array<{ source: string }> } }>,
): string[][] {
    // Build adjacency list: file → set of files it imports
    const adj = new Map<string, Set<string>>();
    const allFiles = new Set(Object.keys(files));

    for (const [filePath, record] of Object.entries(files)) {
        const imports = record.symbols?.imports ?? [];
        for (const imp of imports) {
            if (!imp.source.startsWith('.')) continue; // skip package imports
            const resolved = resolveRelativeImport(imp.source, filePath, allFiles);
            if (resolved) {
                if (!adj.has(filePath)) adj.set(filePath, new Set());
                adj.get(filePath)!.add(resolved);
            }
        }
    }

    // DFS cycle detection (Johnson-like simple cycle finding)
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stack: string[] = [];

    function dfs(node: string): void {
        if (visited.has(node)) return;
        visited.add(node);
        inStack.add(node);
        stack.push(node);

        for (const neighbor of adj.get(node) ?? []) {
            if (inStack.has(neighbor)) {
                // Found a cycle — extract the cycle from stack
                const cycleStart = stack.indexOf(neighbor);
                if (cycleStart >= 0) {
                    const cycle = stack.slice(cycleStart);
                    // Only report cycles of length >= 2
                    if (cycle.length >= 2) {
                        cycles.push(cycle);
                    }
                }
            } else if (!visited.has(neighbor)) {
                dfs(neighbor);
            }
        }

        stack.pop();
        inStack.delete(node);
    }

    for (const file of allFiles) {
        dfs(file);
    }

    return cycles;
}

/**
 * Simple relative import path resolution (reused logic from callGraphResolver).
 */
function resolveRelativeImport(
    importPath: string,
    currentFilePath: string,
    allFiles: Set<string>,
): string | undefined {
    if (!importPath.startsWith('.')) return undefined;

    const dir = currentFilePath.includes('/')
        ? currentFilePath.substring(0, currentFilePath.lastIndexOf('/'))
        : '';

    // Normalize './' and '../' paths
    const parts = (dir ? dir + '/' + importPath : importPath).split('/');
    const resolved: string[] = [];
    for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') { resolved.pop(); continue; }
        resolved.push(part);
    }
    const basePath = resolved.join('/');

    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.kt',
                        '/index.ts', '/index.js', '/index.tsx', '/index.jsx'];
    for (const ext of extensions) {
        const candidate = basePath + ext;
        if (allFiles.has(candidate)) return candidate;
    }
    return undefined;
}

// ─── Orphaned Clusters ─────────────────────────────────────────────────────

/**
 * Clusters whose member files have zero cross-cluster call edges
 * (neither calling nor called by files in other clusters).
 */
function findOrphanedClusters(
    clusters: Record<string, FeatureCluster>,
    callGraph?: SerializedCallGraph,
    snapshot?: { files: Record<string, { symbols?: { imports?: { source: string }[] } }> },
): string[] {
    if (!callGraph) return Object.keys(clusters);

    // Map file → clusterId
    const fileToCluster = new Map<string, string>();
    for (const [clusterId, cluster] of Object.entries(clusters)) {
        for (const file of cluster.files) {
            fileToCluster.set(file, clusterId);
        }
    }

    // Find clusters that have at least one cross-cluster edge (call graph)
    const connectedClusters = new Set<string>();
    for (const edge of callGraph.edges ?? []) {
        const callerFile = edge.callerKey.split('::')[0];
        const calleeFile = edge.calleeKey.split('::')[0];
        const callerCluster = fileToCluster.get(callerFile);
        const calleeCluster = fileToCluster.get(calleeFile);

        if (callerCluster && calleeCluster && callerCluster !== calleeCluster) {
            connectedClusters.add(callerCluster);
            connectedClusters.add(calleeCluster);
        }
    }

    // Issue 141: Also check import edges — files importing from other clusters are connected
    if (snapshot) {
        for (const [fp, record] of Object.entries(snapshot.files)) {
            const srcCluster = fileToCluster.get(fp);
            if (!srcCluster || connectedClusters.has(srcCluster)) continue;
            for (const imp of record.symbols?.imports ?? []) {
                if (!imp.source.startsWith('.')) continue;
                // Resolve relative import to a file path
                const dir = fp.substring(0, fp.lastIndexOf('/'));
                const resolved = imp.source.replace(/^\.\//, dir + '/').replace(/^\.\.\//, dir + '/../');
                // Find matching file in the cluster map (approximate match)
                for (const [filePath, clusterId] of fileToCluster.entries()) {
                    if (clusterId !== srcCluster && filePath.includes(imp.source.replace(/^\.\.?\//, ''))) {
                        connectedClusters.add(srcCluster);
                        connectedClusters.add(clusterId);
                        break;
                    }
                }
                if (connectedClusters.has(srcCluster)) break;
            }
        }
    }

    // Issue 141: Clusters with APIs should never be flagged as orphaned
    return Object.keys(clusters).filter((id) => {
        if (connectedClusters.has(id)) return false;
        // A cluster with entry points (APIs) is a real subsystem, not orphaned
        const cluster = clusters[id];
        if (cluster.entryPoints && cluster.entryPoints.length > 0) return false;
        return true;
    });
}
