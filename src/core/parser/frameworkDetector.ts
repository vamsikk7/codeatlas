/**
 * frameworkDetector.ts
 *
 * Universal API route & endpoint detector for all supported languages and frameworks.
 * Extends the existing apiDetector.ts (Express/Koa/Fastify only) to support
 * decorator-based and pattern-based endpoint detection across frameworks.
 *
 * Returns the same ApiRecord[] type, so existing sequence diagram builders
 * and API explorers work unchanged.
 */

import type Parser from 'web-tree-sitter';
import type { ApiRecord, Anchor } from '../graph/graphTypes';
import type { SupportedLanguage } from './treeSitterParser';

// ─── Types (canonical location: frameworks/types.ts) ───────────────────────
// Issue #703 Phase 1: type definitions moved to `frameworks/types.ts` so
// per-framework plugin files can consume the same `RoutePattern` /
// `DetectionContext` / `ExtractResult` contract. The dispatcher continues
// to use them via these aliased imports — the structural shape is
// byte-identical to the prior inline definitions.

import type { ExtractResult, RoutePattern, DetectionContext } from './frameworks/types';
import { frameworkRegistry } from './frameworks';
import {
    parseJsdocSchema,
    parseTsHandlerSchema,
    parseZodInferredApiSchema,
    parseJoiInferredApiSchema,
    parseYupInferredApiSchema,
    parseClassValidatorInferredApiSchema,
} from './schemaInference';

// UX-29 Phase 1 (2026-06-05) — per-framework taggers extracted to
// keep this dispatcher file under control. See `middlewareTaggers.ts`
// for the function-by-function contract.
import {
    tagFastApiAuthDependencies,
    tagSpringSecurityAnnotations,
    tagNestJsMiddleware,
    tagDjangoViewDecorators,
    tagFlaskMiddleware,
    tagRailsControllerFilters,
    tagGoMiddleware,
    tagLaravelMiddleware,
    tagAspNetAttributes,
    tagRustMiddleware,
    tagGrpcInterceptors,
    tagGraphqlDirectives,
    tagSymfonyAttributes,
    tagSinatraBeforeHooks,
} from './middlewareTaggers';

// ─── Framework Route Patterns ───────────────────────────────────────────────
//
// Issue #703 Phase 2 (PRs 2–17): every per-framework pattern table that
// used to live inline here has moved into `src/core/parser/frameworks/*.ts`
// as a `FrameworkPlugin`. The plugins register themselves on
// `frameworks/index.ts` import; the dispatcher in `detectFrameworkApis`
// pulls them from `frameworkRegistry.getForLanguage(language)`.
//
// Twenty-one plugins are registered today (counts as of PR-17):
//
//   js/ts shared:
//     nestjs (3), bull (3), mq-consumers (4), orm-hooks (3),
//     migrations (2), socket-io (1), node-events (2), hono (1),
//     node-http (1), meta-frameworks (11), graphql (4 — js/ts/py/jvm),
//     grpc (3 — js/ts/go)
//   python:      python (25) + graphql
//   java/kotlin: java-spring (19) + (kotlin only) ktor (5) + graphql
//   go:          go (3) + grpc
//   rust:        rust (8)
//   csharp:      csharp (3)
//   php:         php (8)
//   ruby:        ruby (9)
//   swift:       swift (1)
//
// The seed-file convention helper (`matchSeedFile`), the route-from-path
// helper (`inferRouteFromFilePath`), and the function-name proximity
// helper (`findNearestFunctionName`) remain in this file so plugins
// don't end up cross-importing each other.

/**
 * Tier 1 (Issue 364 — Same TS file parsed up to 5× per save) — recognise database seed scripts by file path
 * convention. Seeds don't share a regex shape across frameworks (a Prisma
 * seed has an async `main()`, a Rails seed is a top-level Ruby file with
 * inline `Model.create!`, a Sequelize seed exports `up`/`down`), so we
 * detect by path and pick the most likely handler name to anchor the
 * sequence/flow graph.
 */
function matchSeedFile(filePath: string, source: string): string | null {
    // Prisma convention: prisma/seed.{ts,js,mjs}
    if (/(?:^|\/)prisma\/seed\.(?:[mc]?[jt]sx?)$/i.test(filePath)) {
        return /(?:async\s+function|const)\s+main\b/.test(source) ? 'main' : 'seed';
    }
    // Rails convention: db/seeds.rb
    if (/(?:^|\/)db\/seeds\.rb$/i.test(filePath)) return 'seeds';
    // Sequelize convention: seeders/<n>-<name>.{ts,js}
    if (/(?:^|\/)seeders\/[^\/]+\.(?:[mc]?[jt]sx?)$/i.test(filePath)) {
        return /exports\.up\s*=|export\s+(?:const|async\s+function|function)\s+up\b/.test(source) ? 'up' : 'seed';
    }
    // Knex convention: seeds/<name>.{ts,js}
    if (/(?:^|\/)seeds\/[^\/]+\.(?:[mc]?[jt]sx?)$/i.test(filePath) &&
        /exports\.seed\s*=|export\s+(?:const|async\s+function|function)\s+seed\b/.test(source)) {
        return 'seed';
    }
    return null;
}

/**
 * Infer API route from file path using directory convention.
 * E.g., 'app/api/users/[id]/route.ts' → '/api/users/[id]'
 */
export function inferRouteFromFilePath(filePath: string, prefixes: string[]): string | null {
    for (const prefix of prefixes) {
        const idx = filePath.indexOf(prefix);
        if (idx === -1) continue;
        let route = filePath.slice(idx + prefix.length);
        // Remove file extension + framework-specific filename suffixes:
        //   /route.ts            (Next.js App Router)
        //   /+server.ts          (SvelteKit endpoint)
        //   /+page.server.ts     (SvelteKit page server)
        //   /+layout.server.ts   (SvelteKit layout server)
        //   /+page.ts            (SvelteKit page client loader)
        route = route
            .replace(/\/route\.\w+$/, '')
            .replace(/\/\+server\.\w+$/, '')
            .replace(/\/\+(?:page|layout)\.server\.\w+$/, '')
            .replace(/\/\+(?:page|layout)\.\w+$/, '')
            .replace(/\.\w+$/, '');
        // Remove method suffix (Nuxt: .post, .get)
        route = route.replace(/\.(get|post|put|patch|delete)$/i, '');
        // Normalize
        if (!route.startsWith('/')) route = '/' + route;
        route = route.replace(/\/index$/, '/').replace(/\/+$/, '') || '/';
        return route;
    }
    return null;
}

// ─── Pattern Registry ───────────────────────────────────────────────────────
//
// All patterns now live on `frameworkRegistry` (see Issue #703). This
// inline map is retained only as a placeholder — every per-language
// entry resolves to an empty array, so the dispatcher relies entirely
// on the registry. Languages with no plugin coverage (currently c, cpp,
// dart) map to `[]`; new languages are added by registering a plugin
// rather than editing this table.
const FRAMEWORK_PATTERNS: Record<SupportedLanguage, RoutePattern[]> = {
    javascript: [],
    typescript: [],
    python: [],
    java: [],
    kotlin: [],
    go: [],
    rust: [],
    c: [],
    cpp: [],
    csharp: [],
    php: [],
    ruby: [],
    swift: [],
    dart: [],
};

// ─── Main Detection Function ────────────────────────────────────────────────

/**
 * For Java/Kotlin Spring Boot: extract the class-level @RequestMapping base path.
 * Returns the prefix string (e.g. "/api/todos") or empty string if none found.
 * Also returns offsets of class-level @RequestMapping matches to suppress them
 * from being treated as method-level endpoints.
 */
