/**
 * frameworks/types.ts — Plugin contract for per-framework route detectors
 * (Issue #703, Phase 1 of the v2 plugin architecture refactor — see
 *  docs/v2-frontend-mobile-layer-spec.md §0 for the non-regression contract).
 *
 * This module owns the type definitions shared between `frameworkDetector.ts`
 * (the dispatcher) and the per-framework plugin files under this directory.
 * It contains no runtime logic — just types — so importing it cannot change
 * any existing behavior.
 *
 * The `FrameworkPlugin` interface is the contract every per-framework file
 * exports. Once all frameworks are extracted (later PRs of #703), the
 * dispatcher will collect plugins from the registry instead of consulting
 * the long inline pattern tables in `frameworkDetector.ts`.
 */

import type { SupportedLanguage } from '../treeSitterParser';

// ─── Existing types (moved verbatim from frameworkDetector.ts so plugins can use them) ──

/**
 * Output of a single pattern match. `method` is the HTTP-style verb (`GET` /
 * `POST` / `JOB` / `MQ_CONSUMER` / etc.); `route` is the path or topic;
 * `handlerName` overrides the default `findNearestFunctionName` lookup.
 * `extraMethods` is used by patterns that detect multi-method route
 * declarations (e.g. `@RequestMapping(method = {GET, POST})`).
 */
export type ExtractResult = {
    method: string;
    route: string;
    handlerName?: string;
    extraMethods?: string[];
};

/**
 * One regex-driven detection rule. Each `RoutePattern` either matches an
 * annotation/decorator (`decoratorPattern`) or a function-call site
 * (`callPattern`) and emits one or more `ExtractResult`s from the match.
 *
 * Returning an array from `extract` lets a single match site declare
 * multiple routes — used by Apollo SDL (`type Query { a: …; b: … }`),
 * Rails `resources :foo` (which expands to 7 REST actions), Spring
 * `@RequestMapping(method = {GET, POST})`, and similar.
 */
export interface RoutePattern {
    /** Regex to match decorator/annotation text (e.g., `@app.route('/users')`). */
    decoratorPattern?: RegExp;
    /** Regex to match function call patterns (e.g., `router.get('/users', handler)`). */
    callPattern?: RegExp;
    /**
     * Extract method + route from the regex match. Returning an array
     * declares multiple routes from the same match site; returning `null`
     * tells the dispatcher to drop the match.
     */
    extract: (match: RegExpMatchArray, context: DetectionContext) => ExtractResult | ExtractResult[] | null;

    // ─── Optional suppression flags (Issue #703 Phase 2+) ──
    // Pre-#703, the dispatcher decided suppression via reference-identity
    // checks against inline pattern Sets (`jsExpressPatterns.has(pattern)`).
    // For backward-compat, the dispatcher still honours those Sets — these
    // flags are the new way for plugin-extracted patterns to declare the
    // same suppression behaviour without depending on identity.

    /**
     * When true AND the file's language is JS/TS, skip matches that fall
     * inside a backtick template literal. Prevents `app.Get("/", …)`
     * snippets inside svelte/docs files from being parsed as live routes.
     * Set on patterns that look like JS function calls or decorators.
     */
    skipInsideTemplate?: boolean;

    /**
     * When true, suppress this pattern when the file is a test file
     * (matched by `isTestFile(filePath)`). GraphQL `typeDefs` strings
     * inside apollo `__tests__/` directories trigger false matches; set
     * this on patterns whose syntax legitimately appears in test fixtures
     * to suppress them in tests.
     */
    skipInGraphqlTestFile?: boolean;

    /**
     * When true (default), the dispatcher skips matches inside line and
     * block comments. Set to `false` for patterns that intentionally fire
     * from comment-embedded syntax — gRPC `// rpc Foo(...)` in `.pb.go`
     * stubs and `* rpc Foo(...)` in JSDoc-wrapped TS service stubs both
     * declare real endpoints.
     */
    skipInComment?: boolean;
}

