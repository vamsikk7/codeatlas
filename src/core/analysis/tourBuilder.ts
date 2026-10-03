/**
 * tourBuilder.ts — Issue #702 Onboarding Tour mode (MVP backend).
 *
 * Produces an ordered sequence of "tour steps" — entry points + a one-
 * line "why this matters" blurb — so a new contributor can read the
 * codebase in a deliberate order instead of bouncing between layers.
 *
 * Two modes per the issue:
 *   - **'codebase'**: depth-first from the highest-fan-in entry points.
 *     Useful when you've never seen the repo before: starts at the routes
 *     that most code depends on (e.g. auth middleware), then walks the
 *     dependency tree outward.
 *   - **'recent'**: orders by diff status first (`modified` → `added` →
 *     `unchanged`), then by fan-in within each diff bucket. Replaces the
 *     "what changed recently?" use case that the existing git-diff replay
 *     covers, but without requiring a git diff to be active.
 *
 * The MVP synthesises blurbs from snapshot data ("GET /login — handles
 * login requests, called by 3 routes"). The full LLM-driven blurbs from
 * the #702 spec ship in a follow-up that wires `llmNamingService`.
 *
 * Pure data-in / data-out — the MCP tool + UI both consume this output.
 */

import type {
    Snapshot,
    DiffStatus,
    ApiRecord,
    Anchor,
    SerializedCallGraph,
} from '../graph/graphTypes';

export type TourMode = 'codebase' | 'recent';

export interface TourStep {
    /** ApiRecord.apiId — the route or screen this step focuses on. */
    entryPointId: string;
    /** One-line "why this matters" blurb. Heuristic in the MVP, LLM later. */
    why: string;
    /** Source anchor (file + symbol) so the UI can deep-link to the editor. */
    anchor: Anchor;
    /** Synthetic method + route shorthand for the step header. */
    label: string;
    /** Which existing layer view the UI should open when the step is shown. */
    layer: 'sequence' | 'file';
    /** Drill-down graph id the renderer can use directly (no extra lookup). */
    drillDownGraphId: string;
    /** How many other code paths reach this entry point. Higher = more
     *  load-bearing; surfaced in the UI as a "called by N" badge. */
    fanIn: number;
    /** Diff status at the time the tour was generated (for the 'recent'
     *  mode ordering). Carried forward so the UI can color the step. */
    diff?: DiffStatus;
    /** Position in the ordered tour, 1-based. */
    stepNumber: number;
}

export interface TourBuildOptions {
    /** Cap the returned step count. Default 30 — chosen to fit the issue's
     *  "30-minute reading session" target (assuming ~60s per step). */
    maxSteps?: number;
    /** Diff source for the 'recent' mode. Defaults to `apiIndex` derived
     *  from `snapshot.apiIndex` lookups against `baselineApiIds`. */
    baselineApiIds?: ReadonlySet<string>;
}

/**
 * Compute the tour step sequence.
 *
 * @param snapshot   Working snapshot. We read `apiIndex`, `callGraph`
 *                   (for fan-in counts), and per-API diff flags.
 * @param mode       `'codebase'` (default) or `'recent'`.
 * @param options    `maxSteps`, optional baseline lookup set.
 */
