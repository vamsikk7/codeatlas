/**
 * anonRouteFinder.ts
 *
 * Locates anonymous route handler bodies in tree-sitter ASTs across languages.
 *
 * Issue 253 follow-up: replaces the v3.1.5 Babel-wrapper approach which
 * passed Go/Kotlin/Rust/Ruby/PHP source through the JS parser and silently
 * failed. Each language's lambda/closure has a distinct AST shape, so we
 * dispatch per-language and return the body block node directly.
 *
 * The returned node's `.children` are statement nodes — suitable input
 * for buildFlowGraphFromBody().
 */

import { parseSource, type SupportedLanguage } from './treeSitterParser';

interface TSNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    childCount: number;
    children: TSNode[];
    parent: TSNode | null;
    childForFieldName(fieldName: string): TSNode | null;
    descendantsOfType(types: string | string[]): TSNode[];
}

function unquote(s: string): string {
    if (s.length < 2) return s;
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' || first === "'" || first === '`') && first === last) {
        return s.slice(1, -1);
    }
    return s;
}

function findStringLiteralValue(arg: TSNode): string | null {
    // Common: arg is itself a string-literal-like node
    const stringTypes = new Set([
        'string_literal', 'interpreted_string_literal', 'raw_string_literal',
        'string', 'encapsed_string',
    ]);
    if (stringTypes.has(arg.type)) {
        // Issue 354: when the literal contains string-template interpolation
        // (Kotlin `$var` / `${expr}`), there are multiple string_content
        // chunks interleaved with `$` and `interpolated_identifier` children.
        // The detector regex captures the raw source text between the quote
        // chars, so to match it we must reconstruct that same raw form via
        // the literal's full unquoted text. Single-content strings still take
        // the fast path.
        const contentChildren = arg.children.filter(c => c.type === 'string_content');
        if (contentChildren.length === 1) return contentChildren[0].text;
        return unquote(arg.text);
    }
    // Wrapper: argument node with string child
    if (arg.type === 'argument' || arg.type === 'value_argument') {
        for (const c of arg.children) {
            const v = findStringLiteralValue(c);
            if (v != null) return v;
        }
    }
    return null;
}

/**
 * Find an anonymous route handler's body node in the given AST.
 *
 * @returns A node whose `.children` are statement nodes, or null if no match.
 */
export async function findAnonymousRouteBody(
    code: string,
    language: SupportedLanguage,
    method: string,
    route: string,
): Promise<TSNode | null> {
    let tree;
    try {
        tree = await parseSource(code, language);
    } catch {
        return null;
    }
    const root = tree.rootNode as unknown as TSNode;

    switch (language) {
        case 'go': return findGoRouteBody(root, method, route);
        case 'rust': return findRustRouteBody(root, method, route);
        case 'kotlin': return findKotlinRouteBody(root, method, route);
        case 'ruby': return findRubyRouteBody(root, method, route);
        case 'php': return findPhpRouteBody(root, method, route);
        case 'swift': return findSwiftRouteBody(root, method, route);
        case 'javascript':
        case 'typescript': return findJsRouteBody(root, method, route);
        default: return null;
    }
}

// ─── JS/TS: app.get('/users', (req, res) => {...}) ──────────────────────────
// Also covers Fastify (`fastify.get`), Hono (`app.get`), Koa-router, and
// any builder that follows the `<obj>.<verb>("/path", fn)` shape.
//
// Handles three callback shapes:
//   1. Block-body arrow:  (c) => { ... }
//   2. Concise arrow:     (c) => c.text('hi')          → wrapped as one statement
//   3. function expr:     function (req) { ... }
//
// The last callback in the args list is the handler; preceding args may be
// middleware (e.g. `app.get('/posts', prettyJSON(), (c) => {...})`).
function findJsRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    const calls = root.descendantsOfType('call_expression');
    const verb = method.toLowerCase();
    for (const call of calls) {
        const fn = call.childForFieldName('function');
        if (!fn) continue;
        if (fn.type !== 'member_expression') continue;
        const propIdent = fn.children.find(c => c.type === 'property_identifier');
        if (!propIdent || propIdent.text.toLowerCase() !== verb) continue;

        const args = call.childForFieldName('arguments');
        if (!args) continue;
        const matched = args.children.some(c => findStringLiteralValue(c) === route);
        if (!matched) continue;

        // Iterate from the end so we find the LAST callback (handler) — earlier
        // arrow/function args are typically middleware.
        for (let i = args.children.length - 1; i >= 0; i--) {
            const c = args.children[i];
            if (c.type !== 'arrow_function' && c.type !== 'function_expression') continue;
            const body = c.childForFieldName('body')
                ?? c.children.find(ch => ch.type === 'statement_block');
            if (!body) continue;
            // Block body — direct return.
            if (body.type === 'statement_block' || body.type === 'block') return body;
            // Concise arrow: body is the expression itself. Synthesize a wrapper
            // node whose `.children` is the single expression so buildFlowGraphFromBody
            // can iterate it as a one-statement block.
            return {
                type: 'block',
                text: body.text,
                startIndex: body.startIndex,
                endIndex: body.endIndex,
                childCount: 1,
                children: [body],
                parent: c,
                childForFieldName: () => null,
                descendantsOfType: () => [],
            } as TSNode;
        }
    }
    return null;
}