function extractSpringClassBasePath(source: string): { basePath: string; classLevelOffsets: Set<number> } {
    const classLevelOffsets = new Set<number>();
    // Pattern: @RequestMapping("...") or @RequestMapping(value="...", ...) at class level
    const pattern = /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    let basePath = '';

    while ((match = pattern.exec(source)) !== null) {
        // Look at what follows this annotation (within ~300 chars) to determine if it's class-level
        const after = source.slice(match.index + match[0].length, match.index + match[0].length + 300);
        const afterLines = after.split('\n').slice(0, 8).join('\n');
        // Class-level: a `class` keyword appears before any method access modifier
        const classIdx = afterLines.search(/\bclass\b/);
        const methodIdx = afterLines.search(/\b(?:public|private|protected)\b[^{]*\(/);
        if (classIdx !== -1 && (methodIdx === -1 || classIdx < methodIdx)) {
            // This is the class-level @RequestMapping
            classLevelOffsets.add(match.index);
            if (!basePath) {
                basePath = match[1].replace(/\/$/, ''); // strip trailing slash
            }
        }
    }

    return { basePath, classLevelOffsets };
}

/**
 * Issue 345: For ASP.NET Core controllers, extract the class-level `[Route("/api")]`
 * prefix so method-level `[HttpGet("/{id}")]` results can be composed
 * (`/api/{id}`).
 *
 * Mirrors `extractSpringClassBasePath` in shape, but for C# attribute syntax.
 */
function extractAspNetClassBasePath(source: string): string {
    const pattern = /\[Route\s*\(\s*"([^"]+)"\s*\)\]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const after = source.slice(match.index + match[0].length, match.index + match[0].length + 300);
        const afterLines = after.split('\n').slice(0, 8).join('\n');
        // Class-level [Route] is followed by a `class` declaration before any
        // method declaration (which has return type + name + `(`).
        const classIdx = afterLines.search(/\bclass\b/);
        const methodIdx = afterLines.search(/\b(?:public|private|protected|internal)\b[^{]*\(/);
        if (classIdx !== -1 && (methodIdx === -1 || classIdx < methodIdx)) {
            return match[1].replace(/\/$/, '');
        }
    }
    return '';
}

/**
 * Combine a base path prefix with a method-level route.
 */
function combinePaths(base: string, route: string): string {
    if (!base) return route;
    const normalizedRoute = route === '/' ? '' : route.replace(/^\//, '');
    return base + (normalizedRoute ? '/' + normalizedRoute : '');
}

/**
 * Issue 335-338: For Go web frameworks, extract router-group bindings so that
 * routes registered on a sub-group (`g.GET("/users", h)`) can have the parent's
 * prefix prepended.
 *
 * Detected forms:
 *   • `g := r.Group("/api")`              — Gin / Echo / Fiber
 *   • `api := app.Group("/api")`          — Fiber
 *   • `var g = e.Group("/api")`           — older Go style
 *   • `g.Use(...).Group("/api")`          — chained
 *
 * Chi's `r.Route("/users", func(r chi.Router) { … })` sub-router is handled by
 * `extractGoChiRouteBlocks` because the receiver name (`r`) is a closure
 * parameter, not a top-level binding.
 */
function extractGoGroupBindings(source: string): Map<string, string> {
    const bindings = new Map<string, string>();
    // `<var> := <receiver>.Group("/api")`. Allows trailing args (Fiber
    // middleware: `app.Group("/api", logger.New())`) and a trailing
    // `.Use(...)` chain. Receiver captured separately so chained groups
    // (`r := v1.Group("/todos")` after `v1 := engine.Group("/api/v1")`)
    // resolve to the full prefix `/api/v1/todos`.
    const re = /\b(?:var\s+)?(\w+)\s*(?::=|=)\s*(\w+)\s*\.\s*Group\s*\(\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    const raw: Array<{ var: string; receiver: string; path: string }> = [];
    while ((m = re.exec(source)) !== null) {
        const path = m[3].startsWith('/') || m[3] === '' ? m[3] : '/' + m[3];
        raw.push({ var: m[1], receiver: m[2], path });
    }
    // Resolve in source order so a parent binding is visible to its child.
    for (const b of raw) {
        const parent = bindings.get(b.receiver) ?? '';
        const full = parent
            ? parent.replace(/\/$/, '') + (b.path.startsWith('/') ? b.path : '/' + b.path)
            : (b.path.startsWith('/') ? b.path : '/' + b.path);
        bindings.set(b.var, full);
    }
    return bindings;
}

/**
 * Issue 337: Chi `r.Route("/users", func(r chi.Router) { … })` declares a
 * sub-router scoped to "/users". Inside the closure, route-method calls on the
 * closure parameter (also named `r` by convention) need the parent prefix.
 *
 * Returns ranges `{prefix, startOffset, endOffset, paramName}` covering each
 * inner closure body so the route extractor can prepend the prefix when a
 * route's match.index falls inside a range AND the route's receiver matches
 * `paramName`.
 */
function extractGoChiRouteBlocks(source: string): Array<{ prefix: string; startOffset: number; endOffset: number; paramName: string }> {
    const blocks: Array<{ prefix: string; startOffset: number; endOffset: number; paramName: string }> = [];
    // Match `<var>.Route("/path", func(<param> ...) {` opening — record opening brace position.
    const re = /\b\w+\s*\.\s*Route\s*\(\s*"([^"]+)"\s*,\s*func\s*\(\s*(\w+)\b[^)]*\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        const prefix = m[1].startsWith('/') ? m[1] : '/' + m[1];
        const paramName = m[2];
        // Brace-count forward to find matching close.
        let depth = 1;
        let pos = m.index + m[0].length; // after the opening `{`
        while (pos < source.length && depth > 0) {
            const ch = source[pos];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            pos++;
        }
        blocks.push({ prefix, startOffset: m.index + m[0].length, endOffset: pos, paramName });
    }
    return blocks;
}

/**
 * Issue 334: Ktor `routing { route("/api") { route("/users") { get("/{id}") {…}; … } } }`
 * — bare `get/post/...` calls inside nested `route("/path")` blocks need their
 * parent paths concatenated. Returns ranges with the *cumulative* prefix so a
 * route extractor can pick the innermost containing range and prepend.
 */
function extractKtorRouteBlocks(source: string): Array<{ prefix: string; startOffset: number; endOffset: number }> {
    const blocks: Array<{ prefix: string; startOffset: number; endOffset: number }> = [];
    // Match `route("/path") {` openings — the regex covers both bare and
    // chained forms. Brace-walk forward to find the matching close.
    const re = /\broute\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        const path = m[1].startsWith('/') ? m[1] : '/' + m[1];
        let depth = 1;
        let pos = m.index + m[0].length;
        while (pos < source.length && depth > 0) {
            const ch = source[pos];
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            pos++;
        }
        blocks.push({ prefix: path, startOffset: m.index + m[0].length, endOffset: pos });
    }
    // Resolve nested cumulative prefixes: an inner block's prefix becomes
    // <outer.prefix> + <self.prefix>.
    for (let i = 0; i < blocks.length; i++) {
        const inner = blocks[i];
        // Find the innermost OUTER block whose range contains inner.startOffset.
        let bestParent: { prefix: string; startOffset: number; endOffset: number } | null = null;
        for (let j = 0; j < blocks.length; j++) {
            if (i === j) continue;
            const outer = blocks[j];
            if (outer.startOffset < inner.startOffset && outer.endOffset > inner.endOffset) {
                if (!bestParent || outer.startOffset > bestParent.startOffset) bestParent = outer;
            }
        }
        if (bestParent) {
            inner.prefix = bestParent.prefix.replace(/\/$/, '') + (inner.prefix.startsWith('/') ? inner.prefix : '/' + inner.prefix);
        }
    }
    return blocks;
}

/**
 * Find the innermost Ktor route-block that contains `matchIndex` and return
 * its cumulative prefix. Returns '' if not inside any block.
 */
function resolveKtorRoutePrefix(
    matchIndex: number,
    blocks: Array<{ prefix: string; startOffset: number; endOffset: number }>,
): string {
    let bestPrefix = '';
    let bestStart = -1;
    for (const b of blocks) {
        if (matchIndex >= b.startOffset && matchIndex < b.endOffset && b.startOffset > bestStart) {
            bestPrefix = b.prefix;
            bestStart = b.startOffset;
        }
    }
    return bestPrefix;
}

/**
 * For a Go route match, look up the receiver variable (the part before the
 * method call) and resolve any group prefix that should be prepended.
 *
 * Resolution order:
 *   1. If the match falls inside a Chi `r.Route(...)` closure and the receiver
 *      matches the closure parameter, use the Route prefix.
 *   2. Otherwise, look up the receiver in the group-binding map.
 *   3. Otherwise, no prefix.
 */
function resolveGoRoutePrefix(
    matchText: string,
    matchIndex: number,
    bindings: Map<string, string>,
    chiBlocks: Array<{ prefix: string; startOffset: number; endOffset: number; paramName: string }>,
): string {
    // Receiver: the variable before the first `.` in the match text.
    // matchText like `g.GET("/users"` → receiver = `g`.
    // matchText might start with a word boundary; strip leading non-word.
    const receiverMatch = /(\w+)\s*\./.exec(matchText);
    if (!receiverMatch) return '';
    const receiver = receiverMatch[1];
    // Chi sub-router scope wins if applicable.
    for (let i = chiBlocks.length - 1; i >= 0; i--) {
        const b = chiBlocks[i];
        if (matchIndex >= b.startOffset && matchIndex < b.endOffset && receiver === b.paramName) {
            return b.prefix;
        }
    }
    return bindings.get(receiver) ?? '';
}

/**
 * For Laravel PHP: extract Route::prefix('...')->group(...) boundaries.
 * Uses brace-counting to find group boundaries.
 * Returns { prefix, startOffset, endOffset }[] for each group.
 */
function extractLaravelRoutePrefixes(source: string): Array<{ prefix: string; startOffset: number; endOffset: number }> {
    const groups: Array<{ prefix: string; startOffset: number; endOffset: number }> = [];
    const prefixPattern = /Route\s*::\s*prefix\s*\(\s*['"]([^'"]+)['"]\s*\)\s*->\s*group\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = prefixPattern.exec(source)) !== null) {
        const prefix = match[1].replace(/\/$/, '');
        const groupStart = match.index + match[0].length;
        // Brace-count from groupStart to find the matching closing paren of group(...)
        let depth = 1; // we're already inside group(
        let pos = groupStart;
        while (pos < source.length && depth > 0) {
            const ch = source[pos];
            if (ch === '(' || ch === '{') depth++;
            else if (ch === ')' || ch === '}') depth--;
            pos++;
        }
        groups.push({ prefix: prefix.startsWith('/') ? prefix : '/' + prefix, startOffset: groupStart, endOffset: pos });
    }
    return groups;
}

/**
 * For FastAPI Python: extract APIRouter(prefix="...") declarations.
 * Returns { prefix, varName } for each router instantiation so routes
 * registered with @router.get etc. can have the prefix prepended.
 */
function extractFastAPIRouterPrefixes(source: string): Array<{ prefix: string; varName: string }> {
    // Issue 181: Match all APIRouter() instantiations, with or without prefix
    const routers: Array<{ prefix: string; varName: string }> = [];
    const routerPattern = /(\w+)\s*=\s*APIRouter\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = routerPattern.exec(source)) !== null) {
        const varName = match[1];
        const args = match[2];
        const prefixMatch = args.match(/prefix\s*=\s*['"]([^'"]*)['"]/);
        const rawPrefix = prefixMatch ? prefixMatch[1] : '';
        const prefix = rawPrefix ? (rawPrefix.startsWith('/') ? rawPrefix : '/' + rawPrefix).replace(/\/$/, '') : '';
        // Only record routers with a prefix (empty prefix = no prepending needed)
        if (prefix) routers.push({ prefix, varName });
    }
    return routers;
}

/**
 * For Spring Boot Java/Kotlin: extract security annotations (@Secured, @PreAuthorize, @RolesAllowed)
 * on controller methods. Returns a map of method name → security annotations.
 */
