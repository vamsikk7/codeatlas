/**
 * workspaceRouterTracker.ts
 *
 * Cross-file router/group tracker (Issue #357).
 *
 * Real codebases split routers across files: a file declares
 * `func RegisterUserRoutes(r *gin.RouterGroup)` with routes inside, and a
 * different file calls `RegisterUserRoutes(v1.Group("/users"))`. Per-file
 * regex extraction misses these — the routes appear inside the function
 * body but their effective prefix lives at the call site in another file.
 *
 * This tracker runs once per workspace pre-pass:
 *  - **Phase A (per-file scan)** records: function declarations whose params
 *    are router/group types (Go: `*gin.RouterGroup`, `*fiber.App`, `*echo.Group`,
 *    `chi.Router`, `*fiber.Router`; Kotlin: `Routing.<receiver>` extensions),
 *    plus the route calls inside their bodies; and call sites that pass a
 *    prefixed group expression.
 *  - **Phase B (resolve)** answers `prefixesForFunction(name)` so the
 *    framework detector can prepend the call-site prefix to each emitted
 *    route while extracting from the receiving function's body.
 *
 * The tracker is intentionally regex-based (no AST). It targets the very
 * common cross-file pattern, not every possible router composition. Cases
 * not handled — passing routers through structs, building router lists,
 * conditional registration — are out of scope; #358 will track residuals.
 */

export interface WorkspaceRoute {
    method: string;
    path: string;
    handlerName: string;
    /** Absolute byte offset of the route call inside `filePath`'s source. */
    sourceOffset: number;
    filePath: string;
}

export interface RouterFunctionDecl {
    name: string;
    /** Parameter name through which routes are registered (e.g. `r`). */
    paramName: string;
    filePath: string;
    /** Bracket-counted body bounds inside the source. */
    bodyStart: number;
    bodyEnd: number;
    /** Routes detected inside the body (no prefix applied yet). */
    routes: WorkspaceRoute[];
}

export interface RouterCallSite {
    /** Function being called — bare name (e.g. `ArticlesRegister`). */
    functionName: string;
    /** Resolved effective prefix at the call site (e.g. `/api/articles`). */
    prefix: string;
    /** File where the call appears — for diagnostics only. */
    filePath: string;
}

export class WorkspaceRouterTracker {
    private decls: Map<string, RouterFunctionDecl[]> = new Map();
    private calls: RouterCallSite[] = [];

    /** Idempotent — calling scan again with the same path replaces prior data. */
    scan(filePath: string, source: string, language: string): void {
        this.scanDecls(filePath, source, language);
        this.scanCalls(filePath, source, language);
    }

    /**
     * Extract router-receiving function decls only. Run for every file in a
     * first pass before `scanCalls` so call-site resolution can rely on a
     * complete cross-workspace decls map.
     *
     * Test files (`*_test.go`, `*Test.kt`, `*Spec.kt`) are skipped — register
     * functions in test setup duplicate production registrations and would
     * over-emit routes. Decls in test files (rare) are also skipped to keep
     * the tracker's keyspace clean.
     */
    scanDecls(filePath: string, source: string, language: string): void {
        // Wipe prior decls for this file.
        for (const [name, list] of this.decls) {
            const filtered = list.filter(d => d.filePath !== filePath);
            if (filtered.length === 0) this.decls.delete(name);
            else this.decls.set(name, filtered);
        }
        if (isTestFilePath(filePath)) return;
        if (language === 'go') this.scanGoDecls(filePath, source);
        else if (language === 'kotlin') this.scanKotlinDecls(filePath, source);
    }

    /**
     * Extract call sites only. Requires `scanDecls` to have run for every
     * file first. Skips test files for the same reason as `scanDecls` —
     * they contain bench/integration setup that shouldn't add to the live
     * route count.
     */
    scanCalls(filePath: string, source: string, language: string): void {
        this.calls = this.calls.filter(c => c.filePath !== filePath);
        if (isTestFilePath(filePath)) return;
        if (language === 'go') this.scanGoCalls(filePath, source);
        else if (language === 'kotlin') this.scanKotlinCalls(filePath, source);
    }

