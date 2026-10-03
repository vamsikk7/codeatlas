// Core graph types shared across all diagram layers
// These are the data structures that flow between builders, diff engine, storage, and webview

export type DiffStatus = 'added' | 'deleted' | 'modified' | 'unchanged';

export interface Anchor {
    filePath: string;
    symbol?: string;
    span?: { start: number; end: number };
    stableKey?: string;
    // #513 — verbatim source quoted by the AI to justify a finding. Filtered
    // server-side; only present when the snippet was successfully matched
    // back to the source corpus we shipped.
    snippet?: string;
    lineStart?: number;
    lineEnd?: number;
    // #855 — which gate tier accepted this evidence: 'exact' / 'fuzzy'
    // (verbatim or Levenshtein quote match) vs 'anchor' (quote drifted but
    // the symbol resolved in source). Lets the PR comment flag lower-
    // confidence findings instead of dropping them.
    evidenceConfidence?: 'exact' | 'fuzzy' | 'anchor';
}

export interface GraphNode {
    id: string;
    type: 'file' | 'import' | 'variable' | 'function' | 'participant' | 'statement' | 'decision' | 'loop' | 'terminal' | 'return' | 'service' | 'cluster' | 'class' | 'section'
        // v2 phase 6 (#487 — L4 node-kind taxonomy expansion (component / hook / store / view / viewmodel / repository)) — L4 kinds taxonomy expansion per
        // `docs/v2-frontend-mobile-layer-spec.md` §3 (L4) + §5.
        // Backend file graphs continue to emit only the kinds above;
        // FE/mobile graphs gain these per-category kinds via the
        // `fileGraphEnricher` post-processor (gated on
        // `ServiceRecord.category`).
        // Frontend additions:
        | 'component'      // function/class React/Vue/Svelte component
        | 'hook'           // `use*` function defined or imported here
        | 'store'          // Zustand/Redux/Jotai/Recoil store, Context provider
        | 'fetcher'        // fetch / axios / tRPC / apollo client wrapper
        | 'route-config'   // Next.js page export, Remix loader/action, SvelteKit +page.server.ts
        // Mobile additions:
        | 'view'           // Activity / Fragment / @Composable / UIViewController / SwiftUI View / StatefulWidget
        | 'viewmodel'      // ViewModel / Bloc / Provider / Riverpod notifier
        | 'repository'
        | 'network-client'
        | 'persistence';   // Room DAO / CoreData entity / SwiftData @Model / Hive box
    label: string;
    subtitle?: string;
    body?: string;
    kind?: string;
    diff?: DiffStatus;
    diffDetail?: { deleted?: string; added?: string };
    anchor?: Anchor;
    meta?: Record<string, unknown>;
    clusterMembership?: string;
    serviceId?: string;
    impactScore?: number;
    hidden?: boolean;
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    edgeType?: 'contains' | 'calls' | 'uses' | 'depends' | 'participant' | 'message' | 'flow' | 'deleted' | 'inter-service' | 'inter-cluster';
    diff?: DiffStatus;
    diffDetail?: { deleted?: string; added?: string };
    styleKind?: 'normal' | 'added' | 'deleted' | 'changed';
    callCount?: number;
    meta?: Record<string, unknown>;
    hidden?: boolean;
}

export type DiagramType = 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'screen-content'
    // Issue #700 — Knowledge Map view: single-canvas unified diagram that
    // overlays L1 services, L2a clusters, L2b APIs, and infrastructure on
    // one canvas. Built by `mapGraphBuilder.buildMapGraph`; rendered by
    // `webview-ui/src/components/MapView.tsx`. Existing layer graphs stay
    // as drill-downs (click a node → open its layer view).
    | 'map'
    // Issue #701 — Domain graph: business-intent clustering parallel to
    // the existing Louvain feature clusters. Each domain is a named
    // verb-action ("Authenticate users", "Process payments") with
    // contributing routes + files. Built by
    // `domainGraphBuilder.buildDomainGraph`; rendered as a Modules ↔
    // Domains toggle on top of FeatureView.
    | 'domain'
    // Issue #712 — wiki / knowledge-base view. Markdown documents in
    // `docs/` / `runbooks/` / `adr/` parsed for [[wikilinks]], headings,
    // and code references. Cross-links between wiki nodes and code
    // nodes appear when a doc references a file path or symbol name.
    | 'wiki';

export interface DiagramGraph {
    graphId: string;
    type: DiagramType;
    nodes: GraphNode[];
    edges: GraphEdge[];
    anchors: Record<string, Anchor>;
    meta: Record<string, unknown>;
}