export function buildTour(
    snapshot: Snapshot,
    mode: TourMode = 'codebase',
    options: TourBuildOptions = {},
): TourStep[] {
    const maxSteps = options.maxSteps ?? 30;
    const rawApis = Object.values(snapshot.apiIndex ?? {});
    if (rawApis.length === 0) return [];

    // Issue #770: filter out entry points that aren't a useful Step 1
    // for a new contributor — test files, framework-class synthetic
    // `constructor` entries (NestJS), and library internals (e.g. the
    // py-starlette repo indexes the starlette package itself).
    const libraryInternalsRoot = detectLibraryInternalsRoot(snapshot);
    const apis = rawApis.filter(api => !shouldExcludeFromTour(api, libraryInternalsRoot));
    if (apis.length === 0) return [];

    const fanInLookup = buildFanInLookup(snapshot);
    const diffLookup = buildDiffLookup(apis, options.baselineApiIds);

    type Candidate = TourStep & { _sortKey: number[] };
    const candidates: Candidate[] = apis.map(api => {
        const fanIn = fanInLookup.get(`${api.filePath}::${api.handlerName}`) ?? 0;
        const diff = diffLookup.get(api.apiId);
        const step: TourStep = {
            entryPointId: api.apiId,
            why: writeBlurb(api, fanIn, diff),
            anchor: api.anchor ?? { filePath: api.filePath, span: { start: 0, end: 1 } },
            label: `${api.method} ${api.route}`,
            layer: api.handlerName ? 'sequence' : 'file',
            drillDownGraphId: api.handlerName
                ? `sequence:${api.filePath}:${api.handlerName}`
                : `file:${api.filePath}`,
            fanIn,
            diff,
            stepNumber: 0, // placeholder — overwritten after sort
        };
        const _sortKey = sortKeyFor(step, mode, api);
        return Object.assign(step, { _sortKey });
    });

    // Stable sort: lower _sortKey comes first. The tie-breaker on equal
    // primary keys is the apiId, which is stable across rebuilds.
    candidates.sort((a, b) => {
        for (let i = 0; i < a._sortKey.length; i++) {
            const av = a._sortKey[i] ?? 0;
            const bv = b._sortKey[i] ?? 0;
            if (av !== bv) return av - bv;
        }
        return a.entryPointId.localeCompare(b.entryPointId);
    });

    // #846a — cluster attribution: tell the reader which feature owns the
    // entry point so step blurbs read as guidance, not route restatements.
    const clusterByFile = new Map<string, string>();
    for (const cluster of Object.values(snapshot.clusters ?? {})) {
        for (const f of (cluster as { files?: string[] }).files ?? []) {
            if (!clusterByFile.has(f)) clusterByFile.set(f, (cluster as { name?: string; id: string }).name ?? (cluster as { id: string }).id);
        }
    }

    return candidates.slice(0, maxSteps).map((s, i) => {
        let why = s.why;
        const clusterName = clusterByFile.get(s.anchor?.filePath ?? '');
        if (clusterName && !why.includes(clusterName)) {
            why = `${why} Part of the “${clusterName}” feature.`;
        }
        // #846a — frame STEP 1 as guidance: say WHY it leads the tour.
        if (i === 0 && mode === 'codebase') {
            const reason = s.fanIn >= 2
                ? `the most connected entry point (fan-in ${s.fanIn})`
                : `the most natural first entry into this codebase`;
            why = `Start here — ${reason}. ${why}`;
        }
        const out: TourStep = {
            entryPointId: s.entryPointId,
            why,
            anchor: s.anchor,
            label: s.label,
            layer: s.layer,
            drillDownGraphId: s.drillDownGraphId,
            fanIn: s.fanIn,
            diff: s.diff,
            stepNumber: i + 1,
        };
        return out;
    });
}

/**
 * Issue #770: per-method-class priority weight. Multiplied into the
 * negative fan-in so high-priority routes win when fan-in ties — and
 * also so low-priority entries like DB migrations don't beat a real
 * HTTP route just because they happened to score a higher fan-in.
 *
 * Tiers (lowest score = ranks first, since we negate fan-in):
 *   1.0 — first-tier user-facing routes (HTTP, RESOURCE, CONTROLLER, SCREEN, NAV_ROUTE)
 *   0.7 — background work (JOB, MQ_CONSUMER, CLI_COMMAND, subscriptions, RPC)
 *   0.5 — cross-cutting (push handlers, lifecycle, deep links, widget targets)
 *   0.4 — middleware / interceptors / filters / DI / event listeners / health
 *   0.2 — infrastructure / data tier (DB_MIGRATION, DB_SEED)
 *   0.3 — catch-alls (`ALL *`, bare `*`)
 *   default 0.6 — unrecognised method
 */