// ─── Go: r.GET("/users", func(c *gin.Context) {...}) ────────────────────────

function findGoRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    const calls = root.descendantsOfType('call_expression');
    for (const call of calls) {
        const fn = call.childForFieldName('function');
        if (!fn) continue;
        // Match either selector_expression (r.GET) or bare identifier (GET)
        let methodName: string | null = null;
        if (fn.type === 'selector_expression') {
            const fid = fn.children.find(c => c.type === 'field_identifier');
            methodName = fid?.text ?? null;
        } else if (fn.type === 'identifier') {
            methodName = fn.text;
        }
        if (!methodName || methodName.toUpperCase() !== method.toUpperCase()) continue;

        const args = call.childForFieldName('arguments');
        if (!args) continue;
        const stringMatches = args.children.some(c => {
            const v = findStringLiteralValue(c);
            return v === route;
        });
        if (!stringMatches) continue;

        const funcLit = args.children.find(c => c.type === 'func_literal');
        if (!funcLit) continue;
        const body = funcLit.childForFieldName('body');
        if (body && body.type === 'block') return body;
    }
    return null;
}

// ─── Rust: .route("/users", get(|| async {...})) ────────────────────────────

function findRustRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    // Issue 339 follow-through: Rust supports two route-registration shapes:
    //   1. Axum:  `.route(<route>, <verb>(<closure>))`
    //   2. Actix: `web::resource(<route>).route(web::<verb>().to(<closure>))`
    // The original implementation only handled (1). Handle both.
    const closureBodyOf = (closure: TSNode): TSNode | null => {
        const direct = closure.children.find(c => c.type === 'block');
        if (direct) return direct;
        const asyncBlock = closure.children.find(c => c.type === 'async_block');
        if (asyncBlock) {
            const inner = asyncBlock.children.find(c => c.type === 'block');
            if (inner) return inner;
            // `async { … }` — the async_block's children are the body items
            // directly. Wrap as a synthetic block.
            return asyncBlock;
        }
        // Issue 354: closure body can be any single expression — `|req| match
        // *req.method() { … }`, `|x| if x > 0 {…} else {…}`, etc. Wrap as a
        // block whose children iterate the expression as one statement.
        const exprChild = closure.children.find(c =>
            c.type !== 'closure_parameters' && c.type !== '|' && c.type !== 'move'
            && c.type !== '->' && c.type !== '_type'
        );
        if (exprChild) {
            return {
                type: 'block',
                text: exprChild.text,
                startIndex: exprChild.startIndex,
                endIndex: exprChild.endIndex,
                childCount: 1,
                children: [exprChild],
                parent: closure,
                childForFieldName: () => null,
                descendantsOfType: () => [],
            } as TSNode;
        }
        return null;
    };

    const calls = root.descendantsOfType('call_expression');
    for (const call of calls) {
        const fn = call.childForFieldName('function');
        if (!fn) continue;

        // Shape 1: Axum `.route(<route>, <verb>(<closure>))`.
        if (fn.type === 'field_expression') {
            const field = fn.children.find(c => c.type === 'field_identifier');
            if (field?.text === 'route') {
                const args = call.childForFieldName('arguments');
                if (!args) continue;
                const stringArg = args.children.find(c => findStringLiteralValue(c) === route);
                if (!stringArg) continue;
                const verbCall = args.children.find(c => {
                    if (c.type !== 'call_expression') return false;
                    const vfn = c.childForFieldName('function');
                    if (vfn?.type !== 'identifier') return false;
                    // Issue 352: also accept `get_service`, `post_service`, etc.
                    // wrapper variants used for Tower service composition.
                    const upper = vfn.text.toUpperCase();
                    return upper === method.toUpperCase()
                        || upper === `${method.toUpperCase()}_SERVICE`;
                });
                if (!verbCall) continue;
                const verbArgs = verbCall.childForFieldName('arguments');
                if (!verbArgs) continue;
                const closure = verbArgs.children.find(c => c.type === 'closure_expression');
                if (!closure) {
                    // Issue 352: `get_service(service_fn(|_| async { … }))` —
                    // walk one level deeper into nested call_expression to
                    // find the closure inside `service_fn(...)`.
                    const innerCall = verbArgs.children.find(c => c.type === 'call_expression');
                    if (innerCall) {
                        const innerArgs = innerCall.childForFieldName('arguments');
                        const innerClosure = innerArgs?.children.find(c => c.type === 'closure_expression');
                        if (innerClosure) {
                            const body = closureBodyOf(innerClosure);
                            if (body) return body;
                        }
                    }
                    continue;
                }
                const body = closureBodyOf(closure);
                if (body) return body;
            }

            // Shape 2: Actix `web::resource(<route>).route(web::<verb>().to(<closure>))`
            // OR direct `web::resource(<route>).to(<closure>)`. The outer call
            // here is `.to(closure)`. Walk back through the call chain to
            // confirm a containing `web::resource(<route>)` matches.
            if (field?.text === 'to') {
                const args = call.childForFieldName('arguments');
                const closure = args?.children.find(c => c.type === 'closure_expression');
                if (!closure) continue;

                // Verify the verb. The `.to(...)` is the field. Its receiver
                // is either `web::<verb>()` (the `.route(web::get().to(...))`
                // shape) — verb must match — OR `web::resource(<route>)` (the
                // direct `.to()` shape) — assume GET.
                const receiver = fn.children.find(c => c.type === 'call_expression');
                if (!receiver) continue;
                const recFn = receiver.childForFieldName('function');
                if (recFn?.type !== 'scoped_identifier') continue;
                // scoped_identifier `web::resource` parses as identifier
                // `web`, `::`, identifier `resource`. We want the LAST
                // identifier (the function name), not the namespace.
                const recIdents = recFn.children.filter(c => c.type === 'identifier');
                const recIdent = recIdents.length > 0 ? recIdents[recIdents.length - 1].text : '';

                let routeMatches = false;
                if (recIdent === 'resource') {
                    // Direct `web::resource(<route>).to(<closure>)` — verb
                    // implicitly GET; verify route from receiver's args.
                    if (method.toUpperCase() !== 'GET') continue;
                    const recArgs = receiver.childForFieldName('arguments');
                    if (recArgs?.children.some(c => findStringLiteralValue(c) === route)) {
                        routeMatches = true;
                    }
                } else if (recIdent.toUpperCase() === method.toUpperCase()) {
                    // `web::<verb>().to(<closure>)` — walk up the chain to find
                    // the parent `.route(...)` call whose receiver is
                    // `web::resource(<route>)`.
                    let cursor: TSNode | null = call.parent;
                    while (cursor && !routeMatches) {
                        if (cursor.type === 'call_expression') {
                            const cFn = cursor.childForFieldName('function');
                            if (cFn?.type === 'field_expression') {
                                const cField = cFn.children.find(c => c.type === 'field_identifier');
                                if (cField?.text === 'route') {
                                    // `<receiver>.route(...)` — receiver is the
                                    // value child, look for `web::resource(<route>)`.
                                    const cVal = cFn.childForFieldName('value');
                                    if (cVal?.type === 'call_expression') {
                                        const cValFn = cVal.childForFieldName('function');
                                        if (cValFn?.type === 'scoped_identifier' && cValFn.text.endsWith('::resource')) {
                                            const cValArgs = cVal.childForFieldName('arguments');
                                            if (cValArgs?.children.some(c => findStringLiteralValue(c) === route)) {
                                                routeMatches = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        cursor = cursor.parent;
                    }
                }

                if (!routeMatches) continue;
                const body = closureBodyOf(closure);
                if (body) return body;
            }
        }
    }
    return null;
}

// ─── Kotlin (Ktor): get("/users") { ... } ───────────────────────────────────

function findKotlinRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    // Outer call_expression: `get("/users") { ... }`
    // Inner call_expression: `get("/users")`
    // call_suffix → annotated_lambda → lambda_literal → statements
    const calls = root.descendantsOfType('call_expression');
    for (const outer of calls) {
        // Outer must have a trailing lambda
        const outerSuffix = outer.children.find(c => c.type === 'call_suffix');
        if (!outerSuffix) continue;
        const annotated = outerSuffix.children.find(c => c.type === 'annotated_lambda');
        if (!annotated) continue;
        const lambda = annotated.children.find(c => c.type === 'lambda_literal');
        if (!lambda) continue;

        // Outer's first child should be the inner `get("/users")` call_expression
        const inner = outer.children.find(c => c.type === 'call_expression');
        if (!inner) continue;
        const ident = inner.children.find(c => c.type === 'simple_identifier');
        if (!ident || ident.text.toLowerCase() !== method.toLowerCase()) continue;

        const innerSuffix = inner.children.find(c => c.type === 'call_suffix');
        if (!innerSuffix) continue;
        const valueArgs = innerSuffix.children.find(c => c.type === 'value_arguments');
        if (!valueArgs) continue;
        // Issue 354: tolerate leading-slash mismatch. Detector normalizes
        // routes to start with `/`, but Ktor route strings sometimes omit it
        // (e.g. `get("{$pathParameterName...}")`). Compare both with and
        // without the leading slash.
        const routeAlt = route.startsWith('/') ? route.slice(1) : '/' + route;
        const matched = valueArgs.children.some(c => {
            const v = findStringLiteralValue(c);
            return v === route || v === routeAlt;
        });
        if (!matched) continue;

        const statements = lambda.children.find(c => c.type === 'statements');
        if (statements) return statements;
    }
    return null;
}

// ─── Ruby (Sinatra): get '/users' do ... end ────────────────────────────────

function findRubyRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    const calls = root.descendantsOfType('call');
    for (const call of calls) {
        const ident = call.children.find(c => c.type === 'identifier');
        if (!ident || ident.text.toLowerCase() !== method.toLowerCase()) continue;

        const argList = call.children.find(c => c.type === 'argument_list');
        if (!argList) continue;
        const matched = argList.children.some(c => findStringLiteralValue(c) === route);
        if (!matched) continue;

        const doBlock = call.children.find(c => c.type === 'do_block' || c.type === 'block');
        if (!doBlock) continue;
        const bodyStmt = doBlock.children.find(c => c.type === 'body_statement');
        if (bodyStmt) return bodyStmt;
    }
    return null;
}

// ─── PHP (Laravel): Route::get('/users', function () {...}) ─────────────────

function findPhpRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    const scoped = root.descendantsOfType('scoped_call_expression');
    for (const call of scoped) {
        // Match: ClassName::method(...)
        // children: name "Route", ::, name "get", arguments
        const nameNodes = call.children.filter(c => c.type === 'name');
        const methodName = nameNodes[1]?.text;
        if (!methodName || methodName.toLowerCase() !== method.toLowerCase()) continue;

        const args = call.children.find(c => c.type === 'arguments');
        if (!args) continue;

        const matched = args.children.some(c => findStringLiteralValue(c) === route);
        if (!matched) continue;

        // Find the anonymous function argument
        for (const arg of args.children) {
            if (arg.type !== 'argument') continue;
            const anon = arg.children.find(c =>
                c.type === 'anonymous_function_creation_expression'
                || c.type === 'arrow_function');
            if (anon) {
                const body = anon.childForFieldName('body')
                    ?? anon.children.find(c => c.type === 'compound_statement');
                if (body) return body;
            }
        }
    }
    return null;
}

// ─── Swift (Vapor): routes.get("hello") { req in … } ───────────────────────

function findSwiftRouteBody(root: TSNode, method: string, route: string): TSNode | null {
    // Vapor strips a leading `/` from the registered path: `routes.get("hello")`
    // produces route `/hello`. Compare against both shapes.
    const routeNoSlash = route.startsWith('/') ? route.slice(1) : route;
    const calls = root.descendantsOfType('call_expression');
    const verbLower = method.toLowerCase();
    const verbRe = new RegExp(`\\.${verbLower}\\b`, 'i');
    for (const call of calls) {
        const text = call.text;
        if (!text) continue;
        if (!verbRe.test(text)) continue;
        if (!text.includes(`"${routeNoSlash}"`) && !text.includes(`"${route}"`)) continue;
        // Trailing closure is parsed as `lambda_literal`. Pick the first one
        // attached to this call.
        const lambdas = call.descendantsOfType('lambda_literal');
        if (lambdas.length > 0) {
            const lambda = lambdas[0];
            const stmts = lambda.children.find(c => c.type === 'statements');
            if (stmts) return stmts;
            return lambda;
        }
    }
    return null;
}