// File record for snapshot storage
export interface FileRecord {
    path: string;
    hash: string;
    mtime: number;
    content?: string;         // baseline source code for diff computation
    symbols: {
        functions: SymbolRecord[];
        variables: SymbolRecord[];
        imports: ImportRecord[];
        injectedDeps?: Record<string, string>;
        /** MCP-EVAL-4 — function names referenced by a framework-invocation
         *  wrapper in this file (`Depends(get_db_session)`, `Security(...)`).
         *  Such providers are reachable via the framework even though the static
         *  call graph never sees a direct call to them. */
        frameworkRefs?: string[];
    };
}

export interface SymbolRecord {
    name: string;
    kind: 'function' | 'variable' | 'class';
    span: { start: number; end: number };
    signature: string;
    bodyText: string;
    /** #837 — raw (newline-preserving) source of the full function
     *  declaration/assignment, truncated. `bodyText` is whitespace-collapsed
     *  (normalizeSpace), which is UNPARSEABLE for semicolon-less code, so
     *  flow-diff reconstruction silently produced zero badges. Optional —
     *  absent on legacy baselines (best-effort diff + log there). */
    bodySrc?: string;
    stableKey: string;
    calls?: string[];
    memberCalls?: Record<string, string[]>;
    /** Local variable name → import source, e.g. serializer → .serializers */
    localVarTypes?: Record<string, string>;
    /** Parent class name (e.g. 'BaseController') — only set for kind:'class' */
    extendsClass?: string;
    /** Implemented interface names (e.g. ['TodoService', 'Serializable']) — only set for kind:'class' */
    implementsInterfaces?: string[];
    /** MCP-EVAL-4 — decorator source text (`@shared_task`, `@router.post(...)`).
     *  Used to recognise framework-registered functions (Celery tasks, pytest
     *  fixtures, CLI commands, validators, signal receivers) as reachable so the
     *  static call graph doesn't flag them as dead. */
    decorators?: string[];
}

export interface ImportRecord {
    source: string;
    specifiers: Array<{ local: string; imported: string }>;
    span: { start: number; end: number };
    stableKey: string;
}

// API index record
export interface ApiRecord {
    apiId: string;
    method: string;
    route: string;
    rawRoute?: string;   // original detected route before mount-prefix applied (idempotency guard)
    handlerName: string;
    filePath: string;
    anchor: Anchor;
    diff?: DiffStatus;  // set by buildApiListGraph when comparing baseline ↔ working
    /**
     * Issue 368: optional architectural intent tags layered on top of the
     * route's primary `method`. Used by the L2b panel to surface a small
     * marker (⚡ for webhooks, ❤️ for health) next to the row so the user
     * can scan a flat HTTP list for "interesting" routes at a glance.
     */
    meta?: {
        webhook?: boolean;  // route handles an inbound webhook (Stripe/GitHub/Slack/etc.)
        webhookProvider?: string; // 'stripe' | 'github' | 'slack' | 'generic' — for tooltip / icon
        /**
         * Issue 408: per-route middleware chain. Captured from Express-style
         * `router.method(path, mw1, mw2, handler)` registration where every
         * argument between the path and the handler is a middleware. Stored
         * as the source identifier (e.g., `auth.required`) so L2b can render
         * an auth indicator and L3 can insert the middleware participant.
         */
        middlewares?: string[];
        /**
         * Convenience flag derived from `middlewares` (or JSDoc `@auth`):
         * - 'required' → at least one `auth.required` / similar middleware
         * - 'optional' → at least one `auth.optional` / similar
         * - undefined → no auth middleware on the route
         */
        auth?: 'required' | 'optional';
        /**
         * #880: when a Rails resource route (declared in config/routes.rb) is
         * re-anchored onto its controller file, `routeDeclFile` keeps where the
         * route was declared and `railsResource` the resource path, so the
         * route↔controller link survives even though `filePath` now points at
         * the controller (the actual handler).
         */
        routeDeclFile?: string;
        railsResource?: string;
        /**
         * TICKET-MOBILE-1: true when this SCREEN record came from a Kotlin
         * `@Composable` (vs a class-based Activity/Fragment). The Phase-1.5
         * screen reclassifier keeps only navigable composables (NavHost
         * destinations / `*Screen`) and drops the rest as UI components.
         */
        composable?: boolean;
        /**
         * Issue 418: set true when this MIDDLEWARE record corresponds to an
         * Express error-handling middleware — a 4-arg function
         * `(err, req, res, next) => …` registered via `app.use(...)`. The L2b
         * panel surfaces this with a distinct marker; the L3 sequence builder
         * can wire 4xx/5xx returns to this participant.
         */
        error?: boolean;
        /**
         * Issue 414: for-loop unrolled route registration — emitted as ONE
         * parameterized `ApiRecord` (e.g. `/random/:index`) instead of N
         * iteration-substituted records. `from`/`to`/`step` describe the loop
         * bounds; `count` is the iteration count. Renderers surface this as
         * "N routes" in tooltips so users see the cardinality without
         * cluttering the L2b list with N rows.
         */
        dynamicRange?: { var: string; from: number; to: number; step: number; count: number };
        /**
         * Issue #600 — API Testing Phase 0: optional schema metadata mined
         * from JSDoc tags, inline Zod/Joi/Yup/class-validator imports, and
         * TypeScript parameter types. Additive — existing layers ignore
         * unknown meta keys, so populating them doesn't shift L2a/L2b/L3
         * graph outputs. The future API-testing UI consumes these fields
         * to pre-fill request bodies, query params, and path params.
         */
        pathParams?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
        queryParams?: Array<{ name: string; type?: string; required?: boolean; description?: string }>;
        requestSchema?: {
            kind: 'json' | 'form' | 'multipart' | 'raw';
            schema?: JsonSchemaLike;
            source: 'jsdoc' | 'zod' | 'joi' | 'yup' | 'class-validator' | 'ts-type';
        };
        responseSchema?: Array<{
            status: number;
            schema?: JsonSchemaLike;
            source: 'jsdoc' | 'inferred';
            description?: string;
        }>;
    };
}