const METHOD_PRIORITY: Record<string, number> = {
    GET: 1.0, POST: 1.0, PUT: 1.0, PATCH: 1.0, DELETE: 1.0,
    HEAD: 1.0, OPTIONS: 1.0,
    RESOURCE: 1.0, CONTROLLER: 1.0, ROUTE: 0.9,
    SCREEN: 1.0, NAV_ROUTE: 1.0,
    SERVER_ACTION: 1.0, DATA_FETCH: 0.9,
    WS: 0.9, SSE: 0.9, SUBSCRIPTION: 0.9, GRPC: 0.9, RPC: 0.9,
    SOCKET_EVENT: 0.9,
    JOB: 0.7, MQ_CONSUMER: 0.7, CLI_COMMAND: 0.7,
    PUSH_HANDLER: 0.5, BG_TASK: 0.5, LIFECYCLE: 0.5,
    DEEP_LINK: 0.6, WIDGET: 0.6, CONTENT_PROVIDER: 0.4,
    NETWORK: 0.6, DI_BINDING: 0.4,
    MIDDLEWARE: 0.4, SERVLET_FILTER: 0.4, HANDLER_INTERCEPTOR: 0.4,
    FILTER: 0.4, MODEL_HOOK: 0.4, EVENT_LISTENER: 0.4,
    EVENT_EMIT: 0.4, AOP_BEFORE: 0.4, AOP_AFTER: 0.4, AOP_AROUND: 0.4,
    HEALTH: 0.4, DI_DEPENDENCY: 0.4,
    DB_MIGRATION: 0.2, DB_SEED: 0.2, SIGNAL: 0.4,
    MOUNT: 0.5, INCLUDE: 0.5, PATH: 0.5, STATIC_PATHS: 0.5,
    ANY: 0.3,
};

/**
 * BUG-POLAR-27: framework META / asset routes (OpenGraph & Twitter images,
 * favicons, icons, sitemaps, robots, manifests, Next.js internals, static
 * assets) are GET routes so they scored the top HTTP priority (1.0) and, with
 * a bit of fan-in, won the "most natural first entry" slot — e.g. `GET /og` led
 * the polar tour instead of an auth/checkout route. These are not meaningful
 * business entry points, so they're downweighted to just above catch-alls.
 */
const META_ROUTE_RE = /(?:^|\/)(?:og|opengraph-image|twitter-image|favicon|icon|apple-icon|apple-touch-icon|robots|sitemap|manifest|_next|static|assets?)(?:[/.]|$)/i;

function priorityFor(api: ApiRecord): number {
    const m = api.method?.toUpperCase?.() ?? '';
    // Catch-all routes (`ALL *`, `*`, `/*`) get downweighted aggressively
    // since they're framework-glue (404 handlers, request loggers, JWT
    // middleware shims). A real route with fan-in 1 should still beat a
    // catch-all with fan-in 10, so use 0.05 — high enough that very
    // dominant catch-alls still appear, low enough they never win on
    // typical fan-in skew.
    if (api.route === '*' || api.route === '/*') return 0.05;
    // BUG-POLAR-27: meta/asset routes rank just above catch-alls so a real
    // route with any fan-in leads the tour over `/og`, `/favicon.ico`, etc.
    if (META_ROUTE_RE.test(api.route ?? '')) return 0.15;
    return METHOD_PRIORITY[m] ?? 0.6;
}

/**
 * Numeric sort key — earlier-sorting key means earlier-in-tour step.
 * Returns an array because the secondary key matters when the primary
 * matches (and the sort comparator above iterates it).
 *
 * For 'codebase' (Issue #770):
 *   key = [-priority*fanIn, -fanIn]
 *     — primary: load-bearing PRIORITY-WEIGHTED fan-in.
 *     — secondary: raw fan-in (tie-breaks within the same priority class).
 * For 'recent':
 *   key = [diffBucket, -priority*fanIn] — modified first, then added, etc.
 *                                          Inside each bucket, priority +
 *                                          fan-in still rank, so a modified
 *                                          DB_SEED doesn't beat a modified
 *                                          POST handler.
 */