    /** All resolved prefixes at which `funcName` is called across the workspace. */
    prefixesForFunction(funcName: string): string[] {
        return this.calls
            .filter(c => c.functionName === funcName)
            .map(c => c.prefix);
    }

    /** All cross-file decls of `funcName` (one entry per file that defines it). */
    declsForFunction(funcName: string): RouterFunctionDecl[] {
        return this.decls.get(funcName) ?? [];
    }

    /**
     * Emit (method, prefixed-path, handler) for every cross-file resolution.
     * For Kotlin extension-function bodies (Routing.userRoutes etc.) where the
     * inner verb blocks are anonymous, surface the parent extension-function
     * name as the handler so the anonymous-resolution invariant (which expects
     * `anonymous@…` handlers to point at a flow body) doesn't trip on routes
     * we emit purely from cross-file context.
     */
    resolvedRoutes(): WorkspaceRoute[] {
        const out: WorkspaceRoute[] = [];
        for (const [funcName, declList] of this.decls) {
            const prefixes = this.prefixesForFunction(funcName);
            if (prefixes.length === 0) continue;
            for (const decl of declList) {
                for (const route of decl.routes) {
                    const isAnon = route.handlerName.startsWith('anonymous@');
                    const named = isAnon ? `${funcName}:${route.method}:${route.path || '/'}` : route.handlerName;
                    for (const prefix of prefixes) {
                        out.push({
                            method: route.method,
                            path: joinPath(prefix, route.path),
                            handlerName: named,
                            sourceOffset: route.sourceOffset,
                            filePath: route.filePath,
                        });
                    }
                }
            }
        }
        return out;
    }

    /** Reset everything — for tests and full reinit. */
    clear(): void {
        this.decls.clear();
        this.calls.length = 0;
    }

    /** Total decls — exposed for tests / diagnostics. */
    get declCount(): number {
        let n = 0;
        for (const list of this.decls.values()) n += list.length;
        return n;
    }

    get callCount(): number { return this.calls.length; }

    // ─── Go scanning ────────────────────────────────────────────────────────

    private scanGoDecls(filePath: string, source: string): void {
        const declRe = /func\s*(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?(\w+)\s*\(\s*(\w+)\s+\*?(?:gin\.RouterGroup|gin\.Engine|fiber\.App|fiber\.Router|chi\.Router|chi\.Mux|echo\.Group|echo\.Echo)\b[^)]*\)/g;
        let dm: RegExpExecArray | null;
        while ((dm = declRe.exec(source)) !== null) {
            const funcName = dm[1];
            const paramName = dm[2];
            const sigEnd = dm.index + dm[0].length;
            const braceOpen = source.indexOf('{', sigEnd);
            if (braceOpen < 0) continue;
            const bodyEnd = matchBrace(source, braceOpen);
            if (bodyEnd < 0) continue;
            const body = source.slice(braceOpen + 1, bodyEnd);
            const routes = collectGoRoutesIn(body, paramName, braceOpen + 1, filePath);
            if (routes.length === 0) continue;
            const decl: RouterFunctionDecl = {
                name: funcName,
                paramName,
                filePath,
                bodyStart: braceOpen + 1,
                bodyEnd,
                routes,
            };
            const list = this.decls.get(funcName) ?? [];
            list.push(decl);
            this.decls.set(funcName, list);
        }
    }