/**
 * Per-file context passed to every `RoutePattern.extract()` call. Plugins
 * use `filePath` for route-prefix inference (Next.js / Nuxt / Remix /
 * SvelteKit file-system routing), `source` for cross-pattern lookups
 * (Spring class base path, Laravel route group prefix), and `language` to
 * branch detection logic when one plugin spans multiple languages.
 */
export interface DetectionContext {
    filePath: string;
    source: string;
    language: SupportedLanguage;
}

// ─── New: FrameworkPlugin contract ──

/**
 * One framework's detection rules, packaged so the dispatcher can collect
 * them from the registry instead of via the monolithic inline pattern
 * tables in `frameworkDetector.ts`.
 *
 * Phase 1 (this PR) defines the interface but registers no frameworks —
 * the dispatcher continues to consult its inline `FRAMEWORK_PATTERNS`
 * tables, so behavior is byte-identical to today. Later PRs of #703
 * extract one framework at a time (Express first, then NestJS, then
 * Spring, etc.) into sibling files that export a `FrameworkPlugin`.
 *
 * Each extracted plugin must pass `verify:real` against the 29 backend
 * fixture repos with zero invariant drift before merging — see the
 * non-regression contract in `docs/v2-frontend-mobile-layer-spec.md` §0.
 */
export interface FrameworkPlugin {
    /**
     * Stable identifier. Used for telemetry, conflict detection in the
     * registry, and `debug` log lines. Must be unique across all plugins.
     * Lowercase, kebab-case, framework-name only (no language suffix —
     * `express`, not `js-express`).
     */
    id: string;

    /** Display name for the L1 microservice node subtitle and logs. */
    name: string;

    /**
     * Languages this plugin's patterns apply to. The dispatcher looks up
     * the file's language from `treeSitterParser.detectLanguage()` and
     * runs only plugins whose `languages` array includes it.
     *
     * Multi-language plugins (e.g. GraphQL SDL applies to JS/TS + Java +
     * Python) declare every language they handle here.
     */
    languages: SupportedLanguage[];

    /**
     * Route patterns this framework owns. These run with the same
     * semantics as today's inline `RoutePattern[]` arrays in
     * `frameworkDetector.ts` — the dispatcher iterates each pattern's
     * `decoratorPattern` / `callPattern` against the source and calls
     * `extract()` per match.
     */
    patterns: RoutePattern[];

    /**
     * Optional per-file precomputation step. Runs once before any
     * `patterns[].extract()` call and stores its output for the dispatcher
     * to thread into the `DetectionContext` (TBD in PR-N once the
     * dispatcher routes through the registry).
     *
     * Use cases: compute Spring class-level `@RequestMapping` base path,
     * collect FastAPI router-prefix bindings, extract Ktor route blocks.
     * Today these helpers live as private functions in
     * `frameworkDetector.ts`; later PRs migrate them into per-plugin
     * `preprocess` hooks.
     */
    preprocess?: (context: DetectionContext) => Record<string, unknown> | undefined;

    /**
     * Optional post-processing step that runs after all of this plugin's
     * patterns have matched. Receives the freshly-extracted records for
     * this file from this plugin only (not other plugins' output) and
     * returns the possibly-modified set.
     *
     * Use cases: tag Spring routes with `@PreAuthorize` middleware
     * annotations, apply ASP.NET class base paths, attach webhook intent
     * tags. Today these are scattered in `detectFrameworkApis()`; later
     * PRs migrate them into per-plugin `postprocess` hooks.
     */
    postprocess?: (
        records: ExtractResultWithAnchor[],
        context: DetectionContext,
        preprocessState?: Record<string, unknown>,
    ) => ExtractResultWithAnchor[];
}

/**
 * Internal helper type: an `ExtractResult` annotated with the source
 * `match.index` so post-processors can correlate with the source span.
 * Used by `postprocess` hooks (PR-N).
 */
export interface ExtractResultWithAnchor {
    result: ExtractResult;
    matchIndex: number;
}