function sortKeyFor(step: TourStep, mode: TourMode, api: ApiRecord): number[] {
    const priority = priorityFor(api);
    const weighted = priority * step.fanIn;
    // Issue UX-13 (2026-06-03) — when fan-in is 0/equal across many
    // routes (very common on small projects), the previous sort fell
    // back to graphId-alphabetical, which on the realworld test repo
    // landed Tour Step 1 on `DELETE /api/articles/:slug` — a hostile
    // first impression. Add a verb-friendliness tie-breaker so reading
    // verbs (GET, HEAD) win over write verbs (POST/PUT/PATCH/DELETE)
    // at otherwise-equal rank. Lower verb rank sorts earlier.
    const verbRank = methodFriendlinessRank(api.method);
    if (mode === 'recent') {
        const bucket = step.diff === 'modified' ? 0
            : step.diff === 'added' ? 1
                : 2;
        return [bucket, -weighted, -step.fanIn, verbRank];
    }
    return [-weighted, -step.fanIn, verbRank];
}

/**
 * Issue UX-13 — HTTP verb friendliness rank for tour-step ordering.
 * Lower = earlier in the tour (more welcoming first step).
 *
 *   0  — GET / HEAD / OPTIONS / RESOURCE / CONTROLLER / SCREEN — safe reads.
 *   1  — POST — write but new-entity / creation.
 *   2  — PUT / PATCH — mutate existing.
 *   3  — DELETE / catch-alls / unknown.
 */
function methodFriendlinessRank(method: string | undefined): number {
    const m = (method ?? '').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || m === 'SCREEN'
        || m === 'NAV_ROUTE' || m === 'RESOURCE' || m === 'CONTROLLER'
        || m === 'SUBSCRIPTION' || m === 'DATA_FETCH' || m === 'HEALTH') return 0;
    if (m === 'POST') return 1;
    if (m === 'PUT' || m === 'PATCH') return 2;
    if (m === 'DELETE') return 3;
    // Workers, jobs, hooks etc. sit in the middle.
    return 2;
}

/**
 * Issue #770: skip entries that aren't useful Tour Step 1 candidates.
 *
 *   1. **Test files** — handler `filePath` contains `__tests__/`,
 *      `tests/`, `spec/`, `.test.`, or `.spec.` (any segment).
 *   2. **Synthetic `constructor` entries** — NestJS controllers emit a
 *      `constructor` entry alongside `@Get/@Post/...` methods; the
 *      constructor isn't a real route handler.
 *   3. **Library internals** — if the repo packages itself (e.g.
 *      py-starlette indexes the starlette/ library source), files
 *      living inside that self-imported directory are downranked to
 *      hidden so the Tour doesn't open on the library's own internals.
 */
function shouldExcludeFromTour(api: ApiRecord, libraryInternalsRoot: string | null): boolean {
    const fp = api.filePath ?? '';
    if (/(^|\/)(__tests__|tests?|spec|specs|integration-test)(\/|$)/i.test(fp)) return true;
    if (/\.(test|spec)\.[a-z]+$/i.test(fp)) return true;
    if (api.handlerName === 'constructor') return true;
    if (libraryInternalsRoot && fp.startsWith(libraryInternalsRoot + '/')) return true;
    return false;
}

/**
 * Issue #770: when the workspace IS the framework's own library code
 * (signalled by a top-level package metadata file whose `name` matches
 * a directory containing source), return that directory so handlers
 * declared inside it can be excluded. Conservative default — only
 * Python / npm shapes for now since those are the common offenders
 * (py-starlette indexes starlette itself).
 */
