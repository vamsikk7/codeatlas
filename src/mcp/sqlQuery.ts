/**
 * sqlQuery.ts — read-only SQL access against the CodeAtlas state.db.
 *
 * Why exposed: callers (LLMs, scripts) sometimes need ad-hoc queries the
 * canned MCP tools don't cover — e.g. "list every route whose handler name
 * matches `delete*` in cluster X with diff != 'unchanged'". Rather than ship
 * a new tool for every shape, expose a tightly-restricted SQL endpoint.
 *
 * Hard guardrails (defense-in-depth, all must pass before the SQL hits SQLite):
 *   1. Only SELECT statements allowed (regex on first non-whitespace token).
 *   2. Reject statements containing any DML/DDL keyword as a whole token
 *      (INSERT, UPDATE, DELETE, REPLACE, DROP, ALTER, CREATE, ATTACH, DETACH,
 *      PRAGMA, REINDEX, VACUUM, BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE).
 *   3. Reject queries with multiple statements (semicolon between non-trailing).
 *   4. Reject queries longer than `MAX_SQL_LENGTH` bytes.
 *   5. Force a LIMIT clause via the wrapping query when none is present.
 *   6. Restrict accessible tables to the well-known snapshot tables.
 *   7. Run with a strict row cap; truncate the response.
 *
 * The result is a structured `SqlQueryResult` with rows + meta so the LLM
 * caller knows exactly what came back (column names, row count, truncation).
 */
import type { SnapshotStore } from '../core/storage/snapshotStore';

const MAX_SQL_LENGTH = 4_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

const FORBIDDEN_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE',
    'ATTACH', 'DETACH', 'PRAGMA', 'REINDEX', 'VACUUM',
    'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
    'TRUNCATE', 'MERGE', 'GRANT', 'REVOKE',
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i');

/**
 * #889 — filesystem / extension-loading scalar functions. A `SELECT
 * readfile('/etc/passwd')` carries no DML/DDL keyword and no FROM, so it slips
 * past every other guard. The current engine is sql.js (WASM) which doesn't
 * compile these in (they'd error "no such function") — but this is the
 * load-bearing guard if the store ever swaps to a native SQLite build that does
 * (or loads the `fileio`/`zipfile` extensions). Matched in function-call form
 * (`name(`) after string-literal stripping so a literal in a quoted string is
 * not a false positive.
 */
const FORBIDDEN_FUNCTIONS = [
    'readfile', 'writefile', 'load_extension', 'fts3_tokenizer',
    'zipfile', 'edit', 'lsmode', 'fileio_read', 'fileio_write',
];
const FORBIDDEN_FN_RE = new RegExp(`\\b(${FORBIDDEN_FUNCTIONS.join('|')})\\s*\\(`, 'i');

/**
 * Tables an LLM is permitted to query. Reject queries that reference any
 * other table (`sqlite_master`, `git_refs`, etc.) so a careless query can't
 * accidentally read internal extension state or break the abstraction.
 *
 * NOTE: `sqlite_master` IS allowed because we use it for schema introspection
 * via `describe_schema()` — but only the read-only metadata columns.
 */
const ALLOWED_TABLES = new Set([
    'apis', 'graphs', 'files', 'snapshots', 'comments', 'settings',
    // v2 data tables — service detection (#714 Flutter monorepo + the rest
    // of the FE/mobile pipeline lands its results here), Louvain clusters,
    // screen records (v2 phase 3), and L2b screen-content items
    // (v2 phase 4 — #718 Android XML visual items live in `screen_items`).
    // Agents need read access to these to answer FE/mobile-specific
    // questions ("list screens in this app", "what visual elements does
    // the auth screen expose?", "which Flutter app owns this widget?").
    'services', 'clusters', 'screens', 'screen_items',
    'sqlite_master', // for schema queries
]);

export interface SqlQueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    /** Echoed-back SQL (post-rewrite if a LIMIT was injected). */
    executedSql: string;
}

export interface SqlQueryError {
    error: string;
    hint?: string;
}

/**
 * Parse out every identifier that appears after FROM or JOIN. Robust enough
 * to reject `select * from secret_table` while allowing the snapshot tables.
 */
function extractReferencedTables(sql: string): string[] {
    const tables: string[] = [];
    // Strip string literals so a literal "delete" inside a quoted string
    // doesn't trigger the forbidden-keyword check.
    const stripped = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    const re = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(stripped)) !== null) {
        tables.push(m[1].toLowerCase());
    }
    return tables;
}

/**
 * Extract CTE names introduced by `WITH name AS (...)` (including
 * comma-separated multi-CTE forms). These need to be permitted in the
 * referenced-table check so users can build read-only queries on top of CTEs.
 */
function extractCteNames(sql: string): string[] {
    const stripped = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    if (!/^\s*WITH\b/i.test(stripped)) return [];
    const names: string[] = [];
    // Match `WITH name AS (...)` and subsequent `, name AS (...)` clauses
    // up to the outer SELECT keyword. Simplified — assumes well-formed input.
    const re = /(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi;
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(stripped)) !== null) {
        names.push(m[1].toLowerCase());
    }
    return names;
}

/**
 * Run a read-only SQL query against the snapshot store. Returns either a
 * structured result or a structured error — never throws.
 */
