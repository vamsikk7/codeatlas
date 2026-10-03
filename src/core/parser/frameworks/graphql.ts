/**
 * frameworks/graphql.ts — Cross-language GraphQL plugin
 * (Issue #703, Phase 2 PR-17.)
 *
 * GraphQL routing is mediated by resolvers, not URL paths. Four
 * patterns cover the common shapes across JS/TS, Python, and JVM:
 *
 *   1. **NestJS / TypeGraphQL decorators** — `@Query()`, `@Mutation()`,
 *      `@Subscription()` on a class method. The pattern is anchored to
 *      its own line (`^[ \t]*@…$` with `m` flag) so we don't false-match
 *      NestJS REST `@Query()` as a method parameter decorator.
 *   2. **Apollo Server SDL** — `type Query { fieldName(...) }` parsed
 *      from the typedef block. Each field becomes its own ApiRecord
 *      with an `anonymous@<METHOD>:<field>` handler so the cross-file
 *      verifier can still match a resolver.
 *   3. **Resolver-object shorthand** — `Query: { users: …, posts: … }`
 *      inside `const resolvers = { … }`. Brace-counted body parse so
 *      nested keys (e.g. `Subscription: { todoCreated: { subscribe }}`)
 *      contribute the leaf name.
 *   4. **TypeGraphQL `@Resolver(() => Type)`** — class-level decorator
 *      announcing the resolver class.
 *
 * Suppression: ALL GraphQL patterns carry `skipInGraphqlTestFile: true`.
 * Pre-#703 the dispatcher used `graphqlPatterns.has(pattern)` to
 * suppress GraphQL hits inside test fixtures (`*.test.{ts,js,py}`) so
 * mock schema usage doesn't bleed into API counts. Once the inline
 * GRAPHQL_PATTERNS array is empty, the Set lookup returns false for
 * every plugin pattern — the explicit flag is what preserves that
 * behaviour.
 *
 * Languages: js, ts, python, java, kotlin (the pre-#703
 * `FRAMEWORK_PATTERNS` table spread `GRAPHQL_PATTERNS` into all five).
 */

import type { FrameworkPlugin } from './types';

/**
 * BUG-SUBSCRIPTION-FALSEPOS — Guard for the two "bare" GraphQL patterns
 * (SDL `type Query|Mutation|Subscription { … }` and resolver-object
 * `Query|Mutation|Subscription: { … }`) that key only off the type name.
 *
 * openapi-typescript generated clients (e.g. polar/clients/src/client/v1.ts)
 * emit `components.schemas.Subscription: { amount: number; customer_id: …; }`
 * data-model types. That is `Subscription: {` textually — indistinguishable
 * from an Apollo resolver map by name alone — so the resolver-object pattern
 * was emitting every scalar field (`amount`, `customer_id`, …) as a bogus
 * SUBSCRIPTION "endpoint".
 *
 * The gate: only treat a `Query|Mutation|Subscription` block as GraphQL when
 * the file has real GraphQL context. Two independent signals qualify:
 *
 *   1. A GraphQL library is imported / used in the file (`graphql`, apollo,
 *      `@nestjs/graphql`, `type-graphql`, `graphql-subscriptions`, a `gql`
 *      tagged template, `graphql-tag`, mercurius, pothos, nexus). This covers
 *      SDL `typeDefs` blocks and resolver maps that live alongside a graphql
 *      import.
 *   2. The matched block's body is resolver-shaped — its fields are functions
 *      (`name: (args) => …`, `name(args) {`, `async …`) or nested resolver
 *      objects (`name: { subscribe … }`), not scalar type refs
 *      (`amount: number;`). This covers resolver maps that import only their
 *      service deps (matches the existing APOLLO_RESOLVERS_TS fixture).
 *
 * A generated OpenAPI data model — no graphql import + scalar-only fields —
 * satisfies neither and yields ZERO records.
 */