function detectLibraryInternalsRoot(snapshot: Snapshot): string | null {
    const files = Object.keys(snapshot.files ?? {});
    if (files.length === 0) return null;
    // Find a top-level directory whose name matches the repo's package
    // name. We approximate package name from common entry-point files.
    const packageFiles = files.filter(f =>
        f === 'pyproject.toml' || f === 'setup.py' || f === 'package.json' || f === 'Cargo.toml',
    );
    if (packageFiles.length === 0) return null;
    // Look for top-level directories whose name might be the package.
    const topDirs = new Set<string>();
    for (const f of files) {
        const slash = f.indexOf('/');
        if (slash > 0) topDirs.add(f.slice(0, slash));
    }
    // Cheap heuristic: a top-level dir matching a package convention
    // and containing >= 20 source files is likely the library itself.
    for (const dir of topDirs) {
        if (!/^[a-z][a-z0-9_-]*$/i.test(dir)) continue;
        const fileCountInDir = files.filter(f => f.startsWith(dir + '/')).length;
        if (fileCountInDir < 20) continue;
        // Also require an `__init__.py` or `index.{ts,js}` directly inside
        // — that's the "this is the package root" tell.
        if (
            files.includes(`${dir}/__init__.py`)
            || files.includes(`${dir}/index.ts`)
            || files.includes(`${dir}/index.js`)
            || files.includes(`${dir}/mod.rs`)
            || files.includes(`${dir}/lib.rs`)
        ) {
            return dir;
        }
    }
    return null;
}

/**
 * Pre-compute fan-in (number of incoming call-graph edges) per function
 * key. Used to rank entry points by how load-bearing they are: a function
 * everything else calls into is a better tour starting point than a leaf.
 */
function buildFanInLookup(snapshot: Snapshot): Map<string, number> {
    const out = new Map<string, number>();
    const cg = snapshot.callGraph;
    if (!cg) return out;
    for (const node of Object.values(cg.nodes ?? {})) {
        out.set(node.key, node.calledBy?.length ?? 0);
    }
    return out;
}

function buildDiffLookup(
    apis: ApiRecord[],
    baselineApiIds: ReadonlySet<string> | undefined,
): Map<string, DiffStatus> {
    const out = new Map<string, DiffStatus>();
    // Issue #748: read the per-record `diff` field that
    // `buildApiListGraph` already populates by comparing baseline vs
    // working. This is what makes `mode: 'recent'` actually order
    // modified routes ahead of unchanged ones — previously only 'added'
    // was detected (via the `baselineApiIds` set), so a modified
    // canonical route stayed in the bucket-2 tail.
    for (const api of apis) {
        if (api.diff && api.diff !== 'unchanged') {
            out.set(api.apiId, api.diff);
        }
    }
    // The baseline-set check still fires for cases where the API list
    // graph hasn't been rebuilt yet but the caller has fresh baseline
    // info — covers init races on cold workspaces.
    if (baselineApiIds) {
        for (const api of apis) {
            if (!out.has(api.apiId) && !baselineApiIds.has(api.apiId)) {
                out.set(api.apiId, 'added');
            }
        }
    }
    return out;
}

/**
 * Compose the one-line "why this matters" blurb. Issue #753: the previous
 * blurb was a generic restatement of method + route + handler — useful as
 * a label but no actual insight about why the route deserves attention.
 * This version leads with the most-salient architectural signal first
 * (change status > fan-in rank > auth required > webhook > parameter
 * route) and falls back to the bare route+handler only when no signal
 * stands out.
 *
 * The LLM-generated blurb described in the #702 spec is still the
 * eventual upgrade path; this template is what ships when no LLM is
 * configured, and it should still teach the reader something they
 * couldn't get from `git ls-files | grep`.
 */
/**
 * Bug D (2026-06-04) — Tour step bodies were exposing synthetic handler
 * IDs like `anonymous@GET:/` that the parser invents for routes without
 * a named handler function (inline arrow callbacks). Treat those as
 * "no friendly name" and drop them from the rendered blurb so users see
 * "Read /." instead of "Read /. Handler: `anonymous@GET:/`.".
 */
export function isAnonymousHandlerName(name: string | undefined | null): boolean {
    if (!name) return true;
    return name.startsWith('anonymous@');
}