function extractSpringSecurityAnnotations(source: string): Map<string, string[]> {
    const securityMap = new Map<string, string[]>();
    // Match security annotations followed by a method declaration
    const pattern = /@(Secured|PreAuthorize|RolesAllowed)\s*\(\s*["'{]([^"'}]*)["'}]?\s*\)[\s\S]{0,200}?(?:public|protected|private)?\s+\w+\s+(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const annotation = `@${match[1]}(${match[2]})`;
        const methodName = match[3];
        const existing = securityMap.get(methodName) ?? [];
        existing.push(annotation);
        securityMap.set(methodName, existing);
    }
    return securityMap;
}

/**
 * Detect API routes/endpoints in source code using language-specific patterns.
 * Returns ApiRecord[] compatible with existing sequence diagram builders.
 *
 * This is a text-pattern based detector that works without requiring a parsed AST.
 * For decorator-based detection on AST nodes, use detectDecoratorRoutes().
 */
/**
 * Heuristics: this file is a unit/integration test (Issue 336 — L3 noise: phantom test-file APIs and orphan participants).
 * Used to suppress GraphQL `type Query { ... }` matches against test fixtures
 * — those produce phantom APIs in apollo's __tests__ dir.
 */
export function isTestFile(filePath: string): boolean {
    return /(?:^|\/)__tests?__\//.test(filePath)
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath)
        || /(?:^|\/)tests?\//.test(filePath)
        // Issue 338: JUnit / Spring / Kotlin Compose `*Test.kt` /
        // `*Tests.java` / `*TestSuite.kt`.
        || /(?:Tests?|TestSuite)\.(?:java|kt|cs|py|rb|go|rs|swift)$/.test(filePath)
        // BUG-EXPLORE-14: JS/TS test-suite basenames — `*Test.ts`, `*Tests.ts`,
        // `*Spec.ts` (Jasmine), `*TestSuite.ts` (+ jsx/tsx/mjs/cjs). Previously
        // EXCLUDED to preserve Apollo's `apolloServerTests.ts` "API surface", but
        // that file's 57 inline gql operations are TEST fixtures, not real entry
        // points — counting them produced phantom L2b rows and a 532-node L3
        // sequence. The camelCase-capital `T`/`S` is itself the word boundary, so
        // `latest.ts`, `contests.ts`, `manifest.ts` (lowercase) never match. The
        // apollo verify:real baseline is regenerated to drop the phantom count.
        || /(?:Tests?|TestSuite|Spec)\.[cm]?[jt]sx?$/.test(filePath)
        // BUG-EXPLORE-14: unambiguous test-infrastructure path segments.
        // `integration-testsuite/` (Apollo), generic `testsuite/` / `test-suite/`,
        // end-to-end (`e2e/`), and fixture/mock folders never hold real routes.
        || /(?:^|\/)(?:[\w-]*-)?testsuite\//i.test(filePath)
        || /(?:^|\/)test-suite\//i.test(filePath)
        || /(?:^|\/)e2e\//.test(filePath)
        || /(?:^|\/)__fixtures__\//.test(filePath)
        || /(?:^|\/)fixtures\//.test(filePath)
        || /(?:^|\/)__mocks__\//.test(filePath)
        // Folder conventions used by framework demo apps for benchmarks.
        || /(?:^|\/)benches?\//.test(filePath)
        // Issue 348: Android instrumented & unit-test directory conventions —
        // `androidTest/`, `unitTest/`, JUnit `@Test` files in `wear/src/test/`.
        || /(?:^|\/)(?:androidTest|unitTest)\//.test(filePath)
        // Ruby RSpec convention: `*_spec.rb`.
        || /_spec\.rb$/.test(filePath)
        // Python pytest convention: `test_*.py` / `*_test.py`.
        || /(?:^|\/)test_\w+\.py$/.test(filePath)
        || /_test\.py$/.test(filePath)
        // (Removed Issue 337: `_examples/` is NOT a test convention — it's
        // where many framework repos put canonical example apps that we
        // explicitly want to detect as routes. Go's `_*` underscore prefix
        // means "excluded from build" but those files are still real example
        // code, not test fixtures. True Go test files end in `_test.go` and
        // are filtered separately at the addApi level via `/_test\.go$/`.)
        // Issue 352: smoke-test directories (Apollo's smoke-test/, etc.).
        || /^smoke-test\//.test(filePath);
        // Note: NOT skipping `examples/` / `samples/` blanket — ts-nuxt's
        // primary content lives under `examples/` (the Nuxt repo *is* the
        // example apps), and Java's `org/springframework/samples/petclinic/...`
        // is a Java *package* namespace, not a docs directory. Filtering these
        // would erase the entire repo's API surface.
}

/**
 * Heuristics: position `idx` in `source` is inside a backtick template literal
 * (Issue 336 — L3 noise: phantom test-file APIs and orphan participants). Counts unescaped backticks before idx — odd count = inside.
 * This catches `app.Get("/", ...)` patterns embedded as code-as-string in
 * Svelte / docs templates (e.g. go-fiber's sveltekit-embed/code.ts).
 */
/**
 * #899 — per-file suppression index. The three hot predicates below were each
 * called PER MATCH and scanned the source from offset 0 every time —
 * O(matches × fileLen) — and `isInsideLineCommentOrDocBlock` allocated an
 * idx-sized string twice per call (`source.slice(0,idx).match(/"""/g)`). We
 * precompute the toggle positions in ONE linear pass per file and binary-search
 * per match → O(log n). Semantics are preserved exactly.
 */
interface SuppressionIndex {
    backticks: number[];      // unescaped ` positions (template-literal toggles)
    tripleDouble: number[];   // non-overlapping """ positions
    tripleSingle: number[];   // non-overlapping ''' positions
    rustTestSpans: Array<[number, number]>; // [bodyStart, bodyEnd) of test-module bodies (rust only)
}

/** Non-overlapping occurrences of `needle` (mirrors `String.match(/needle/g)`). */
function collectNonOverlapping(source: string, needle: string): number[] {
    const out: number[] = [];
    let i = source.indexOf(needle);
    while (i !== -1) { out.push(i); i = source.indexOf(needle, i + needle.length); }
    return out;
}

/** Body spans of Rust `#[cfg(test)] mod` / `mod tests` blocks, in source order. */
function collectRustTestSpans(source: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const modPattern = /(#\[cfg\(test\)\]\s*)?mod\s+(\w+)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = modPattern.exec(source)) !== null) {
        const isTest = !!match[1] || /^tests?$/.test(match[2]);
        if (!isTest) continue;
        const bodyStart = match.index + match[0].length;
        let depth = 1, i = bodyStart;
        for (; i < source.length && depth > 0; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
        }
        spans.push([bodyStart, i]); // i is one past the closing `}` (or EOF)
    }
    return spans;
}

function buildSuppressionIndex(source: string, language: SupportedLanguage): SuppressionIndex {
    const backticks: number[] = [];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '`' && (i === 0 || source[i - 1] !== '\\')) backticks.push(i);
    }
    return {
        backticks,
        tripleDouble: collectNonOverlapping(source, '"""'),
        tripleSingle: collectNonOverlapping(source, "'''"),
        rustTestSpans: language === 'rust' ? collectRustTestSpans(source) : [],
    };
}

/** Count of sorted-array entries strictly less than `idx` (binary search). */
function countBelow(arr: number[], idx: number): number {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < idx) lo = mid + 1; else hi = mid; }
    return lo;
}

function isInsideTemplateLiteral(sup: SuppressionIndex, idx: number): boolean {
    return countBelow(sup.backticks, idx) % 2 === 1;
}

/**
 * Heuristics: the line at `idx` starts with a comment marker (Issue 339 — Rust: anonymous closures + named-fn flow extraction missing).
 * Catches:
 *   //  /// //!  - C-family / Rust line comments
 *   *           - middle of `/** */` block comment
 *   #           - Python / Ruby / shell line comment, or Rust attribute (caller decides)
 *
 * The block-comment check (`/* … * /`) walks back through `idx` chars to test
 * whether we're inside an unclosed `/*`. Skipping comment-line matches
 * eliminates false-positive route detections from Rust doc comments
 * (`/// #[get("/")]`), C# XML doc, JS JSDoc, etc.
 */
/**
 * Issue 352: file path is itself a Rust tests/ directory (`crate-name/tests/*.rs`)
 * or a `mod.rs` inside such a directory. The whole file is test code; route
 * registrations are test fixtures.
 */
function isRustTestPath(filePath: string): boolean {
    // Match any `.rs` file under a `tests/` (or `test/`) directory at any depth
    // (`crate/tests/foo.rs`, `crate/tests/sub/foo.rs`, `crate/tests/a/b/c.rs`).
    return /(?:^|\/)tests?\/(?:[^/]+\/)*[^/]+\.rs$/.test(filePath);
}

/**
 * Heuristic: position `idx` is inside a Rust `#[cfg(test)] mod tests { … }`
 * or `mod tests { … }` block (Issue 348 — Misc TS edge cases + parser hygiene). Walks back to the latest
 * `mod <name> {` declaration; if it matches the test-module convention
 * AND the brace depth from there to idx hasn't returned to zero, we're
 * inside the test module and the route registration is a test fixture.
 */
function isInsideRustTestModule(sup: SuppressionIndex, idx: number): boolean {
    // Mirror the original "last test-mod start before idx, still open at idx"
    // semantics over the precomputed spans (sorted by start).
    let lastStart = -1, lastEnd = -1;
    for (const [s, e] of sup.rustTestSpans) {
        if (s < idx) { lastStart = s; lastEnd = e; } else break;
    }
    return lastStart !== -1 && idx < lastEnd;
}

