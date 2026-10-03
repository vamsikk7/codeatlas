/**
 * frameworks/jvm.ts — JVM-family framework plugins
 * (Issue #703, Phase 2 PR-14.)
 *
 * Two plugins exported from this file:
 *
 *   - **java-spring** — Spring Boot + Micronaut + JAX-RS + Jakarta +
 *     Spring AOP + Spring Kafka/RabbitMQ/JMS + Spring Cloud Stream +
 *     Spring Shell + @Scheduled/@Async. Registered for BOTH `java`
 *     and `kotlin` so Kotlin Spring projects still get coverage (the
 *     pre-#703 dispatcher spread JAVA_PATTERNS into KOTLIN_PATTERNS).
 *   - **ktor** — Ktor server DSL (`routing { get("/x") { … } }`),
 *     Ktor Locations API, Ktor WebSocket / SSE, and the path-less verb
 *     blocks inside `route("/prefix") { get { … } }`. Registered for
 *     `kotlin` only.
 *
 * Splitting into two plugins (rather than a single big "jvm" plugin)
 * matches the conceptual boundary: Spring is a Java-Kotlin shared
 * stack; Ktor is Kotlin-only. The registry handles per-language
 * iteration so the dispatcher's pre-#703 behaviour is preserved
 * byte-for-byte.
 *
 * Suppression: JVM patterns were not in any of the three pre-#703
 * suppression sets (`jsExpressPatterns`, `graphqlPatterns`,
 * `grpcPatterns`). No flags applied.
 */

import type { FrameworkPlugin } from './types';
import { findNearestFunctionName } from '../frameworkDetector';

/**
 * BUG-EXP-16 — text of the JAX-RS annotation block around `idx`. `window`
 * spans from the previous declaration/statement boundary (`}` / `;` / `{`, so
 * a backward scan can't bleed into a SIBLING method) through the start of this
 * declaration; `declSlice` is just this member's own annotation-through-body
 * head, used to tell a type declaration (class/interface/enum) from a method.
 * The forward end stops at the first `{` (capped at 400 chars) — for a `@Path`
 * whose route contains braces (`@Path("/{id}")`) that's the brace inside the
 * route, which is fine: the window still captures any sibling `@GET`/`@Path`.
 */
function jaxrsAnnotationWindow(src: string, idx: number): { window: string; declSlice: string } {
    const braceIdx = src.indexOf('{', idx);
    const declEnd = braceIdx >= 0 ? Math.min(braceIdx + 1, idx + 400) : Math.min(src.length, idx + 400);
    const backStart = Math.max(0, idx - 400);
    const back = src.slice(backStart, idx);
    const boundary = Math.max(back.lastIndexOf('}'), back.lastIndexOf(';'), back.lastIndexOf('{'));
    const blockStart = boundary >= 0 ? backStart + boundary + 1 : backStart;
    return { window: src.slice(blockStart, declEnd), declSlice: src.slice(idx, declEnd) };
}

