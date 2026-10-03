import { parseJSAuto } from './jsParser';
import { parseJSCached } from './astCache';
import type { EntityRecord } from '../graph/graphTypes';
import _traverse from '@babel/traverse';

// Handle ESM/CJS interop for babel traverse
const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

/**
 * Extract source text for an AST node
 */
export function srcText(node: any, source: string): string {
    if (!node || node.start == null || node.end == null) return '';
    return source.slice(node.start, node.end).trim();
}

/**
 * Normalize whitespace in a string
 */
export function normalizeSpace(s: string): string {
    return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * #837 — raw (newline-preserving) function source for diff reconstruction.
 * `bodyText` above is whitespace-collapsed, which cannot be re-parsed for
 * semicolon-less code (`const a = 1 const b = 2`); the flow-diff silently
 * stamped zero badges for such handlers. Truncated to bound record size.
 */
function rawFnSrc(s: string): string {
    const raw = s || '';
    return raw.length > 6000 ? raw.slice(0, 6000) : raw;
}

/**
 * Get function parameter list as a comma-separated string
 */
/** Issue 414: walk up the traversal path to find the enclosing ForStatement, if any. */
function findEnclosingForLoop(p: any): any | null {
    let cur = p?.parentPath;
    while (cur) {
        if (cur.node?.type === 'ForStatement') return cur.node;
        cur = cur.parentPath;
    }
    return null;
}

/** Issue 414: extract the single loop-variable name from a ForStatement init. */
function getForLoopVar(forNode: any): string | null {
    const init = forNode?.init;
    if (init?.type !== 'VariableDeclaration' || init.declarations?.length !== 1) return null;
    const d = init.declarations[0];
    if (d?.id?.type !== 'Identifier') return null;
    return d.id.name;
}

function getFunctionParamList(fnNode: any): string {
    return (fnNode.params || [])
        .map((p: any) => (p.type === 'Identifier' ? p.name : 'arg'))
        .join(', ');
}

export interface FileAnalysis {
    entities: EntityRecord[];
    funcs: Map<string, EntityRecord>;
    vars: Map<string, EntityRecord>;
    importsByLocal: Map<string, string>;
    fileName: string;
}

/**
 * Analyze a JS file and extract all top-level entities:
 * imports, variables, and functions (including arrow/function expressions assigned to variables).
 * Also captures `module.exports = ...` and `exports.X = ...` assignments as variable entities.
 *
 * Also analyzes function-level dependencies: which functions call which, use which vars, and depend on which imports.
 */
export function collectTopLevelEntities(code: string, fileName: string = 'file.js'): FileAnalysis {
    // INVARIANT (ADR-022): high-frequency parser routes through the AST
    // cache so a single save event doesn't reparse the same file 5+ times.
    // `parseJSCached` falls back to a fresh parse on cache miss; behavior
    // is identical to `parseJSAuto` from the caller's perspective.
    const ast = parseJSCached(code, fileName);
    const entities: EntityRecord[] = [];
    const importsByLocal = new Map<string, string>();
    const vars = new Map<string, EntityRecord>();
    const funcs = new Map<string, EntityRecord>();

    const body = ast.program.body || [];

    for (const stmt of body) {
        // Unwrap export declarations so exported functions/variables are visible.
        // e.g. `export const fn = async () => {}` wraps a VariableDeclaration in
        // an ExportNamedDeclaration — unwrap to process the inner node normally.
        let s: any = stmt;
        if (s.type === 'ExportNamedDeclaration' && s.declaration) {
            s = s.declaration;
        } else if (
            s.type === 'ExportDefaultDeclaration' &&
            (s.declaration?.type === 'FunctionDeclaration' || s.declaration?.type === 'ClassDeclaration')
        ) {
            s = s.declaration;
        }

        // import ... from '...'
        if (s.type === 'ImportDeclaration') {
            const source = s.source?.value || '';
            const names = (s.specifiers || []).map((sp: any) => {
                const local = sp.local?.name;
                const imported =
                    sp.type === 'ImportDefaultSpecifier'
                        ? 'default'
                        : sp.type === 'ImportNamespaceSpecifier'
                            ? '*'
                            : sp.imported?.name || 'unknown';
                if (local) importsByLocal.set(local, source);
                return `${imported} as ${local}`;
            });

            entities.push({
                kind: 'import',
                name: source,
                key: `import:${source}`,
                signature: `import ${names.join(', ')} from "${source}"`,
                bodyText: normalizeSpace(srcText(s, code)),
                locText: normalizeSpace(srcText(s, code)),
            });
            continue;
        }

        // function foo() {}
        if (s.type === 'FunctionDeclaration' && s.id?.name) {
            const name = s.id.name;
            const isAsync = s.async ? 'async ' : '';
            const signature = `${isAsync}function ${name}(${getFunctionParamList(s)})`;
            const bodyText = normalizeSpace(srcText(s.body, code));
            const fnEntity: EntityRecord = {
                kind: 'function',
                name,
                key: `function:${name}`,
                signature,
                bodyText,
                bodySrc: rawFnSrc(srcText(s, code)),
                locText: normalizeSpace(srcText(s, code)),
                node: s,
                calls: new Set<string>(),
                usesVars: new Set<string>(),
                usesImports: new Set<string>(),
            };
            funcs.set(name, fnEntity);
            entities.push(fnEntity);
            continue;
        }

        // Issue 265: class declarations — extract methods so the call graph
        // can attach edges to them (NestJS controllers/services etc.). Without
        // this, ts-nestjs and similar OOP-heavy repos report 0 call edges.
        if (s.type === 'ClassDeclaration' && s.id?.name) {
            const className = s.id.name;
            for (const m of s.body?.body ?? []) {
                if (m.type !== 'ClassMethod' && m.type !== 'ClassPrivateMethod') continue;
                if (!m.key || m.key.type !== 'Identifier') continue;
                const methodName = m.key.name;
                const qname = `${className}.${methodName}`;
                const isAsync = m.async ? 'async ' : '';
                const signature = `${isAsync}${methodName}(${getFunctionParamList(m)})`;
                const bodyText = m.body ? normalizeSpace(srcText(m.body, code)) : '';
                const methodEntity: EntityRecord = {
                    kind: 'function',
                    name: qname,
                    key: `function:${qname}`,
                    signature,
                    bodyText,
                    // Methods lack the `function` keyword — consumers
                    // (rebuildFile oldFnCode) prefix it before parsing.
                    bodySrc: rawFnSrc(srcText(m, code)),
                    locText: normalizeSpace(srcText(m, code)),
                    node: m,
                    calls: new Set<string>(),
                    usesVars: new Set<string>(),
                    usesImports: new Set<string>(),
                };
                funcs.set(qname, methodEntity);
                entities.push(methodEntity);
            }
            continue;
        }

        // const/let/var declarations
        if (s.type === 'VariableDeclaration') {
            for (const d of (s as any).declarations || []) {
                if (!d.id || d.id.type !== 'Identifier') continue;
                const name = d.id.name;
                const init = d.init;

                // Direct: `const X = () => {}` or `const X = function() {}`.
                // Wrapped: `const X = catchAsync(() => {})` or `const X = asyncHandler(fn)` —
                // the higher-order wrapper pattern that's standard for Express controllers
                // and several other frameworks. We treat the wrapped arrow/function as the
                // entity's body so handlers like `authController.login` resolve as
                // first-class functions for sequence-graph generation, flow-graph builds,
                // and call-graph attachment.
                let fnInit: any = null;
                if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
                    fnInit = init;
                } else if (
                    init && init.type === 'CallExpression' &&
                    Array.isArray(init.arguments) && init.arguments.length > 0
                ) {
                    // First-arg HOC pattern (catchAsync(fn), asyncHandler(fn), wrap(fn)).
                    // Last-arg variant is rarer in real code — adopt only the first-arg
                    // shape to keep false positives (setTimeout, callback registrations)
                    // bounded.
                    const firstArg = init.arguments[0];
                    if (firstArg && (firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression')) {
                        fnInit = firstArg;
                    }
                }

                if (fnInit) {
                    const fakeFn = { ...fnInit, id: d.id };
                    const isAsync = fnInit.async ? 'async ' : '';
                    const signature = `${isAsync}function ${name}(${getFunctionParamList(fakeFn)})`;
                    const bodyText =
                        fnInit.body?.type === 'BlockStatement'
                            ? normalizeSpace(srcText(fnInit.body, code))
                            : normalizeSpace(srcText(fnInit.body, code));
                    const fnEntity: EntityRecord = {
                        kind: 'function',
                        name,
                        key: `function:${name}`,
                        signature,
                        bodyText,
                        // Declarator text (`name = (…) => {…}`) — parses as
                        // an assignment expression.
                        bodySrc: rawFnSrc(srcText(d, code)),
                        locText: normalizeSpace(srcText(d, code)),
                        node: fakeFn,
                        calls: new Set<string>(),
                        usesVars: new Set<string>(),
                        usesImports: new Set<string>(),
                    };
                    funcs.set(name, fnEntity);
                    entities.push(fnEntity);
                } else {
                    const signature = `var ${name}`;
                    const bodyText = normalizeSpace(srcText(d, code));
                    const vEntity: EntityRecord = {
                        kind: 'variable',
                        name,
                        key: `variable:${name}`,
                        signature,
                        bodyText,
                        locText: normalizeSpace(srcText(d, code)),
                    };
                    vars.set(name, vEntity);
                    entities.push(vEntity);
                }
            }

            // CommonJS require capture
            for (const d of (s as any).declarations || []) {
                if (
                    d.init?.type === 'CallExpression' &&
                    d.init.callee?.type === 'Identifier' &&
                    d.init.callee.name === 'require' &&
                    d.init.arguments?.[0]?.type === 'StringLiteral'
                ) {
                    const src = d.init.arguments[0].value;

                    if (d.id?.type === 'Identifier') {
                        importsByLocal.set(d.id.name, src);
                    } else if (d.id?.type === 'ObjectPattern') {
                        for (const prop of d.id.properties) {
                            if (prop.value?.type === 'Identifier') {
                                importsByLocal.set(prop.value.name, src);
                            }
                        }
                    }

                    if (!entities.find((e) => e.key === `import:${src}`)) {
                        entities.push({
                            kind: 'import',
                            name: src,
                            key: `import:${src}`,
                            signature: `require("${src}")`,
                            bodyText: `require("${src}")`,
                            locText: `require("${src}")`,
                        });
                    }
                }
            }
            continue;
        }

        // ExpressionStatement: capture `module.exports = ...` and `exports.X = ...`
        if (s.type === 'ExpressionStatement' && (s as any).expression?.type === 'AssignmentExpression') {
            const expr = (s as any).expression;
            const left = expr.left;
            const right = expr.right;

            // module.exports = <something>
            if (
                left.type === 'MemberExpression' &&
                left.object?.name === 'module' &&
                left.property?.name === 'exports'
            ) {
                const bodyText = normalizeSpace(srcText(right, code));
                const locText = normalizeSpace(srcText(stmt, code));
                if (!entities.find(e => e.key === 'variable:module.exports')) {
                    const vEntity: EntityRecord = {
                        kind: 'variable',
                        name: 'module.exports',
                        key: 'variable:module.exports',
                        signature: 'module.exports',
                        bodyText,
                        locText,
                    };
                    vars.set('module.exports', vEntity);
                    entities.push(vEntity);
                }
                continue;
            }

            // exports.X = <something>
            if (
                left.type === 'MemberExpression' &&
                left.object?.name === 'exports' &&
                left.property?.type === 'Identifier'
            ) {
                const propName = left.property.name;
                // 2026-06-09 — when the RHS is a function/arrow, treat as a
                // named function (so a flow graph is built and L3-fallback
                // works) rather than a generic variable. Serverless / AWS
                // Lambda / Azure Functions handler files exclusively use
                // this `exports.X = (event) => {…}` shape; without this
                // branch the handler has no entry in `symbols.functions`
                // and the sequence→flow fallback has nothing to fall back
                // to.
                if (right && (right.type === 'ArrowFunctionExpression' || right.type === 'FunctionExpression')) {
                    if (!funcs.has(propName)) {
                        const sigText = right.params?.length
                            ? `function ${propName}(${right.params.map((p: any) => srcText(p, code) || '').join(', ')})`
                            : `function ${propName}()`;
                        const fnEntity: EntityRecord = {
                            kind: 'function', name: propName,
                            key: `function:${propName}`,
                            signature: sigText,
                            bodyText: right.body ? normalizeSpace(srcText(right.body, code)) : '',
                            bodySrc: rawFnSrc(srcText(stmt, code)),
                            locText: normalizeSpace(srcText(stmt, code)),
                            node: right,
                            calls: new Set<string>(), usesVars: new Set<string>(), usesImports: new Set<string>(),
                        };
                        funcs.set(propName, fnEntity);
                        entities.push(fnEntity);
                    }
                    continue;
                }
                const key = `variable:exports.${propName}`;
                const bodyText = normalizeSpace(srcText(right, code));
                const locText = normalizeSpace(srcText(stmt, code));
                if (!entities.find(e => e.key === key)) {
                    const vEntity: EntityRecord = {
                        kind: 'variable',
                        name: `exports.${propName}`,
                        key,
                        signature: `exports.${propName}`,
                        bodyText,
                        locText,
                    };
                    vars.set(`exports.${propName}`, vEntity);
                    entities.push(vEntity);
                }
                continue;
            }

            // 2026-06-09 — `module.exports.X = arrow|function`. CJS-style
            // serverless examples use this near-exclusively. AST shape:
            // left = MemberExpression { object: MemberExpression {
            //   object: 'module', property: 'exports' }, property: 'X' }.
            if (
                left.type === 'MemberExpression' &&
                left.object?.type === 'MemberExpression' &&
                left.object.object?.name === 'module' &&
                left.object.property?.name === 'exports' &&
                left.property?.type === 'Identifier' &&
                right &&
                (right.type === 'ArrowFunctionExpression' || right.type === 'FunctionExpression')
            ) {
                const propName = left.property.name;
                if (!funcs.has(propName)) {
                    const sigText = right.params?.length
                        ? `function ${propName}(${right.params.map((p: any) => srcText(p, code) || '').join(', ')})`
                        : `function ${propName}()`;
                    const fnEntity: EntityRecord = {
                        kind: 'function', name: propName,
                        key: `function:${propName}`,
                        signature: sigText,
                        bodyText: right.body ? normalizeSpace(srcText(right.body, code)) : '',
                        bodySrc: rawFnSrc(srcText(stmt, code)),
                        locText: normalizeSpace(srcText(stmt, code)),
                        node: right,
                        calls: new Set<string>(), usesVars: new Set<string>(), usesImports: new Set<string>(),
                    };
                    funcs.set(propName, fnEntity);
                    entities.push(fnEntity);
                }
                continue;
            }
        }
    }

    // Issue 350: pick up named function expressions and tRPC-style procedure
    // arrows that aren't top-level declarations. Without this:
    //  - `app.all("*", function getReplayResponse(req, res, next) {…})` in
    //    ts-remix's `server.ts` (a named FunctionExpression nested inside
    //    `run()`) has no flow graph
    //  - `healthcheck: publicProcedure.query(({input}) => …)` in tRPC
    //    routers has no flow graph (the arrow is the procedure body)
    traverse(ast, {
        // Issue 409: inline arrow handlers passed directly to
        // `router.METHOD(path, mw?, arrow)` aren't top-level declarations and
        // weren't reaching the entity set. Without an EntityRecord per route,
        // file-hash changes from editing the arrow body produce no L4 modified
        // node, no L5 flow graph, and no L3 modified marker. Synthesize the
        // entity here using the same `anonymous@<METHOD>:<route>` naming
        // convention used by sequence-graph naming + apiDetector so the diff
        // path picks up body edits via bodyText/stableKey.
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            const method = callee.property?.name?.toLowerCase();
            if (!method || !['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'].includes(method)) return;
            const args = p.node.arguments || [];
            if (args.length < 2) return;
            const routeArg = args[0];
            let route = '';
            if (routeArg.type === 'StringLiteral') route = routeArg.value;
            else if (routeArg.type === 'TemplateLiteral' && routeArg.quasis?.length === 1) route = routeArg.quasis[0].value.raw;
            else if (routeArg.type === 'TemplateLiteral') {
                // Issue 414: template-literal route with interpolation
                // (`/random/${index}`). If the enclosing ForStatement binds the
                // single interpolation expression to the loop variable, build
                // the parameterized route `/random/:index` so the diff path
                // tracks the SHARED arrow body once (not N times).
                const forLoop = findEnclosingForLoop(p);
                if (!forLoop) return;
                const loopVar = getForLoopVar(forLoop);
                if (!loopVar) return;
                let paramRoute = '';
                let ok = true;
                for (let i = 0; i < routeArg.quasis.length; i++) {
                    paramRoute += routeArg.quasis[i].value.raw;
                    if (i < routeArg.expressions.length) {
                        const ex = routeArg.expressions[i];
                        if (ex?.type === 'Identifier' && ex.name === loopVar) {
                            paramRoute += `:${loopVar}`;
                        } else {
                            ok = false; break;
                        }
                    }
                }
                if (!ok) return;
                route = paramRoute;
            } else return;
            if (!route.startsWith('/') && route !== '*') return;
            const last = args[args.length - 1];
            if (last?.type !== 'ArrowFunctionExpression' && last?.type !== 'FunctionExpression') return;
            const name = `anonymous@${method.toUpperCase()}:${route}`;
            if (funcs.has(name)) return;
            const isAsync = last.async ? 'async ' : '';
            const bodyText = last.body ? normalizeSpace(srcText(last.body, code)) : '';
            const fnEntity: EntityRecord = {
                kind: 'function',
                name,
                key: `function:${name}`,
                signature: `${isAsync}${method} route handler(${(last.params || []).map((q: any) => q.type === 'Identifier' ? q.name : 'arg').join(', ')})`,
                bodyText,
                // #837/anon — capture the raw, newline-preserving arrow source so
                // the save-time flow-diff reconstruction (syncOrchestrator) uses
                // the real `(req,res)=>{…}` text. Without it, the fallback rebuilt
                // invalid JS from the synthetic `"<method> route handler(...)"`
                // signature, buildDiffMap parse-failed, and body edits to inline
                // anonymous handlers never stamped L5/L3/L2 as modified.
                bodySrc: rawFnSrc(srcText(last, code)),
                locText: normalizeSpace(srcText(last, code)),
                node: last,
                calls: new Set<string>(),
                usesVars: new Set<string>(),
                usesImports: new Set<string>(),
            };
            funcs.set(name, fnEntity);
            entities.push(fnEntity);
        },
        FunctionExpression(p: any) {
            const fn = p.node;
            if (!fn.id?.name) return;
            const name = fn.id.name;
            if (funcs.has(name)) return;
            const isAsync = fn.async ? 'async ' : '';
            funcs.set(name, {
                kind: 'function', name,
                key: `function:${name}`,
                signature: `${isAsync}function ${name}(${getFunctionParamList(fn)})`,
                bodyText: fn.body ? normalizeSpace(srcText(fn.body, code)) : '',
                locText: normalizeSpace(srcText(fn, code)),
                node: fn,
                calls: new Set<string>(), usesVars: new Set<string>(), usesImports: new Set<string>(),
            });
            entities.push(funcs.get(name)!);
        },
        ObjectProperty(p: any) {
            // tRPC: `<name>: <expr>.query(arrow)` or `<name>.mutation(arrow)`.
            const prop = p.node;
            if (!prop.key || prop.key.type !== 'Identifier') return;
            const v = prop.value;
            if (v?.type !== 'CallExpression') return;
            const callee = v.callee;
            if (callee?.type !== 'MemberExpression') return;
            const methodName = callee.property?.name;
            if (methodName !== 'query' && methodName !== 'mutation' && methodName !== 'subscription') return;
            const arg = v.arguments?.[0];
            if (!arg) return;
            if (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') return;
            const name = prop.key.name;
            if (funcs.has(name)) return;
            // Wrap the arrow so buildFlowGraph can parse it standalone.
            const argText = srcText(arg, code);
            const wrappedSignature = `function ${name}() /* tRPC ${methodName} */`;
            funcs.set(name, {
                kind: 'function', name,
                key: `function:${name}`,
                signature: wrappedSignature,
                bodyText: arg.body ? normalizeSpace(srcText(arg.body, code)) : '',
                locText: normalizeSpace(argText),
                node: arg,
                calls: new Set<string>(), usesVars: new Set<string>(), usesImports: new Set<string>(),
            });
            entities.push(funcs.get(name)!);
        },
    });

    // Analyze function dependencies
    const topFuncNames = new Set([...funcs.keys()]);
    const topVarNames = new Set([...vars.keys()]);
    const importLocalNames = new Set([...importsByLocal.keys()]);

    for (const fn of Array.from(funcs.values())) {
        if (!fn.node) continue;
        try {
            const fnCode = srcText(fn.node, code);
            if (!fnCode) continue;
            const fnAst = parseJSAuto(fnCode, fileName);

            traverse(fnAst, {
                CallExpression(path: any) {
                    const c = path.node.callee;
                    if (c.type === 'Identifier' && topFuncNames.has(c.name)) {
                        fn.calls!.add(c.name);
                    }
                    if (c.type === 'Identifier' && importLocalNames.has(c.name)) {
                        fn.usesImports!.add(c.name);
                    }
                    if (
                        c.type === 'MemberExpression' &&
                        c.object?.type === 'Identifier' &&
                        importLocalNames.has(c.object.name)
                    ) {
                        fn.usesImports!.add(c.object.name);
                    }
                },
                Identifier(path: any) {
                    if (path.parent.type === 'FunctionDeclaration' && path.parent.id === path.node) return;
                    if (
                        (path.parent.type === 'VariableDeclarator' && path.parent.id === path.node) ||
                        (path.parent.type === 'FunctionExpression' && path.parent.id === path.node)
                    ) {
                        return;
                    }
                    const n = path.node.name;
                    if (topVarNames.has(n)) fn.usesVars!.add(n);
                    if (importLocalNames.has(n)) fn.usesImports!.add(n);
                },
            });
        } catch (e) {
            // Skip analysis errors for individual functions
        }
    }

    return { entities, funcs, vars, importsByLocal, fileName };
}

/**
 * Multi-language dispatch: detect language from file extension and route to
 * the appropriate parser. Babel for JS/TS (backward compatible), Tree-sitter
 * for everything else.
 *
 * Returns the same FileAnalysis shape so all downstream graph builders work unchanged.
 */
export async function collectEntitiesForFile(
    code: string,
    filePath: string
): Promise<FileAnalysis> {
    const { detectLanguage } = await import('./treeSitterParser');
    const language = detectLanguage(filePath);

    // JS/TS: use existing Babel parser for backward compatibility
    if (!language || language === 'javascript' || language === 'typescript') {
        const fileName = filePath.split('/').pop() ?? filePath;
        return collectTopLevelEntities(code, fileName);
    }

    // All other languages: use Tree-sitter
    const { parseSource } = await import('./treeSitterParser');
    const { extractSymbols } = await import('./treeSitterExtractor');
    const fileName = filePath.split('/').pop() ?? filePath;

    const tree = await parseSource(code, language);
    return extractSymbols(tree, code, language, fileName);
}