function isInsideLineCommentOrDocBlock(source: string, sup: SuppressionIndex, idx: number): boolean {
    // Check current line's prefix
    const lineStart = source.lastIndexOf('\n', idx - 1) + 1;
    const linePrefix = source.slice(lineStart, idx).trimStart();
    if (linePrefix.startsWith('//')) return true;     // line/doc comment
    if (linePrefix.startsWith('#') && !linePrefix.startsWith('#[')) return true; // py/rb/sh comment (NOT Rust attribute)
    if (linePrefix.startsWith('*') && !linePrefix.startsWith('*/')) return true; // jsdoc continuation `* description`

    // Issue 350: Python triple-quoted docstrings (`"""…"""` / `'''…'''`).
    // #899 — odd count of `"""`/`'''` openings before idx = inside. Precomputed
    // positions + binary search (was `source.slice(0,idx).match(/"""/g)` ×2 per call).
    if (countBelow(sup.tripleDouble, idx) % 2 === 1) return true;
    if (countBelow(sup.tripleSingle, idx) % 2 === 1) return true;

    // Walk back from idx checking for unclosed block comment.
    // Cheap version: find the latest `/*` and `*/` before idx; if `/*` is later,
    // we're inside. Only count `/*` openings that begin a comment — i.e., the
    // char before is start-of-line / whitespace / `;` etc., NOT another path
    // char. Otherwise route literals like `/proxy/*` would self-mark as
    // "inside a block comment" (Issue 348 — Misc TS edge cases + parser hygiene).
    let lastOpen = -1;
    for (let i = idx - 2; i >= 0; i--) {
        if (source[i] === '/' && source[i + 1] === '*') {
            const prev = i === 0 ? '\n' : source[i - 1];
            if (/[\s;,({[=]/.test(prev)) { lastOpen = i; break; }
        }
    }
    if (lastOpen === -1) return false;
    const lastClose = source.lastIndexOf('*/', idx - 1);
    return lastOpen > lastClose;
}

/**
 * Detect HTTP routes + non-API entry points (jobs, message queues, CLI commands,
 * model hooks, etc.) in a single source file. The detector applies a per-language
 * pattern catalogue — Express/Koa/Fastify/Nest/Hono/Next/Remix/SvelteKit/tRPC for
 * JS/TS, FastAPI/Django/Flask for Python, Spring/Micronaut/JAX-RS for Java/Kotlin,
 * Gin/Echo/Chi/Fiber for Go, Laravel/Symfony for PHP, Rails/Sinatra for Ruby,
 * Actix/Axum/Rocket for Rust, ASP.NET for C#, Vapor for Swift — gated by import
 * presence (e.g. `import Hono from 'hono'`) to suppress false positives in test
 * fixtures or vendored sample code.
 *
 * @param source - Raw source code of the file being scanned
 * @param filePath - Workspace-relative path (used for file-system routing
 *                   conventions in Next.js / Nuxt / SvelteKit / Remix and for
 *                   path-gated detectors like Rails AR callbacks)
 * @param language - Detected language for selecting the correct pattern set
 * @returns Array of `ApiRecord` (one per detected route or entry point). May
 *          include synthetic methods like `JOB` / `MQ_CONSUMER` / `CLI_COMMAND`
 *          / `MODEL_HOOK` / `DB_MIGRATION` / `SOCKET_EVENT` / `SUBSCRIPTION` /
 *          `HEALTH` / `FILTER` (see CLAUDE.md "Non-API entry-point detection").
 */
export function detectFrameworkApis(
    source: string,
    filePath: string,
    language: SupportedLanguage
): ApiRecord[] {
    // Issue #703 Phase 2: merge inline patterns (today's FRAMEWORK_PATTERNS
    // tables) with patterns contributed by registered plugins. Order is
    // preserved: inline first, then registry — so extracted plugins act as
    // append-only consumers of the same dispatcher loop.
    const inlinePatterns = FRAMEWORK_PATTERNS[language] ?? [];
    const registryPatterns: RoutePattern[] = frameworkRegistry
        .getForLanguage(language)
        .flatMap((plugin) => plugin.patterns);
    const patterns = [...inlinePatterns, ...registryPatterns];
    if (patterns.length === 0) return [];

    // Issue 336 / Issue #703 Phase 2: pattern-level suppression flags
    // carry the per-pattern policy.
    //
    //   `skipInGraphqlTestFile` (GraphQL only) — GraphQL patterns fire on
    //   test fixtures in apollo's __tests__/, so we silence them when
    //   `isTestFile(filePath)` is true.
    //
    //   `skipInsideTemplate` (JS/TS Express-shape only) — svelte/docs
    //   fixtures embed `app.Get("/", …)` inside backtick strings; the
    //   flag prevents those from registering as APIs. GraphQL `type Query
    //   {…}` legitimately lives inside backticks (gql tag), so its
    //   patterns DO NOT carry the flag and continue to match.
    //
    //   `skipInComment` (gRPC opts OUT) — gRPC `.proto`-style declarations
    //   are sometimes only present in JSDoc / `// rpc Foo(Req)` form
    //   inside .pb.go stubs and generated TS service files. gRPC plugin
    //   patterns set `skipInComment: false`; everything else defaults to
    //   `true` (skip comments).
    //
    // Pre-#703 the dispatcher used reference-identity Set lookups against
    // inline arrays for this. Post-#703 the inline arrays are empty so
    // the flag is the sole carrier of the policy.
    const skipGraphqlInThisFile = isTestFile(filePath);
    const isJsTs = language === 'javascript' || language === 'typescript';

    // For Spring Boot Java/Kotlin: extract class-level @RequestMapping prefix
    const isSpring = language === 'java' || language === 'kotlin';
    const { basePath: springBasePath, classLevelOffsets } = isSpring
        ? extractSpringClassBasePath(source)
        : { basePath: '', classLevelOffsets: new Set<number>() };

    // Issue 345: For C#/ASP.NET: extract class-level [Route("/api")] prefix.
    const aspnetBasePath = language === 'csharp' ? extractAspNetClassBasePath(source) : '';
    // Compose-aware base path used by both Spring and ASP.NET method-level routes.
    const basePath = isSpring ? springBasePath : aspnetBasePath;

    // For Laravel PHP: extract Route::prefix('...')->group(...) boundaries
    const phpPrefixGroups = language === 'php' ? extractLaravelRoutePrefixes(source) : [];

    // For FastAPI Python: extract APIRouter(prefix="...") declarations
    const fastAPIRouterPrefixes = language === 'python' ? extractFastAPIRouterPrefixes(source) : [];

    // For Spring Security: extract @Secured, @PreAuthorize, @RolesAllowed
    const springSecurityMap = isSpring ? extractSpringSecurityAnnotations(source) : new Map<string, string[]>();

    // Issues 335-338: Go group-router binding map + Chi sub-router blocks.
    const goBindings = language === 'go' ? extractGoGroupBindings(source) : new Map<string, string>();
    const goChiBlocks = language === 'go' ? extractGoChiRouteBlocks(source) : [];

    // Issue 334: Ktor nested `route("/api") { route("/users") { … } }` blocks.
    const ktorBlocks = language === 'kotlin' ? extractKtorRouteBlocks(source) : [];

    const apis: ApiRecord[] = [];
    const seen = new Set<string>();

    // Tier 1 (Issue 364 — Same TS file parsed up to 5× per save) — file-path-based DB_SEED detection. Seed scripts
    // are conventionally placed at well-known paths and don't have a single
    // shared regex. We emit one DB_SEED record per seed file pointing at the
    // file's primary export / `main` function so L3/L4/L5 build naturally.
    const seedHandlerName = matchSeedFile(filePath, source);
    if (seedHandlerName) {
        const seedName = filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'seed';
        apis.push({
            apiId: `seed:${filePath}:${seedHandlerName}`,
            method: 'DB_SEED',
            route: `seed:${seedName}`,
            handlerName: seedHandlerName,
            filePath,
            anchor: { filePath, startLine: 1, endLine: 1 } as Anchor,
        });
        seen.add(`DB_SEED|seed:${seedName}|${seedHandlerName}`);
    }

    // #899 — precompute the comment/template/test-module toggle positions ONCE
    // (single linear pass) so the per-match suppression checks below are O(log n)
    // instead of O(idx). Replaces the per-call from-offset-0 scans + `match(/"""/g)`.
    const suppression = buildSuppressionIndex(source, language);

    for (const pattern of patterns) {
        // GraphQL patterns are suppressed in test files (their typeDefs
        // strings over-fire in apollo's __tests__/).
        if (skipGraphqlInThisFile && pattern.skipInGraphqlTestFile === true) continue;

        // JS/TS Express-shape patterns set `skipInsideTemplate: true` to
        // avoid matching backtick-string snippets in svelte/docs fixtures.
        const skipInsideTemplate = isJsTs && pattern.skipInsideTemplate === true;
        // gRPC patterns set `skipInComment: false` to keep matching
        // `// rpc Foo(...)` in .pb.go / generated TS stubs.
        const skipInComment = pattern.skipInComment !== false;

        // Check decorator patterns
        if (pattern.decoratorPattern) {
            pattern.decoratorPattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.decoratorPattern.exec(source)) !== null) {
                // Skip class-level @RequestMapping — it's a prefix, not an endpoint
                if (classLevelOffsets.has(match.index)) continue;
                if (skipInsideTemplate && isInsideTemplateLiteral(suppression, match.index)) continue;
                // Issue 339: skip matches inside doc/line/block comments
                // (Rust `/// #[get("/")]`, JSDoc `* @Get`, etc.).
                if (skipInComment && isInsideLineCommentOrDocBlock(source, suppression, match.index)) continue;
                // Issue 348: skip route matches inside Rust `mod tests { … }`
                // / `#[cfg(test)] mod` blocks. axum/src/extension.rs hosts
                // production code AND a `#[cfg(test)] mod tests` block whose
                // tests register routes against nested helper fns.
                if (language === 'rust' && (isRustTestPath(filePath) || isInsideRustTestModule(suppression, match.index))) continue;
                const raw = pattern.extract(match, { filePath, source, language });
                const results = !raw ? [] : Array.isArray(raw) ? raw : [raw];
                for (const result of results) {
                    let route = (isSpring || language === 'csharp') ? combinePaths(basePath, result.route) : result.route;
                    // Apply Laravel prefix groups
                    if (language === 'php') {
                        for (const g of phpPrefixGroups) {
                            if (match.index >= g.startOffset && match.index < g.endOffset) {
                                route = combinePaths(g.prefix, route);
                                break;
                            }
                        }
                    }
                    // Apply FastAPI router prefixes: match @router.get → find router's prefix
                    if (language === 'python' && fastAPIRouterPrefixes.length > 0) {
                        const decoratorText = source.slice(Math.max(0, match.index - 50), match.index + 10);
                        for (const rp of fastAPIRouterPrefixes) {
                            if (decoratorText.includes(`@${rp.varName}.`) || decoratorText.includes(`@${rp.varName} .`)) {
                                route = combinePaths(rp.prefix, route);
                                break;
                            }
                        }
                    }
                    addApi(apis, seen, result.method, route, filePath, match.index, source, language, result.handlerName);
                    // Fan out extraMethods (e.g. @api_view(['GET', 'POST']) → also emit POST)
                    for (const extra of result.extraMethods ?? []) {
                        addApi(apis, seen, extra, route, filePath, match.index, source, language, result.handlerName);
                    }
                }
            }
        }

        // Check call patterns
        if (pattern.callPattern) {
            pattern.callPattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.callPattern.exec(source)) !== null) {
                if (skipInsideTemplate && isInsideTemplateLiteral(suppression, match.index)) continue;
                // Issue 339: skip matches inside comments (gRPC exempted via Issue 348 — Misc TS edge cases + parser hygiene).
                if (skipInComment && isInsideLineCommentOrDocBlock(source, suppression, match.index)) continue;
                // Issue 348: skip route matches inside Rust `mod tests { … }`
                // / `#[cfg(test)] mod` blocks. axum/src/extension.rs hosts
                // production code AND a `#[cfg(test)] mod tests` block whose
                // tests register routes against nested helper fns.
                if (language === 'rust' && (isRustTestPath(filePath) || isInsideRustTestModule(suppression, match.index))) continue;
                const raw = pattern.extract(match, { filePath, source, language });
                const results = !raw ? [] : Array.isArray(raw) ? raw : [raw];
                for (const result of results) {
                    let route = result.route;
                    // Apply Laravel prefix groups
                    if (language === 'php') {
                        for (const g of phpPrefixGroups) {
                            if (match.index >= g.startOffset && match.index < g.endOffset) {
                                route = combinePaths(g.prefix, route);
                                break;
                            }
                        }
                    }
                    // Issues 335-338: prepend Go group/sub-router prefixes when the
                    // match's receiver matches a tracked binding or Chi block scope.
                    if (language === 'go') {
                        const prefix = resolveGoRoutePrefix(match[0], match.index, goBindings, goChiBlocks);
                        if (prefix) route = combinePaths(prefix, route);
                    }
                    // Issue 334: prepend Ktor `route("/api") { … }` parent prefix when
                    // the match falls inside a (possibly nested) route block.
                    if (language === 'kotlin' && ktorBlocks.length > 0) {
                        const prefix = resolveKtorRoutePrefix(match.index, ktorBlocks);
                        if (prefix) route = combinePaths(prefix, route);
                    }
                    addApi(apis, seen, result.method, route, filePath, match.index, source, language, result.handlerName);
                    for (const extra of result.extraMethods ?? []) {
                        addApi(apis, seen, extra, route, filePath, match.index, source, language, result.handlerName);
                    }
                }
            }
        }
    }

    // Issue 338: Go binding-receiver routes — `auth := api.Group("/auth"); auth.Post("/login", h)`.
    // The per-framework Go patterns only match specific receivers (r/mux/router/
    // app/fiber/e/echo/g/group/engine); custom binding names (`api`, `auth`,
    // `v1`, `product`, etc.) slip through. Walk the binding map and fire a
    // `<bindingName>.<METHOD>("/path"`-shaped pattern for each. Runs AFTER
    // the main pattern loop so we don't double-count routes both passes
    // catch — addApi's seen-Set handles dedup.
    if (language === 'go' && goBindings.size > 0) {
        const verbs = '(Get|Post|Put|Patch|Delete|Head|Options|All)';
        for (const [varName, prefix] of goBindings) {
            if (/^(r|mux|router|app|fiber|e|echo|g|group|engine)$/.test(varName)) continue;
            const re = new RegExp(`\\b${varName}\\s*\\.\\s*${verbs}\\s*\\(\\s*"([^"]+)"`, 'g');
            let mm: RegExpExecArray | null;
            while ((mm = re.exec(source)) !== null) {
                const method = mm[1].toUpperCase();
                const route = combinePaths(prefix, mm[2]);
                addApi(apis, seen, method, route, filePath, mm.index, source, language, undefined);
            }
        }
    }

    // Issue 368: post-pass webhook intent tagging.
    // When the source contains signature-verification patterns for a known
    // webhook provider, set `meta.webhook = true` on the nearest HTTP route
    // record. The L2b panel shows a ⚡ marker on those rows.
    //
    // (Path-prefix HEALTH auto-retag was scoped out of this pass — it
    // re-classified `/health` GET routes used as benign example fixtures
    // across ~10 detector test files. The explicit NestJS `@HealthCheck()`
    // decorator pattern still emits HEALTH; users wanting path-based health
    // classification can re-request once test fixtures are updated.)
    tagWebhookRoutes(apis, source);

    // Issue 419 follow-up: post-pass FastAPI auth-dependency tagging.
    // When a Python route decorator includes `dependencies=[Depends(get_current_user)]`
    // or the handler signature has `user: User = Depends(get_current_user)`, mark
    // the route with `meta.auth = 'required'`. Recognises common auth-dependency
    // names (`current_user`, `get_current_user`, `get_current_active_user`, etc.).
    if (language === 'python') {
        tagFastApiAuthDependencies(apis, source);
    }

    // Issue 419 follow-up: Spring Security annotations.
    // `@PreAuthorize("hasRole('USER')")`, `@Secured("ROLE_USER")`,
    // `@RolesAllowed("USER")`, `@PreFilter`, `@PostAuthorize` all imply the
    // annotated method or class requires authentication. `@PermitAll` is the
    // explicit unauth marker (auth='optional' / undefined).
    if (language === 'java' || language === 'kotlin') {
        tagSpringSecurityAnnotations(apis, source);
    }

    // UX-34 (2026-06-04) — NestJS sibling decorators. `@UseGuards`,
    // `@UseInterceptors`, `@UsePipes`, `@UseFilters` appear next to the
    // route decorator (`@Get / @Post / …`) and declare the per-route
    // middleware chain. Class-level versions apply to every method in
    // the class. Without this, every NestJS route reported zero
    // middleware in L3 even when guarded by JwtAuthGuard etc.
    if (language === 'javascript' || language === 'typescript') {
        tagNestJsMiddleware(apis, source);
    }

    // UX-36 (2026-06-04) — Django per-view decorators + DRF permission_classes.
    // `@login_required`, `@permission_required(...)`, `@user_passes_test(...)`,
    // `@method_decorator(login_required, name='dispatch')` on CBVs, and
    // DRF `permission_classes = [IsAuthenticated]` on viewsets. The
    // GLOBAL `MIDDLEWARE` list from settings.py is a separate cross-
    // file pass run in syncOrchestrator Phase 1.5 (see applyDjangoGlobalMiddleware).
    if (language === 'python') {
        tagDjangoViewDecorators(apis, source);
    }

    // UX-38 (2026-06-05) — Flask middleware. Captures per-view
    // decorators (`@login_required`, `@jwt_required`, `@cross_origin`,
    // `@limiter.limit(...)`, `@cache.cached`, `@admin_required`, etc.)
    // and same-file `@app.before_request` / `@<bp>.before_request`
    // hooks. Hooks scoped by the receiver: only routes registered on
    // the same `<recv>.route(...)` pick up `<recv>.before_request`.
    if (language === 'python') {
        tagFlaskMiddleware(apis, source);
    }

    // UX-39 (2026-06-05) — Rails controller filters. Each
    // `before_action :name` / `after_action :name` / `around_action :name`
    // in a `*_controller.rb` file applies to every HTTP route defined
    // in that same controller. Filter records still get emitted as
    // FILTER apis (Tier 1, Issue #364) — this pass additionally
    // populates `meta.middlewares` on the route records so they render
    // as L3 sequence participants.
    if (language === 'ruby') {
        tagRailsControllerFilters(apis, source, filePath);
        // UX-47 (2026-06-05) — Sinatra `before do ... end` /
        // `before '/path' do ... end` hooks. Same-file as the routes.
        tagSinatraBeforeHooks(apis, source);
    }

    // UX-41 (2026-06-05) — Go middleware chains (Gin/Echo/Chi/Fiber).
    // `<recv>.Use(mw1, mw2)` declares middleware on a router; the
    // middlewares apply to every route registered on the same
    // receiver. Args may be plain identifiers (`jwtAuth`), function
    // calls (`gin.Recovery()`, `cors.New()`), or member references
    // (`middleware.Logger`). The full `pkg.Symbol` form is preserved
    // for L3 sequence rendering.
    if (language === 'go') {
        tagGoMiddleware(apis, source);
    }

    // UX-40 (2026-06-05) — Laravel middleware. Three families:
    //   1. Per-route chain: `Route::middleware(['auth'])->get('/x', ...)`.
    //   2. Group middleware: `Route::group(['middleware' => ['auth']], fn(){ ... })`.
    //   3. Controller __construct() `$this->middleware('auth')` (class-wide).
    // Family 3 is cross-file (route in routes/web.php, middleware in
    // app/Http/Controllers/*) and out of scope for the same-file v1.
    if (language === 'php') {
        tagLaravelMiddleware(apis, source);
        // UX-47 (2026-06-05) — Symfony PHP attributes #[IsGranted] /
        // #[Security] sit ABOVE the #[Route] attribute on a controller
        // method. They authorize the action and should land in the
        // middleware chain so L3 renders the security check.
        tagSymfonyAttributes(apis, source);
    }

    // UX-45 (2026-06-05) — ASP.NET Core attributes. `[Authorize]`,
    // `[Authorize(Roles="...")]`, `[AllowAnonymous]`, `[ServiceFilter]`,
    // `[TypeFilter]` attached to controller actions or classes. Method-
    // level proximity walks back from the `[HttpGet/...]` decorator
    // looking for sibling attributes; class-level walks back from the
    // enclosing class declaration. `[AllowAnonymous]` on a method
    // overrides any class-level `[Authorize]` for that route.
    if (language === 'csharp') {
        tagAspNetAttributes(apis, source);
    }

    // UX-46 (2026-06-05) — Rust middleware. Actix `.wrap(...)`, Axum
    // `.layer(...)`, and Rocket `.attach(...)` chained on the app/
    // router builder. V1 collects file-level chained calls and applies
    // them to every Rust route detected in the same file (matches the
    // typical single-app-per-file Rust structure). Per-scope precision
    // is a follow-up.
    if (language === 'rust') {
        tagRustMiddleware(apis, source);
    }

    // UX-42 (2026-06-05) — gRPC interceptors. Cross-language pass that
    // recognises Node `interceptors: [...]`, Go `grpc.UnaryInterceptor`/
    // `ChainUnaryInterceptor`, Python `interceptors=[...]`, and Java
    // `ServerInterceptors.intercept(svc, ...)`. Attaches to every
    // GRPC/RPC route detected in the same file.
    tagGrpcInterceptors(apis, source);

    // UX-43 (2026-06-05) — GraphQL SDL field directives. Inline
    // `@auth(requires: ADMIN)` / `@hasRole(...)` / `@isAuthenticated`
    // on fields inside `type Query/Mutation/Subscription { ... }`.
    tagGraphqlDirectives(apis, source);

    // Issue #600 Phase 0.5 — schema-metadata tagging. JSDoc + TS-type
    // sources are universal (no import resolution required) and cover
    // most of the surface for the API Testing UI. Zod/Joi/Yup +
    // class-validator wiring lands in a follow-up — they need import
    // detection so the inferrer can locate the schema definition.
    tagApiSchemas(apis, source, language);

    return dedupeSameLocationApis(apis);
}