export const javaSpringPlugin: FrameworkPlugin = {
    id: 'java-spring',
    name: 'Spring + Micronaut + JAX-RS (Java/Kotlin)',
    languages: ['java', 'kotlin'],
    patterns: [
        // Spring Boot: @GetMapping("/path"), @PostMapping("/path"), etc.
        {
            decoratorPattern: /@(Get|Post|Put|Patch|Delete)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]\s*\)/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
        // Spring Boot: @RequestMapping(value="/path", method=RequestMethod.GET)
        {
            decoratorPattern: /@RequestMapping\s*\([^)]*\)/gi,
            extract: (m) => {
                const pathMatch = m[0].match(/(?:value|path)\s*=\s*['"]([^'"]+)['"]/) || m[0].match(/['"]([^'"]+)['"]/);
                const route = pathMatch ? pathMatch[1] : '/';
                const methodMatch = m[0].match(/method\s*=\s*(?:RequestMethod\.)?([A-Z]+)/i);
                return { method: methodMatch ? methodMatch[1].toUpperCase() : 'GET', route };
            },
        },
        // Jakarta/JAX-RS: @GET / @POST / @PUT / @PATCH / @DELETE / @HEAD / @OPTIONS
        // Negative lookahead rules out Kotlin annotation site targets (@get:Rule)
        // and labeled returns/breaks (return@get).
        {
            decoratorPattern: /(?<!\b(?:return|break|continue|this|super)\s*)@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(?!:)/gi,
            extract: (m, ctx) => {
                // BUG-EXP-16 — when this same member ALSO carries a `@Path`, the
                // `@Path` pattern below emits the MERGED record (this verb + the
                // real route, e.g. `GET /{id}`). Emitting the bare verb here too
                // would duplicate it as `GET /`, so defer to the `@Path` record.
                const { window } = jaxrsAnnotationWindow(ctx.source, m.index ?? 0);
                if (/@Path\s*\(/i.test(window)) return null;
                return { method: m[1].toUpperCase(), route: '/' };
            },
        },
        // JAX-RS @Path. BUG-EXP-16 — how a `@Path` becomes an entry depends on
        // what it annotates (java-jaxrs had 256 spurious PATH of 534):
        //   • on a resource CLASS  → base prefix only, NOT a standalone endpoint.
        //   • on an `@GET`/`@POST`/… method → MERGE: emit ONE record carrying the
        //     verb + this real route (e.g. `GET /{id}`). The bare-verb pattern
        //     above defers to us so the endpoint isn't duplicated as `GET /`.
        //   • on a method with NO HTTP verb → sub-resource LOCATOR: the only case
        //     that is itself a standalone `PATH` endpoint.
        {
            decoratorPattern: /@Path\s*\(\s*['"]([^'"]+)['"]\s*\)/gi,
            extract: (m, ctx) => {
                const { window, declSlice } = jaxrsAnnotationWindow(ctx.source, m.index ?? 0);
                if (/\b(class|interface|enum)\s+\w/.test(declSlice)) return null; // class-level base prefix
                const verb = window.match(/@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b(?!:)/i);
                if (verb) return { method: verb[1].toUpperCase(), route: m[1] }; // merge route into the verb
                return { method: 'PATH', route: m[1] };                          // sub-resource locator
            },
        },
        // Micronaut: @Get("/path"), @Post("/path")
        {
            decoratorPattern: /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"]([^'"]+)['"]\s*\)/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
        // Spring Boot: @GetMapping/@PostMapping etc. without a path argument
        {
            decoratorPattern: /@(Get|Post|Put|Patch|Delete)Mapping(?!\s*\([^)]*['"])/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: '/' }),
        },
        // Spring WebFlux functional router: .route(GET("/path"), handler)
        {
            callPattern: /\.(?:and)?[Rr]oute\s*\(\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^'"]+)['"]\s*\)/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
        // Spring WebFlux RouterFunctions.route().GET("/path").POST("/path") chain
        {
            callPattern: /\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^'"]+)['"]\s*,/gi,
            extract: (m, ctx) => {
                if (!ctx.source.includes('RouterFunction') && !ctx.source.includes('route()')) return null;
                return { method: m[1].toUpperCase(), route: m[2] };
            },
        },
        // Spring AOP — @Aspect class detection
        {
            decoratorPattern: /@Aspect\b[\s\S]{0,200}?class\s+(\w+)/gi,
            extract: (m) => ({ method: 'AOP_ASPECT', route: `aspect:${m[1]}`, handlerName: m[1] }),
        },
        // Spring AOP — @Around/@Before/@After advice
        {
            decoratorPattern: /@(Around|Before|After|AfterReturning|AfterThrowing)\s*\(\s*["']([^"']+)["']\s*\)/gi,
            extract: (m, ctx) => {
                const adviceType = m[1].toUpperCase();
                const pointcut = m[2];
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: `AOP_${adviceType}`, route: pointcut, handlerName };
            },
        },
        // Spring Boot Servlet Filter
        {
            callPattern: /class\s+(\w+)\s+implements\s+(?:javax\.servlet\.)?Filter\b/gi,
            extract: (m) => ({ method: 'SERVLET_FILTER', route: '/*', handlerName: m[1] }),
        },
        // Spring Boot HandlerInterceptor
        {
            callPattern: /class\s+(\w+)\s+implements\s+HandlerInterceptor\b/gi,
            extract: (m) => ({ method: 'HANDLER_INTERCEPTOR', route: '/*', handlerName: m[1] }),
        },
        // Spring @Scheduled (cron / fixed-rate / fixed-delay)
        {
            decoratorPattern: /@Scheduled\s*\(([^)]*)\)/g,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                const cronMatch = m[1].match(/cron\s*=\s*['"]([^'"]+)['"]/);
                const rateMatch = m[1].match(/(?:fixedRate|fixedDelay|fixedRateString|fixedDelayString)\s*=\s*['"]?([^,'")\s]+)/);
                const route = cronMatch ? `cron:${cronMatch[1]}` : rateMatch ? `interval:${rateMatch[1]}` : `scheduled:${handlerName}`;
                return { method: 'JOB', route, handlerName };
            },
        },
        // Spring @Async
        {
            decoratorPattern: /@Async\s*(?:\([^)]*\))?/g,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'JOB', route: `async:${handlerName}`, handlerName };
            },
        },
        // Spring Kafka: @KafkaListener(topics = "X", groupId = "Y")
        {
            decoratorPattern: /@KafkaListener\s*\(([^)]*)\)/g,
            extract: (m, ctx) => {
                const topicsMatch = m[1].match(/topics\s*=\s*\{?\s*['"]([^'"]+)['"]/);
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'MQ_CONSUMER', route: `kafka:${topicsMatch ? topicsMatch[1] : 'default'}`, handlerName };
            },
        },
        // Spring RabbitMQ: @RabbitListener(queues = "X")
        {
            decoratorPattern: /@RabbitListener\s*\(([^)]*)\)/g,
            extract: (m, ctx) => {
                const queuesMatch = m[1].match(/queues\s*=\s*\{?\s*['"]([^'"]+)['"]/);
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'MQ_CONSUMER', route: `rabbit:${queuesMatch ? queuesMatch[1] : 'default'}`, handlerName };
            },
        },
        // Spring JMS: @JmsListener(destination = "X")
        {
            decoratorPattern: /@JmsListener\s*\(([^)]*)\)/g,
            extract: (m, ctx) => {
                const destMatch = m[1].match(/destination\s*=\s*\{?\s*['"]([^'"]+)['"]/);
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'MQ_CONSUMER', route: `jms:${destMatch ? destMatch[1] : 'default'}`, handlerName };
            },
        },
        // Spring Cloud Stream: @StreamListener("inputChannel")
        {
            decoratorPattern: /@StreamListener\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'MQ_CONSUMER', route: `stream:${m[1]}`, handlerName };
            },
        },
        // Spring Shell: @ShellMethod / @ShellComponent
        {
            decoratorPattern: /@ShellMethod\s*\(([^)]*)\)/g,
            extract: (m, ctx) => {
                const valueMatch = m[1].match(/(?:value|key)\s*=\s*['"]([^'"]+)['"]/) || m[1].match(/['"]([^'"]+)['"]/);
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                const cmdName = valueMatch ? valueMatch[1] : handlerName;
                return { method: 'CLI_COMMAND', route: `shell:${cmdName}`, handlerName };
            },
        },
    ],
};