/**
 * Issue #600 — JSON-Schema-lite. We avoid pulling in `json-schema` as a
 * runtime dependency; the structure is intentionally a subset so it can
 * be serialised into the existing snapshot store + diffed cheaply.
 *
 * Unknown keywords (e.g. JSON Schema `$ref`, `oneOf`, `if`/`then`) are
 * NOT supported in v1 — the inference modules drop them and surface a
 * narrowed object/array/primitive shape only. The L2b UI in Phase 1+
 * renders unsupported shapes as "schema not detected — fill manually".
 */
export interface JsonSchemaLike {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    /** For `type: 'object'`: property name → child schema. */
    properties?: Record<string, JsonSchemaLike>;
    /** For `type: 'object'`: which property names are required. */
    required?: string[];
    /** For `type: 'array'`: element schema. */
    items?: JsonSchemaLike;
    /** For `type: 'string' | 'number'`: enumeration constraint. */
    enum?: Array<string | number | boolean | null>;
    /** Free-form description (from JSDoc / inline comments). */
    description?: string;
    /** Hint that the property was marked optional or nullable. */
    nullable?: boolean;
    /** Format hint — `email`, `uri`, `date-time`, `uuid`, etc. */
    format?: string;
    /** Example value (single, not array) — used by the testing UI to seed inputs. */
    example?: unknown;
}

// Comment model
export interface Comment {
    id: string;
    status: 'open' | 'resolved';
    layer: DiagramType;
    targetType: 'node' | 'edge';
    targetId: string;
    anchor: Anchor;
    body: string;
    author: string;
    createdAt: string;
    // #504 — distinguishes user-authored comments from AI-review findings.
    // Defaults to 'user' so pre-v3 DBs round-trip unchanged.
    source?: 'user' | 'ai';
}

// #498/#499 — AI review findings. One finding may bind to multiple layers
// (e.g. an auth gap appears on L2b, L3, L4 simultaneously); bindings is the
// list of (graphId, targetId) pairs the layer-fan-out emitted for this one
// logical finding.
export interface AiReviewBinding {
    graphId: string;
    targetId: string;
    targetType: 'node' | 'edge';
    layer: DiagramType;
}

export type AiReviewSeverity = 'info' | 'warning' | 'error';
export type AiReviewCategory =
    | 'architecture'
    | 'api-design'
    | 'code-quality'
    | 'logic-bug'
    | 'security'
    | 'performance'
    | 'guideline';
export type AiReviewStatus = 'open' | 'resolved' | 'ignored' | 'stale';

/**
 * #534 — provenance tag stamped on every finding at review time so the UI
 * can show "reviewed against commit abc1234" and the user can tell stale
 * vs fresh findings after the code drifts.
 *
 *   - kind: 'git'      → ref is a 7-char git short SHA (`git rev-parse --short HEAD`).
 *   - kind: 'snapshot' → ref is an 8-char hex hash deterministically derived
 *                        from the working snapshot's `${path}@${hash}` lines
 *                        (used when the workspace isn't a git repo).
 */
export interface AiReviewBaselineRef {
    kind: 'git' | 'snapshot';
    ref: string;
    capturedAt: string;               // ISO 8601
}

/**
 * Issue 613 — one row of the finding's resolve/ignore/reopen history.
 * The trail is append-only — every status transition gets a new entry.
 * `actor` is the local username (or 'system' when no user is associated,
 * e.g. evidence-gate or guidelines-drift staleness from #536).
 */
export interface AiReviewAuditEntry {
    ts: string;                       // ISO 8601
    fromStatus: AiReviewStatus | null;  // null on creation
    toStatus: AiReviewStatus;
    actor: string;
    note?: string;                    // optional comment supplied at the time
}

/**
 * Issue (post-#605) — blast radius summary attached to each AI Review
 * finding so the popover can show "fixing this affects N functions in M
 * services" alongside severity. Computed once per entry-point file by
 * `analyzeImpact()` and stamped onto every finding produced from that
 * entry. Optional + back-compat — readers default to "unknown".
 */