function friendlyHandlerName(api: ApiRecord): string | null {
    if (isAnonymousHandlerName(api.handlerName)) return null;
    return api.handlerName!;
}

function writeBlurb(api: ApiRecord, fanIn: number, diff?: DiffStatus): string {
    const insights: string[] = [];
    const meta = api.meta ?? {};
    const methodVerb = methodToVerb(api.method);
    const friendly = friendlyHandlerName(api);
    const labelTail = friendly
        ? `\`${api.method} ${api.route}\` → \`${friendly}\``
        : `\`${api.method} ${api.route}\``;

    // Lead with diff status — modified > added > deleted. Tour mode
    // `recent` already groups by diff; the blurb makes the reason
    // explicit so a reader skimming the codebase mode also notices.
    if (diff === 'modified') {
        insights.push(`Modified in working diff — likely needs review`);
    } else if (diff === 'added') {
        insights.push(`Newly added since baseline`);
    } else if (diff === 'deleted') {
        insights.push(`Removed since baseline`);
    }

    // Fan-in is the strongest "load-bearing" signal: a route that many
    // other functions converge on is critical to understand.
    if (fanIn >= 5) {
        insights.push(`load-bearing (fan-in ${fanIn})`);
    } else if (fanIn >= 2) {
        insights.push(`fan-in ${fanIn}`);
    }

    // Security-flavoured flags.
    if (meta.webhook) {
        const provider = meta.webhookProvider && meta.webhookProvider !== 'generic'
            ? `${meta.webhookProvider} webhook`
            : `webhook receiver`;
        insights.push(provider);
    } else if (meta.auth === 'required') {
        // Only call out auth when there's no more-specific signal.
        if (insights.length === 0) insights.push(`auth-gated`);
    } else if (meta.auth === undefined && /^(POST|PUT|PATCH|DELETE)$/.test(api.method)) {
        // Write route without auth on the chain — useful escalation.
        insights.push(`write route, no auth middleware detected`);
    }

    // Middleware chain — surface only when it's non-trivial so the
    // blurb stays one line. Two or more middlewares is "non-trivial".
    if (Array.isArray(meta.middlewares) && meta.middlewares.length >= 2) {
        insights.push(`${meta.middlewares.length} middlewares`);
    }

    // Error-handling middleware.
    if (meta.error) {
        insights.push(`error handler`);
    }

    // Parameter route — useful to flag :id-style routes for new
    // contributors learning the routing patterns.
    if (/:[a-zA-Z]/.test(api.route)) {
        // Don't lead with this; it's contextual. Only mention when the
        // insight list is sparse.
        if (insights.length <= 1) insights.push(`parameterised path`);
    }

    if (insights.length === 0) {
        // Fall back to the original restatement when no signal stands
        // out — a leaf GET on `/health` deserves a one-line "Read /health"
        // explanation, not a forced insight. Bug D: only mention the
        // handler when it has a friendly name; anonymous synthetic IDs
        // like `anonymous@GET:/` add noise without info.
        const handlerSuffix = friendly ? ` Handler: \`${friendly}\`.` : '';
        return `${methodVerb} ${api.route}.${handlerSuffix}`;
    }

    return `${insights[0].charAt(0).toUpperCase()}${insights[0].slice(1)}${insights.length > 1 ? '; ' + insights.slice(1).join(', ') : ''}. ${labelTail}.`;
}

function methodToVerb(method: string): string {
    switch (method) {
        case 'GET': return 'Read';
        case 'POST': return 'Create';
        case 'PUT':
        case 'PATCH': return 'Update';
        case 'DELETE': return 'Delete';
        case 'WS': return 'Stream over';
        case 'SUBSCRIPTION': return 'Subscribe to';
        case 'JOB': return 'Run background job';
        case 'MQ_CONSUMER': return 'Consume messages from';
        case 'CLI_COMMAND': return 'CLI command';
        case 'SCREEN': return 'Render screen';
        case 'NAV_ROUTE': return 'Navigate to';
        default: return method;
    }
}