/**
 * BUG-POLAR-3: collapse the SAME endpoint detected twice by overlapping detection
 * patterns at the SAME code location (e.g. a FastAPI `@router.get(...)` matched by
 * both a decorator pattern and a generic route pattern at the same offset →
 * `anonymous@GET:/x` + `anonymous@GET:/x#1`, rendering as two identical L2a rows).
 * Genuine multi-registration of the same `(method,route)` — BUG-EXPLORE-1's echo
 * sub-app example — lives at DISTINCT offsets, so keying the dedupe on the anchor
 * offset preserves those while removing same-location doubles.
 */
export function dedupeSameLocationApis(apis: ApiRecord[]): ApiRecord[] {
    const seen = new Set<string>();
    const out: ApiRecord[] = [];
    for (const a of apis) {
        const off = a.anchor?.span?.start ?? -1;
        const key = `${a.method}:${a.route}::${a.filePath}@${off}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}

/**
 * Issue 368 — webhook signature-verification patterns by provider. When any
 * of these match the source, the nearest HTTP route record (by byte offset)
 * gets `meta.webhook = true` + the provider name. The L2b panel shows a ⚡
 * marker on those rows.
 */
const WEBHOOK_PROVIDER_PATTERNS: Array<{ provider: string; pattern: RegExp }> = [
    // Stripe SDK
    { provider: 'stripe', pattern: /\bstripe(?:\.\w+)*\.webhooks\.constructEvent\s*\(/g },
    { provider: 'stripe', pattern: /\bStripe::Webhook(?:::Signature)?\.\s*(?:construct_event|verify_header)\s*\(/g },
    // GitHub webhook signature header constants
    { provider: 'github', pattern: /['"]X-Hub-Signature-256['"]|['"]x-hub-signature-256['"]/g },
    { provider: 'github', pattern: /\b(?:WebhookSignatureVerificationError|verify(?:_)?(?:webhook|signature))\b/g },
    // Slack signing-secret verification
    { provider: 'slack', pattern: /['"]x-slack-signature['"]|['"]X-Slack-Signature['"]/g },
    { provider: 'slack', pattern: /\bSLACK_SIGNING_SECRET\b|\bsigning(?:_|-)?secret\b/gi },
    // Twilio
    { provider: 'twilio', pattern: /\bTwilio(?:\.\w+)*\.validateRequest\s*\(|RequestValidator\(\s*\w*['"]TWILIO_AUTH_TOKEN['"]/g },
    // Generic — express raw `req.headers['x-signature']` verifications, HMAC checks
    { provider: 'generic', pattern: /\b(?:hmac|HMAC)\s*\.\s*createHmac\s*\(\s*['"]sha(?:256|512)['"]/g },
    { provider: 'generic', pattern: /\bcrypto\.createHmac\s*\(\s*['"]sha(?:256|512)['"]/g },
];

const HTTP_METHODS_FOR_WEBHOOK = new Set(['POST', 'PUT', 'PATCH']);

function tagWebhookRoutes(apis: ApiRecord[], source: string): void {
    if (apis.length === 0) return;
    const httpRoutes = apis
        .map((api, idx) => ({ api, idx, offset: api.anchor?.span?.start ?? 0 }))
        .filter(r => HTTP_METHODS_FOR_WEBHOOK.has(r.api.method))
        .sort((a, b) => a.offset - b.offset);
    if (httpRoutes.length === 0) return;

    const matchOffsets: Array<{ offset: number; provider: string }> = [];
    for (const { provider, pattern } of WEBHOOK_PROVIDER_PATTERNS) {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(source)) !== null) {
            matchOffsets.push({ offset: m.index, provider });
        }
    }
    if (matchOffsets.length === 0) return;

    // For each webhook signal, attach to the nearest HTTP route by offset
    // (preferring a route whose handler appears within ~4KB before/after
    // the signal — webhook verification is typically at the top of the
    // handler body or its middleware).
    const PROXIMITY = 4096;
    for (const sig of matchOffsets) {
        let best: { api: ApiRecord; provider: string; dist: number } | null = null;
        for (const r of httpRoutes) {
            const dist = Math.abs(r.offset - sig.offset);
            if (dist > PROXIMITY) continue;
            if (!best || dist < best.dist) {
                best = { api: r.api, provider: sig.provider, dist };
            }
        }
        if (best) {
            best.api.meta = { ...(best.api.meta ?? {}), webhook: true, webhookProvider: best.provider };
        }
    }
}

function tagApiSchemas(apis: ApiRecord[], source: string, language: SupportedLanguage | string): void {
    if (apis.length === 0 || !source) return;
    // JSDoc is universal. TS-type only runs on JS/TS sources — Python
    // type-hints / JVM annotations are out of scope for v1.
    const canRunTsType = language === 'typescript' || language === 'javascript' || language === 'tsx' || language === 'jsx';

    for (const api of apis) {
        const offset = api.anchor?.span?.start ?? -1;
        if (offset < 0) continue;
        const meta = api.meta ?? {};
        // Skip if every populated field is already set.
        if (meta.requestSchema && meta.pathParams && meta.queryParams && meta.responseSchema) continue;

        // 1. JSDoc — walk backward to find a `*/` close-of-comment within
        //    the 800-char window. If found, extract the full `/** … */`
        //    block and parse it.
        const lookback = source.slice(Math.max(0, offset - 800), offset);
        const closeIdx = lookback.lastIndexOf('*/');
        if (closeIdx >= 0) {
            const openIdx = lookback.lastIndexOf('/**', closeIdx);
            if (openIdx >= 0 && openIdx < closeIdx) {
                const blockComment = lookback.slice(openIdx, closeIdx + 2);
                const j = parseJsdocSchema(blockComment);
                if (j.requestSchema && !meta.requestSchema) meta.requestSchema = j.requestSchema;
                if (j.pathParams && !meta.pathParams) meta.pathParams = j.pathParams;
                if (j.queryParams && !meta.queryParams) meta.queryParams = j.queryParams;
                if (j.responseSchema && !meta.responseSchema) meta.responseSchema = j.responseSchema;
            }
        }

        // 2. Validator-library inference — Phase 0.6 (#600 — API Testing surface: Phase 0 — schema metadata on `ApiRecord`). Look for
        //    Zod / Joi / Yup schema references in a small window around
        //    the route anchor (forward up to the next route or 1200
        //    chars, whichever is sooner) and try to resolve the schema
        //    declaration from the same source file.
        if (canRunTsType && !meta.requestSchema) {
            const window = source.slice(offset, Math.min(source.length, offset + 1200));
            const validatorSchema = inferValidatorSchema(source, window);
            if (validatorSchema) meta.requestSchema = validatorSchema;
        }

        // 3. TS-type — extract a small forward window starting at the
        //    route anchor and try to find the handler signature. We
        //    accept any of `(req:…) =>`, `(req:…): T =>`, `function(req:…)`,
        //    or a single-arg form `(input:…) =>`.
        if (canRunTsType && !meta.requestSchema) {
            const forward = source.slice(offset, Math.min(source.length, offset + 800));
            const sigMatch = /\(([^)]*)\)\s*(?::\s*[^=>;{]+)?\s*(?:=>|\{)/.exec(forward);
            if (sigMatch) {
                const t = parseTsHandlerSchema(source, `(${sigMatch[1]})`);
                if (t.requestSchema && !meta.requestSchema) meta.requestSchema = t.requestSchema;
            }
        }

        // Only assign back if we actually populated something — keeps
        // the snapshot diff clean when no schema was inferable.
        if (
            meta.requestSchema !== api.meta?.requestSchema
            || meta.pathParams !== api.meta?.pathParams
            || meta.queryParams !== api.meta?.queryParams
            || meta.responseSchema !== api.meta?.responseSchema
        ) {
            api.meta = meta;
        }
    }
}

/**
 * Issue #600 Phase 0.6 — sniff a route window for one of:
 *
 *   • `<Schema>.parse(req.body)` / `<Schema>.safeParse(req.body)` — inline Zod
 *   • `<Schema>.parseAsync(req.body)`                              — inline Zod
 *   • `validate(<Schema>)` / `validateBody(<Schema>)`              — middleware
 *   • `zValidator('json', <Schema>, …)`                            — Hono
 *   • `{ body: <Schema> }` / `schema: { body: <Schema> }`          — Fastify+Zod
 *
 * For each recognised reference, look up `<Schema>` declared in the
 * same source file (`const Schema = z.object(...)` / `joi.object(...)`
 * / `yup.object(...)`) and run the matching inference module to lift
 * the shape into a `JsonSchemaLike`.
 *
 * Falls back to `undefined` when the schema reference can't be
 * resolved — the JSDoc + TS-type passes still get a turn afterwards.
 */
function inferValidatorSchema(
    fullSource: string,
    routeWindow: string,
): NonNullable<ApiRecord['meta']>['requestSchema'] | undefined {
    const patterns: Array<RegExp> = [
        /(\b[A-Z][\w$]*)\s*\.\s*(?:parse|safeParse|parseAsync)\s*\(\s*req\s*\.\s*body/,
        /\bvalidate(?:Body|Request)?\s*\(\s*(\b[A-Z][\w$]*)\s*[,)]/,
        /\bzValidator\s*\(\s*['"`]\w+['"`]\s*,\s*(\b[A-Z][\w$]*)\s*[,)]/,
        /\bschema\s*:\s*\{\s*body\s*:\s*(\b[A-Z][\w$]*)\s*[,}]/,
        /\bbody\s*:\s*(\b[A-Z][\w$]*)\s*[,}]/,
    ];
    let schemaName: string | undefined;
    for (const re of patterns) {
        const m = re.exec(routeWindow);
        if (m && m[1]) {
            schemaName = m[1];
            break;
        }
    }
    if (!schemaName) return undefined;

    // First try the const-declaration form: Zod / Joi / Yup all export
    // schemas as `const Foo = z.object(...)` / `Joi.object(...)` / `yup.object(...)`.
    const declRe = new RegExp(`(?:export\\s+)?const\\s+${escapeRegex(schemaName)}\\s*=\\s*([\\s\\S]+?);`, 'm');
    const decl = declRe.exec(fullSource);
    if (decl) {
        const expr = decl[1].trim();
        if (/^z\s*\.\s*\w+\s*\(/.test(expr)) {
            const result = parseZodInferredApiSchema(expr);
            if (result.requestSchema) return result.requestSchema;
        }
        if (/^Joi\s*\.\s*\w+\s*\(|^joi\s*\.\s*\w+\s*\(/.test(expr)) {
            const result = parseJoiInferredApiSchema(expr);
            if (result.requestSchema) return result.requestSchema;
        }
        if (/^yup\s*\.\s*\w+\s*\(|^Yup\s*\.\s*\w+\s*\(/.test(expr)) {
            const result = parseYupInferredApiSchema(expr);
            if (result.requestSchema) return result.requestSchema;
        }
    }

    // Then try the class-declaration form: class-validator uses
    // `class Foo { @IsString() title: string; }`. The schema name in
    // those wrappers acts as a type; the parser walks the class body
    // for `@Is…` decorators + TS annotations.
    const classDecl = new RegExp(`(?:export\\s+)?class\\s+${escapeRegex(schemaName)}\\b`).exec(fullSource);
    if (classDecl) {
        const result = parseClassValidatorInferredApiSchema(fullSource, schemaName);
        if (result.requestSchema) return result.requestSchema;
    }
    return undefined;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Create an ApiRecord and add it to the results if not a duplicate.
 */
function addApi(
    apis: ApiRecord[],
    seen: Set<string>,
    method: string,
    route: string,
    filePath: string,
    offset: number,
    source: string,
    language: SupportedLanguage,
    handlerNameOverride?: string
): void {
    // Normalize route
    if (!route.startsWith('/') && !route.startsWith('*')) {
        route = '/' + route;
    }

    // Find the function name near this match (use override when caller extracted it from pattern)
    let handlerName = handlerNameOverride ?? findNearestFunctionName(source, offset, language);

    // Issue 348: in test files, route-pattern matches that have to fall back
    // to `findNearestFunctionName` (no captured handler from the regex) are
    // almost always noise — RSpec matchers, JUnit local vars, Go `_test.go`
    // helpers. Reject these unless the caller explicitly supplied a
    // non-anonymous override (a real captured handler name).
    // Issue 352: also reject anonymous@ overrides in test files — these come
    // from inline closures in test fixtures (`get("/anything") { … }` inside
    // `AnythingTest.kt`, smoke-test files, etc.) and only pollute the api list.
    const inTestFile = isTestFile(filePath) || /_test\.go$/.test(filePath);
    if (inTestFile) {
        if (
            handlerNameOverride === undefined ||
            handlerNameOverride.startsWith('anonymous@')
        ) {
            return;
        }
    }

    // Filter out Django/Flask routing utility functions that are not real API handlers
    const ROUTING_UTILITY_NAMES = new Set([
        'include', 'serve', 'static', 'redirect', 'path', 're_path', 'url',
        'render', 'render_template', 'send_file', 'send_from_directory',
    ]);
    if (ROUTING_UTILITY_NAMES.has(handlerName)) return;

    // Issue 348: when the handler name is junk (a local var, language keyword,
    // port number, single-char ident, or the `'handler'` fallback), DON'T
    // drop the API — that would lose api-list coverage for real routes whose
    // handler is just an inline lambda. Instead substitute a synthetic
    // `anonymous@<METHOD>:<route>` name so the route is still listed and the
    // anon-handler flow path can pick it up if a body-finder exists.
    //
    // Issue 352: only apply the junk filter when the handler came from
    // findNearestFunctionName fallback (no override). When a regex extract
    // explicitly captured the handler (e.g. Axum `.route("/", get(handler))`
    // captured `handler` as the real fn name), trust it — keyword-shaped
    // names CAN be legitimate fn identifiers in user code.
    const isJunkHandler =
        handlerNameOverride === undefined && (
            !handlerName ||
            handlerName === 'handler' ||
            /^(?:if|for|while|else|switch|case|return|throw|do|end|func|function|class|default|async|await|interface|enum|type|abstract|const|let|var|val|move|null|nil|true|false|undefined|none|void|when|where|select|into|as|is|in|out|pub|fun|impl|trait|struct|mod|use|crate|super|self|Self)$/.test(handlerName) ||
            /^\d/.test(handlerName) ||
            /^_+$/.test(handlerName) ||
            handlerName.length === 1
        );
    if (isJunkHandler && !handlerName.startsWith('anonymous@')) {
        handlerName = `anonymous@${method}:${route}`;
    }

    // Anonymous-style handler names collide when multiple call sites in the
    // same file share `(method, route)` — e.g. echo subdomain examples where
    // 3 sub-app instances each register `GET /` (Issue #336 follow-up). We must
    // keep those distinct in the apiIndex, but the byte `offset` we used to
    // append is UNSTABLE: any edit above the route shifts it, so its apiId
    // changes and the baseline diff falsely flags the route added/deleted on
    // every save — and an edit+revert never returns to a clean match
    // (BUG-EXPLORE-1). Use a STABLE per-file occurrence index instead: the
    // first (and, overwhelmingly, only) anon handler for a given (method,route)
    // in a file gets NO suffix — a fully route-based, edit-stable apiId — and
    // genuine collisions get `#1`, `#2`, … in source order. `seen` already
    // holds the emitted apiIds, so we count prior occurrences of this exact
    // base key. Named handlers keep their stable IDs.
    let idKey = handlerName;
    if (handlerName.startsWith('anonymous@')) {
        const base = `${method}:${route}::${filePath}::${handlerName}`;
        let occ = 0;
        for (const s of seen) {
            if (s === base || s.startsWith(`${base}#`)) occ++;
        }
        idKey = occ === 0 ? handlerName : `${handlerName}#${occ}`;
    }
    const apiId = `${method}:${route}::${filePath}::${idKey}`;
    if (seen.has(apiId)) return;
    seen.add(apiId);

    const anchor: Anchor = {
        filePath,
        symbol: handlerName,
        span: { start: offset, end: offset + 1 },
    };

    apis.push({
        apiId,
        method,
        route,
        handlerName,
        filePath,
        anchor,
    });
}

/**
 * Find the nearest function/method name around a given offset.
 * Uses simple regex heuristics.
 */
// Exported for `frameworks/*.ts` plugins (Issue #703). Many decorator/
// attribute-based patterns need to look up the underlying function name —
// rather than every plugin re-implementing the language-aware scan, they
// share this helper. A future PR (#703 PR-18 final cleanup) may move this
// into a dedicated `frameworks/helpers.ts` if the plugin-→-dispatcher import
// direction becomes a maintainability problem.
export function findNearestFunctionName(source: string, offset: number, language: SupportedLanguage): string {
    // Look backward for common function patterns
    const before = source.slice(Math.max(0, offset - 500), offset);
    // Look forward (needed for decorator/annotation-based frameworks where
    // function comes after the annotation). Issue 350: bumped from 300 → 800
    // chars; Symfony controllers stack multiple `#[Route(…)]` + `#[Cache(…)]`
    // decorators (each 80-200 chars) above a single method, and the function
    // declaration was being cut off the slice for the first 1-2 routes.
    const after = source.slice(offset, offset + 800);

    // Python: forward scan — def or class follows decorator (@api_view, @app.route, etc.).
    // BUG-POLAR-13: a decorator's argument list can span many lines (a multi-line
    // `responses={…}` dict, stacked decorators). We track bracket depth so the
    // whole argument list is skipped before looking for the handler `def`/`class`.
    // A fixed 8-line window used to stop short of the real `def` (→ `anonymous@…`)
    // and let the generic scan below grab a bogus identifier out of a description
    // string ("…active subscription(s)." → "subscription"). Uses a wider window
    // read straight from source so very long decorators still reach the handler.
    if (language === 'python') {
        const pyAfter = source.slice(offset, offset + 2000);
        let depth = 0;
        let entered = false;
        for (const line of pyAfter.split('\n').slice(0, 60)) {
            // Only inspect a line for the handler when we're outside the
            // decorator's (possibly nested, multi-line) argument brackets.
            if (!entered || depth === 0) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('@')) {
                    const defMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
                    if (defMatch) return defMatch[1];
                    const classMatch = trimmed.match(/^class\s+(\w+)/);
                    if (classMatch) return classMatch[1];
                }
            }
            for (const ch of line) {
                if (ch === '(' || ch === '[' || ch === '{') { depth++; entered = true; }
                else if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; }
            }
        }
    }

    // PHP: forward scan — function declaration follows #[Route] attribute
    if (language === 'php') {
        for (const line of after.split('\n').slice(0, 8)) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#[')) continue;
            const funcMatch = trimmed.match(/^(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)/);
            if (funcMatch) return funcMatch[1];
        }
    }

    // Rust: `#[get("/path")] async fn handler(...) {…}` — fn declaration
    // follows the attribute. Issue 352 — Per-language body-finder coverage for closure shapes the AST patterns don't yet match. Issue 354: also accept the same-line
    // form `#[get("/")] fn name() { }` used in macro/inline contexts.
    if (language === 'rust') {
        const fnPattern = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/;
        const inlinePattern = /\bfn\s+(\w+)/;
        for (const line of after.split('\n').slice(0, 8)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('#[')) {
                // Same-line `#[get("/")] fn name() {…}` form.
                const inline = trimmed.match(inlinePattern);
                if (inline) return inline[1];
                continue;
            }
            if (trimmed.startsWith('//')) continue;
            const fnMatch = trimmed.match(fnPattern);
            if (fnMatch) return fnMatch[1];
            break;
        }
    }

    // Java/C#/Kotlin/Swift/TS/JS: forward look — method declaration follows
    // an annotation/attribute/decorator. Uses a line-by-line scan to handle
    // complex return types (e.g. Map<String, Integer>) that would confuse a
    // single-pass regex.
    //
    // Issue 338: gate this so it only fires when the match offset's own line
    // begins with a decorator/attribute marker (`@`, `[`, `#[`). For
    // call-pattern matches (e.g. Go `app.Get("/", …)`, Express `router.get(…)`)
    // the offset is on the call's own line and the old scan wrongly returned
    // the method name (`Get`/`HttpGet`/`Authorize`/`Route`) as the handler.
    {
        // Find the start of the line containing `offset`.
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
        const offsetLine = source.slice(lineStart, source.indexOf('\n', offset) === -1 ? source.length : source.indexOf('\n', offset)).trimStart();
        const onDecoratorOrAttribute =
            offsetLine.startsWith('@') ||
            offsetLine.startsWith('[') ||
            offsetLine.startsWith('#[');
        if (onDecoratorOrAttribute) {
            for (const line of after.split('\n').slice(0, 8)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (trimmed.startsWith('@')) continue;
                if (trimmed.startsWith('[')) continue;       // C# attribute
                if (trimmed.startsWith('#[')) continue;      // Rust/PHP attribute
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                const parenIdx = trimmed.indexOf('(');
                if (parenIdx > 0) {
                    const beforeParen = trimmed.slice(0, parenIdx).trim();
                    if (/^(?:if|for|while|switch|catch|return|throw)\b/.test(beforeParen)) continue;
                    const nameMatch = beforeParen.match(/(\w+)$/);
                    if (nameMatch) {
                        // Don't return attribute/annotation tokens that snuck
                        // through (e.g. `[HttpGet("/")] public IActionResult Get()`).
                        if (/^(?:HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Authorize|AllowAnonymous|Route|HttpOptions|FromBody|FromQuery|FromRoute|HttpHead|HttpAny|FromHeader)$/.test(nameMatch[1])) continue;
                        return nameMatch[1];
                    }
                }
            }
        }
    }

    // Issue 348 (round 4): backward-scan regexes are language-gated. Without
    // this, the JS `(?:const|let|var)\s+(\w+)` regex fires on Rust `let
    // adapter = …` and emits the local variable as a handler name.

    // Python: backward scan — def functionName (fallback when not decorator-preceded)
    if (language === 'python') {
        const pyMatch = before.match(/def\s+(\w+)\s*\([^)]*\)\s*(?:->.*?)?:\s*$/);
        if (pyMatch) return pyMatch[1];
    }

    // Java/C#/Kotlin/Swift: method declaration backward look — fallback when no annotation pattern found.
    if (language === 'java' || language === 'csharp' || language === 'kotlin' || language === 'swift') {
        const javaMatch = before.match(/(?:(?:public|private|protected|internal|static|override|suspend|fun)\s+)*[\w<>[\]?,\s]+\s+(\w+)\s*\([^)]*\)\s*\{?\s*$/);
        if (javaMatch) return javaMatch[1];
    }

    // Go: prefer the forward-look handler arg (`app.Get("/x", handler)`) over
    // the backward-scan enclosing function. Closures (`func(...)`) are emitted
    // as `anonymous@` upstream by goExtract, so the forward look only fires
    // for named handlers (`pkg.Index`, `MyHandler`, `h.handle`).
    if (language === 'go') {
        const fwd = after.match(/^[^)\n]*?,\s*(?:\w+\.)?(\w+)\s*\)/);
        if (fwd && !/^(?:func|nil|true|false)$/.test(fwd[1])) {
            return fwd[1];
        }
        const goMatch = before.match(/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/);
        if (goMatch) return goMatch[1];
    }

    // JS/TS: function name( / const name = / name(
    // Avoids emitting JS keywords (`class`, `function`, `default`, `async`,
    // `interface`) as handler names — NestJS files would otherwise trip
    // `(?:export)\s+(\w+)` against `export class ArticleController` and
    // capture `class`. Uses a more selective alternation that consumes
    // intermediate keywords before the identifier.
    if (language === 'javascript' || language === 'typescript') {
        const jsMatch = before.match(
            /(?:function\s+|(?:const|let|var)\s+|export(?:\s+default)?(?:\s+async)?\s+(?:function\*?|class|abstract\s+class|interface|enum|type|async)\s+|export\s+)(\w+)/,
        );
        if (jsMatch && !/^(?:class|function|default|async|interface|enum|type|abstract|const|let|var|return|if|for|while|switch|case)$/.test(jsMatch[1])) {
            return jsMatch[1];
        }
    }

    // Ruby: def method_name
    if (language === 'ruby') {
        const rbMatch = before.match(/def\s+(\w+)/);
        if (rbMatch) return rbMatch[1];
    }

    // Rust: fn function_name
    if (language === 'rust') {
        const rsMatch = before.match(/fn\s+(\w+)/);
        if (rsMatch) return rsMatch[1];
    }

    // Look forward for the handler (e.g. Express: router.get('/path', handlerFn)).
    // Issue 350: gate to JS/TS — for Rust, this regex captures the next
    // identifier after `,` in `web::get().to(config)` and returns the local
    // variable `config` as the handler name; the language-specific fallback
    // ('handler' default) is preferable in that case.
    if (language === 'javascript' || language === 'typescript') {
        const handlerMatch = after.match(/[,=]\s*(\w+)[\s,)]/);
        if (handlerMatch) return handlerMatch[1];
    }

    return 'handler';
}