    private scanGoCalls(filePath: string, source: string): void {
        const localBindings = collectGoLocalGroupBindings(source);
        const rootApps = collectGoRootAppBindings(source);
        const callRe = /\b(?:\w+\s*\.\s*)?(\w+)\s*\(\s*([^()]*(?:\([^()]*\)[^()]*)*)\s*\)/g;
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(source)) !== null) {
            const funcName = cm[1];
            // Only resolve calls to functions we identified as router-receiving
            // in the decls pre-pass. Other calls are noise.
            if (!this.decls.has(funcName)) continue;
            const argText = cm[2];
            const prefix = resolveGoArgPrefix(argText, localBindings, rootApps);
            if (prefix == null) continue;
            this.calls.push({ functionName: funcName, prefix, filePath });
        }
    }

    // ─── Kotlin scanning ────────────────────────────────────────────────────

    private scanKotlinDecls(filePath: string, source: string): void {
        const declRe = /fun\s+(?:Routing|Route)\s*\.\s*(\w+)\s*\([^)]*\)\s*\{/g;
        let dm: RegExpExecArray | null;
        while ((dm = declRe.exec(source)) !== null) {
            const funcName = dm[1];
            const braceOpen = dm.index + dm[0].length - 1;
            const bodyEnd = matchBrace(source, braceOpen);
            if (bodyEnd < 0) continue;
            const body = source.slice(braceOpen + 1, bodyEnd);
            const routes = collectKtorRoutesIn(body, braceOpen + 1, filePath);
            if (routes.length === 0) continue;
            const decl: RouterFunctionDecl = {
                name: funcName,
                paramName: '',
                filePath,
                bodyStart: braceOpen + 1,
                bodyEnd,
                routes,
            };
            const list = this.decls.get(funcName) ?? [];
            list.push(decl);
            this.decls.set(funcName, list);
        }
    }

    private scanKotlinCalls(filePath: string, source: string): void {
        // Call sites: bare extension-function invocations inside `routing { … }`
        // OR inside `route("/prefix") { … }` blocks (where the prefix should
        // propagate to inner routes). Track the prefix at the call site using
        // brace-counted block bounds.
        const blocks = extractKtorPrefixBlocks(source);
        const routingRe = /\brouting\s*\{/g;
        let rm: RegExpExecArray | null;
        while ((rm = routingRe.exec(source)) !== null) {
            const open = source.indexOf('{', rm.index);
            const close = matchBrace(source, open);
            if (close < 0) continue;
            const body = source.slice(open + 1, close);
            const bodyOffset = open + 1;
            const callRe = /(?<![.\w])(\w+)\s*\(/g;
            let cm: RegExpExecArray | null;
            while ((cm = callRe.exec(body)) !== null) {
                const name = cm[1];
                if (KTOR_BUILTINS.has(name)) continue;
                if (!this.decls.has(name)) continue;
                // Compute innermost-route prefix at the absolute offset.
                const absOff = bodyOffset + cm.index;
                let prefix = '';
                for (const b of blocks) {
                    if (absOff >= b.start && absOff < b.end) {
                        prefix = prefix ? joinPath(prefix, b.prefix) : b.prefix;
                    }
                }
                this.calls.push({ functionName: name, prefix, filePath });
            }
        }
    }
}

// ─── Go helpers ─────────────────────────────────────────────────────────────

/**
 * Heuristic test-file detector. Covers the common cross-language patterns:
 *   `*_test.go`           — Go convention
 *   `*Test.kt` / `*Tests.kt` / `*Spec.kt` — Kotlin (JUnit, Spek, MockK)
 *   anything under a `/test/`, `/tests/`, or `__tests__/` directory
 * Test files often duplicate production register-function calls (e.g.
 * `users.UsersRegister(v1.Group("/users"))` in both `main.go` and
 * `unit_test.go`), which would over-emit routes when call sites multiply.
 */
function isTestFilePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (/_test\.go$/.test(lower)) return true;
    if (/(?:^|\/)tests?\//.test(lower)) return true;
    if (/__tests__\//.test(lower)) return true;
    if (/(?:^|\/)spec\//.test(lower)) return true;
    if (/(?:^|\/)[\w.-]+(?:test|tests|spec)\.(?:kt|kts)$/i.test(lower)) return true;
    return false;
}

function collectGoLocalGroupBindings(source: string): Map<string, string> {
    const bindings = new Map<string, string>();
    const re = /\b(?:var\s+)?(\w+)\s*(?::=|=)\s*(\w+)\s*\.\s*Group\s*\(\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    const raw: Array<{ var: string; receiver: string; path: string }> = [];
    while ((m = re.exec(source)) !== null) {
        const path = m[3].startsWith('/') || m[3] === '' ? m[3] : '/' + m[3];
        raw.push({ var: m[1], receiver: m[2], path });
    }
    for (const b of raw) {
        const parent = bindings.get(b.receiver) ?? '';
        const full = parent
            ? joinPath(parent, b.path)
            : (b.path.startsWith('/') ? b.path : '/' + b.path);
        bindings.set(b.var, full);
    }
    return bindings;
}

function collectGoRoutesIn(body: string, paramName: string, baseOffset: number, filePath: string): WorkspaceRoute[] {
    // Track local group bindings inside the function body, rooted at the
    // function parameter. `<var> := <recv>.Group("/path")` chains so that
    // `auth := api.Group("/auth")` after `api := app.Group("/api")` resolves
    // to the full prefix `/api/auth`.
    const localGroups = new Map<string, string>([[paramName, '']]);
    const bindRe = /\b(?:var\s+)?(\w+)\s*(?::=|=)\s*(\w+)\s*\.\s*Group\s*\(\s*"([^"]+)"/g;
    let bm: RegExpExecArray | null;
    while ((bm = bindRe.exec(body)) !== null) {
        const v = bm[1], recv = bm[2];
        if (!localGroups.has(recv)) continue;
        const parent = localGroups.get(recv) ?? '';
        const sub = bm[3].startsWith('/') ? bm[3] : '/' + bm[3];
        localGroups.set(v, parent ? joinPath(parent, sub) : sub);
    }

    // Extract route registrations on any tracked local binding.
    const routes: WorkspaceRoute[] = [];
    const verbAlternation = '(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Get|Post|Put|Delete|Patch|Head|Options|All|Any|Use|Handle|Add)';
    for (const [varName, prefix] of localGroups) {
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(
            `\\b${escaped}\\s*\\.\\s*${verbAlternation}\\s*\\(\\s*"([^"]*)"\\s*,\\s*([\\w.]+)`,
            'g',
        );
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
            const method = m[1].toUpperCase();
            if (method === 'USE' || method === 'HANDLE' || method === 'ALL' || method === 'ANY' || method === 'ADD') continue;
            const literal = m[2];
            const literalPath = literal.startsWith('/') || literal === '' ? literal : '/' + literal;
            const fullPath = prefix
                ? (literalPath ? joinPath(prefix, literalPath) : prefix)
                : literalPath;
            routes.push({
                method,
                path: fullPath,
                handlerName: m[3].split('.').pop() ?? m[3],
                sourceOffset: baseOffset + m.index,
                filePath,
            });
        }
    }
    return routes;
}

function collectGoRootAppBindings(source: string): Set<string> {
    // `<var> := fiber.New()` / `gin.Default()` / `gin.New()` / `echo.New()` /
    // `chi.NewRouter()` / `chi.NewMux()` — root engines with effective prefix "".
    const out = new Set<string>();
    const re = /\b(\w+)\s*:=\s*(?:fiber|gin|echo|chi)\s*\.\s*(?:New|Default|NewRouter|NewMux)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.add(m[1]);
    return out;
}

function resolveGoArgPrefix(
    argText: string,
    localBindings: Map<string, string>,
    rootApps: Set<string>,
): string | null {
    // Pattern: `<var>.Group("/path", ...)` — chained from a known binding.
    const grouped = argText.match(/^\s*(\w+)\s*\.\s*Group\s*\(\s*"([^"]+)"/);
    if (grouped) {
        const base = localBindings.get(grouped[1]);
        const sub = grouped[2].startsWith('/') ? grouped[2] : '/' + grouped[2];
        if (base != null) return base ? joinPath(base, sub) : sub;
        if (rootApps.has(grouped[1])) return sub;
    }
    // Pattern: bare `<var>` — known group binding OR a root app/engine.
    const bare = argText.match(/^\s*(\w+)\s*(?:,|$)/);
    if (bare) {
        const v = localBindings.get(bare[1]);
        if (v != null) return v;
        if (rootApps.has(bare[1])) return ''; // root prefix
    }
    return null;
}

const KTOR_BUILTINS = new Set([
    'route', 'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
    'authenticate', 'install', 'intercept', 'webSocket', 'sse', 'trace',
    'method', 'application', 'static', 'resources', 'locations', 'swagger',
    'openAPI', 'host', 'port', 'listen', 'environment', 'module',
    'staticFiles', 'staticResources', 'rateLimit', 'cachingHeaders',
    'compression', 'cors', 'callId', 'callLogging', 'contentNegotiation',
    'sessions', 'statusPages', 'autoHead', 'doubleReceive', 'forwardedHeaders',
    'partialContent', 'webjars', 'shutDownUrl', 'requireAuth',
]);

function extractKtorPrefixBlocks(source: string): Array<{ prefix: string; start: number; end: number }> {
    const blocks: Array<{ prefix: string; start: number; end: number }> = [];
    const re = /\broute\s*\(\s*"([^"]+)"\s*\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        const open = source.indexOf('{', m.index);
        const close = matchBrace(source, open);
        if (close < 0) continue;
        const prefix = m[1].startsWith('/') ? m[1] : '/' + m[1];
        blocks.push({ prefix, start: open + 1, end: close });
    }
    return blocks;
}

