/**
 * ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — `RepoSummary` shape + serialiser.
 *
 * Each per-repo `RepoOrchestrator` emits a `RepoSummary` at the end of
 * its `initialize()`. The aggregator persists it to `monorepo.db.repo_summaries`
 * and runs the registered `CrossRepoAnalyzer`s, which sparsely update the
 * cross-repo consolidated tables (`shared_externals`, `shared_schemas`,
 * `cross_repo_http_edges`).
 *
 * The summary is intentionally NARROW — it carries only what cross-repo
 * consolidation needs, not the full per-repo state. This keeps the
 * aggregator's responsibilities clear: it owns the cross-repo view, not a
 * mirror of every per-repo state.db.
 *
 * Producer/consumer schema sync is enforced by `SUMMARY_SCHEMA_VERSION` +
 * the contract test in `repoSummary.contract.test.ts`. If you change the
 * shape, bump the version AND update the JSON Schema at
 * `docs/repo-summary-schema.json`.
 */

/** Bump on any shape change; producer + consumer must match. */
export const SUMMARY_SCHEMA_VERSION = 1;

/** Coarse-grained technology bucket. Free-form to stay extensible. */
export type ServiceTechnology =
    | 'nodejs' | 'python' | 'java' | 'kotlin' | 'go' | 'rust'
    | 'ruby' | 'php' | 'swift' | 'dart' | 'csharp' | 'unknown';

/**
 * SDK category — free-form string so producer detectors (`sdkDetector`)
 * can pass through their own taxonomy without coupling the summary
 * module to the parser's exact enum. Common values: `ai`, `payments`,
 * `auth`, `storage`, `comms`, `observability`, `analytics`, `push`,
 * `crash`, `ads`, `graphql`, `baas`, `attribution`.
 */
export type SdkCategory = string;

/**
 * Persistent storage engine string. Common values from
 * `dbSchemaDetector`: `postgresql`, `mysql`, `sqlite`, `mongodb`,
 * `mssql`, `oracle`, `unknown`.
 */
export type DbEngine = string;

/**
 * Where the schema declaration came from. Common values:
 * `prisma`, `typeorm`, `sequelize`, `mongoose`, `sqlalchemy`, `django`,
 * `rails`, `gorm`.
 */
export type SchemaSource = string;

export interface SummaryApi {
    apiId: string;
    method: string;
    route: string;
    filePath: string;
    handlerName: string;
}

export interface SummarySdk {
    /** Stable id from the SDK catalog (e.g. `openai`, `stripe`). */
    sdkId: string;
    /** Human-display name. */
    name: string;
    category: SdkCategory;
}

export interface SummarySchema {
    engine: DbEngine;
    tableName: string;
    displayName: string;
    source: SchemaSource;
}

/** Output of `RepoOrchestrator.produceSummary()` consumed by analyzers. */
export interface RepoSummary {
    repoId: string;
    schemaVersion: number;
    technology: ServiceTechnology;
    apis: ReadonlyArray<SummaryApi>;
    sdks: ReadonlyArray<SummarySdk>;
    schemas: ReadonlyArray<SummarySchema>;
    /** Outgoing HTTP request templates this repo issues (e.g. `http://other:3001/api/x/:id`). */
    httpClientPaths: ReadonlyArray<string>;
    /**
     * UX-67c (2026-06-09) — per-API surface hash for cross-repo
     * propagation. Each entry maps an `apiId` to a stable hash of the
     * route + method + handler shape; `crossRepoHttpAnalyzer` records
     * the producer hash via `ConsumedApiHashTracker.recordProducerHash`,
     * consumer-side analyzers call `recordConsumer`, and the cascade
     * surfaces `listStaleApis()` so consumer L1 / L3 edges flag
     * `~ modified` when the producer's shape drifts. Optional —
     * absent on legacy summaries.
     */
    apiHashes?: Readonly<Record<string, string>>;
    /** Set when the per-repo init failed. */
    failedAt?: number;
    errorMessage?: string;
}

// ─── API surface dedupe (#817 / #830, 2026-06-11) ───────────────────────

/**
 * Handler names that are framework artifacts, not real handlers. The JS
 * rebuild path can leave duplicate apiIndex entries for the same
 * (method, route) with one of these as `handlerName` (#830 — e.g. a
 * second `GET:/api/items::file::express` record appears after every
 * rebuild of an Express file). Because `apiHashes` is keyed by the
 * SHORT apiId, last-wins ordering made the surface hash flip on every
 * rebuild — flagging EVERY consumer edge `modified` after any producer
 * save, not just real surface changes.
 */
const GENERIC_HANDLER_TOKENS = new Set(['express', 'router', 'app', 'fastify', 'koa', 'server', '']);