const GRAPHQL_CONTEXT_RE =
    /\bgraphql\b|@nestjs\/graphql|type-graphql|graphql-subscriptions|graphql-tag|\bgql\s*[`(]|\bmercurius\b|@pothos\/|\bnexus\b|apollo/i;

export function hasGraphqlLibraryContext(source: string): boolean {
    return GRAPHQL_CONTEXT_RE.test(source);
}

/**
 * Returns true when a `{ … }` block body reads like a GraphQL resolver map /
 * SDL field set rather than a scalar TS data-model type. A single
 * function-shaped or arg-carrying field is enough to qualify; a body made up
 * entirely of `name: ScalarType;` fields does not.
 */
export function bodyLooksLikeGraphqlBlock(body: string): boolean {
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = /^(\w+)\s*([:(])/.exec(line);
        if (!m) continue;
        const rest = line.slice(m[0].length).trim();
        // Method-shorthand `name(args) …` or SDL field-with-args `name(arg: T): T`.
        if (m[2] === '(') return true;
        // Arrow / function / async resolver, or a nested resolver object.
        if (/=>/.test(rest) || /^async\b/.test(rest) || /^function\b/.test(rest)) return true;
        if (/^\{/.test(rest) && /\b(subscribe|resolve)\b/.test(body)) return true;
    }
    return false;
}

/** Combined gate used by both bare-name GraphQL patterns. */
function isRealGraphqlBlock(source: string, blockBody: string): boolean {
    return hasGraphqlLibraryContext(source) || bodyLooksLikeGraphqlBlock(blockBody);
}

export const graphqlPlugin: FrameworkPlugin = {
    id: 'graphql',
    name: 'GraphQL (Apollo / TypeGraphQL / NestJS GraphQL)',
    languages: ['javascript', 'typescript', 'python', 'java', 'kotlin'],
    patterns: [
        // NestJS / TypeGraphQL: @Query() / @Mutation() / @Subscription() — line-anchored.
        {
            decoratorPattern: /^[ \t]*@(Query|Mutation|Subscription)\s*\(\s*(?:['"]([^'"]+)['"])?\s*\)\s*$/gm,
            extract: (m, ctx) => {
                const arg = m[2];
                // Spring Data JPA `@Query("SELECT … FROM …")` (JPQL/SQL) collides
                // with the NestJS/TypeGraphQL `@Query('fieldName')` form. Java/Kotlin
                // GraphQL never uses the `@Query('name')` decorator (it uses
                // `@QueryMapping` etc.), so a string-arg `@Query` there is always
                // Spring JPA; and a SQL-shaped arg in ANY language is a query
                // statement, not a GraphQL field name. Skip both — don't inflate
                // the API surface with `QUERY /SELECT … FROM …` pseudo-routes.
                if (arg) {
                    if (ctx.language === 'java' || ctx.language === 'kotlin') return null;
                    if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(arg) || /\bFROM\b|\bWHERE\b|\bJOIN\b/i.test(arg)) return null;
                }
                return { method: m[1].toUpperCase(), route: arg || '/' };
            },
            skipInGraphqlTestFile: true,
        },
        // Apollo Server SDL: type Query { fieldName(...) }
        {
            callPattern: /type\s+(Query|Mutation|Subscription)\s*\{([^}]{0,2000})\}/gi,
            extract: (m, ctx) => {
                // BUG-SUBSCRIPTION-FALSEPOS — require real GraphQL context so a
                // generated OpenAPI data-model type named Query/Mutation/Subscription
                // (scalar fields, no graphql import) is not treated as SDL.
                if (!isRealGraphqlBlock(ctx.source, m[2])) return null;
                const method = m[1].toUpperCase();
                const fields = [...m[2].matchAll(/^[ \t]*(\w+)\s*[(:]/gm)];
                if (fields.length === 0) return { method, route: '/', handlerName: `anonymous@${method}:/` };
                return fields.map(f => ({
                    method,
                    route: f[1],
                    handlerName: `anonymous@${method}:${f[1]}`,
                }));
            },
            skipInGraphqlTestFile: true,
        },
        // Resolver-object shorthand: const resolvers = { Query: { users: …, posts: … } }
        {
            callPattern: /\b(Query|Mutation|Subscription)\s*:\s*\{/g,
            extract: (m, ctx) => {
                const method = m[1].toUpperCase();
                const openIdx = (m.index ?? 0) + m[0].length - 1;
                let depth = 1;
                let pos = openIdx + 1;
                while (pos < ctx.source.length && depth > 0) {
                    const ch = ctx.source[pos];
                    if (ch === '{') depth++;
                    else if (ch === '}') depth--;
                    pos++;
                }
                const body = ctx.source.slice(openIdx + 1, pos - 1);
                // BUG-SUBSCRIPTION-FALSEPOS — a generated OpenAPI schema map
                // (`Subscription: { amount: number; … }`) is `Subscription: {`
                // textually but is NOT a resolver map. Require real GraphQL
                // context (graphql import) or resolver-shaped fields.
                if (!isRealGraphqlBlock(ctx.source, body)) return null;
                const lineFields = [...body.matchAll(/^[ \t]+(\w+)\s*[:(]/gm)].map(x => x[1]);
                const uniq = [...new Set(lineFields)];
                if (uniq.length === 0) return null;
                return uniq.map(name => ({ method, route: name, handlerName: name }));
            },
            skipInGraphqlTestFile: true,
        },
        // @Resolver(() => Type)
        {
            decoratorPattern: /@Resolver\s*\(\s*(?:\(\s*\)\s*=>\s*)?(\w+)/gi,
            extract: (m) => ({ method: 'RESOLVER', route: m[1] }),
            skipInGraphqlTestFile: true,
        },
    ],
};