export function runReadOnlyQuery(
    store: SnapshotStore,
    sql: string,
    limit: number = DEFAULT_LIMIT,
): SqlQueryResult | SqlQueryError {
    // ── Length cap ────────────────────────────────────────────────
    if (!sql || typeof sql !== 'string') return { error: 'query must be a non-empty string' };
    if (sql.length > MAX_SQL_LENGTH) {
        return { error: `query exceeds max length (${MAX_SQL_LENGTH} bytes)` };
    }

    // ── Single-statement guard ────────────────────────────────────
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (trimmed.includes(';')) {
        return { error: 'multiple statements not allowed', hint: 'remove the embedded semicolon' };
    }

    // ── First token must be SELECT ────────────────────────────────
    const firstToken = trimmed.split(/\s+/, 1)[0]?.toUpperCase();
    if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
        return { error: 'only SELECT (or WITH … SELECT) statements are allowed', hint: `got: ${firstToken}` };
    }

    // ── Forbidden DML/DDL keywords ────────────────────────────────
    // Strip string literals first to avoid false positives.
    const stripped = trimmed.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    const forbiddenMatch = stripped.match(FORBIDDEN_RE);
    if (forbiddenMatch) {
        return { error: `forbidden keyword: ${forbiddenMatch[1]}`, hint: 'only read-only SELECTs are allowed' };
    }

    // ── Forbidden filesystem / extension-loading functions (#889) ─────
    const forbiddenFn = stripped.match(FORBIDDEN_FN_RE);
    if (forbiddenFn) {
        return { error: `forbidden function: ${forbiddenFn[1]}`, hint: 'filesystem / extension-loading functions are not permitted' };
    }

    // ── Table allowlist ──────────────────────────────────────────
    // CTE names introduced by WITH count as locally-defined aliases — add
    // them to the allowlist for this query so users can build read-only
    // multi-step queries.
    const cteNames = new Set(extractCteNames(trimmed));
    const referenced = extractReferencedTables(trimmed);
    for (const t of referenced) {
        if (!ALLOWED_TABLES.has(t) && !cteNames.has(t)) {
            return {
                error: `table not allowed: ${t}`,
                hint: `allowed tables: ${[...ALLOWED_TABLES].join(', ')}`,
            };
        }
    }

    // ── Row cap ──────────────────────────────────────────────────
    const cap = Math.min(Math.max(1, limit), MAX_LIMIT);
    // Append `LIMIT cap+1` if the SQL doesn't already end with a LIMIT clause.
    // The +1 lets us detect truncation. Appending (not subquery-wrapping) keeps
    // the query valid for both plain SELECTs and WITH … SELECT CTEs (which can
    // break when wrapped in `SELECT * FROM (...)` on older SQLite builds).
    const hasLimit = /\bLIMIT\s+\d+/i.test(stripped);
    const wrapped = hasLimit ? trimmed : `${trimmed} LIMIT ${cap + 1}`;

    let rows: Record<string, unknown>[];
    try {
        rows = store.getSqliteStore().all(wrapped);
    } catch (e: any) {
        return { error: `sql error: ${e?.message ?? String(e)}` };
    }

    const truncated = rows.length > cap;
    if (truncated) rows = rows.slice(0, cap);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        executedSql: wrapped,
    };
}

/**
 * Return a description of the snapshot schema — table names + column defs +
 * a row count per table — so LLMs can author SELECTs against the right
 * tables/columns without having to guess. Schema introspection is also a
 * read-only operation; it lives here so the access path is gated identically
 * to `runReadOnlyQuery`.
 */
export interface SchemaDescription {
    tables: Array<{
        name: string;
        columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }>;
        rowCount: number;
    }>;
    notes: string[];
}

export function describeSchema(store: SnapshotStore): SchemaDescription {
    const sqlite = store.getSqliteStore();
    const tables: SchemaDescription['tables'] = [];
    for (const table of ALLOWED_TABLES) {
        if (table === 'sqlite_master') continue;
        try {
            const cols = sqlite.all(`PRAGMA table_info(${table})`) as Array<{
                name: string; type: string; notnull: number; pk: number;
            }>;
            if (cols.length === 0) continue;
            const countRow = sqlite.get(`SELECT count(*) AS c FROM ${table}`);
            tables.push({
                name: table,
                columns: cols.map((c) => ({
                    name: c.name,
                    type: c.type,
                    notnull: !!c.notnull,
                    pk: !!c.pk,
                })),
                rowCount: Number(countRow?.c ?? 0),
            });
        } catch {
            // Table may not exist in older state.db schemas — skip.
        }
    }
    return {
        tables,
        notes: [
            'apis.record_json is a JSON-encoded ApiRecord (method, route, handlerName, filePath, meta {auth, middlewares, error, webhook, dynamicRange}, diff). Query JSON fields with json_extract(record_json, \'$.path.to.field\').',
            'graphs.graph_json is a JSON-encoded DiagramGraph (graphId, type, nodes[], edges[], anchors, meta). The graph_id column is `<type>:<filePath>:<handlerName>` for sequence/flow graphs.',
            'files.record_json is the FileRecord; the `content` column may be NULL after a save (#354/#355) — use the SnapshotStore.getFileContent() API for content access instead.',
            'snapshot_kind column on apis/graphs/files is \'baseline\' | \'working\'. Filter by it explicitly.',
            'Forbidden keywords (will be rejected): INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, ATTACH, DETACH, PRAGMA, VACUUM, BEGIN, COMMIT, ROLLBACK, TRUNCATE.',
            'Forbidden functions (will be rejected): readfile, writefile, load_extension, fts3_tokenizer, zipfile — no filesystem or extension access.',
        ],
    };
}