export const ktorPlugin: FrameworkPlugin = {
    id: 'ktor',
    name: 'Ktor server DSL',
    languages: ['kotlin'],
    patterns: [
        // Ktor: routing { get("/path") { ... } } — emit anonymous@ when followed
        // by a trailing-lambda block.
        {
            callPattern: /\b(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]\s*\)/gi,
            extract: (m, ctx) => {
                const method = m[1].toUpperCase();
                const route = m[2];
                if (/^https?:\/\//.test(route)) return null;
                if (route.includes('$port')) return null;
                const before = m.input?.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0) ?? '';
                if (/\./.test(before)) return null;
                const src = ctx.source;
                const hasClientImport = /\bimport\s+io\.ktor\.client\b/.test(src);
                const hasServerRouting = /\bimport\s+io\.ktor\.server\.routing\b/.test(src) ||
                    /\brouting\s*\{/.test(src) ||
                    /\bRoute\.\w+\s*\(/.test(src) ||
                    /\broute\s*\(\s*["']/.test(src);
                if (hasClientImport && !hasServerRouting) return null;
                const tail = m.input?.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30) ?? '';
                if (/^\s*\{/.test(tail)) {
                    return { method, route, handlerName: `anonymous@${method}:${route}` };
                }
                return { method, route };
            },
        },
        // Ktor Locations API: `get<Index> { ... }` / `post<Routes.User> { … }`
        {
            callPattern: /\b(get|post|put|patch|delete|head|options)\s*<\s*([\w.]+)\s*>\s*\{/gi,
            extract: (m) => {
                const before = m.input?.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0) ?? '';
                if (/\./.test(before)) return null;
                const method = m[1].toUpperCase();
                const typeName = m[2];
                return { method, route: '/' + typeName, handlerName: `Locations:${typeName}` };
            },
        },
        // Ktor WebSocket: `webSocket("/ws") { … }`
        {
            callPattern: /\bwebSocket\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            extract: (m) => {
                const before = m.input?.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0) ?? '';
                if (/\./.test(before)) return null;
                return { method: 'WS', route: m[1], handlerName: `webSocket:${m[1]}` };
            },
        },
        // Ktor SSE: `sse("/events") { … }`
        {
            callPattern: /\bsse\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
            extract: (m) => {
                const before = m.input?.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0) ?? '';
                if (/\./.test(before)) return null;
                return { method: 'SSE', route: m[1], handlerName: `sse:${m[1]}` };
            },
        },
        // Ktor path-less verb block inside `route("/prefix") { get { … } }`
        {
            callPattern: /(?<![.\w])(get|post|put|patch|delete|head|options)\s*\{/gi,
            extract: (m, ctx) => {
                const before = m.input?.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0) ?? '';
                if (/\./.test(before)) return null;
                const src = ctx.source;
                const hasClientImport = /\bimport\s+io\.ktor\.client\b/.test(src);
                const hasServerRouting = /\bimport\s+io\.ktor\.server\.routing\b/.test(src) ||
                    /\brouting\s*\{/.test(src);
                if (hasClientImport && !hasServerRouting) return null;
                const method = m[1].toUpperCase();
                return { method, route: '/', handlerName: `${method}:root` };
            },
        },
    ],
};
