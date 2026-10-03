/**
 * flowGraphResolve.ts — #861 (2026-06-12).
 *
 * Tolerant flow-graph id resolution. Java/Kotlin class methods are stored
 * under a CLASS-PREFIXED flow id (`flow:<file>:<Class>.<method>`) because the
 * tree-sitter extractor names entities `Class.method` to disambiguate
 * same-named methods across classes. But route handlers, L2b api rows, and
 * the L3→L5 sequence-fallback all reference the BARE method name
 * (`flow:<file>:<method>`), so the exact lookup misses and the drill falls
 * back to the file graph — Java controllers appeared to have "no L5 flow".
 *
 * This resolver returns the real stored flow id for a requested one,
 * tolerating the bare-vs-class-prefixed mismatch in BOTH directions.
 */

/** Parse `flow:<file>:<name>` → { file, name }, where <name> is the LAST
 *  colon-delimited segment (file paths never contain a flow handler colon
 *  the way the builder keys them; the builder uses `flow:${filePath}:${name}`). */
function parseFlowId(id: string): { file: string; name: string } | null {
    if (!id.startsWith('flow:')) return null;
    const rest = id.slice('flow:'.length);
    const lastColon = rest.lastIndexOf(':');
    if (lastColon === -1) return null;
    return { file: rest.slice(0, lastColon), name: rest.slice(lastColon + 1) };
}

/** Bare method name = the part after the last '.' (strips a `Class.` prefix). */
function bareName(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? name : name.slice(dot + 1);
}

/**
 * TICKET-UI-5 — when a request names a CLASS (a class-based view / controller
 * anchored by class name), pick the class's PRIMARY request-handler method.
 * Lower index = more preferred; DRF mixin actions rank above raw HTTP verbs,
 * and helpers (`get_queryset`, `filter_queryset`, `perform_*`) — absent from
 * this list — rank last so a real handler always wins.
 */
const HANDLER_METHOD_PRIORITY = [
    'list', 'retrieve', 'create', 'update', 'partial_update', 'destroy',
    'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'handle',
];
function methodPriorityRank(method: string): number {
    const i = HANDLER_METHOD_PRIORITY.indexOf(method);
    return i === -1 ? HANDLER_METHOD_PRIORITY.length : i;
}

/**
 * Resolve a requested flow graph id to a real key present in `graphIds`,
 * tolerating bare ↔ class-prefixed method names. Returns the matching id or
 * `undefined`. Exact match wins; otherwise match on (same file, same bare
 * method name).
 */
export function resolveFlowGraphId(graphIds: Iterable<string>, requestedId: string): string | undefined {
    const set = graphIds instanceof Set ? graphIds : new Set(graphIds);
    if (set.has(requestedId)) return requestedId;
    const want = parseFlowId(requestedId);
    if (!want) return undefined;
    const wantBare = bareName(want.name);
    let fallback: string | undefined;
    for (const gid of set) {
        const have = parseFlowId(gid);
        if (!have || have.file !== want.file) continue;
        if (bareName(have.name) === wantBare) {
            // Prefer an exact name tie-break if multiple classes share a bare
            // method name in the same file (rare); otherwise first match.
            if (have.name === want.name) return gid;
            fallback ??= gid;
        }
    }
    if (fallback) return fallback;

    // TICKET-UI-5 — no method matched by bare name. If the request names a CLASS
    // (no `.` — e.g. a Django/DRF class-based view anchored by class name), the
    // flow graphs are keyed `Class.method`; resolve to the class's primary
    // request-handler method so the L3→L5 drill lands on a real flow.
    if (!want.name.includes('.')) {
        const prefix = `${want.name}.`;
        let best: { gid: string; method: string } | undefined;
        for (const gid of set) {
            const have = parseFlowId(gid);
            if (!have || have.file !== want.file || !have.name.startsWith(prefix)) continue;
            const method = have.name.slice(prefix.length);
            if (
                !best
                || methodPriorityRank(method) < methodPriorityRank(best.method)
                || (methodPriorityRank(method) === methodPriorityRank(best.method) && method < best.method)
            ) {
                best = { gid, method };
            }
        }
        if (best) return best.gid;
    }
    return undefined;
}
