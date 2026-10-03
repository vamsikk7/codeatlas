/**
 * searchIndex.ts — reverse-indexed keyword search over the workspace snapshot.
 *
 * For LLMs (and humans) that know a feature/route/function/class/file by NAME
 * but don't know where it lives. Builds a token → entries map at query time
 * over a focused entity set (no source-file body indexing — that would blow
 * the token budget and is the file-walker's job). Scoring blends:
 *   - per-token frequency (TF)
 *   - per-field weight (name > path > body)
 *   - per-kind boost (route > function > file)
 *   - diff recency (added/modified entities float to the top)
 *
 * Designed to fit in the same on-demand path as the rest of the MCP context
 * pack — the index is rebuilt per query (cheap on indexed metadata, expensive
 * if we tried to index every file body). Cache it across queries for one
 * snapshot if perf needs it later.
 */
import type { Snapshot } from '../core/graph/graphTypes';

export type SearchEntityKind = 'feature' | 'route' | 'function' | 'class' | 'file' | 'service';

export interface SearchResult {
    kind: SearchEntityKind;
    id: string;
    name: string;
    /** Headline / preview string suitable for an LLM tool result. */
    headline: string;
    score: number;
    filePath?: string;
    route?: string;
    method?: string;
    clusterLabel?: string;
    serviceId?: string;
    diff?: string;
}

export interface SearchOptions {
    /** Comma-separated kinds to include. Default: all. */
    kinds?: SearchEntityKind[];
    /** Max results returned. Default 20. */
    limit?: number;
    /** Minimum normalized score (0..1). Default 0.05. */
    minScore?: number;
    /**
     * When true, only return entries that match EVERY supplied keyword/token
     * (AND semantics). Default false → entries matching ANY token are kept,
     * but those matching more tokens score higher via the coverage multiplier.
     */
    requireAll?: boolean;
}

/** Tokens shorter than this and stop words are dropped from query + corpus. */
const MIN_TOKEN_LEN = 2;
const STOP_WORDS = new Set([
    'the', 'and', 'or', 'but', 'is', 'in', 'on', 'at', 'to', 'of', 'a', 'an',
    'for', 'with', 'by', 'as', 'be', 'this', 'that', 'it', 'from', 'into',
    'return', 'const', 'let', 'var', 'function', 'async', 'await',
]);

/**
 * Tokenize a string into normalized search tokens. Splits on word boundaries,
 * also splits camelCase / snake_case / kebab-case identifiers so that
 * `getUserById` yields `get`, `user`, `by`, `id`, AND the raw `getuserbyid`.
 */
export function tokenize(s: string): string[] {
    if (!s) return [];
    const out = new Set<string>();
    // Split on non-word characters.
    const parts = s.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    for (const p of parts) {
        // Keep the whole-token (lowercased) as one signal.
        const whole = p.toLowerCase();
        if (whole.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(whole)) out.add(whole);
        // Split camelCase / PascalCase: insert a separator before uppercase
        // letters that follow lowercase, and before digits that follow letters.
        const camelSplit = p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([0-9])/g, '$1 $2');
        // Then split on underscores, dashes, dots, slashes.
        for (const sub of camelSplit.split(/[_\-./\s]+/)) {
            const t = sub.toLowerCase();
            if (t.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(t)) out.add(t);
        }
    }
    return [...out];
}

interface IndexEntry {
    kind: SearchEntityKind;
    id: string;
    name: string;
    headline: string;
    filePath?: string;
    route?: string;
    method?: string;
    clusterLabel?: string;
    serviceId?: string;
    diff?: string;
    /** Tokens that scored a high-weight match (name / route). */
    primaryTokens: Set<string>;
    /** Tokens that scored a low-weight match (path / signature / body). */
    secondaryTokens: Set<string>;
}

const KIND_BOOST: Record<SearchEntityKind, number> = {
    route: 1.6,
    feature: 1.4,
    service: 1.4,
    class: 1.2,
    function: 1.1,
    file: 0.8,
};

/**
 * Build the searchable entity set from a snapshot. Index is rebuilt per call;
 * for hot paths a caller can memoise externally on snapshot identity.
 */