export interface AiReviewBlastRadius {
    directImpacts: number;          // functions in the changed file itself
    transitiveCallers: number;      // upstream callers via call edges
    reviewRequired: number;         // import-only dependents (needs human review)
    clustersAffected: number;
    servicesAffected: number;
    /** Top 5 most-impactful callers — already filtered by call-edge confidence. */
    topCallers?: Array<{
        filePath: string;
        functionName: string;
        impactKind: 'direct' | 'transitive' | 'review-required';
    }>;
}

export interface AiReviewFinding {
    id: string;
    entryPointId: string;             // method+route key, e.g. 'GET:/api/articles'
    bindings: AiReviewBinding[];      // layers this finding applies to
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    anchor?: Anchor;                  // optional file/symbol/span anchor for editor jump
    status: AiReviewStatus;
    model: string;
    guidelinesHash?: string;          // ties finding to the guideline set that produced it
    baselineRef?: AiReviewBaselineRef; // #534 — what state was reviewed
    createdAt: string;                // ISO 8601
    updatedAt: string;                // ISO 8601
    /**
     * Issue 613 — status-change history. Appended on every `updateStatus`
     * call. Optional for back-compat with rows written before the field
     * existed; readers should default to `[]`.
     */
    auditTrail?: AiReviewAuditEntry[];
    /**
     * Blast radius — surfaced in the popover so users know the impact of
     * acting (or not acting) on this finding. Computed at review time.
     */
    blastRadius?: AiReviewBlastRadius;
}

// Call graph types (GitNexus-style knowledge graph)
export type CallEdgeKind = 'calls' | 'imports';

export interface SerializedCallEdge {
    key: string;           // callee function key "<filePath>::<functionName>"
    confidence: number;    // 0.0–1.0 (intra-file calls=0.9, cross-file=0.85, heuristic=0.6, imports=0.95)
    kind: CallEdgeKind;
}

export interface SerializedCallGraphNode {
    key: string;          // "<filePath>::<functionName>"
    filePath: string;
    functionName: string;
    calls: string[];      // outgoing edges (function keys) — kept for backwards-compat iteration
    calledBy: string[];   // incoming edges (function keys) — kept for backwards-compat iteration
    callEdges?: SerializedCallEdge[];  // enriched outgoing edges with confidence + kind
}

export interface SerializedFlatEdge {
    callerKey: string;
    calleeKey: string;
    confidence: number;
    kind: CallEdgeKind;
}

export interface SerializedCallGraph {
    nodes: Record<string, SerializedCallGraphNode>;
    edges: SerializedFlatEdge[];   // flat edge list for quick traversal
    version: number;
}

/**
 * Issue #705 — Infrastructure-as-code record (non-AST parse output).
 *
 * Parsers in `src/core/parser/infra/` each emit one or more
 * `InfraRecord`s per file. The `kind` discriminator drives downstream
 * handling: `'docker-stage'` → L1 service intent; `'terraform-resource'`
 * → L1 infra node + dependency edges; `'k8s-deployment'` → L1 service;
 * `'graphql-type'` → L2b api-list section; `'openapi-route'` → L2b
 * api-list; `'protobuf-service'` → L1 + L2b for gRPC services.
 *
 * Phase 1 ships Dockerfile + Terraform parsers; later phases add the
 * remaining kinds without breaking the contract.
 */
export type InfraKind =
    | 'docker-stage'           // Dockerfile multi-stage build target
    | 'docker-compose-service' // docker-compose.yml service block
    | 'terraform-resource'     // .tf `resource "<type>" "<name>" {}` block
    | 'terraform-module'       // .tf `module "<name>" {}` block
    | 'k8s-deployment'         // K8s `kind: Deployment`
    | 'k8s-service'            // K8s `kind: Service`
    | 'k8s-ingress'            // K8s `kind: Ingress`
    | 'k8s-cronjob'            // K8s `kind: CronJob`
    | 'graphql-type'           // GraphQL `type Foo { … }` SDL declaration
    | 'graphql-query'          // GraphQL Query/Mutation/Subscription field
    | 'openapi-route'          // OpenAPI/Swagger path item
    | 'protobuf-service'       // .proto `service Foo { … }` declaration
    | 'protobuf-rpc'           // .proto rpc within a service
    | 'wiki-doc';              // Issue #712 — markdown / ADR / runbook

export interface InfraRecord {
    id: string;            // Stable id — `"infra:<kind>:<name>"` or similar.
    kind: InfraKind;
    name: string;          // Human-readable label (resource name, type name, etc.).
    filePath: string;      // Workspace-relative path that produced this record.
    anchor: Anchor;        // Source location for editor open.
    /** Optional dependency targets (other InfraRecord.id values OR
     *  bare strings when the dependency is external). Drives the L1
     *  graph edges. Example: a Terraform `aws_lambda_function` may
     *  depend on an `aws_iam_role.lambda_exec`. */
    dependencies?: string[];
    /** Free-form per-kind metadata — base image for `docker-stage`,
     *  provider for `terraform-resource`, etc. Stays opaque to the
     *  dispatcher; renderers + service detectors read it selectively. */
    meta?: Record<string, unknown>;
}