/**
 * Deterministically dedupe summary apis by (method, route): prefer the
 * entry with a SPECIFIC handler name over a generic framework token;
 * tie-break lexicographically so init and rebuild paths agree on the
 * winner regardless of apiIndex iteration order.
 */
export function dedupeApiSurfaces(apis: ReadonlyArray<SummaryApi>): SummaryApi[] {
    const bySurface = new Map<string, SummaryApi>();
    for (const a of apis) {
        const k = `${a.method.toUpperCase()}|${a.route}`;
        const prev = bySurface.get(k);
        if (!prev) { bySurface.set(k, a); continue; }
        const prevGeneric = GENERIC_HANDLER_TOKENS.has(prev.handlerName);
        const curGeneric = GENERIC_HANDLER_TOKENS.has(a.handlerName);
        if (prevGeneric && !curGeneric) {
            bySurface.set(k, a);
        } else if (prevGeneric === curGeneric && a.handlerName < prev.handlerName) {
            bySurface.set(k, a);
        }
    }
    return [...bySurface.values()];
}

// ─── Serialiser / deserialiser ──────────────────────────────────────────

/**
 * Encode a summary for `monorepo.db.repo_summaries.summary_json`. Stable
 * key order so two runs with identical content yield identical strings —
 * keeps the WAL diff small.
 */
export function serializeRepoSummary(s: RepoSummary): string {
    const ordered: any = {
        repoId: s.repoId,
        schemaVersion: s.schemaVersion,
        technology: s.technology,
        apis: [...s.apis].sort((a, b) => a.apiId.localeCompare(b.apiId)),
        sdks: [...s.sdks].sort((a, b) => a.sdkId.localeCompare(b.sdkId)),
        schemas: [...s.schemas].sort((a, b) =>
            a.engine.localeCompare(b.engine) || a.tableName.localeCompare(b.tableName)),
        httpClientPaths: [...s.httpClientPaths].sort(),
    };
    if (s.apiHashes && Object.keys(s.apiHashes).length > 0) {
        const sortedKeys = Object.keys(s.apiHashes).sort();
        const hashes: Record<string, string> = {};
        for (const k of sortedKeys) hashes[k] = s.apiHashes[k];
        ordered.apiHashes = hashes;
    }
    if (s.failedAt !== undefined) ordered.failedAt = s.failedAt;
    if (s.errorMessage !== undefined) ordered.errorMessage = s.errorMessage;
    return JSON.stringify(ordered);
}

/**
 * Parse + validate. Rejects on missing required fields or version
 * mismatch (caller marks `repos.status='stale'` and requests re-init).
 */
export function deserializeRepoSummary(json: string): RepoSummary {
    const raw = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null) {
        throw new Error('[RepoSummary] payload is not an object');
    }
    if (typeof raw.schemaVersion !== 'number') {
        throw new Error('[RepoSummary] missing schemaVersion');
    }
    if (raw.schemaVersion !== SUMMARY_SCHEMA_VERSION) {
        throw new RepoSummarySchemaVersionMismatch(raw.schemaVersion, SUMMARY_SCHEMA_VERSION);
    }
    if (typeof raw.repoId !== 'string' || !raw.repoId) {
        throw new Error('[RepoSummary] missing repoId');
    }
    return {
        repoId: raw.repoId,
        schemaVersion: raw.schemaVersion,
        technology: raw.technology ?? 'unknown',
        apis: Array.isArray(raw.apis) ? raw.apis : [],
        sdks: Array.isArray(raw.sdks) ? raw.sdks : [],
        schemas: Array.isArray(raw.schemas) ? raw.schemas : [],
        httpClientPaths: Array.isArray(raw.httpClientPaths) ? raw.httpClientPaths : [],
        apiHashes: (raw.apiHashes && typeof raw.apiHashes === 'object') ? raw.apiHashes : undefined,
        failedAt: raw.failedAt,
        errorMessage: raw.errorMessage,
    };
}

export class RepoSummarySchemaVersionMismatch extends Error {
    constructor(public readonly received: number, public readonly expected: number) {
        super(`[RepoSummary] schema version mismatch — got ${received}, expected ${expected}. Repo needs re-init.`);
        this.name = 'RepoSummarySchemaVersionMismatch';
    }
}

/** Empty summary for a freshly-detected repo before any data lands. */
export function emptyRepoSummary(repoId: string): RepoSummary {
    return {
        repoId,
        schemaVersion: SUMMARY_SCHEMA_VERSION,
        technology: 'unknown',
        apis: [],
        sdks: [],
        schemas: [],
        httpClientPaths: [],
    };
}