// ─── Ktor helpers ───────────────────────────────────────────────────────────

function collectKtorRoutesIn(body: string, baseOffset: number, filePath: string): WorkspaceRoute[] {
    const routes: WorkspaceRoute[] = [];
    // Track route("/path") {…} blocks inside the function body to compose prefixes.
    const blocks: Array<{ prefix: string; start: number; end: number }> = [];
    const blockRe = /\broute\s*\(\s*"([^"]+)"\s*\)\s*\{/g;
    let bm: RegExpExecArray | null;
    while ((bm = blockRe.exec(body)) !== null) {
        const open = body.indexOf('{', bm.index);
        const close = matchBrace(body, open);
        if (close < 0) continue;
        const prefix = bm[1].startsWith('/') ? bm[1] : '/' + bm[1];
        blocks.push({ prefix, start: open + 1, end: close });
    }

    const verbRe = /\b(get|post|put|delete|patch|head|options)\s*(?:\(\s*"([^"]*)"\s*\))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = verbRe.exec(body)) !== null) {
        const method = m[1].toUpperCase();
        const literal = m[2] ?? '';
        // Find innermost containing block.
        let innerPrefix = '';
        for (const b of blocks) {
            if (m.index >= b.start && m.index < b.end) {
                innerPrefix = innerPrefix ? joinPath(innerPrefix, b.prefix) : b.prefix;
            }
        }
        const literalPath = literal === '' ? '' : (literal.startsWith('/') ? literal : '/' + literal);
        const path = innerPrefix ? joinPath(innerPrefix, literalPath) : literalPath;
        routes.push({
            method,
            path: path === '' ? '/' : path,
            handlerName: `anonymous@${method}:${path === '' ? '/' : path}`,
            sourceOffset: baseOffset + m.index,
            filePath,
        });
    }
    return routes;
}

// ─── shared helpers ─────────────────────────────────────────────────────────

function matchBrace(source: string, openIdx: number): number {
    if (source[openIdx] !== '{') return -1;
    let depth = 1;
    let i = openIdx + 1;
    while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (depth === 0) return i;
        i++;
    }
    return -1;
}

function joinPath(a: string, b: string): string {
    const left = a.endsWith('/') ? a.slice(0, -1) : a;
    const right = b === '' ? '' : (b.startsWith('/') ? b : '/' + b);
    return left + right || '/';
}