/**
 * Issue #701 — Domain cluster (business-intent grouping).
 *
 * Sits parallel to `FeatureCluster` (Louvain structural clustering). Where a
 * FeatureCluster answers "what files talk to each other?", a DomainCluster
 * answers "what does this codebase DO?" — keyed by verb-action labels like
 * "Authenticate users" / "Process payments". Multiple domains may overlap
 * on the same file (a payment-flow controller can belong to "Process
 * payments" + "Audit & logging" simultaneously); this differs from the
 * FeatureCluster contract which assigns each file to exactly one cluster.
 *
 * v2-phase MVP (this PR): domains are derived heuristically from route
 * paths + cluster keywords. The full LLM-driven analyzer with
 * evidence-gate + cost-modal + budget-cap controls ships in a follow-up
 * (the existing `llmNamingService` infrastructure is what it will reuse).
 */
export interface DomainCluster {
    id: string;            // "domain:<slug>" — slug derived from `name` lower-cased.
    name: string;          // Human-readable verb-action: "Authenticate users".
    verb: string;          // Action verb alone: "authenticate" / "process" / "search".
    routes: string[];      // ApiRecord.apiId values that belong to this domain.
    files: string[];       // Workspace-relative file paths that contribute to this domain.
    confidence: number;    // 0..1 — heuristic certainty (LLM analyzer will overwrite with calibrated scores).
    /** Optional parent service the domain primarily lives in (when one
     *  service dominates the route set). Multi-service domains leave it
     *  unset; the renderer shows them at workspace level instead. */
    serviceId?: string;
    diff?: DiffStatus;
    /** Free-form provenance — how this domain was derived.
     *  `'heuristic'`: produced by `detectDomains` (deterministic).
     *  `'llm-refined'`: heuristic output that the optional LLM refiner
     *  (Issue #733) touched. The deterministic system stays the source
     *  of truth; the LLM only renames + recalibrates confidence + merges. */
    source?: 'heuristic' | 'llm-refined';
}

// Feature/domain cluster (from GitNexus community detection)
export interface FeatureCluster {
    id: string;           // "cluster:<label>"
    label: string;        // inferred domain name, e.g., "auth", "payments"
    name?: string;        // human-readable name (= label initially, overridden by LLM in Issue 16)
    serviceId?: string;   // parent service ID (e.g. "service:orders") — set by detectCommunities
    files: string[];      // member file paths
    entryPoints: string[]; // function keys that are API handler entry points
    apisInCluster?: ApiRecord[]; // API records belonging to files in this cluster
    screensInCluster?: ApiRecord[];      // items with method=SCREEN (Activities, Fragments, Views, @Composable)
    navRoutesInCluster?: ApiRecord[];    // items with method=NAV_ROUTE (navigation destinations)
    networkCallsInCluster?: ApiRecord[]; // items with method=NETWORK (Retrofit, URLSession, fetch)
    diBindingsInCluster?: ApiRecord[];   // items with method=DI_BINDING (Hilt, Koin, Context, Redux)
    internalCallCount: number;
    externalCallCount: number;
    modularity?: number;       // Louvain modularity Q for this cluster's partition
    diff?: DiffStatus;
    subClusters?: Record<string, FeatureCluster>; // recursive sub-divisions for large clusters (>15 files)
}

/** L2b item category — used to partition ApiRecord[] into sections in the API List panel */
export type L2bCategory = 'api' | 'screen' | 'nav-route' | 'network' | 'di-binding' | 'subsystem';

/** Synthetic method constants for mobile/UI items stored as ApiRecord.method */
export const MOBILE_METHODS = new Set(['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING']);

// Infrastructure service (database, cache, queue, external API) detected at L1 system design
export interface InfrastructureService {
    id: string;       // "infra:<name>"
    name: string;
    /**
     * Infrastructure node kind:
     *   - `database` — Mongo/Postgres/MySQL/etc.
     *   - `cache`    — Redis/Memcached/etc.
     *   - `queue`    — RabbitMQ/Kafka/SQS/etc.
     *   - `external` — generic outbound URL with no known provider type.
     *   - `sdk`      — v2 phase 2 (#482 — L1: third-party SDK detection (FE/mobile)): third-party SDK imported by an
     *                  FE/mobile service. Carries `sdkId` so the L1
     *                  builder can pick an icon / category-specific
     *                  label (`«sdk»`).
     */
    kind: 'database' | 'cache' | 'queue' | 'external' | 'sdk';
    consumedBy: string[]; // service IDs that connect to this
    diff?: DiffStatus;
    /**
     * Set when `kind === 'sdk'`. Matches the `id` in the `SDK_CATALOG`
     * (e.g. `'stripe'`, `'sentry'`). Drives icon mapping in L1.
     */
    sdkId?: string;
    /**
     * Set when `kind === 'sdk'`. Broad function category from the SDK
     * catalog (`'payments'`, `'auth'`, `'observability'`, ...).
     */
    sdkCategory?: string;
}