// ─── Reduced output shape for MCP / serialization ───────────────────────────

/**
 * The MCP tool wants a flat, JSON-friendly shape — no embedded anchors,
 * just the strings the caller needs to render the step. This is what
 * `get_tour` will return per the issue spec.
 */
export interface TourStepLite {
    stepNumber: number;
    entryPointId: string;
    label: string;
    why: string;
    filePath: string;
    symbol?: string;
    fanIn: number;
    diff?: DiffStatus;
    drillDownGraphId: string;
}

export function toLiteSteps(steps: TourStep[]): TourStepLite[] {
    return steps.map(s => ({
        stepNumber: s.stepNumber,
        entryPointId: s.entryPointId,
        label: s.label,
        why: s.why,
        filePath: s.anchor.filePath,
        symbol: s.anchor.symbol,
        fanIn: s.fanIn,
        diff: s.diff,
        drillDownGraphId: s.drillDownGraphId,
    }));
}

// ─── ADR-034 Phase H (#793 — Phase H: Tours per repo + workspace meta-tour (ADR-034)) — workspace meta-tour ───────────────────────
//
// One step per repo. Steps ordered by cross-repo HTTP topology — repos
// with no incoming HTTP edges come first (these are the "producers" /
// gateway-style services that originate cross-repo calls). Repos that
// only RECEIVE calls land later. Ties broken lexicographically by
// rootPath. Cycles broken deterministically by ignoring the
// lexicographically-greater edge.
//
// Each step's `drillDownGraphId` points at the per-repo `tour:<repoId>`
// so a click drills into that repo's full per-handler tour (built by
// the existing `buildTour` against the per-repo state.db).
//
// Pure function — reads aggregator state only, no per-repo snapshot
// access. Empty / failed / api-less repos are skipped so the tour
// doesn't contain dead steps.

interface MetaTourAggregatorView {
    listRepos(): ReadonlyArray<{
        repoId: string;
        name: string;
        rootPath: string;
        status: 'parsing' | 'ready' | 'failed' | 'stale';
    }>;
    listCrossRepoHttpEdges(): ReadonlyArray<{
        sourceRepo: string;
        targetRepo: string;
        method: string;
        route: string;
    }>;
    getRepoSummary(repoId: string): {
        apis: ReadonlyArray<{
            apiId: string;
            method: string;
            route: string;
            filePath: string;
            handlerName: string;
        }>;
    } | undefined;
}