export function buildSearchIndex(snapshot: Snapshot): IndexEntry[] {
    const entries: IndexEntry[] = [];

    // Features (clusters)
    for (const c of Object.values(snapshot.clusters ?? {})) {
        const label = c.name ?? c.label;
        const headline = `feature: ${label} (${c.files.length} files, ${c.entryPoints?.length ?? 0} entry points)`;
        entries.push({
            kind: 'feature',
            id: c.id,
            name: label,
            headline,
            clusterLabel: c.label,
            serviceId: c.serviceId,
            diff: c.diff,
            primaryTokens: new Set(tokenize(label)),
            secondaryTokens: new Set([
                ...tokenize(c.id),
                ...c.files.flatMap((f) => tokenize(f)),
            ]),
        });
    }

    // Services
    for (const s of Object.values(snapshot.services ?? {})) {
        const headline = `service: ${s.name} (${s.technology}, ${s.exposedApiCount} exposed APIs)`;
        entries.push({
            kind: 'service',
            id: s.id,
            name: s.name,
            headline,
            serviceId: s.id,
            diff: s.diff,
            primaryTokens: new Set(tokenize(s.name)),
            secondaryTokens: new Set([
                ...tokenize(s.id),
                ...tokenize(s.rootPath),
                ...tokenize(s.technology),
            ]),
        });
    }

    // Routes / entry points (any ApiRecord). Cluster + service membership
    // looked up via clusters[*].files membership.
    const fileToCluster = new Map<string, { id: string; label: string; serviceId?: string }>();
    for (const c of Object.values(snapshot.clusters ?? {})) {
        for (const f of c.files) fileToCluster.set(f, { id: c.id, label: c.name ?? c.label, serviceId: c.serviceId });
    }
    for (const a of Object.values(snapshot.apiIndex ?? {})) {
        const cluster = fileToCluster.get(a.filePath);
        const headline = `${a.method} ${a.route} → ${a.handlerName} (${a.filePath})`;
        entries.push({
            kind: 'route',
            id: a.apiId,
            name: `${a.method} ${a.route}`,
            headline,
            method: a.method,
            route: a.route,
            filePath: a.filePath,
            clusterLabel: cluster?.label,
            serviceId: cluster?.serviceId,
            diff: a.diff,
            primaryTokens: new Set([
                ...tokenize(a.route),
                ...tokenize(a.handlerName),
                ...tokenize(a.method.toLowerCase()),
            ]),
            secondaryTokens: new Set([
                ...tokenize(a.filePath),
                ...((a.meta?.middlewares ?? []).flatMap((m) => tokenize(m))),
            ]),
        });
    }

    // Functions / classes — index symbol records per file.
    for (const [filePath, file] of Object.entries(snapshot.files ?? {})) {
        for (const fn of file.symbols?.functions ?? []) {
            const kind: SearchEntityKind = fn.kind === 'class' ? 'class' : 'function';
            const headline = `${kind}: ${fn.name} (${filePath})`;
            entries.push({
                kind,
                id: `${filePath}::${fn.name}`,
                name: fn.name,
                headline,
                filePath,
                primaryTokens: new Set(tokenize(fn.name)),
                secondaryTokens: new Set([
                    ...tokenize(filePath),
                    ...tokenize(fn.signature ?? ''),
                    // Index function CALLS so a search like "createUser" finds
                    // callers, not just the definer.
                    ...((fn.calls ?? []).flatMap((c) => tokenize(c))),
                ]),
            });
        }
    }

    // Files (catch-all when a user remembers a path but nothing else).
    for (const [filePath] of Object.entries(snapshot.files ?? {})) {
        entries.push({
            kind: 'file',
            id: filePath,
            name: filePath.split('/').pop() ?? filePath,
            headline: `file: ${filePath}`,
            filePath,
            primaryTokens: new Set(tokenize(filePath)),
            secondaryTokens: new Set(),
        });
    }

    return entries;
}

/**
 * Run a keyword search over the snapshot. Returns ranked results.
 *
 * Scoring: for each query token, count how many primary/secondary token sets
 * contain it, weighted (primary = 3, secondary = 1). Multiply by the entity-
 * kind boost. Boost added/modified diff state by +20%. Normalize by query
 * token count so single-token searches don't always win.
 */
export function searchWorkspace(
    snapshot: Snapshot,
    /** Either a single query string ("GET user comment") or an array of
     *  separately-tokenised keywords (["GET", "user", "comment"]). Arrays let
     *  LLM callers pass already-split terms without worrying about how the
     *  framework tokenises a free-form string. */
    query: string | string[],
    options: SearchOptions = {},
): SearchResult[] {
    // Tokenise. For string input the existing camelCase / snake_case splitter
    // fires; for array input each element is tokenised separately and the
    // union forms the query token set.
    const tokens: string[] = [];
    if (Array.isArray(query)) {
        const seen = new Set<string>();
        for (const kw of query) {
            for (const t of tokenize(kw)) if (!seen.has(t)) { seen.add(t); tokens.push(t); }
        }
    } else {
        tokens.push(...tokenize(query));
    }
    if (tokens.length === 0) return [];

    const limit = options.limit ?? 20;
    const minScore = options.minScore ?? 0.05;
    const requireAll = options.requireAll === true;
    const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;

    const index = buildSearchIndex(snapshot);

    const scored: Array<{ entry: IndexEntry; raw: number }> = [];
    for (const entry of index) {
        if (kindFilter && !kindFilter.has(entry.kind)) continue;

        let raw = 0;
        let matched = 0;
        for (const t of tokens) {
            const inPrimary = entry.primaryTokens.has(t);
            const inSecondary = entry.secondaryTokens.has(t);
            if (inPrimary) { raw += 3; matched++; }
            else if (inSecondary) { raw += 1; matched++; }
        }
        if (matched === 0) continue;
        // AND semantics: require every supplied query token to match.
        if (requireAll && matched < tokens.length) continue;
        // Score boost: prefer entries matching MORE of the query tokens.
        const coverage = matched / tokens.length;
        let score = raw * coverage * KIND_BOOST[entry.kind];
        // Diff recency boost.
        if (entry.diff && entry.diff !== 'unchanged') score *= 1.2;
        scored.push({ entry, raw: score });
    }

    // Normalize scores to 0..1 by the top raw score for readable output.
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.raw - a.raw);
    const top = scored[0].raw;
    return scored
        .map(({ entry, raw }) => ({
            kind: entry.kind,
            id: entry.id,
            name: entry.name,
            headline: entry.headline,
            score: Number((raw / top).toFixed(3)),
            filePath: entry.filePath,
            route: entry.route,
            method: entry.method,
            clusterLabel: entry.clusterLabel,
            serviceId: entry.serviceId,
            diff: entry.diff,
        }))
        .filter((r) => r.score >= minScore)
        .slice(0, limit);
}