/**
 * Repo / service category. Drives which L1-L5 layer detectors run for a
 * service. Added in v2 phase 2 (#482 + #483) per
 * `docs/v2-frontend-mobile-layer-spec.md` §5.
 *
 * - `backend` — server-side code (today's default and still the only
 *   category that runs Louvain clustering at L2a).
 * - `frontend` — browser-rendered code (Next.js / Nuxt / Remix /
 *   SvelteKit / React SPA). Triggers SDK detection at L1 and screen
 *   enumeration at L2a in later phases.
 * - `mobile` — native + cross-platform mobile apps (Android, iOS,
 *   React Native, Expo, Flutter, KMP). Same SDK / screen treatment as
 *   frontend plus platform-event sources (FCM, APNs, deep links).
 * - `monorepo-parent` — a top-level workspaces / pnpm-workspace.yaml /
 *   lerna.json directory with no code of its own. Its children carry
 *   the real categories.
 * - `unknown` — no recognised category signals. Falls back to backend
 *   rendering for back-compat.
 *
 * Existing snapshots loaded from disk DO NOT carry this field and are
 * upgraded to `'backend'` at load time so behaviour stays identical
 * until a service detector actually classifies them.
 */
export type RepoCategory = 'backend' | 'frontend' | 'mobile' | 'monorepo-parent' | 'unknown';

// Microservice record
export interface ServiceRecord {
    id: string;           // "service:<name>"
    name: string;
    rootPath: string;     // workspace-relative root of this service
    technology: 'express' | 'fastify' | 'nestjs' | 'koa' | 'django' | 'flask' | 'fastapi' | 'starlette' | 'spring' | 'micronaut' | 'gin' | 'echo' | 'chi' | 'fiber' | 'actix' | 'axum' | 'rocket' | 'aspnet' | 'laravel' | 'symfony' | 'rails' | 'sinatra' | 'vapor' | 'android' | 'ios' | 'react-native' | 'nextjs' | 'react' | 'vue' | 'svelte' | 'angular' | 'kmp' | 'maui' | 'serverless' | 'unknown';
    /**
     * v2 phase 2 (#482 + #483): drives FE/mobile-only L1 enrichment
     * (SDK nodes, screen→backend boundary edges). Defaults to `'backend'`
     * for back-compat — pre-v2 snapshots load as backend services.
     */
    category: RepoCategory;
    exposedApiCount: number;
    /**
     * Phase 2 finding #6 residual (2026-06-07): FE / mobile services
     * don't EXPOSE HTTP routes — they CONSUME them (fetch / axios /
     * useQuery / Dio / URLSession). Reporting their outgoing-call
     * count under `exposedApiCount` mislabels the semantic. This
     * companion field carries the NETWORK / DATA_FETCH tally so the
     * L1 label can switch by category. Optional / defaults to 0 for
     * back-compat with persisted snapshots from earlier builds.
     */
    consumedApiCount?: number;
    consumedUrls: string[];   // external URL patterns called
    consumedServices: string[]; // sibling service IDs called
    diff?: DiffStatus;
    /**
     * The owning repo root when the workspace is in multi-repo mode (≥2
     * sibling repos in one folder, no monorepo orchestrator). Undefined
     * for single-repo / monorepo workspaces. Used by the L1 graph builder
     * to attach a `repoId` to each service node so the browser can group
     * by repo instead of rendering one spaghetti canvas.
     */
    repoId?: string;
}

/**
 * Screen record — single user-visible screen of an FE/mobile service.
 *
 * v2 phase 3 (#484 — L2a screen enumeration (flat list, per-framework detectors)) per `docs/v2-frontend-mobile-layer-spec.md` §3 (L2a).
 * Frontend / mobile services replace today's Louvain clustering with a
 * flat list of screens at L2a. Each `ScreenRecord` becomes one entry
 * in the L2a panel; the screen's framework-specific declaration site
 * gives `routePath` (URL pattern or nav-graph route) and `anchor`
 * (jump-to-definition target).
 *
 * Backend services produce zero `ScreenRecord`s — the field is
 * intentionally optional on `Snapshot` and empty when populated for
 * backend repos.
 *
 * `parentNavGroup` carries an optional URL-prefix (`/admin/*`,
 * `/onboarding/*`) used by the L2a renderer to group screens under
 * section headers when ≥2 screens share a prefix. Detection of the
 * prefix happens at render time, not extraction time — leaving this
 * field unset is fine for first-pass per-framework detectors.
 */