/**
 * Classify external system type from a module/package name.
 * Extended to support all languages' package naming conventions.
 */
export function classifyExternalSystemMultiLang(nameOrPath: string, language: SupportedLanguage): string {
    const v = (nameOrPath || '').toLowerCase();

    // Database
    const dbPatterns = [
        'mongoose', 'sequelize', 'prisma', 'typeorm', 'knex', 'pg', 'mysql', 'mongodb',
        'sqlalchemy', 'django.db', 'peewee', 'tortoise',  // Python
        'jdbc', 'hibernate', 'jpa', 'mybatis', 'r2dbc',   // Java
        'gorm', 'sqlx', 'pgx', 'database/sql',            // Go
        'diesel', 'sqlx', 'sea-orm',                       // Rust
        'entity-framework', 'dapper', 'npgsql',            // C#
        'eloquent', 'doctrine',                             // PHP
        'activerecord',                                     // Ruby
        'fluent',                                           // Swift
    ];
    if (dbPatterns.some(k => v.includes(k))) return 'database';

    // Cache
    const cachePatterns = ['redis', 'ioredis', 'memcached', 'valkey', 'django.cache', 'caffeine'];
    if (cachePatterns.some(k => v.includes(k))) return 'cache';

    // Storage
    const storagePatterns = ['s3', 'gcs', 'storage', 'bucket', 'minio', 'blob', 'azure/storage', 'boto3'];
    if (storagePatterns.some(k => v.includes(k))) return 'storage';

    // Messaging/Queue
    const mqPatterns = ['kafka', 'rabbitmq', 'amqplib', 'celery', 'nats', 'pulsar', 'sqs', 'sns'];
    if (mqPatterns.some(k => v.includes(k))) return 'queue';

    // External service calls
    const servicePatterns = [
        'axios', 'fetch', 'got', 'request', 'grpc', 'http', 'net/http',
        'requests', 'httpx', 'aiohttp', 'urllib',          // Python
        'resttemplate', 'webclient', 'feign', 'retrofit',  // Java
        'reqwest', 'hyper',                                 // Rust
        'httpclient',                                       // C#
        'guzzle', 'curl',                                   // PHP
        'faraday', 'net/http',                              // Ruby
    ];
    if (servicePatterns.some(k => v.includes(k))) return 'service';

    return 'module';
}