export function buildWorkspaceMetaTour(
    aggregator: MetaTourAggregatorView,
    _workspaceRoot: string,
): TourStep[] {
    const allRepos = aggregator.listRepos();
    // Skip failed repos — their summary may be stale or missing.
    const candidates = allRepos.filter((r) => r.status !== 'failed');
    if (candidates.length === 0) return [];

    // Build in-degree map keyed by repoId. Repos with 0 in-edges go first.
    const inDegree = new Map<string, number>();
    for (const r of candidates) inDegree.set(r.repoId, 0);
    const edges = aggregator.listCrossRepoHttpEdges();
    const knownRepos = new Set(candidates.map((r) => r.repoId));
    // Stable iteration order for cycle breaking — sort edges first.
    const sortedEdges = [...edges].sort((a, b) =>
        a.sourceRepo.localeCompare(b.sourceRepo) ||
        a.targetRepo.localeCompare(b.targetRepo));
    // Build adjacency for in-degree count. An edge SOURCE → TARGET means
    // SOURCE calls TARGET; TARGET receives, so TARGET has an in-edge.
    const adj = new Map<string, Set<string>>();   // source → {targets}
    for (const r of candidates) adj.set(r.repoId, new Set());
    for (const e of sortedEdges) {
        if (!knownRepos.has(e.sourceRepo) || !knownRepos.has(e.targetRepo)) continue;
        if (e.sourceRepo === e.targetRepo) continue;   // self-loop ignored
        if (adj.get(e.sourceRepo)!.has(e.targetRepo)) continue;   // dedup
        adj.get(e.sourceRepo)!.add(e.targetRepo);
        inDegree.set(e.targetRepo, (inDegree.get(e.targetRepo) ?? 0) + 1);
    }

    // Kahn's algorithm with deterministic lexicographic tie-break.
    const ordered: string[] = [];
    const visited = new Set<string>();
    // Take 0-in-degree nodes lexicographically.
    while (ordered.length < candidates.length) {
        const ready = candidates
            .filter((r) => !visited.has(r.repoId) && (inDegree.get(r.repoId) ?? 0) === 0)
            .sort((a, b) => a.rootPath.localeCompare(b.rootPath) || a.repoId.localeCompare(b.repoId));
        if (ready.length === 0) {
            // Cycle detected — pick the lex-smallest remaining as the
            // cycle-break point, decrement an arbitrary in-edge so progress
            // can continue. Reproducible across runs because we sort.
            const remaining = candidates
                .filter((r) => !visited.has(r.repoId))
                .sort((a, b) => a.rootPath.localeCompare(b.rootPath) || a.repoId.localeCompare(b.repoId));
            if (remaining.length === 0) break;
            const pick = remaining[0];
            inDegree.set(pick.repoId, 0);
            continue;
        }
        const next = ready[0];
        ordered.push(next.repoId);
        visited.add(next.repoId);
        // Decrement in-degree of every successor.
        for (const target of adj.get(next.repoId) ?? []) {
            inDegree.set(target, Math.max(0, (inDegree.get(target) ?? 0) - 1));
        }
    }

    // Now turn the ordered repos into TourSteps. Each step picks the
    // repo's top entry — heuristic: first GET route if any, else first
    // apiId in the summary's `apis` array (which is already sorted by
    // apiId thanks to `serializeRepoSummary`).
    const steps: TourStep[] = [];
    let stepNumber = 1;
    for (const repoId of ordered) {
        const r = candidates.find((c) => c.repoId === repoId)!;
        const summary = aggregator.getRepoSummary(repoId);
        if (!summary || summary.apis.length === 0) continue;
        const top = pickTopEntry(summary.apis);
        steps.push({
            entryPointId: top.apiId,
            why: whyFor(r.name, top.method, top.route),
            anchor: {
                filePath: top.filePath,
                symbol: top.handlerName,
                stableKey: `tour:${repoId}:${top.apiId}`,
            },
            label: `${r.name}: ${top.method} ${top.route}`,
            layer: 'sequence',
            drillDownGraphId: `tour:${repoId}`,
            fanIn: 0,   // meta-tour doesn't carry per-step fanIn; UI hides the badge
            diff: undefined,
            stepNumber: stepNumber++,
        });
    }
    return steps;
}

function pickTopEntry<T extends { method: string; route: string; apiId: string }>(apis: ReadonlyArray<T>): T {
    // Prefer a non-:param GET route (health/index style) — most readable
    // first impression. Fall back to first GET, then first api overall.
    const gets = apis.filter((a) => a.method.toUpperCase() === 'GET');
    const cleanGets = gets.filter((a) => !a.route.includes(':') && !a.route.includes('{') && !a.route.includes('$'));
    // BUG-POLAR-27: the shortest clean GET was often a framework META/asset route
    // (`/og`, `/favicon.ico`, `/sitemap.xml`) — a poor "start here". Prefer a
    // meaningful clean GET; only fall back to meta routes if that's all there is.
    const meaningfulGets = cleanGets.filter((a) => !META_ROUTE_RE.test(a.route));
    const pickFrom = meaningfulGets.length ? meaningfulGets : cleanGets;
    if (pickFrom.length) {
        // shortest non-param GET (often /health, /, /status)
        return [...pickFrom].sort((a, b) => a.route.length - b.route.length)[0];
    }
    if (gets.length) return gets[0];
    return apis[0];
}

function whyFor(repoName: string, method: string, route: string): string {
    return `${repoName} — start here. ${method} ${route} is the most natural first entry into this service.`;
}