export type ScreenFramework =
    | 'nextjs-app'
    | 'nextjs-pages'
    | 'nuxt'
    | 'remix'
    | 'sveltekit'
    | 'expo-router'
    | 'react-spa'
    | 'react-native-nav'
    | 'flutter-goroute'
    | 'flutter-material-page-route'
    | 'android-activity'
    | 'android-fragment'
    | 'android-compose'
    | 'ios-uikit'
    | 'ios-swiftui';

export interface ScreenRecord {
    /** Stable id of the form `screen:<serviceId>:<routePath>` */
    screenId: string;
    /** Owning service id (matches `ServiceRecord.id`). */
    serviceId: string;
    /** URL pattern or nav-route literal — display label in L2a. */
    routePath: string;
    /** Framework that produced this screen (drives icon / colour mapping). */
    framework: ScreenFramework;
    /** Workspace-relative path of the file that declares the screen. */
    filePath: string;
    /** Click-through anchor for jump-to-definition. */
    anchor: Anchor;
    /** Optional URL-prefix grouping (`/admin/*`, `/onboarding/*`) for L2a section headers. */
    parentNavGroup?: string;
    diff?: DiffStatus;
}

/**
 * v2 phase 4 (#485 — L2b screen contents — 5 sections + visual inventory) per `docs/v2-frontend-mobile-layer-spec.md` §3 (L2b).
 * Five primary sections + one collapsible "visual" inventory bottom row.
 *
 * Each detected per-screen item gets one of these section tags. The
 * `'visual'` section holds the inventory entries surfaced under
 * `Visual elements` (collapsed by default in the UI).
 *
 * Backend behaviour: unchanged. `ApiListPanel.tsx` keeps today's
 * 10-section HTTP/synthetic-method layout for backend services. The
 * five-section + visual layout is FE/mobile-only — gated by the
 * active L2a item's service category at the panel's render boundary.
 */
export type L2bSection =
    | 'interactions'
    | 'data'
    | 'lifecycle'
    | 'nav-in'
    | 'nav-out'
    | 'visual';

/**
 * Visual-element bucket inside the collapsed `'visual'` section of L2b.
 * Drives the grouping headers in the inventory ("Buttons", "Inputs",
 * "Lists", ...).
 *
 * `'custom'` captures non-primitive PascalCase elements that don't
 * match any other bucket — typically user-defined components rendered
 * inside the screen. They get a nested-content count summary
 * ("`<LoginForm /> — 2 inputs, 1 button`") and a side-drawer expand
 * affordance per spec §3 (L2b).
 */
export type VisualElementKind =
    | 'button'
    | 'input'
    | 'list'
    | 'label'
    | 'image'
    | 'form'
    | 'layout'
    | 'divider'
    | 'indicator'
    | 'modal'
    | 'custom';

/**
 * One item inside an L2b section for an FE/mobile screen.
 *
 * Stable id form: `<section>:<file>:<symbol>` so the L2b panel can
 * preserve scroll position + selection across cascade rebuilds when a
 * single item changes (per spec §3).
 *
 * The `kind` field carries section-specific sub-categories — examples:
 *   - section: 'interactions' → `kind: 'interaction:click'` /
 *     `'interaction:submit'` / `'interaction:change'`
 *   - section: 'data'         → `kind: 'data:hook' | 'data:store' |
 *     'data:inject'`
 *   - section: 'lifecycle'    → `kind: 'lifecycle:mount' |
 *     'lifecycle:focus' | 'lifecycle:resume' | …`
 *   - section: 'nav-in'       → `kind: 'nav-in:deep-link' |
 *     'nav-in:push' | 'nav-in:widget' | …`
 *   - section: 'nav-out'      → `kind: 'nav-out:link' |
 *     'nav-out:navigate' | …`
 *   - section: 'visual'       → carries the additional
 *     `visualKind: VisualElementKind` discriminator.
 */
export interface L2bScreenItem {
    /** Stable id, `<section>:<file>:<symbol>` */
    itemId: string;
    /** Owning screen id (matches `ScreenRecord.screenId`). */
    screenId: string;
    /** Which of the five L2b sections (or the bottom visual inventory). */
    section: L2bSection;
    /** Section-specific sub-kind, e.g. `'interaction:click'`. */
    kind: string;
    /** Handler / hook / element label rendered in the row. */
    label: string;
    /** Optional handler function name (interactions / lifecycle / data). */
    handlerName?: string;
    /** Optional visual-element bucket — set when `section === 'visual'`. */
    visualKind?: VisualElementKind;
    /** Optional target screen id for `nav-out` items (cross-link to L1). */
    targetScreenId?: string;
    /** Optional `route` for nav items (URL or path literal). */
    route?: string;
    /** File path where the item is declared (drives jump-to-definition). */
    filePath: string;
    /** Click-through anchor for jump-to-definition. */
    anchor: Anchor;
    diff?: DiffStatus;
}

