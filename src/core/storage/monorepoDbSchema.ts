/**
 * ADR-034 Phase A — `monorepo.db` schema + migration constants (#786 — Phase A: per-repo DB foundation (ADR-034)).
 *
 * The aggregator DB lives next to each workspace's `state.db` and carries
 * cross-repo state (repo registry, shared externals, shared schemas,
 * cross-repo HTTP edges, repo summaries, workspace-scope graphs). In
 * Phase A every cross-repo table is empty — DDL ships now so future
 * phases (C #788, J #795) can populate without a migration.
 *
 * The schema version is bumped whenever the SQL shape changes. Forward
 * migrations live next to the DDL in `MONOREPO_MIGRATIONS`.
 */

export const MONOREPO_SCHEMA_VERSION = 1;

/**
 * Full DDL for `monorepo.db`. Emitted in order on first init when the
 * file is absent. Phase A inserts a single row into `schema_version` so
 * future readers can fast-fail on shape mismatch.
 *
 * NOTE on `CREATE TABLE … AS SELECT * FROM … WHERE 0`: SQLite materialises
 * a snapshot of the source table's column structure at DDL time. The
 * baseline tables MUST be created after their source tables so the schema
 * propagates. Order matters here.
 */
export const MONOREPO_DDL: ReadonlyArray<string> = [
    `CREATE TABLE IF NOT EXISTS schema_version (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS repos (
        repo_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        realpath_hash TEXT NOT NULL,
        technology TEXT,
        status TEXT NOT NULL CHECK (status IN ('parsing','ready','failed','stale')),
        last_init_at INTEGER,
        error_message TEXT,
        fallback_state_path TEXT,
        state_db_schema_version INTEGER NOT NULL,
        summary_schema_version INTEGER NOT NULL,
        diff TEXT
    )`,

    `CREATE INDEX IF NOT EXISTS idx_repos_realpath ON repos(realpath_hash)`,

    // Cross-repo tables — schema-only in Phase A; populated by C/J.
    `CREATE TABLE IF NOT EXISTS shared_externals (
        provider_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        consumers_json TEXT NOT NULL,
        diff TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS baseline_shared_externals AS
        SELECT * FROM shared_externals WHERE 0`,

    `CREATE TABLE IF NOT EXISTS shared_schemas (
        engine TEXT NOT NULL,
        table_name TEXT NOT NULL,
        consumers_json TEXT NOT NULL,
        diff TEXT,
        PRIMARY KEY (engine, table_name)
    )`,
    `CREATE TABLE IF NOT EXISTS baseline_shared_schemas AS
        SELECT * FROM shared_schemas WHERE 0`,

    `CREATE TABLE IF NOT EXISTS cross_repo_http_edges (
        source_repo TEXT NOT NULL,
        target_repo TEXT NOT NULL,
        method TEXT NOT NULL,
        route TEXT NOT NULL,
        diff TEXT,
        PRIMARY KEY (source_repo, target_repo, method, route)
    )`,
    `CREATE TABLE IF NOT EXISTS baseline_cross_repo_http_edges AS
        SELECT * FROM cross_repo_http_edges WHERE 0`,

    // Workspace-scope graphs (microservice:workspace, map:workspace,
    // domain:workspace, tour:workspace, health:report, feature:workspace).
    `CREATE TABLE IF NOT EXISTS graphs (
        graph_id TEXT PRIMARY KEY,
        graph_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS baseline_graphs AS
        SELECT * FROM graphs WHERE 0`,

    `CREATE TABLE IF NOT EXISTS repo_summaries (
        repo_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        summary_schema_version INTEGER NOT NULL,
        received_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS baseline_repo_summaries AS
        SELECT * FROM repo_summaries WHERE 0`,

    // ADR-034 Phase G (#792 — Phase G: AI Code Review per repo + workspace guidelines (ADR-034)) — workspace-wide AI review guidelines and
    // workspace-scope findings. Per-repo guidelines + findings continue
    // to live in each repo's state.db.review_guidelines and
    // state.db.ai_review_findings. The aggregator only carries the
    // workspace-level row + findings against workspace-scope graphIds
    // (e.g. `microservice:workspace`, `map:workspace`).
    `CREATE TABLE IF NOT EXISTS workspace_review_guidelines (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        text TEXT NOT NULL DEFAULT '',
        hash TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_ai_review_findings (
        finding_id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL,
        finding_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_findings_graph ON workspace_ai_review_findings(graph_id)`,

    // ADR-034 Phase I (#794 — Phase I: API Testing per repo + cross-repo chain runner (ADR-034)) — per-repo workspace settings + saved chains.
    // repo_settings keeps a row per repoId carrying workspace-aware
    // per-repo config (dev_base_url, plus future per-repo tweaks). Kept
    // out of `repos` so the registry table stays cheap to rotate.
    `CREATE TABLE IF NOT EXISTS repo_settings (
        repo_id TEXT PRIMARY KEY,
        dev_base_url TEXT NOT NULL DEFAULT '',
        settings_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS api_testing_chains (
        chain_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        env_text TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
    )`,
];

/** PRAGMAs applied immediately after `CREATE`. */
export const MONOREPO_PRAGMAS: ReadonlyArray<string> = [
    `PRAGMA journal_mode = WAL`,
    `PRAGMA synchronous = NORMAL`,
];

/**
 * Forward migrations keyed by target version. Phase A ships v1 — no
 * migrations yet. Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) lands v2 (shared-state population).
 */
export const MONOREPO_MIGRATIONS: ReadonlyMap<number, ReadonlyArray<string>> =
    new Map([
        // [2, ['ALTER TABLE …']],  // Reserved for Phase C / Phase J.
    ]);

/**
 * Stable filename for the aggregator DB. Lives next to `state.db` in
 * `.codeatlas/`. The dirname comes from the workspace root.
 */
export const MONOREPO_DB_FILE = 'monorepo.db';