// Code health analysis report
export interface HealthReport {
    deadFunctions: string[];           // function keys never called
    godFiles: string[];                // file paths with > threshold symbols
    highCouplingFiles: string[];       // file paths with > threshold edges
    cyclicDependencies: string[][];    // each inner array is one cycle (file paths)
    orphanedClusters: string[];        // cluster IDs with no cross-cluster calls
}

// Snapshot structure
export interface Snapshot {
    files: Record<string, FileRecord>;
    apiIndex: Record<string, ApiRecord>;
    graphs: Record<string, DiagramGraph>;
    callGraph?: SerializedCallGraph;
    clusters?: Record<string, FeatureCluster>;
    services?: Record<string, ServiceRecord>;
    health?: HealthReport;
    /**
     * v2 phase 3 (#484 — L2a screen enumeration (flat list, per-framework detectors)): per-screen records for FE/mobile services.
     * Empty / undefined for pre-v2 snapshots and pure-backend repos.
     */
    screens?: Record<string, ScreenRecord>;
    /**
     * v2 phase 4 (#485 — L2b screen contents — 5 sections + visual inventory): per-screen L2b content items grouped by
     * section. Keyed by `screenId` so the L2b panel can scope items
     * to the active L2a screen without iterating the workspace.
     * Empty / undefined for backend services + pre-v2 snapshots.
     */
    screenItems?: Record<string, L2bScreenItem[]>;
    /**
     * Issue #701 / #734 — Domain clusters (business-intent grouping
     * parallel to the structural `clusters`). Heuristic output from
     * `detectDomains` overwrites this on every init; the optional LLM
     * refiner (#733 — LLM-driven Domain refinement (complementary, deterministic-system-led) 🟠 Medium 2026-05-30) can layer refinements on top. Persisted to
     * sqlite schema v9 so LLM-refined names survive VS Code reload.
     * Empty / undefined on pre-v9 DBs and freshly-init'd workspaces.
     */
    domains?: Record<string, DomainCluster>;
}

export interface WorkspaceState {
    /** Legacy shape version field (predates schema_version). Kept for back-compat. */
    version: number;
    /**
     * Persisted schema version. Bumped when the state.json shape changes
     * incompatibly. Mismatches on load → re-init instead of silently using
     * corrupt data. See ADR-015 / Issue 367 — `state.json` has no schema version.
     */
    schema_version?: number;
    workspaceRoot: string;
    baseline: Snapshot;
    working: Snapshot;
    comments: Comment[];
    /** #498/#499 — AI review findings, persisted alongside comments. */
    aiReviewFindings?: AiReviewFinding[];
    /** #505 — user-supplied review guidelines text. */
    reviewGuidelines?: { text: string; hash: string; updatedAt: number };
    settings: {
        autoUpdate: boolean;
    };
}

// Message event from extension to webview
export interface SequenceMessage {
    from: string;
    to?: string;
    toParticipantKey?: string;
    /** For return messages: the participant key the return originates from (carried from forward call's toParticipantKey) */
    fromParticipantKey?: string;
    label: string;
    raw: string;
    category: 'internal' | 'external';
    pseudoKind?: string;
    pseudoName?: string;
    /** If true, this is a return/response message (rendered dashed, reverse direction) */
    isReturn?: boolean;
    /** The variable name the return value is assigned to (e.g. "result" from `const result = await foo()`) */
    returnLabel?: string;
}

export interface FunctionEntity {
    key: string;
    name: string;
    node: any;  // Babel AST node
    signature: string;
    bodyText: string;
    raw: string;
    filePath?: string;
    calls: SequenceMessage[];
    usesVars?: Set<string>;
    usesImports?: Set<string>;
}

export interface EntityRecord {
    kind: 'import' | 'variable' | 'function' | 'class';
    name: string;
    key: string;
    signature: string;
    bodyText: string;
    /** #837 — raw function source (see SymbolRecord.bodySrc). Functions only. */
    bodySrc?: string;
    locText: string;
    node?: any;
    calls?: Set<string>;
    /** Member calls: maps receiver name → set of method names (e.g. todoService → {save, findAll}) */
    memberCalls?: Map<string, Set<string>>;
    /** Local var → import source resolved at extraction time (e.g. serializer → .serializers) */
    localVarTypes?: Map<string, string>;
    usesVars?: Set<string>;
    usesImports?: Set<string>;
    /** Parent class name (e.g. 'BaseController') — only set for kind:'class' */
    extendsClass?: string;
    /** Implemented interface names (e.g. ['TodoService', 'Serializable']) — only set for kind:'class' */
    implementsInterfaces?: string[];
    /** MCP-EVAL-4 — decorator source text (`@shared_task`), functions only. */
    decorators?: string[];
}
