import { parseJSAuto } from '../parser/jsParser';
import { parseJSCached } from '../parser/astCache';
import { collectTopLevelEntities, normalizeSpace, srcText } from '../parser/symbolExtractor';
import { classifyExternalSystem } from '../parser/apiDetector';
import { baseName } from '../navigation/pathUtils';
import type { DiagramGraph, GraphNode, GraphEdge, Anchor, DiffStatus, SequenceMessage, FunctionEntity, ApiRecord } from './graphTypes';
import _traverse from '@babel/traverse';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

/**
 * npm packages that are infrastructure/framework plumbing and should NOT appear
 * as meaningful participants in a sequence diagram.
 */
/**
 * Java/Kotlin package prefixes that are framework/stdlib noise — not real service participants.
 * These are filtered so Spring annotations, Lombok, java.util etc. don't clutter sequence diagrams.
 */
const JAVA_NOISE_PREFIXES = [
    'org.springframework.', 'org.hibernate.', 'org.aspectj.',
    'javax.', 'jakarta.',
    'lombok.',
    'java.', 'sun.', 'com.sun.',
    'com.fasterxml.jackson.', 'com.google.gson.',
    'io.swagger.', 'io.micrometer.', 'io.jsonwebtoken.',
    'org.slf4j.', 'org.apache.',
    // Django routing/config — not data-layer, suppress as participants
    'django.urls', 'django.conf.', 'django.middleware.',
    'django.utils.', 'django.http', 'django.core.',
    'django.contrib.admin', 'django.contrib.auth.',
    'django.views.',
    // DRF framework plumbing
    'rest_framework.views', 'rest_framework.permissions',
    'rest_framework.authentication', 'rest_framework.decorators',
    'rest_framework.generics', 'rest_framework.mixins',
    'rest_framework.viewsets', 'rest_framework.routers',
    'rest_framework.response', 'rest_framework.request',
    'rest_framework.status', 'rest_framework.exceptions',
    'rest_framework.filters', 'rest_framework.pagination',
    'rest_framework.serializers', 'rest_framework.fields',
    'rest_framework.validators', 'rest_framework.renderers',
    'rest_framework.parsers', 'rest_framework.throttling',
    'rest_framework.metadata', 'rest_framework.compat',
    'rest_framework.test', 'rest_framework.utils',
    // Python stdlib noise
    'abc.', 'typing.', 'dataclasses.',
    'logging', 'os',
];

const FRAMEWORK_NOISE = new Set([
    // Web frameworks
    'express', 'fastify', 'koa', 'hapi', 'restify', 'polka', 'connect',
    // HTTP middleware
    'cors', 'helmet', 'morgan', 'body-parser', 'compression', 'cookie-parser',
    'express-session', 'multer', 'express-fileupload', 'express-validator',
    'express-rate-limit', 'express-jwt', 'express-async-handler',
    'passport', 'passport-local', 'passport-jwt',
    // Config/env
    'dotenv', 'config', 'nconf', 'convict',
    // Node built-ins
    'path', 'fs', 'os', 'url', 'util', 'crypto', 'stream', 'events',
    'http', 'https', 'net', 'child_process', 'buffer', 'assert', 'zlib',
    'querystring', 'readline', 'timers',
    // General utilities (not services)
    'lodash', 'underscore', 'ramda', 'moment', 'dayjs', 'date-fns',
    // Logging (not external services)
    'winston', 'pino', 'bunyan', 'log4js', 'debug', 'chalk',
    // Validation
    'joi', 'yup', 'zod', 'ajv', 'validator',
    // Router helpers
    'express-router', 'router',
]);

function isFrameworkNoise(importPath: string): boolean {
    if (importPath.startsWith('.') || importPath.startsWith('/')) return false;
    const pkgName = importPath.startsWith('@')
        ? importPath.split('/').slice(0, 2).join('/')
        : importPath.split('/')[0];
    if (FRAMEWORK_NOISE.has(pkgName)) return true;
    // Java/Kotlin: filter known framework/stdlib dot-separated package prefixes
    return JAVA_NOISE_PREFIXES.some(p => importPath.startsWith(p));
}

/**
 * Shorten a fully-qualified dot-separated name to just the class name (last segment).
 * e.g. "com.example.utils.MyClass" → "MyClass"
 *      "org.springframework.data.jpa.repository.JpaRepository" → "JpaRepository"
 */
export function shortenQualifiedName(name: string): string {
    if (!name.includes('.')) return name;
    return name.split('.').pop()!;
}

let idCounter = 0;

/** #203 — read sequence-traversal depth from VS Code config; default 8. */
function getSequenceTraversalDepth(): number {
    try {
        // require to dodge a hard import on `vscode` in non-extension contexts (tests, MCP CLI).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode: any = require('vscode');
        const cfg = vscode?.workspace?.getConfiguration?.('codeatlas');
        const val = cfg?.get?.('sequenceTraversalDepth', 8);
        return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : 8;
    } catch {
        return 8;
    }
}
function nextId(prefix: string = 'node'): string {
    return `${prefix}_${++idCounter}`;
}
function resetIds(): void {
    idCounter = 0;
}

/**
 * Built-in objects whose method calls should NEVER create sequence participants.
 * Any call like `console.log()`, `JSON.parse()`, `Math.floor()` is filtered entirely.
 */
const NOISE_RECEIVERS = new Set([
    'console', 'JSON', 'Math', 'Object', 'Array', 'Date', 'Promise', 'Error',
    'Number', 'String', 'Boolean', 'RegExp', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Reflect', 'Proxy', 'Intl', 'Buffer', 'process', 'global', 'globalThis', 'window',
    'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
]);

/**
 * BUG-POLAR-4: framework dependency-injection markers (FastAPI `Depends`/`Query`/
 * `Path`/…). A `Depends(get_session)` in a handler signature is DI wiring resolved
 * BEFORE the body runs — not a runtime call to a participant — so emitting it as a
 * sequence message clutters the diagram and mis-orders the flow. Raised exception
 * constructors (PascalCase `*Error`/`*Exception`) are likewise conditional error
 * branches, not linear happy-path calls; both are filtered from sequence messages.
 */
const DI_MARKER_CALLS = new Set([
    'Depends', 'Query', 'Path', 'Body', 'Header', 'Cookie', 'Form', 'File', 'Security',
]);

/**
 * BUG-POLAR-18: domain exception constructors that DON'T end in Error/Exception
 * (e.g. `ResourceNotFound`, `PaymentMethodInUseByActiveSubscription`,
 * `CustomerNotReady`) were leaking into sequences as linear happy-path messages.
 * The ideal signal is `raise X(...)` context, but the analysis doesn't yet
 * capture raised calls, so this is a name-shape heuristic for exception-like
 * PascalCase names — intentionally conservative to avoid filtering real classes.
 * (Follow-up: capture raise context in the extractor and prefer it over names.)
 */
const EXCEPTION_NAME_RE = /^[A-Z][A-Za-z0-9_]*(?:Error|Exception|NotFound|NotReady|NotAllowed|NotAvailable|NotValid|Denied|Forbidden|Unauthorized|Conflict|AlreadyExists|Expired|Unavailable|TooManyRequests|BadRequest)$/;
const EXCEPTION_SUBSTR_RE = /(?:InUseBy|AlreadyExists|NotFoundBy|NotAllowedFor)/;

export function isSequenceNoiseCall(bareName: string): boolean {
    if (!bareName) return false;
    if (DI_MARKER_CALLS.has(bareName)) return true;
    if (EXCEPTION_NAME_RE.test(bareName)) return true;
    // Compound domain-exception names (`PaymentMethodInUseByActiveSubscription`).
    if (/^[A-Z]/.test(bareName) && EXCEPTION_SUBSTR_RE.test(bareName)) return true;
    return false;
}

/**
 * Built-in array/object/promise methods that should NOT create sequence participants.
 * These are data transformations, not service calls.
 */
const NOISE_METHODS = new Set([
    'map', 'filter', 'find', 'findIndex', 'some', 'every', 'reduce', 'reduceRight',
    'forEach', 'flatMap', 'flat', 'includes', 'indexOf', 'lastIndexOf',
    'sort', 'reverse', 'slice', 'splice', 'concat', 'join', 'split',
    'push', 'pop', 'shift', 'unshift', 'fill', 'copyWithin',
    'keys', 'values', 'entries', 'from', 'of', 'isArray',
    'toString', 'valueOf', 'toLocaleString', 'toFixed', 'toPrecision',
    'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'allSettled', 'race', 'any',
    'parse', 'stringify', 'assign', 'freeze', 'keys', 'values', 'entries',
    'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
    'charAt', 'charCodeAt', 'codePointAt', 'normalize', 'padStart', 'padEnd',
    'repeat', 'replace', 'replaceAll', 'search', 'match', 'matchAll',
    'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd',
    'toLowerCase', 'toUpperCase', 'localeCompare', 'substring', 'substr',
    'log', 'warn', 'error', 'info', 'debug', 'trace', 'dir', 'table',
    'assert', 'clear', 'count', 'countReset', 'group', 'groupEnd', 'time', 'timeEnd',
    'now', 'getTime', 'toISOString', 'toJSON',
    'emit', 'on', 'off', 'once', 'removeListener', 'removeAllListeners',
    'pipe', 'write', 'end', 'destroy', 'read',
    'status', 'json', 'send', 'end', 'redirect', 'render', 'sendFile', 'sendStatus',
    'set', 'get', 'header', 'type', 'cookie', 'clearCookie',
    'next',
]);

/**
 * Extract a short argument summary from a raw call expression.
 * e.g., `db.query('SELECT * FROM users WHERE id = $1', [id])` → `db.query(SELECT..., [id])`
 * Truncates each arg to keep the label concise.
 */
function enrichLabelWithArgs(label: string, raw: string): string {
    if (!raw || !raw.includes('(')) return label;
    // Extract args between first ( and last )
    const openParen = raw.indexOf('(');
    const closeParen = raw.lastIndexOf(')');
    if (openParen < 0 || closeParen <= openParen) return label;
    const argsText = raw.slice(openParen + 1, closeParen).trim();
    if (!argsText) return label;
    // Split args by top-level commas (skip nested parens/brackets)
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of argsText) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) args.push(current.trim());
    // Truncate each arg
    const shortArgs = args.map(a => {
        const clean = a.replace(/\s+/g, ' ').replace(/^['"`]|['"`]$/g, '');
        return clean.length > 20 ? clean.slice(0, 17) + '...' : clean;
    }).join(', ');
    // Replace the () in the label with (args)
    const baseName = label.replace(/\(\)$/, '');
    return `${baseName}(${shortArgs})`;
}

interface Participant {
    key: string;
    name: string;
    kind: string;
    signature: string;
    raw: string;
}

interface FileModel {
    code: string;
    functions: Map<string, FunctionEntity>;
    topVars: Map<string, { name: string; raw: string }>;
    participants: Participant[];
    participantAliases: Map<string, string>;
    chosenEntries: FunctionEntity[];
    importsByLocal?: Map<string, string>;
    routeHandlers?: string[];
}

function isApiHandlerName(name: string): boolean {
    // Issue 178: Tightened regex — require explicit handler/controller/route patterns
    // or exact Next.js data-fetching names. Avoid matching utility functions like
    // getUserProfile, postMessage, createStore, fetchTheme.
    const n = name || '';
    // Exact matches for known entry point names.
    // Issue 343: Remix `loader` / `action` exports are file-based route handlers.
    // Issue 339: Rails resource actions (index/show/new/create/edit/update/destroy)
    // are conventional handler names referenced from `resources :foo`. Without
    // them in the entry-function set, sequence graphs for Rails routes fall
    // back to top-5 utility functions and emit 0 nodes.
    if (/^(handler|route|routes|controller|middleware|loader|action|index|show|new|create|edit|update|destroy|getServerSideProps|getStaticProps|getStaticPaths)$/i.test(n)) return true;
    // Patterns that end with Handler/Controller/Route/Middleware
    if (/(?:Handler|Controller|Route|Middleware|Endpoint)$/i.test(n)) return true;
    // Issue 407: synthetic names produced for inline arrow / function expression
    // handlers passed directly to `router.METHOD(path, ..., handler)`. Without
    // matching these, anonymous handlers don't reach `entryFunctions`, the
    // top-5 fallback fires, and the per-handler filter at the seq-graph entry
    // point falls back to the universe — yielding 30+ cross-route edges in a
    // single-route graph.
    if (/^anonymous@/i.test(n)) return true;
    // Issue 407: cross-file delegators synthesised by collectMultiFileModel for
    // imported handlers (e.g. `route:addTodo`) — also legitimate entry points.
    if (/^route:/i.test(n)) return true;
    // Bare HTTP method names (standalone, not as prefix like getUser).
    // Issue 345: ASP.NET / typed C# controllers expose methods named `Get`,
    // `Post` etc. directly on a class. The class-method extraction surfaces
    // them as `ClassName.Get` etc.; matching the bare verb makes them
    // discoverable as entry points.
    if (/^(get|post|put|patch|delete|head|options)$/i.test(n)) return true;
    // Contains "api" as a word boundary
    if (/\bapi\b/i.test(n)) return true;
    return false;
}

/**
 * Extract the variable name a call result is assigned to.
 * e.g. `const result = await svc.list()` → 'result'
 *      `res.json(data)` → undefined (no assignment)
 */
/**
 * Issue 414: walk up a Babel traversal path to find the enclosing ForStatement
 * (returns the ForStatement node, not the path).
 */
function findEnclosingForLoopRaw(p: any): any | null {
    let cur = p?.parentPath;
    while (cur) {
        if (cur.node?.type === 'ForStatement') return cur.node;
        cur = cur.parentPath;
    }
    return null;
}

function getAssignedVarName(path: any): string | undefined {
    const parent = path.parentPath?.node ?? path.parent;
    if (!parent) return undefined;
    // const x = await call() → AwaitExpression → VariableDeclarator
    // const x = call() → VariableDeclarator
    let assignTarget = parent;
    if (assignTarget.type === 'AwaitExpression') {
        assignTarget = path.parentPath?.parentPath?.node ?? assignTarget;
    }
    if (assignTarget.type === 'VariableDeclarator' && assignTarget.id?.type === 'Identifier') {
        return assignTarget.id.name;
    }
    // x = call() → AssignmentExpression
    if (assignTarget.type === 'AssignmentExpression' && assignTarget.left?.type === 'Identifier') {
        return assignTarget.left.name;
    }
    // return call() → implies return value
    if (assignTarget.type === 'ReturnStatement') {
        return 'result';
    }
    return undefined;
}

function methodNameFromMemberExpression(member: any, source: string): string {
    if (!member || member.type !== 'MemberExpression') return '';
    if (member.property?.type === 'Identifier') return member.property.name;
    if (member.property?.type === 'StringLiteral') return member.property.value;
    return normalizeSpace(srcText(member.property, source));
}

/**
 * Collect a file-level model with participants, functions, and their call relationships.
 */
function collectTopLevelFileModel(code: string, filePath?: string): FileModel & { importsByLocal: Map<string, string>, routeHandlers: string[] } {
    // INVARIANT (ADR-022): full-file parses route through the AST cache.
    const ast = parseJSCached(code, filePath);
    const body = ast.program.body || [];

    const statements: any[] = [];
    for (const stmt of body) {
        if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
            statements.push(stmt.declaration);
        } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration) {
            if (stmt.declaration.type === 'FunctionDeclaration') statements.push(stmt.declaration);
            else statements.push(stmt);
        } else {
            statements.push(stmt);
        }
    }

    const importsByLocal = new Map<string, string>();
    const topVars = new Map<string, { name: string; raw: string }>();
    const functions = new Map<string, FunctionEntity>();
    const participantAliases = new Map<string, string>();
    const participants: Participant[] = [];
    const routeHandlers: string[] = [];

    for (const stmt of statements) {
        if (stmt.type === 'ImportDeclaration') {
            const sourcePath = stmt.source?.value || '';
            const kind = classifyExternalSystem(sourcePath);
            const specs = stmt.specifiers || [];
            for (const s of specs) {
                const local = (s as any).local?.name;
                if (local) importsByLocal.set(local, sourcePath);
            }
            // Skip framework/plumbing packages — they aren't meaningful sequence participants
            if (isFrameworkNoise(sourcePath)) continue;
            const key = `participant:import:${sourcePath}`;
            if (!participants.find((p) => p.key === key)) {
                participants.push({
                    key,
                    name: sourcePath,
                    kind,
                    signature: normalizeSpace(srcText(stmt, code)),
                    raw: normalizeSpace(srcText(stmt, code)),
                });
            }
            continue;
        }

        if (stmt.type === 'VariableDeclaration') {
            for (const d of (stmt as any).declarations || []) {
                // Handle destructured CommonJS require before skipping non-Identifier ids
                // e.g. const { addTodo, listTodos } = require('./todoController')
                if (d.id?.type === 'ObjectPattern' && d.init?.type === 'CallExpression' && d.init.callee?.type === 'Identifier' && d.init.callee.name === 'require' && d.init.arguments?.[0]?.type === 'StringLiteral') {
                    const reqPath = d.init.arguments[0].value;
                    for (const prop of d.id.properties) {
                        if (prop.value?.type === 'Identifier') {
                            importsByLocal.set(prop.value.name, reqPath);
                        } else if (prop.key?.type === 'Identifier' && !prop.value) {
                            // shorthand: const { addTodo } = require(...)
                            importsByLocal.set(prop.key.name, reqPath);
                        }
                    }
                    // Skip framework/plumbing packages
                    if (!isFrameworkNoise(reqPath)) {
                        const key = `participant:import:${reqPath}`;
                        if (!participants.find((p) => p.key === key)) {
                            participants.push({
                                key,
                                name: reqPath,
                                kind: classifyExternalSystem(reqPath),
                                signature: `require("${reqPath}")`,
                                raw: `const {...} = require("${reqPath}")`,
                            });
                        }
                    }
                    continue;
                }

                if (d.id?.type !== 'Identifier') continue;
                const name = d.id.name;

                // Direct: `const X = () => {}` / `const X = function() {}`.
                // Wrapped HOC: `const X = catchAsync(fn)` / `const X = asyncHandler(fn)` —
                // unwrap so Express controllers (and similar HOC patterns) are recognized
                // as first-class entries by the sequence-graph entry-handler matcher.
                let fnInit: any = null;
                if (d.init && (d.init.type === 'ArrowFunctionExpression' || d.init.type === 'FunctionExpression')) {
                    fnInit = d.init;
                } else if (
                    d.init && d.init.type === 'CallExpression' &&
                    Array.isArray(d.init.arguments) && d.init.arguments.length > 0
                ) {
                    const firstArg = d.init.arguments[0];
                    if (firstArg && (firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression')) {
                        fnInit = firstArg;
                    }
                }

                if (fnInit) {
                    const fnNode = { ...fnInit, id: d.id };
                    const isAsync = fnNode.async ? 'async ' : '';
                    const fnEntity: FunctionEntity = {
                        key: `function:${name}`,
                        name,
                        node: fnNode,
                        signature: `${isAsync}function ${name}(${(fnNode.params || []).map((p: any) => p.type === 'Identifier' ? p.name : 'arg').join(', ')})`,
                        bodyText: normalizeSpace(srcText(fnInit.body, code)),
                        raw: normalizeSpace(srcText(d, code)),
                        filePath,
                        calls: [],
                    };
                    functions.set(name, fnEntity);
                } else {
                    const vText = normalizeSpace(srcText(d, code));
                    if (d.id.type === 'Identifier') {
                        topVars.set(name, { name, raw: vText });
                    }

                    // CommonJS require
                    if (d.init?.type === 'CallExpression' && d.init.callee?.type === 'Identifier' && d.init.callee.name === 'require' && d.init.arguments?.[0]?.type === 'StringLiteral') {
                        const reqPath = d.init.arguments[0].value;

                        if (d.id.type === 'Identifier') {
                            importsByLocal.set(name, reqPath);
                        } else if (d.id.type === 'ObjectPattern') {
                            for (const prop of d.id.properties) {
                                if (prop.value?.type === 'Identifier') {
                                    importsByLocal.set(prop.value.name, reqPath);
                                }
                            }
                        }

                        // Skip framework/plumbing packages
                        if (isFrameworkNoise(reqPath)) continue;
                        const key = `participant:import:${reqPath}`;
                        if (!participants.find((p) => p.key === key)) {
                            participants.push({
                                key,
                                name: reqPath,
                                kind: classifyExternalSystem(reqPath),
                                signature: `require("${reqPath}")`,
                                raw: `const ${d.id.type === 'Identifier' ? name : '{...}'} = require("${reqPath}")`,
                            });
                        }
                    }

                    // Heuristic external clients
                    const lname = name.toLowerCase();
                    if (/(db|database|repo|redis|cache|client|s3|bucket|storage|queue|producer|consumer)/.test(lname)) {
                        const pKind = lname.includes('redis') || lname.includes('cache')
                            ? 'cache'
                            : lname.includes('s3') || lname.includes('bucket') || lname.includes('storage')
                                ? 'storage'
                                : lname.includes('db') || lname.includes('repo') || lname.includes('database')
                                    ? 'database'
                                    : 'service';
                        const key = `participant:var:${name}`;
                        if (!participants.find((p) => p.key === key)) {
                            participants.push({ key, name, kind: pKind, signature: vText, raw: vText });
                            participantAliases.set(name, key);
                        }
                    }
                }
            }
            continue;
        }

        if (stmt.type === 'ExpressionStatement') {
            const exp = (stmt as any).expression;
            if (exp?.type === 'AssignmentExpression' && exp.left?.type === 'MemberExpression') {
                const left = exp.left;
                const isExports = (left.object?.type === 'Identifier' && left.object.name === 'exports') ||
                    (left.object?.type === 'MemberExpression' && left.object.object?.name === 'module' && left.object.property?.name === 'exports');

                if (isExports && left.property?.type === 'Identifier') {
                    const name = left.property.name;
                    if (exp.right?.type === 'ArrowFunctionExpression' || exp.right?.type === 'FunctionExpression') {
                        const isAsync = exp.right.async ? 'async ' : '';
                        const fnEntity: FunctionEntity = {
                            key: `function:${name}`,
                            name,
                            node: exp.right,
                            signature: `${isAsync}function ${name}(${(exp.right.params || []).map((p: any) => p.type === 'Identifier' ? p.name : 'arg').join(', ')})`,
                            bodyText: normalizeSpace(srcText(exp.right.body, code)),
                            raw: normalizeSpace(srcText(stmt, code)),
                            filePath,
                            calls: [],
                        };
                        functions.set(name, fnEntity);
                    }
                }
            }
            continue;
        }

        if (stmt.type === 'FunctionDeclaration' && (stmt as any).id?.name) {
            const name = (stmt as any).id.name;
            const isAsync = (stmt as any).async ? 'async ' : '';
            const fnEntity: FunctionEntity = {
                key: `function:${name}`,
                name,
                node: stmt,
                signature: `${isAsync}function ${name}(${(stmt.params || []).map((p: any) => p.type === 'Identifier' ? p.name : 'arg').join(', ')})`,
                bodyText: normalizeSpace(srcText((stmt as any).body, code)),
                raw: normalizeSpace(srcText(stmt, code)),
                filePath,
                calls: [],
            };
            functions.set(name, fnEntity);
            continue;
        }

        // Issue 263 follow-up: NestJS controllers register routes via class
        // methods. Without this, the sequence builder's `functions` map is
        // empty for controller files and every sequence graph for those files
        // ends up participant-only.
        if (stmt.type === 'ClassDeclaration' && (stmt as any).id?.name) {
            const className = (stmt as any).id.name;
            for (const m of (stmt as any).body?.body ?? []) {
                if (m.type !== 'ClassMethod' && m.type !== 'ClassPrivateMethod') continue;
                if (!m.key || m.key.type !== 'Identifier') continue;
                const methodName = m.key.name;
                const qname = `${className}.${methodName}`;
                const isAsync = m.async ? 'async ' : '';
                const params = (m.params || []).map((p: any) => p.type === 'Identifier' ? p.name : 'arg').join(', ');
                const fnEntity: FunctionEntity = {
                    key: `function:${qname}`,
                    name: qname,
                    node: m,
                    signature: `${isAsync}${methodName}(${params})`,
                    bodyText: m.body ? normalizeSpace(srcText(m.body, code)) : '',
                    raw: normalizeSpace(srcText(m, code)),
                    filePath,
                    calls: [],
                };
                functions.set(qname, fnEntity);
                // Also expose under the bare method name so detected handler names
                // (which are bare like "findAll") match without needing the prefix.
                if (!functions.has(methodName)) functions.set(methodName, fnEntity);
            }
            continue;
        }
    }

    // Link imported aliases to participants
    for (const [local, sourcePath] of importsByLocal.entries()) {
        participantAliases.set(local, `participant:import:${sourcePath}`);
    }

    // Also look for inline functions used as API handlers (e.g. app.get(..., (req, res) => {}))
    const anonCounts: Record<string, number> = {};
    traverse(ast, {
        CallExpression(path: any) {
            const callee = path.node.callee;
            if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
                const method = callee.property.name.toLowerCase();
                if (['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(method)) {
                    const args = path.node.arguments || [];
                    const lastArg = args[args.length - 1];
                    if (lastArg) {
                        if (lastArg.type === 'Identifier') {
                            routeHandlers.push(lastArg.name);
                        } else if (lastArg.type === 'MemberExpression' && lastArg.property?.type === 'Identifier') {
                            routeHandlers.push(lastArg.property.name);
                            if (lastArg.object?.type === 'Identifier') {
                                // Also track the base object (e.g. todoController) so imports can be matched
                                routeHandlers.push(lastArg.object.name);
                            }
                        } else if (lastArg.type === 'ArrowFunctionExpression' || lastArg.type === 'FunctionExpression') {
                            // Name using route path (matches apiDetector.ts convention: anonymous@/route)
                            const routeArg = args[0];
                            let route = '';
                            if (routeArg?.type === 'StringLiteral') route = routeArg.value;
                            else if (routeArg?.type === 'TemplateLiteral' && routeArg.quasis?.length === 1) route = routeArg.quasis[0].value.raw;
                            else if (routeArg?.type === 'TemplateLiteral') {
                                // Issue 414: parameterized route inside a for-loop. Mirror
                                // the symbolExtractor + apiDetector behaviour — substitute
                                // the loop variable as `:<loopVar>` so the synthesized
                                // function name matches the ApiRecord's handlerName and
                                // the per-handler filter narrows to the right entry.
                                const forLoop = findEnclosingForLoopRaw(path);
                                const loopVar = forLoop && forLoop.init?.type === 'VariableDeclaration' && forLoop.init.declarations?.[0]?.id?.type === 'Identifier'
                                    ? forLoop.init.declarations[0].id.name
                                    : null;
                                if (loopVar) {
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
                                    if (ok) route = paramRoute;
                                }
                            }
                            anonCounts[method] = (anonCounts[method] || 0) + 1;
                            const name = route ? `anonymous@${method.toUpperCase()}:${route}` : `anonymous_${method}_${anonCounts[method]}`;
                            if (!functions.has(name)) {
                                const paramsText = (lastArg.params || []).map((p: any) => p.type === 'Identifier' ? p.name : 'arg').join(', ');
                                const isAsync = lastArg.async ? 'async ' : '';
                                const fnEntity: FunctionEntity = {
                                    key: `function:${name}`,
                                    name,
                                    node: lastArg,
                                    signature: `${isAsync}${method} route handler(${paramsText})`,
                                    bodyText: normalizeSpace(srcText(lastArg.body, code)),
                                    raw: normalizeSpace(srcText(lastArg, code)),
                                    filePath,
                                    calls: [],
                                };
                                functions.set(name, fnEntity);
                            }
                        }
                    } // close if (lastArg)
                }

                // Issue 263 follow-up — meta-framework wrappers:
                //   `defineEventHandler(arrow)` (Nuxt)
                //   `eventHandler(arrow)` (h3)
                //   `<obj>.query(arrow)` / `.mutation(arrow)` (tRPC)
                // The api detector emits handlerName matching the wrapper name
                // (Nuxt: "defineEventHandler") or the property name (tRPC: "list").
                // Synthesize a FunctionEntity under that name so cross-file
                // resolution can find the handler body.
                const wrapperName = (callee.property as any).name;
                if (
                    callee.type === 'MemberExpression' &&
                    (wrapperName === 'query' || wrapperName === 'mutation' || wrapperName === 'subscription')
                ) {
                    const args = path.node.arguments || [];
                    const cb = args[args.length - 1];
                    if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')) {
                        // Walk up to find the property's key in an object literal
                        // (e.g. `posts: publicProcedure.query(arrow)` → key "posts").
                        let p: any = path;
                        let propKey: string | null = null;
                        while (p && !propKey) {
                            if (p.node?.type === 'ObjectProperty' && p.node.key?.type === 'Identifier') {
                                propKey = p.node.key.name;
                                break;
                            }
                            p = p.parentPath;
                        }
                        if (propKey && !functions.has(propKey)) {
                            const isAsync = cb.async ? 'async ' : '';
                            const fnEntity: FunctionEntity = {
                                key: `function:${propKey}`,
                                name: propKey,
                                node: cb,
                                signature: `${isAsync}${propKey}(${(cb.params || []).map((q: any) => q.type === 'Identifier' ? q.name : 'arg').join(', ')})`,
                                bodyText: cb.body ? normalizeSpace(srcText(cb.body, code)) : '',
                                raw: normalizeSpace(srcText(cb, code)),
                                filePath,
                                calls: [],
                            };
                            functions.set(propKey, fnEntity);
                        }
                    }
                }
            }
            // Bare-call wrappers like `defineEventHandler(arrow)` / `eventHandler(arrow)`
            if (
                callee.type === 'Identifier' &&
                (callee.name === 'defineEventHandler' || callee.name === 'eventHandler' || callee.name === 'createEventHandler')
            ) {
                const args = path.node.arguments || [];
                const cb = args[args.length - 1];
                if (cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression')) {
                    const wrapperName = callee.name;
                    if (!functions.has(wrapperName)) {
                        const isAsync = cb.async ? 'async ' : '';
                        const fnEntity: FunctionEntity = {
                            key: `function:${wrapperName}`,
                            name: wrapperName,
                            node: cb,
                            signature: `${isAsync}${wrapperName}(${(cb.params || []).map((q: any) => q.type === 'Identifier' ? q.name : 'arg').join(', ')})`,
                            bodyText: cb.body ? normalizeSpace(srcText(cb.body, code)) : '',
                            raw: normalizeSpace(srcText(cb, code)),
                            filePath,
                            calls: [],
                        };
                        functions.set(wrapperName, fnEntity);
                    }
                }
            }
        }
    });

    // Analyze function-level calls
    const topFunctionNames = new Set([...functions.keys()]);
    const topVarNames = new Set([...topVars.keys()]);

    for (const fn of functions.values()) {
        let fnSource = srcText(fn.node, code);
        if (!fnSource) continue;
        if (fn.node.type === 'ArrowFunctionExpression' || fn.node.type === 'FunctionExpression') {
            fnSource = `(${fnSource})`;
        }
        try {
            const fnAst = parseJSAuto(fnSource, filePath);
            const messages: SequenceMessage[] = [];

            traverse(fnAst, {
                CallExpression(path: any) {
                    const n = path.node;
                    const callText = normalizeSpace(srcText(n, fnSource));
                    const callee = n.callee;
                    const assignedVar = getAssignedVarName(path);

                    // BUG-POLAR-4: skip FastAPI DI markers + raised exception
                    // constructors — they're not real runtime calls to participants.
                    if (callee.type === 'Identifier' && isSequenceNoiseCall(callee.name)) return;

                    // Helper: push forward call + optional return message
                    function pushWithReturn(msg: SequenceMessage) {
                        messages.push(msg);
                        if (assignedVar) {
                            messages.push({
                                from: msg.to ?? '', to: msg.from,
                                fromParticipantKey: msg.toParticipantKey,
                                label: assignedVar,
                                raw: assignedVar, category: msg.category,
                                isReturn: true, returnLabel: assignedVar,
                            });
                        }
                    }

                    // Direct top-level function call
                    if (callee.type === 'Identifier' && topFunctionNames.has(callee.name)) {
                        pushWithReturn({
                            from: fn.name, to: callee.name, label: enrichLabelWithArgs(`${callee.name}()`, callText),
                            raw: callText, category: 'internal',
                        });
                        return;
                    }

                    // Imported alias direct call
                    if (callee.type === 'Identifier' && participantAliases.has(callee.name)) {
                        pushWithReturn({
                            from: fn.name, toParticipantKey: participantAliases.get(callee.name),
                            label: enrichLabelWithArgs(`${callee.name}()`, callText), raw: callText, category: 'external',
                        });
                        return;
                    }

                    // Member calls: x.y()
                    if (callee.type === 'MemberExpression') {
                        const obj = callee.object;
                        const method = methodNameFromMemberExpression(callee, fnSource);

                        // Determine the receiver name for filtering (handles both simple and nested)
                        const receiverName = obj?.type === 'Identifier' ? obj.name
                            : (obj?.type === 'MemberExpression' && obj.object?.type === 'Identifier') ? obj.object.name
                            : '';

                        // Skip calls on built-in objects (console, JSON, Math, etc.)
                        if (NOISE_RECEIVERS.has(receiverName)) return;

                        // Skip built-in array/object/promise methods — but only when the
                        // receiver is NOT an imported module or known variable (those are real service calls)
                        if (NOISE_METHODS.has(method)) {
                            const isKnownReceiver = participantAliases.has(receiverName) || topVarNames.has(receiverName);
                            if (!isKnownReceiver) return;
                        }

                        if (obj?.type === 'Identifier') {
                            if (participantAliases.has(obj.name)) {
                                pushWithReturn({
                                    from: fn.name, toParticipantKey: participantAliases.get(obj.name),
                                    label: enrichLabelWithArgs(`${obj.name}.${method}()`, callText), raw: callText, category: 'external',
                                });
                                return;
                            }

                            if (topVarNames.has(obj.name)) {
                                const lname = obj.name.toLowerCase();
                                if (/(db|database|repo|redis|cache|client|s3|bucket|storage|queue|producer|consumer)/.test(lname)) {
                                    const pKey = participantAliases.get(obj.name) || `participant:var:${obj.name}`;
                                    participantAliases.set(obj.name, pKey);
                                    pushWithReturn({
                                        from: fn.name, toParticipantKey: pKey,
                                        label: enrichLabelWithArgs(`${obj.name}.${method}()`, callText), raw: callText, category: 'external',
                                    });
                                    return;
                                }
                            }
                        }

                        // Nested: ctx.db.query()
                        if (obj?.type === 'MemberExpression' && obj.object?.type === 'Identifier') {
                            const root = obj.object.name;
                            const mid = methodNameFromMemberExpression(obj, fnSource);
                            const pseudoName = `${root}.${mid}`;
                            const pseudoKey = `participant:pseudo:${pseudoName}`;
                            pushWithReturn({
                                from: fn.name, toParticipantKey: pseudoKey,
                                label: enrichLabelWithArgs(`${pseudoName}.${method}()`, callText), raw: callText, category: 'external',
                                pseudoKind: /(db|repo)/i.test(pseudoName) ? 'database' : /(redis|cache)/i.test(pseudoName) ? 'cache' : /(s3|storage|bucket)/i.test(pseudoName) ? 'storage' : 'service',
                                pseudoName,
                            });
                            return;
                        }
                    }

                    // Issue 212: Detect external HTTP calls — fetch, axios, http, got, superagent, request
                    const EXTERNAL_HTTP_CALLS = new Set(['fetch']);
                    const EXTERNAL_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
                    if (callee.type === 'Identifier' && EXTERNAL_HTTP_CALLS.has(callee.name) && n.arguments?.length) {
                        const argText = normalizeSpace(srcText(n.arguments[0], fnSource));
                        messages.push({
                            from: fn.name, toParticipantKey: 'participant:external:http',
                            label: `${callee.name}(${argText})`, raw: callText, category: 'external',
                            pseudoKind: 'service', pseudoName: 'external-http',
                        });
                    }
                    // axios.get(), http.post(), got(), superagent.get()
                    if (callee.type === 'MemberExpression' && callee.property?.type === 'Identifier' &&
                        EXTERNAL_HTTP_METHODS.has(callee.property.name) && n.arguments?.length) {
                        const objName = callee.object?.type === 'Identifier' ? callee.object.name : '';
                        if (['axios', 'http', 'https', 'got', 'superagent', 'request', 'ky'].includes(objName)) {
                            const argText = normalizeSpace(srcText(n.arguments[0], fnSource));
                            messages.push({
                                from: fn.name, toParticipantKey: `participant:external:${objName}`,
                                label: `${objName}.${callee.property.name}(${argText})`, raw: callText, category: 'external',
                                pseudoKind: 'service', pseudoName: objName,
                            });
                        }
                    }
                },
            });

            fn.calls = messages;
        } catch {
            // Skip analysis errors
        }
    }

    const entryFunctions = [...functions.values()].filter((f) => isApiHandlerName(f.name));
    const chosenEntries = entryFunctions.length ? entryFunctions : [...functions.values()].slice(0, 5);

    return { code, functions, topVars, participants, participantAliases, chosenEntries, importsByLocal, routeHandlers };
}

interface SequenceData {
    participants: Participant[];
    internalFunctions: FunctionEntity[];
    messages: Array<{
        fromSpecial?: string;
        fromFn?: string;
        fromFile?: string;
        toFn?: string;
        toFile?: string;
        toParticipantKey?: string;
        label: string;
        raw: string;
        styleKind: string;
        key: string;
        isReturn?: boolean;
        returnLabel?: string;
    }>;
}

/**
 * Build flat sequence messages from the file model
 */

/**
 * Build a multi-file model by traversing imports from a root file.
 * Resolves cross-file dependencies up to 5 levels deep.
 *
 * @param rootCode - Source code of the entry file
 * @param rootFilePath - Workspace-relative path of the entry file
 * @param resolver - Optional function to resolve import paths to source code
 * @returns Merged FileModel containing all participants and messages across files
 */
export function collectMultiFileModel(rootCode: string, rootFilePath: string, resolver?: FileResolver): FileModel {
    const visited = new Set<string>();
    const models: FileModel[] = [];

    function traverseFile(fileCode: string, filePath: string, depth: number) {
        // #203: depth limit lifted from a hardcoded 8 to the user's
        // `codeatlas.sequenceTraversalDepth` setting (default 8). Read on
        // every call rather than cached so a config change takes effect
        // without a reload — sequence graphs rebuild incrementally anyway.
        if (visited.has(filePath) || depth > getSequenceTraversalDepth()) return;
        visited.add(filePath);

        const model = collectTopLevelFileModel(fileCode, filePath);
        models.push(model);

        if (resolver) {
            // Find external calls to imported modules and resolve them
            const importedPaths = new Set<string>();
            for (const fn of model.functions.values()) {
                for (const call of fn.calls) {
                    if (call.category === 'external' && call.toParticipantKey?.startsWith('participant:import:')) {
                        const sourcePath = call.toParticipantKey.split(':').slice(2).join(':');
                        if (sourcePath) importedPaths.add(sourcePath);
                    }
                }
            }

            // Also traverse imports matching our routing identifiers
            for (const [alias, sourcePath] of model.importsByLocal || []) {
                importedPaths.add(sourcePath);
            }

            for (const sourcePath of importedPaths) {
                const resolved = resolver(sourcePath, filePath);
                if (resolved && !visited.has(resolved.filePath)) {
                    traverseFile(resolved.code, resolved.filePath, depth + 1);
                }
            }
        }
    }

    traverseFile(rootCode, rootFilePath, 0);

    // Merge models
    const merged: FileModel = {
        code: rootCode,
        functions: new Map(),
        topVars: new Map(),
        participants: [],
        participantAliases: new Map(),
        chosenEntries: models[0]?.chosenEntries || [],
        importsByLocal: new Map()
    };

    const participantKeys = new Set<string>();

    for (const m of models) {
        for (const [k, v] of m.functions.entries()) merged.functions.set(k, v);
        for (const [k, v] of m.topVars.entries()) merged.topVars.set(k, v);
        for (const p of m.participants) {
            if (!participantKeys.has(p.key)) {
                participantKeys.add(p.key);
                merged.participants.push(p);
            }
        }
        for (const [k, v] of m.participantAliases.entries()) merged.participantAliases.set(k, v);
        for (const [k, v] of (m.importsByLocal || new Map()).entries()) merged.importsByLocal!.set(k, v);
    }

    // Now convert external calls that resolve to our merged internal functions into internal calls
    for (const fn of merged.functions.values()) {
        for (const call of fn.calls) {
            if (call.category === 'external' && call.toParticipantKey?.startsWith('participant:import:')) {
                // Extract the bare function name from the label (strip args and receiver)
                // e.g. "getArticles(req.query, ...)" → "getArticles"
                // e.g. "userController.getUsers(id)" → "getUsers"
                let possibleFnName = call.label.replace(/\(.*$/, ''); // strip from first ( onwards
                if (possibleFnName.includes('.')) possibleFnName = possibleFnName.split('.').pop()!;

                if (possibleFnName && merged.functions.has(possibleFnName)) {
                    call.category = 'internal';
                    call.to = possibleFnName;
                    call.toParticipantKey = undefined;
                } else {
                    // Also try the full label without parens (legacy format)
                    const fullName = call.label.replace(/\(.*$/, '');
                    if (fullName && merged.functions.has(fullName)) {
                        call.category = 'internal';
                        call.to = fullName;
                        call.toParticipantKey = undefined;
                    }
                }
            }
        }
    }

    // Also inject route handlers identifiers (like app.get('/users', getUsers)) into chosenEntries array
    // For imported handler references (e.g. router.post('/', addTodo) where addTodo is from './todoController'),
    // synthesize a delegator function in the root file so we get: Client -> rootFile -> controllerFile -> db
    for (const m of models) {
        for (const r of (m.routeHandlers || [])) {
            if (!merged.chosenEntries.find(e => e.name === r)) {
                if (merged.functions.has(r)) {
                    const resolvedFn = merged.functions.get(r)!;
                    // If the handler is defined in a different file than the routes file,
                    // synthesize a route delegator to represent the delegation
                    if (resolvedFn.filePath && resolvedFn.filePath !== rootFilePath) {
                        const delegatorName = `route:${r}`;
                        if (!merged.functions.has(delegatorName)) {
                            const delegator: FunctionEntity = {
                                key: `function:${delegatorName}`,
                                name: delegatorName,
                                node: {},
                                signature: `${r}() [route handler]`,
                                bodyText: '',
                                raw: `router.method('...', ${r})`,
                                filePath: rootFilePath,
                                calls: [{
                                    from: delegatorName,
                                    to: r,
                                    label: `${r}()`,
                                    raw: `${r}()`,
                                    category: 'internal',
                                }],
                            };
                            merged.functions.set(delegatorName, delegator);
                            merged.chosenEntries.push(delegator);
                        }
                        // Also make sure the resolved function is in chosenEntries
                        // so its own calls (e.g. db.query()) get expanded
                        if (!merged.chosenEntries.find(e => e.name === r)) {
                            merged.chosenEntries.push(resolvedFn);
                        }
                    } else {
                        merged.chosenEntries.push(resolvedFn);
                    }
                }
            }
        }
    }

    return merged;
}

/**
 * Convert a FileModel into sequence diagram data (participants + ordered messages).
 *
 * @param model - Multi-file model from collectMultiFileModel()
 * @returns SequenceData with participants array and messages array
 */
export function buildSequenceMessages(model: FileModel): SequenceData {
    const allParticipants = [...model.participants];
    const participantKeys = new Set(allParticipants.map((p) => p.key));
    const pseudoParticipants = new Map<string, Participant>();
    const internalFunctions = new Map<string, FunctionEntity>();

    for (const fn of model.chosenEntries) internalFunctions.set(fn.name, fn);

    // BFS expansion: trace through all reachable internal functions
    const bfsQueue = [...model.chosenEntries];
    while (bfsQueue.length > 0) {
        const fn = bfsQueue.shift()!;
        for (const msg of fn.calls) {
            const targetFnName = msg.to;
            if (targetFnName && model.functions.has(targetFnName)) {
                if (!internalFunctions.has(targetFnName)) {
                    const targetFn = model.functions.get(targetFnName)!;
                    internalFunctions.set(targetFnName, targetFn);
                    bfsQueue.push(targetFn);
                }
                msg.to = targetFnName;
            }
        }
    }

    const messages: SequenceData['messages'] = [];
    const deferredReturns: SequenceData['messages'] = [];

    // Helper: generate messages from a function's calls
    // Forward calls are emitted immediately; returns are deferred to after deeper traces
    const emittedKeys = new Set<string>();
    function emitCallMessages(fn: FunctionEntity, isEntry: boolean) {
        if (isEntry) {
            const anonMatch = fn.name.match(/^anonymous@(\w+):(.+)$/);
            const entryLabel = anonMatch
                ? `${anonMatch[1]} ${anonMatch[2]}`
                : `${fn.name}()`;
            const entryKey = `inbound:${fn.name}`;
            if (!emittedKeys.has(entryKey)) {
                emittedKeys.add(entryKey);
                messages.push({
                    fromSpecial: 'client', toFn: fn.name, toFile: fn.filePath,
                    label: entryLabel, raw: fn.signature, styleKind: 'normal',
                    key: entryKey,
                });
            }
        }

        for (const c of fn.calls) {
            // Skip return messages here — they'll be added after deeper traces
            if (c.isReturn) {
                const key = `ret:${c.from}->${c.to}:${c.label}`;
                if (!emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    // Look up callee function to get its correct file path
                    const calleeFn = c.from ? (internalFunctions.get(c.from) || model.functions.get(c.from)) : undefined;
                    deferredReturns.push({
                        // fromFn/fromFile = the caller (receives the return value)
                        fromFn: c.to, fromFile: fn.filePath,
                        // toFn/toFile/toParticipantKey = the callee (source of return)
                        // For external calls, use fromParticipantKey; for internal calls, use callee's file
                        toFn: c.fromParticipantKey ? undefined : (c.from || undefined),
                        toFile: c.fromParticipantKey ? undefined : (calleeFn?.filePath || fn.filePath),
                        toParticipantKey: c.fromParticipantKey,
                        label: c.label, raw: c.raw,
                        styleKind: 'normal', key,
                        isReturn: true, returnLabel: c.returnLabel,
                    });
                }
                continue;
            }

            if (c.to && internalFunctions.has(c.to)) {
                const targetFn = internalFunctions.get(c.to)!;
                const key = `call:${fn.name}->${c.to}:${c.label}`;
                if (!emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    messages.push({
                        fromFn: fn.name, fromFile: fn.filePath,
                        toFn: c.to, toFile: targetFn.filePath,
                        label: c.label, raw: c.raw,
                        styleKind: 'normal', key,
                    });
                    // Immediately emit the target function's calls (depth-first)
                    if (!model.chosenEntries.includes(targetFn)) {
                        emitCallMessages(targetFn, false);
                    }
                }
            } else if (c.toParticipantKey) {
                const pKey = c.toParticipantKey;
                if (!participantKeys.has(pKey) && c.pseudoName) {
                    if (!pseudoParticipants.has(pKey)) {
                        pseudoParticipants.set(pKey, {
                            key: pKey, name: c.pseudoName, kind: c.pseudoKind || 'service',
                            signature: c.pseudoName, raw: c.pseudoName,
                        });
                    }
                }
                const key = `ext:${fn.name}->${pKey}:${c.label}`;
                if (!emittedKeys.has(key)) {
                    emittedKeys.add(key);
                    messages.push({
                        fromFn: fn.name, fromFile: fn.filePath,
                        toParticipantKey: pKey,
                        label: c.label, raw: c.raw, styleKind: 'normal',
                        key,
                    });
                }
            }
        }
    }

    // Emit messages depth-first from entry functions
    for (const fn of model.chosenEntries) {
        emitCallMessages(fn, true);
    }

    // Append deferred return messages at the end (after all deeper traces)
    messages.push(...deferredReturns);

    return {
        participants: allParticipants.concat([...pseudoParticipants.values()]),
        internalFunctions: [...internalFunctions.values()],
        messages,
    };
}

/**
 * Build the diff structure between two versions of a file's sequence graph.
 * Lower-level than `buildSequenceGraph` — exposes the raw participant +
 * message diff sets so callers can render their own annotations.
 *
 * @param oldCode - Baseline source
 * @param newCode - Current source
 * @param filePath - Workspace-relative path (both versions share the path)
 * @param resolver - Cross-file resolver for `newCode`
 * @param oldResolver - Cross-file resolver for `oldCode` (lets the diff walk
 *                      into baseline-only files)
 * @param entryHandlerName - Optional anchor — restricts the diff to messages
 *                           reachable from this handler
 * @returns Diff descriptor with `added` / `modified` / `deleted` arrays for
 *          participants and messages
 */
export function buildSequenceDiff(oldCode: string, newCode: string, filePath: string, resolver?: FileResolver, oldResolver?: FileResolver, entryHandlerName?: string) {
    const oldModel = collectMultiFileModel(oldCode, filePath, oldResolver || resolver);
    const newModel = collectMultiFileModel(newCode, filePath, resolver);

    if (entryHandlerName) {
        const norm = entryHandlerName.replace(/::|->/g, '.');
        const bareTail = norm.includes('.') ? norm.split('.').pop()! : norm;
        const matches = (f: FunctionEntity) =>
            f.name === entryHandlerName
            || f.name === norm
            || f.name === `route:${entryHandlerName}`
            || f.name.endsWith(`.${entryHandlerName}`)
            || f.name.endsWith(`.${norm}`)
            || (bareTail !== entryHandlerName && (f.name === bareTail || f.name.endsWith(`.${bareTail}`)));
        const filterToHandler = (model: FileModel) => {
            let filtered = model.chosenEntries.filter(matches);
            // Issue 407: promote matching function from the full function map
            // if filter missed the target in chosenEntries.
            if (filtered.length === 0) {
                for (const fn of model.functions.values()) {
                    if (matches(fn)) filtered.push(fn);
                }
            }
            if (filtered.length > 0) model.chosenEntries = filtered;
            // else: fall through to legacy universe behaviour (see comment in
            // buildSequenceGraph filter — coarse graph > no graph for cases
            // where the handler name resolves to nothing in either entries
            // or the full function map).
        };
        filterToHandler(oldModel);
        filterToHandler(newModel);
    }

    const oldSeq = buildSequenceMessages(oldModel);
    const newSeq = buildSequenceMessages(newModel);

    // Participant diffs
    const makeParticipantMap = (seq: SequenceData) => new Map([
        ['participant:special:client', { key: 'participant:special:client', name: 'API Client', kind: 'client', raw: 'API Client', signature: 'API Client' } as Participant],
        ...seq.participants.map((p) => [p.key, p] as [string, Participant]),
        ...seq.internalFunctions.map((f) => {
            const fileKey = f.filePath ? `participant:file:${f.filePath}` : `participant:function:${f.name}`;
            const name = f.filePath ? baseName(f.filePath) : f.name;
            return [fileKey, { key: fileKey, name, kind: f.filePath ? 'module' : 'function', raw: name, signature: name } as Participant] as [string, Participant];
        }),
    ]);

    const oldP = makeParticipantMap(oldSeq);
    const newP = makeParticipantMap(newSeq);

    const participantDiff = new Map<string, { deleted?: string; added?: string }>();
    const deletedParticipants: Participant[] = [];
    const currentFileKey = `participant:file:${filePath}`;

    for (const [k, op] of oldP.entries()) {
        const np = newP.get(k);
        if (!np) {
            if (k !== 'participant:special:client' && k !== currentFileKey) {
                deletedParticipants.push(op);
            }
            continue;
        }
        if (normalizeSpace(op.raw) !== normalizeSpace(np.raw)) {
            participantDiff.set(k, { deleted: op.raw, added: np.raw });
        }
    }
    for (const [k, np] of newP.entries()) {
        if (!oldP.has(k) && k !== 'participant:special:client') {
            participantDiff.set(k, { added: np.raw });
        }
    }

    // Message diffs
    const oldSet = new Set(oldSeq.messages.map((m) => m.key));
    const newSet = new Set(newSeq.messages.map((m) => m.key));

    const msgStyleByKey = new Map<string, string>();
    const msgLabelDiffByKey = new Map<string, { deleted: string; added: string }>();
    const deletedMessages: typeof oldSeq.messages = [];

    // Build a map of old messages by key for content comparison
    const oldMsgByKey = new Map(oldSeq.messages.map((m) => [m.key, m]));

    // Find functions whose internal body changed
    const changedFunctions = new Set<string>();
    const oldFnMap = new Map(oldSeq.internalFunctions.map(f => [f.name, f]));
    for (const nf of newSeq.internalFunctions) {
        const of = oldFnMap.get(nf.name);
        if (of && of.bodyText !== nf.bodyText) {
            changedFunctions.add(nf.name);
        }
    }

    for (const m of newSeq.messages) {
        if (oldSet.has(m.key)) {
            // Same message key exists — check if content changed
            const oldMsg = oldMsgByKey.get(m.key);
            if (oldMsg && oldMsg.raw !== m.raw) {
                // Underlying call changed (e.g. different args, query string)
                msgStyleByKey.set(m.key, 'changed');
                msgLabelDiffByKey.set(m.key, { deleted: oldMsg.label, added: m.label });
            } else if (m.toFn && changedFunctions.has(m.toFn)) {
                // Target function changed internally
                msgStyleByKey.set(m.key, 'changed');
            } else {
                msgStyleByKey.set(m.key, 'normal');
            }
        } else {
            msgStyleByKey.set(m.key, 'added');
        }
    }

    for (const m of oldSeq.messages) {
        if (!newSet.has(m.key)) {
            deletedMessages.push(m);
        }
    }

    return { newSeq, participantDiff, deletedParticipants, msgStyleByKey, msgLabelDiffByKey, deletedMessages, changedFunctions };
}

function cleanParticipantName(p: Participant): string {
    if (!p.key.startsWith('participant:import:')) return p.name;
    const importPath = p.name;
    if (importPath.startsWith('.')) {
        // Relative path: show basename without extension (e.g. ./todoController → todoController)
        const base = importPath.split('/').pop() || importPath;
        return base.replace(/\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$/, '');
    }
    // External package: capitalize for readability (mongoose → Mongoose, pg → pg)
    const pkg = importPath.split('/')[0];
    return pkg.charAt(0).toUpperCase() + pkg.slice(1);
}

function participantTitleAndSubtitle(p: Participant): { title: string; subtitle: string } {
    if (p.key === 'participant:special:client') return { title: 'API Client', subtitle: '«actor»' };
    if (p.key.startsWith('participant:function:')) return { title: p.name, subtitle: '«handler/function»' };
    if (p.key.startsWith('participant:file:')) return { title: p.name, subtitle: '«module»' };
    const map: Record<string, string> = {
        database: '«database»', cache: '«cache»', storage: '«storage»',
        service: '«service»', module: '«module»', client: '«actor»', function: '«handler/function»',
    };
    return { title: cleanParticipantName(p), subtitle: map[p.kind] || '«participant»' };
}

export type FileResolver = (importPath: string, currentFilePath: string) => { code: string; filePath: string } | undefined;

/**
 * #862: Cross-file participants resolved through the LSP / call-graph resolver
 * receive an ABSOLUTE `anchor.filePath` (`/Users/.../foo.ts`) while every graph
 * key and same-file participant uses a workspace-relative path (`src/foo.ts`).
 * That split forced a tolerant suffix-lookup in the diff cascade (#858) and is
 * latent for anything else that keys on `anchor.filePath` (navigation, comment
 * re-anchoring, overlays). Normalize every participant + edge anchor back to the
 * workspace-relative key by suffix-matching against the known relative snapshot
 * file keys, so the whole graph lives in one path space. See ADR-049.
 *
 * INVARIANT: after this pass no participant/edge `anchor.filePath` is absolute,
 * provided the file is present in `snapshotFiles`.
 */
function isAbsolutePath(p: string): boolean {
    return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

function normalizeAnchorPaths(
    nodes: GraphNode[],
    anchors: Record<string, Anchor>,
    snapshotFiles?: Record<string, import('./graphTypes').FileRecord>,
): void {
    const relKeys = snapshotFiles ? Object.keys(snapshotFiles) : [];
    if (!relKeys.length) return;
    const toRel = (p: string): string => {
        if (!p || !isAbsolutePath(p)) return p;
        const u = p.replace(/\\/g, '/');
        let best: string | undefined;
        for (const k of relKeys) {
            const nk = k.replace(/\\/g, '/');
            if (u === nk || u.endsWith('/' + nk)) {
                if (!best || nk.length > best.length) best = k; // longest match wins
            }
        }
        return best ?? p;
    };
    for (const n of nodes) {
        if (n.type === 'participant' && n.anchor?.filePath) {
            const rel = toRel(n.anchor.filePath);
            if (rel !== n.anchor.filePath) n.anchor = { ...n.anchor, filePath: rel };
        }
    }
    for (const key of Object.keys(anchors)) {
        const a = anchors[key];
        if (a?.filePath) {
            const rel = toRel(a.filePath);
            if (rel !== a.filePath) anchors[key] = { ...a, filePath: rel };
        }
    }
}

/**
 * Build an L3 API sequence diagram for a single API entry point.
 *
 * Participants: the synthetic `API Client`, file-level handler functions, and
 * detected external systems (DB, queue, cache, HTTP backends). Messages are
 * function-level calls ordered top-down by call site. When `oldCode` is
 * provided the builder runs a side-by-side diff and annotates each
 * participant/message with `'added'`, `'modified'`, `'deleted'`, or
 * `'unchanged'` so the webview can render the diff overlay.
 *
 * @param code - Current source of the file containing the entry handler
 * @param filePath - Workspace-relative path of `code`
 * @param oldCode - Baseline source for diff annotation (omit for clean build)
 * @param resolver - Resolves cross-file imports to their source. Required for
 *                   accurate multi-file sequence graphs.
 * @param oldResolver - Same as `resolver` but for the baseline. Lets the diff
 *                      walk into baseline-only files.
 * @param entryHandlerName - Name of the function to anchor the graph at (e.g.
 *                           `loader` for Remix, `BlogController.index` for
 *                           Symfony). When omitted, the first exported handler
 *                           is used.
 * @param snapshotFiles - Optional FileRecord map for LSP fallback resolution
 *                        of receiver types when tree-sitter can't infer them.
 * @param lspFallbackResolver - Tier-2 receiver resolver used when AST-based
 *                              resolution returns ambiguous matches.
 * @returns DiagramGraph (type=sequence) with participants as nodes + ordered
 *          messages as edges, plus `meta.handlerName`, `meta.filePath`, and
 *          `meta.fileName`.
 */
export function buildSequenceGraph(
    code: string,
    filePath: string,
    oldCode?: string,
    resolver?: FileResolver,
    oldResolver?: FileResolver,
    entryHandlerName?: string,
    snapshotFiles?: Record<string, import('./graphTypes').FileRecord>,
    lspFallbackResolver?: { resolveFromSnapshot: (typeName: string, snapshotFiles: Record<string, import('./graphTypes').FileRecord>) => { filePath: string; typeName: string } | null },
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};
    const fileName = baseName(filePath);

    let seq: SequenceData;
    let participantDiff = new Map<string, { deleted?: string; added?: string }>();
    let deletedParticipants: Participant[] = [];
    let msgStyleByKey = new Map<string, string>();
    let msgLabelDiffByKey = new Map<string, { deleted: string; added: string }>();
    let deletedMessages: SequenceData['messages'] = [];
    let changedFunctions = new Set<string>();

    if (oldCode != null) {
        const d = buildSequenceDiff(oldCode, code, filePath, resolver, oldResolver, entryHandlerName);
        seq = d.newSeq;
        participantDiff = d.participantDiff;
        deletedParticipants = d.deletedParticipants;
        msgStyleByKey = d.msgStyleByKey;
        msgLabelDiffByKey = d.msgLabelDiffByKey;
        deletedMessages = d.deletedMessages;
        changedFunctions = d.changedFunctions;
    } else {
        const model = collectMultiFileModel(code, filePath, resolver);
        if (entryHandlerName) {
            // Issue 263 follow-up: meta-framework / NestJS handlers may live as
            // class methods (named `ClassName.methodName` in funcs) while the
            // detected handlerName is the bare method name. Accept either shape.
            //
            // Issues 343-345: extended matching to cover:
            //   - `BlogController::index` / `BlogController->index` PHP forms
            //     normalized to dot form so `f.name.endsWith('.index')` matches.
            //   - Bare method-name match for ASP.NET / Spring controllers where
            //     `entryHandlerName` is just the method (e.g. `Get`) and the
            //     extracted function is `ClassName.Get`.
            //   - Remix `loader` / `action` exports — the file-based detector
            //     produces these handler names verbatim; today's exact-match
            //     case (1) already covers it but only when the function is
            //     extracted as `loader`/`action` (which it is via the HOC /
            //     direct-arrow branches in symbolExtractor).
            const norm = entryHandlerName.replace(/::|->/g, '.');
            const bareTail = norm.includes('.') ? norm.split('.').pop()! : norm;
            const matches = (f: FunctionEntity) =>
                f.name === entryHandlerName
                || f.name === norm
                || f.name === `route:${entryHandlerName}`
                || f.name.endsWith(`.${entryHandlerName}`)
                || f.name.endsWith(`.${norm}`)
                || (bareTail !== entryHandlerName && (f.name === bareTail || f.name.endsWith(`.${bareTail}`)));
            let filtered = model.chosenEntries.filter(matches);
            // Issue 407: if the chosenEntries top-5 fallback missed the target
            // handler (e.g. a `route:addTodo` not in entries yet), promote the
            // matching function from the full functions map so the graph is
            // still per-handler.
            if (filtered.length === 0) {
                for (const fn of model.functions.values()) {
                    if (matches(fn)) filtered.push(fn);
                }
            }
            if (filtered.length > 0) {
                model.chosenEntries = filtered;
            }
            // else: fall through to legacy universe behaviour. Issue 407 — L3 sequence graphs for `:param` routes are polluted with cross-route + cross-cluster edges's
            // primary fix — recognising `anonymous@…` / `route:…` names in
            // `isApiHandlerName` — makes the filter correctly narrow for the
            // inline-arrow case (the test project's actual shape). Forcing
            // empty here as well would cost ~20 sequence graphs across
            // ts-apollo / ts-nuxt / ts-react-native, where legitimate
            // handler-name lookups don't match any single function in the
            // file (meta-framework synthesized handlers, GraphQL resolvers,
            // etc.) and a coarse graph is strictly better than no graph.
        }
        seq = buildSequenceMessages(model);
    }

    // When scoped to a specific handler, prune participants that have zero messages
    // (neither source nor target). This removes imported-but-never-called modules
    // (e.g. token.utils.ts imported by auth.service.ts but never called in the handler).
    if (entryHandlerName) {
        const keysInUse = new Set<string>();
        for (const m of seq.messages) {
            if (m.toParticipantKey) keysInUse.add(m.toParticipantKey);
            // Also keep source participants — derive key from fromFile/fromSpecial
            if (m.fromFile) keysInUse.add(`participant:file:${m.fromFile}`);
            if (m.fromSpecial) keysInUse.add(`participant:special:${m.fromSpecial}`);
        }
        // Always keep the API Client (first participant, type=special)
        const apiClient = seq.participants.find(p => p.key.startsWith('participant:special:'));
        if (apiClient) keysInUse.add(apiClient.key);
        seq.participants = seq.participants.filter(p => keysInUse.has(p.key));
    }

    // Pre-compute which participant keys have activity from changed/added/deleted messages.
    // These participants will be marked 'modified' (orange) even if they weren't structurally changed.
    const participantsWithActivity = new Set<string>();
    if (oldCode != null) {
        for (const nf of seq.internalFunctions) {
            if (changedFunctions.has(nf.name)) {
                if (nf.filePath) participantsWithActivity.add(`participant:file:${nf.filePath}`);
                participantsWithActivity.add(`participant:function:${nf.name}`);
            }
        }
        for (const m of seq.messages) {
            const style = msgStyleByKey.get(m.key);
            if (style === 'added' || style === 'changed') {
                const fromKey = m.fromFile
                    ? `participant:file:${m.fromFile}`
                    : m.fromSpecial
                        ? `participant:special:${m.fromSpecial}`
                        : `participant:file:${filePath}`;
                const toKey = m.toFile
                    ? `participant:file:${m.toFile}`
                    : m.toParticipantKey || (m.toFn ? `participant:file:${filePath}` : undefined);

                // Only mark the caller (from) as modified if the call itself changed or is new
                if (style === 'added' || msgLabelDiffByKey.has(m.key)) {
                    participantsWithActivity.add(fromKey);
                }

                // The target (to) receives the changed/added message, so its interface/interaction updated
                if (toKey) participantsWithActivity.add(toKey);
            }
        }
        for (const m of deletedMessages) {
            const fromKey = m.fromFile
                ? `participant:file:${m.fromFile}`
                : m.fromSpecial
                    ? `participant:special:${m.fromSpecial}`
                    : `participant:file:${filePath}`;
            const toKey = m.toFile
                ? `participant:file:${m.toFile}`
                : m.toParticipantKey || (m.toFn ? `participant:file:${filePath}` : undefined);

            // If a message was deleted, the caller intrinsically modified its behavior
            participantsWithActivity.add(fromKey);
            // We do NOT add `toKey` for deleted messages, because the recipient didn't change just because it's no longer called
        }
    }

    const pNodeByKey = new Map<string, string>();

    // API Client participant
    const clientKey = 'participant:special:client';
    const clientDiff = participantDiff.get(clientKey);
    const clientNode: GraphNode = {
        id: nextId('participant'), type: 'participant', label: 'API Client',
        subtitle: '«actor»', body: 'Inbound requests',
        diff: clientDiff ? 'modified'
            : participantsWithActivity.has(clientKey) ? 'modified'
                : 'unchanged',
        diffDetail: clientDiff,
        anchor: { filePath },
    };
    nodes.push(clientNode);
    pNodeByKey.set('participant:special:client', clientNode.id);

    // Internal file/function participants
    const seenFiles = new Set<string>();

    // Add the current file if it's not already added
    const currentFileKey = `participant:file:${filePath}`;
    seenFiles.add(currentFileKey);
    const rootMeta = participantTitleAndSubtitle({ key: currentFileKey, name: fileName, kind: 'module', raw: fileName, signature: fileName });
    const rootNode: GraphNode = {
        id: nextId('participant'), type: 'participant', label: rootMeta.title,
        subtitle: rootMeta.subtitle, body: fileName,
        diff: participantsWithActivity.has(currentFileKey) ? 'modified' : 'unchanged',
        diffDetail: undefined,
        anchor: { filePath },
    };
    nodes.push(rootNode);
    pNodeByKey.set(currentFileKey, rootNode.id);

    // Add other files and functions
    for (const f of seq.internalFunctions) {
        const pKey = f.filePath ? `participant:file:${f.filePath}` : `participant:function:${f.name}`;
        if (seenFiles.has(pKey)) continue;
        seenFiles.add(pKey);

        const name = f.filePath ? baseName(f.filePath) : f.name;
        const meta = participantTitleAndSubtitle({ key: pKey, name, kind: f.filePath ? 'module' : 'function', raw: name, signature: name });
        const pDiff = participantDiff.get(pKey);

        const node: GraphNode = {
            id: nextId('participant'), type: 'participant', label: meta.title,
            subtitle: meta.subtitle, body: name,
            diff: pDiff
                ? (pDiff.added && pDiff.deleted ? 'modified' : 'added')
                : participantsWithActivity.has(pKey) ? 'modified'
                    : 'unchanged',
            diffDetail: pDiff, anchor: { filePath: f.filePath || filePath, symbol: f.name },
        };
        nodes.push(node);
        pNodeByKey.set(pKey, node.id);
    }

    // External participants
    // Build a Set of all file paths already covered by internal file participants so we can
    // suppress any import-path participant that would duplicate a resolved module participant.
    const resolvedFilePaths = new Set<string>();
    for (const f of seq.internalFunctions) {
        if (f.filePath) resolvedFilePaths.add(f.filePath);
    }

    for (const p of seq.participants) {
        let pAnchorPath = filePath;
        let pAnchorSymbol: string | undefined;
        // Track whether we resolved the participant's OWN file. If not, it keeps
        // the handler's file as a navigational fallback (click → handler L4) —
        // but that borrowed filePath must not let the cascade attribute the
        // handler's changed flow to this participant (over-marking, see below).
        let resolvedOwnFile = false;

        // Skip import participants whose resolved path corresponds to an already-added file participant.
        // e.g. participant:import:./todoController is redundant when todoController.js is already a participant.
        if (p.key.startsWith('participant:import:')) {
            const importPath = p.key.replace('participant:import:', '');
            // Check if any resolved internal file ends with this import path's basename
            const importBasename = importPath.split('/').pop()?.replace(/\.(js|ts|jsx|tsx)$/, '');
            const alreadyCovered = importBasename && [...resolvedFilePaths].some(fp => {
                const fpBasename = baseName(fp).replace(/\.(js|ts|jsx|tsx)$/, '');
                return fpBasename === importBasename;
            });
            // Also check if we already have an explicitly keyed file participant for this path
            const fileKeyForImport = `participant:file:${importPath}`;
            if (alreadyCovered || pNodeByKey.has(fileKeyForImport)) continue;

            if (resolver) {
                try {
                    const resolved = resolver(importPath, filePath);
                    if (resolved && resolved.filePath) {
                        pAnchorPath = resolved.filePath;
                        resolvedOwnFile = true;
                    }
                } catch {
                    // Ignore resolve errors
                }
            }
            // LSP fallback: try snapshot scan when FileResolver didn't resolve
            if (pAnchorPath === filePath && lspFallbackResolver && snapshotFiles) {
                const importName = importPath.split('/').pop()?.replace(/\.(js|ts|jsx|tsx)$/, '') ?? importPath;
                const fallback = lspFallbackResolver.resolveFromSnapshot(importName, snapshotFiles);
                if (fallback) {
                    pAnchorPath = fallback.filePath;
                    resolvedOwnFile = true;
                }
            }
        } else if (p.key.startsWith('participant:var:')) {
            pAnchorSymbol = p.name;
        }

        const meta = participantTitleAndSubtitle(p);
        const pDiff = participantDiff.get(p.key);
        // Fallback-anchored = borrowed the handler's file because its own file
        // couldn't be resolved (external npm/service participants like
        // prisma.user / Jsonwebtoken). The cascade upgrade pass keys file-based
        // "did this participant's file change?" checks off anchor.filePath, so a
        // fallback anchor would make every such participant inherit the
        // handler's modified flow. Flag it so that pass can skip these.
        const anchorIsFallback = !resolvedOwnFile && pAnchorPath === filePath && p.key !== currentFileKey;
        const node: GraphNode = {
            id: nextId('participant'), type: 'participant', label: meta.title,
            subtitle: meta.subtitle, body: p.signature || p.raw,
            diff: pDiff
                ? (pDiff.added && pDiff.deleted ? 'modified' : 'added')
                : participantsWithActivity.has(p.key) ? 'modified'
                    : 'unchanged',
            diffDetail: pDiff,
            anchor: { filePath: pAnchorPath, symbol: pAnchorSymbol, ...(anchorIsFallback ? { fallback: true } : {}) },
        };
        nodes.push(node);
        pNodeByKey.set(p.key, node.id);
    }

    // Deleted participants
    for (const p of deletedParticipants) {
        const meta = participantTitleAndSubtitle(p);
        const node: GraphNode = {
            id: nextId('ghost'), type: 'participant', label: `${meta.title} (deleted)`,
            subtitle: meta.subtitle, diff: 'deleted',
            diffDetail: { deleted: p.raw || p.signature }, anchor: { filePath },
        };
        nodes.push(node);
        pNodeByKey.set(p.key, node.id);
    }

    // Message edges
    for (const m of seq.messages) {
        let fromKey = m.fromSpecial ? 'participant:special:client' : `participant:function:${m.fromFn}`;
        if (m.fromFile) fromKey = `participant:file:${m.fromFile}`;
        else if (m.fromFn && !m.fromSpecial) fromKey = `participant:file:${filePath}`;

        let toKey = m.toFn ? `participant:function:${m.toFn}` : m.toParticipantKey;
        if (m.toFile) toKey = `participant:file:${m.toFile}`;
        else if (m.toFn) toKey = `participant:file:${filePath}`;

        if (!toKey) continue;

        // Try multiple key patterns to find matching participant nodes
        let s = pNodeByKey.get(fromKey) || pNodeByKey.get(`participant:function:${m.fromFn}`);
        let t = pNodeByKey.get(toKey) || pNodeByKey.get(`participant:function:${m.toFn}`) || (m.toParticipantKey ? pNodeByKey.get(m.toParticipantKey) : undefined);

        // Fallback: for internal calls where toFile isn't set but the function is from a resolved file,
        // look up by the function's filePath from internalFunctions
        if (!t && m.toFn) {
            const internalFn = seq.internalFunctions.find(f => f.name === m.toFn);
            if (internalFn?.filePath) {
                t = pNodeByKey.get(`participant:file:${internalFn.filePath}`);
            }
        }
        if (!s && m.fromFn) {
            const internalFn = seq.internalFunctions.find(f => f.name === m.fromFn);
            if (internalFn?.filePath) {
                s = pNodeByKey.get(`participant:file:${internalFn.filePath}`);
            }
        }

        if (!s || !t) continue;

        const styleKind = (msgStyleByKey.get(m.key) || 'normal') as GraphEdge['styleKind'];
        const diffLabel = msgLabelDiffByKey.get(m.key);
        let label = m.label;
        if (diffLabel) {
            label = `- ${diffLabel.deleted}\n+ ${diffLabel.added}`;
        } else if (styleKind === 'added') {
            label = `+ ${m.label}`;
        }

        const diffStatus: DiffStatus = styleKind === 'added' ? 'added' : styleKind === 'changed' ? 'modified' : 'unchanged';

        if (m.isReturn) {
            // Skip self-referencing return edges (same participant → zero-width invisible edge)
            if (s === t) continue;
            // Return message: reverse direction, dashed style
            const retEdgeId = nextId('edge');
            edges.push({
                id: retEdgeId, source: t, target: s, label: m.returnLabel ?? label,
                edgeType: 'message', diff: diffStatus, styleKind: 'normal',
                meta: { isReturn: true },
            });
            // Anchor return edge to the returning function for click-to-flow navigation
            if (m.fromFn) {
                anchors[retEdgeId] = { filePath: m.fromFile || filePath, symbol: m.fromFn };
            }
        } else {
            const edgeId = nextId('edge');
            edges.push({
                id: edgeId, source: s, target: t, label,
                edgeType: 'message', diff: diffStatus, styleKind,
            });
            // Anchor message edge to the target function for click-to-flow navigation
            if (m.toFn) {
                anchors[edgeId] = { filePath: m.toFile || filePath, symbol: m.toFn };
            }
        }
    }

    // Deleted messages
    for (const m of deletedMessages) {
        let fromKey = m.fromSpecial ? 'participant:special:client' : `participant:function:${m.fromFn}`;
        if (m.fromFile) fromKey = `participant:file:${m.fromFile}`;
        else if (m.fromFn && !m.fromSpecial) fromKey = `participant:file:${filePath}`;

        let toKey = m.toFn ? `participant:function:${m.toFn}` : m.toParticipantKey;
        if (m.toFile) toKey = `participant:file:${m.toFile}`;
        else if (m.toFn) toKey = `participant:file:${filePath}`;

        if (!toKey) continue;

        const s = pNodeByKey.get(fromKey) || pNodeByKey.get(`participant:function:${m.fromFn}`);
        const t = pNodeByKey.get(toKey) || pNodeByKey.get(`participant:function:${m.toFn}`) || (m.toParticipantKey ? pNodeByKey.get(m.toParticipantKey) : undefined);
        if (!s || !t) continue;

        edges.push({
            id: nextId('edge'), source: s, target: t, label: `- ${m.label}`,
            edgeType: 'message', diff: 'deleted', styleKind: 'deleted',
        });
    }

    // Final pass: remove participant nodes that have zero edges (dangling imports)
    // but keep participants with diff status (ghosts from deleted code) and lifeline nodes.
    const connectedNodeIds = new Set<string>();
    for (const e of edges) {
        connectedNodeIds.add(e.source);
        connectedNodeIds.add(e.target);
    }
    const prunedNodes = nodes.filter(n => {
        if (n.type !== 'participant') return true; // keep non-participant nodes
        if (connectedNodeIds.has(n.id)) return true; // has edges
        if (n.diff && n.diff !== 'unchanged') return true; // diff ghost — keep for visualization
        return false; // dangling import — prune
    });

    const graphId = entryHandlerName ? `sequence:${filePath}:${entryHandlerName}` : `sequence:${filePath}`;
    normalizeAnchorPaths(prunedNodes, anchors, snapshotFiles); // #862 — relative anchor paths
    return { graphId, type: 'sequence', nodes: prunedNodes, edges, anchors, meta: { filePath, fileName, handlerName: entryHandlerName } };
}

/**
 * Build a simplified sequence graph for non-JS languages (Python, Go, Java,
 * PHP, Ruby, Rust, C#, Swift, Kotlin, Dart) using pre-extracted tree-sitter
 * analysis data + detected API records.
 *
 * Babel's deep AST call tracing is JS/TS-only. For other languages we don't
 * track function-to-function call edges; instead we produce a shallow graph:
 *
 *   API Client → handler module → external-system participants
 *
 * where external systems are inferred from the file's non-framework imports
 * (DB clients, message queues, HTTP libraries, etc. via
 * `classifyExternalSystemMultiLang`). This is enough to give the user a
 * "what does this endpoint touch" view without the deeper call graph.
 *
 * @param analysis - Tree-sitter extraction output (importsByLocal +
 *                   injectedDeps + entities; funcs is optional and used to
 *                   emit method-level participant labels when available)
 * @param filePath - Workspace-relative path of the handler file
 * @param apis - ApiRecords for this file (each becomes a separate `sequence:`
 *               graph keyed off `handlerName`)
 * @returns Map of `graphId → DiagramGraph` — one entry per API in the file
 */
export function buildSequenceGraphFromAnalysis(
    analysis: {
        importsByLocal: Map<string, string>;
        injectedDeps?: Map<string, string>;
        entities: Array<{ name: string; kind: string }>;
        funcs?: Map<string, any>;
    },
    filePath: string,
    apis: Array<{ apiId: string; method: string; route: string; handlerName: string }>,
    entryHandlerName?: string,
    baselineImports?: Map<string, string>,
    modifiedHandlerNames?: Set<string>,
    resolver?: FileResolver,
    snapshotFiles?: Record<string, import('./graphTypes').FileRecord>,
    /** All participant body-paths from the previous baseline sequence graph for this handler.
     *  Used to correctly mark injected-dep and BFS-discovered participants as 'unchanged'
     *  even when they aren't in the file's own import statements. */
    baselineParticipantBodies?: Set<string>,
    /** Optional LSP fallback resolver for when tree-sitter cannot resolve a receiver type. */
    lspFallbackResolver?: { resolveFromSnapshot: (typeName: string, snapshotFiles: Record<string, import('./graphTypes').FileRecord>) => { filePath: string; typeName: string } | null },
): DiagramGraph {
    resetIds();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const anchors: Record<string, Anchor> = {};
    const fileName = baseName(filePath);

    // API Client
    const clientNode: GraphNode = {
        id: nextId('participant'), type: 'participant',
        label: 'API Client', subtitle: '«actor»', body: 'Inbound requests',
        diff: 'unchanged', anchor: { filePath },
    };
    nodes.push(clientNode);

    // Connect handler requests and trace them using a BFS queue
    // For OOP languages (Java, Kotlin, C#) functions are stored as "ClassName.methodName".
    // frameworkDetector only gives us the bare method name (e.g. "addTodo"), so fall back
    // to a suffix match when the exact key is not found.
    const entryFunc = entryHandlerName && analysis.funcs
        ? analysis.funcs.get(entryHandlerName)
          ?? [...analysis.funcs.values()].find(f => f.name.endsWith(`.${entryHandlerName}`))
        : undefined;

    // Handler module node - represents the file or class containing the entry handler.
    // Java stores entity names as 'ClassName.methodName', but api.handlerName is just 'methodName',
    // so check both exact match and suffix match to handle that format.
    const handlerBodyChanged = entryHandlerName != null && modifiedHandlerNames != null && (
        modifiedHandlerNames.has(entryHandlerName) ||
        [...modifiedHandlerNames].some(n => n.endsWith(`.${entryHandlerName}`))
    );

    let participantLabel = fileName;
    let participantSubtitle = '«module»';

    if (entryHandlerName) {
        if (entryHandlerName.includes('.')) {
            participantLabel = entryHandlerName.split('.')[0];
            participantSubtitle = '«class»';
        } else if (entryFunc && /^[A-Z][a-zA-Z0-9]*$/.test(entryHandlerName)) {
            participantLabel = entryHandlerName;
            participantSubtitle = '«class»';
        }
    }

    const moduleNode: GraphNode = {
        id: nextId('participant'), type: 'participant',
        label: participantLabel, subtitle: participantSubtitle, body: fileName,
        diff: handlerBodyChanged ? 'modified' : 'unchanged', anchor: { filePath },
    };
    nodes.push(moduleNode);

    // Build baseline source set for coarse diff.
    // Union of file import sources + all participant bodies from the previous graph (covers
    // injected-dep participants and BFS-discovered participants from deeper service files).
    const baselineImportSourceSet = baselineImports ? new Set(baselineImports.values()) : null;
    const baselineSources: Set<string> | null = baselineImportSourceSet
        ? new Set([...baselineImportSourceSet, ...(baselineParticipantBodies ?? [])])
        : baselineParticipantBodies ? new Set(baselineParticipantBodies) : null;

    // Current sources: file imports + injected deps (so deleted-detection doesn't misfire on DI fields)
    const currentSources = new Set([
        ...analysis.importsByLocal.values(),
        ...(analysis.injectedDeps ? [...analysis.injectedDeps.values()] : []),
    ]);

    // Map from participant local name to GraphNode ID to draw precise edges
    const participantNameToId = new Map<string, string>();

    // Helper to check if a source or class name is a data model (DTO/Entity/Principal)
    const isDataModel = (name: string, sourcePath: string) => {
        const lowerName = name.toLowerCase();
        // Common DTO suffixes
        if (lowerName.endsWith('dto') || lowerName.endsWith('request') || lowerName.endsWith('response') || lowerName.endsWith('model') || lowerName.endsWith('entity')) {
            return true;
        }
        // Check the class name from source path
        const className = (sourcePath.split('/').pop() || sourcePath.split('.').pop() || sourcePath)
            .replace(/\.(java|kt|py|go|js|ts)$/, '');
        const lowerClass = className.toLowerCase();
        // Security principals / auth context objects — not services
        if (lowerClass.endsWith('user') || lowerClass.endsWith('principal') || lowerClass.endsWith('userdetails') || lowerClass.endsWith('token') || lowerClass.endsWith('claims') || lowerClass.endsWith('credentials')) {
            return true;
        }
        // Common paths for models
        if (sourcePath.includes('/dto/') || sourcePath.includes('.dto.') || sourcePath.includes('/entities/') || sourcePath.includes('.entities.') || sourcePath.includes('/models/') || sourcePath.includes('.models.')) {
            return true;
        }
        // BUG-POLAR-19: Pydantic schema modules — constructors like `TOTPStatus()`
        // / `TOTPEnrollment()` imported from `.schemas` are data-shape constructions
        // (request/response models), not service interactions, so they don't belong
        // as sequence messages. Scoped to the `schemas` MODULE path (NOT Django
        // `.serializers`, which model meaningful transformation steps and stay).
        if (/(?:^|[./])schemas?(?:[./]|$)/.test(sourcePath)) {
            return true;
        }
        return false;
    };

    // Deleted participants: in baseline but not in current
    if (baselineSources) {
        for (const [local, source] of baselineImports!) {
            if (isFrameworkNoise(source)) continue;
            if (currentSources.has(source)) continue;
            const cleanName = source.startsWith('.')
                ? (source.split('/').pop() || source).replace(/\.(py|go|java|rb|php|rs|cs|ts|js)$/, '')
                : source.includes('/')
                    ? source.split('/')[0]
                    : shortenQualifiedName(source);
            const deletedNode: GraphNode = {
                id: nextId('participant'), type: 'participant',
                label: `${cleanName} (deleted)`, subtitle: '«participant»', body: source,
                diff: 'deleted', anchor: { filePath },
            };
            nodes.push(deletedNode);
            void local; // suppress unused
        }
    }

    // External participants from imports (skip framework noise)
    const externalNodes: string[] = [];
    for (const [localName, source] of analysis.importsByLocal.entries()) {
        if (isFrameworkNoise(source)) continue;
        const cleanName = source.startsWith('.')
            ? (/^[A-Z]/.test(localName) ? localName  // prefer PascalCase class name over filename for relative imports
                : (source.split('/').pop() || source).replace(/\.(py|go|java|rb|php|rs|cs|ts|js)$/, ''))
            : source.includes('/')
                ? source.split('/')[0]       // npm / Go path-style packages
                : shortenQualifiedName(source); // Java/Kotlin dot-separated packages

        // Filter out data models
        if (isDataModel(cleanName, source)) continue;

        // Deduplicate by source
        if (externalNodes.includes(source)) continue;
        externalNodes.push(source);

        const sysKind = classifyExternalSystem(source);
        const subtitle = sysKind === 'database' ? '«database»'
            : sysKind === 'cache' ? '«cache»'
            : sysKind === 'storage' ? '«storage»'
            : sysKind === 'service' ? '«service»'
            : source.startsWith('.') ? '«module»'
            : '«participant»';

        const resolved = resolver ? resolver(source, filePath) : undefined;
        const resolvedFilePath = resolved ? resolved.filePath : undefined;
        const participantDiff: DiffStatus = baselineSources && !baselineSources.has(source) ? 'added' : 'unchanged';

        const extNode: GraphNode = {
            id: nextId('participant'), type: 'participant',
            label: cleanName, subtitle, body: source,
            diff: participantDiff, anchor: resolvedFilePath ? { filePath: resolvedFilePath } : undefined,
        };
        nodes.push(extNode);
        participantNameToId.set(localName, extNode.id);
    }

    // Injected service dependencies (same-package DI — not in imports but found in field declarations)
    if (analysis.injectedDeps) {
        for (const [local, source] of analysis.injectedDeps.entries()) {
            if (isFrameworkNoise(source)) continue;
            if (isDataModel(local, source)) continue;
            
            if (externalNodes.includes(source)) {
                // Already added via explicit import (same source path), just map the local name to the existing node
                const existingExtNode = nodes.find(n => n.body === source);
                if (existingExtNode) participantNameToId.set(local, existingExtNode.id);
                continue;
            }
            if (analysis.importsByLocal.has(local)) continue; // skip if explicit import covers same local name
            
            externalNodes.push(source);

            const baselineSrcForDep = baselineImports?.get(local);
            const resolved = resolver ? resolver(source, filePath) : undefined;
            const resolvedFilePath = resolved ? resolved.filePath : undefined;
            const participantDiff: DiffStatus =
                baselineSources && !baselineSources.has(source) && !baselineSrcForDep ? 'added' : 'unchanged';

            const svcNode: GraphNode = {
                id: nextId('participant'), type: 'participant',
                label: shortenQualifiedName(source), subtitle: '«service»', body: source,
                diff: participantDiff, anchor: resolvedFilePath ? { filePath: resolvedFilePath } : undefined,
            };
            nodes.push(svcNode);
            participantNameToId.set(local, svcNode.id);
        }
    }

    // Helper to get or create a participant node
    function getOrCreateParticipant(localName: string, sourcePath: string, currentFilePath: string, receiverKind: 'instance' | 'function' = 'instance'): string {
        // For Python relative imports (.models, .serializers), prefer the PascalCase class name
        // (e.g. Todo, TodoSerializer) over the file basename (models, serializers).
        // BUG-POLAR-10: a snake_case receiver of a relative-import module (e.g.
        // `totp_factor` from `.factors`) is a CLASS INSTANCE, not the module — derive
        // its PascalCase class name (`TotpFactor`) so sibling classes in the same
        // module (`.factors`: BackupCodesFactor / TotpFactor / EmailOTPFactor) get
        // distinct, correctly-labeled participants instead of all collapsing into
        // whichever class was seen first.
        // BUG-POLAR-17: a snake_case FREE-FUNCTION call (`get_audit_context()` — NOT
        // `obj.method()`) is NOT a class instance. It maps to its MODULE, so all
        // free functions from one module (`.utils`: get_audit_context, get_customer)
        // share ONE `utils` lane instead of one PascalCase lane per function.
        let cleanName: string;
        if (sourcePath.startsWith('.')) {
            if (/^[A-Z]/.test(localName)) {
                cleanName = localName; // PascalCase class/constructor — distinct per class.
            } else if (receiverKind === 'instance' && /_[a-z]/.test(localName)) {
                cleanName = localName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(''); // BUG-POLAR-10
            } else {
                // BUG-POLAR-17: free-function call (or class-less receiver) → module basename.
                const stripped = sourcePath.replace(/^[./]+/, '');
                cleanName = (stripped.split(/[/.]/).filter(Boolean).pop() || stripped)
                    .replace(/\.(py|go|java|rb|php|rs|cs|ts|js)$/, '') || sourcePath;
            }
        } else if (sourcePath.includes('/')) {
            cleanName = sourcePath.split('/')[0];
        } else {
            cleanName = shortenQualifiedName(sourcePath);
        }

        // BUG-POLAR-10: dedupe by (source, label) — NOT source alone — so distinct
        // classes/receivers from the same module don't merge into one mislabeled node.
        const existingNode = nodes.find(n => n.body === sourcePath && n.label === cleanName && n.type === 'participant');
        if (existingNode) return existingNode.id;

        const sysKind = classifyExternalSystem(sourcePath);
        const lowerClean = cleanName.toLowerCase();
        const subtitle = sysKind === 'database' ? '«database»'
            : sysKind === 'cache' ? '«cache»'
            : sysKind === 'storage' ? '«storage»'
            : sysKind === 'service' ? '«service»'
            : sourcePath.startsWith('.') ? '«module»'
            : lowerClean.endsWith('repository') || lowerClean.endsWith('dao') ? '«repository»'
            : lowerClean.endsWith('service') ? '«service»'
            : lowerClean.endsWith('client') ? '«client»'
            : '«participant»';

        const resolved = resolver ? resolver(sourcePath, currentFilePath) : undefined;
        const resolvedFilePath = resolved ? resolved.filePath : undefined;
        
        const participantDiff: DiffStatus = baselineSources && !baselineSources.has(sourcePath) ? 'added' : 'unchanged';

        const extNode: GraphNode = {
            id: nextId('participant'), type: 'participant',
            label: cleanName, subtitle, body: sourcePath,
            diff: participantDiff, anchor: resolvedFilePath ? { filePath: resolvedFilePath } : undefined,
        };
        nodes.push(extNode);
        return extNode.id;
    }

    // Entry messages: client → module (one per API endpoint, filtered by entryHandlerName if given)
    // Added BEFORE the BFS so the inbound HTTP request appears first in the diagram.
    const entryApis = entryHandlerName
        ? apis.filter(a => a.handlerName === entryHandlerName)
        : apis;
    for (const api of entryApis) {
        edges.push({
            id: nextId('edge'), source: clientNode.id, target: moduleNode.id,
            label: `${api.method} ${api.route}`, edgeType: 'message', diff: 'unchanged', styleKind: 'normal',
        });
    }

    // Connect handler requests and trace them using a BFS queue
    // entryFunc is already resolved above

    const queue: Array<{
        callerId: string;
        funcName: string;
        memberCalls: Map<string, Set<string>> | undefined;
        calls?: Set<string>;
        importsByLocal: Map<string, string>;
        injectedDeps: Map<string, string> | undefined;
        /** Local var → import source map extracted at parse time */
        localVarTypes?: Map<string, string>;
        filePath: string;
        depth: number;
    }> = [];

    // CBV resolution: when handlerName is a PascalCase class (e.g. Django/DRF MeView)
    // imported into urls.py, it won't be found in analysis.funcs (which belongs to urls.py).
    // Resolve the class to its source file via the resolver, find the HTTP method handler
    // (GET → get, POST → post, …), and bootstrap BFS from that method in the views file.
    if (!entryFunc && entryHandlerName && snapshotFiles && resolver) {
        const isPascalCase = /^[A-Z][a-zA-Z0-9]*$/.test(entryHandlerName);
        const classSource = isPascalCase ? analysis.importsByLocal.get(entryHandlerName) : undefined;
        if (classSource) {
            const resolved = resolver(classSource, filePath);
            if (resolved?.filePath) {
                const viewsFile = snapshotFiles[resolved.filePath];
                if (viewsFile) {
                    // Collect all HTTP methods defined in this view class.
                    // Python stores methods as 'ClassName.method' (e.g. 'TodoListView.get');
                    // other languages (Java) may use bare method names — both forms are checked.
                    const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
                    const definedMethods = HTTP_METHODS.filter(m =>
                        viewsFile.symbols.functions.some(
                            f => f.name === `${entryHandlerName}.${m}` || f.name === m
                        )
                    );
                    const methodsToTrace = definedMethods.length > 0 ? definedMethods : ['get'];

                    // Build the view participant node once; share it across all method dispatch edges.
                    let viewNode: GraphNode | undefined;
                    for (const httpMethod of methodsToTrace) {
                        const methodFuncName = `${entryHandlerName}.${httpMethod}`;
                        const methodFunc = viewsFile.symbols.functions.find(
                            f => f.name === methodFuncName || f.name === httpMethod
                        );
                        if (!methodFunc) continue;

                        if (!viewNode) {
                            viewNode = {
                                id: nextId('participant'), type: 'participant',
                                label: entryHandlerName, subtitle: '«view»', body: resolved.filePath,
                                diff: 'unchanged', anchor: { filePath: resolved.filePath },
                            };
                            nodes.push(viewNode);
                        }

                        // Dispatch edge with anchor → navigates to the method's flow diagram on click
                        const dispatchEdgeId = nextId('edge');
                        edges.push({
                            id: dispatchEdgeId, source: moduleNode.id, target: viewNode.id,
                            label: `${entryHandlerName}.${httpMethod}(request)`,
                            edgeType: 'message', diff: 'unchanged', styleKind: 'normal',
                        });
                        anchors[dispatchEdgeId] = { filePath: resolved.filePath, symbol: methodFuncName };

                        // Build imports from the view file for BFS traversal
                        const viewImports = new Map(
                            viewsFile.symbols.imports.map(i => [i.specifiers[0]?.local || i.source, i.source])
                        );
                        const rawDeps = viewsFile.symbols.injectedDeps;
                        const viewDeps: Map<string, string> | undefined = rawDeps instanceof Map ? rawDeps
                            : rawDeps ? new Map(Object.entries(rawDeps).filter(([, v]) => typeof v === 'string') as [string, string][])
                            : undefined;
                        const rawMC = methodFunc.memberCalls;
                        const viewMemberCalls: Map<string, Set<string>> | undefined = rawMC instanceof Map ? rawMC
                            : rawMC && Object.keys(rawMC).length > 0
                                ? new Map(Object.entries(rawMC).map(([k, v]) => [k, new Set(Array.isArray(v) ? v : [])]))
                                : undefined;
                        const viewCalls = methodFunc.calls
                            ? new Set(Array.isArray(methodFunc.calls) ? methodFunc.calls : [...methodFunc.calls])
                            : undefined;
                        const rawLVT = methodFunc.localVarTypes;
                        const viewLocalVarTypes: Map<string, string> | undefined = rawLVT instanceof Map ? rawLVT
                            : rawLVT ? new Map(Object.entries(rawLVT).filter(([, v]) => typeof v === 'string') as [string, string][])
                            : undefined;
                        queue.push({
                            callerId: viewNode.id,
                            funcName: methodFuncName,
                            memberCalls: viewMemberCalls,
                            calls: viewCalls,
                            importsByLocal: viewImports,
                            injectedDeps: viewDeps,
                            localVarTypes: viewLocalVarTypes,
                            filePath: resolved.filePath,
                            depth: 0,
                        });
                    }
                }
            }
        }
    }

    if (entryFunc) {
        // Augment the local-to-source map with method parameter types so BFS can resolve
        // calls like `user.getId()` where `user` is an `AuthenticatedUser` parameter.
        const augmentedImports = new Map(analysis.importsByLocal);
        if (entryFunc.node) {
            const paramsNode = (entryFunc.node as any).childForFieldName?.('parameters')
                ?? (entryFunc.node as any).children?.find((c: any) => c.type === 'formal_parameters' || c.type === 'parameters');
            if (paramsNode) {
                const PARAM_PRIMITIVES = new Set([
                    'int', 'long', 'double', 'float', 'boolean', 'byte', 'short', 'char',
                    'void', 'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean',
                    'Object', 'Number', 'List', 'Map', 'Set', 'Optional', 'ResponseEntity',
                ]);
                for (const param of (paramsNode.children ?? [])) {
                    if (param.type !== 'formal_parameter' && param.type !== 'spread_parameter') continue;
                    const typeNode = param.childForFieldName?.('type')
                        ?? param.children?.find((c: any) => c.type === 'type_identifier' || c.type === 'generic_type');
                    const nameNode = param.childForFieldName?.('name')
                        ?? param.children?.find((c: any) => c.type === 'identifier');
                    if (!typeNode || !nameNode) continue;
                    const typeName = typeNode.type === 'generic_type'
                        ? (typeNode.children?.find((c: any) => c.type === 'type_identifier')?.text ?? typeNode.text)
                        : typeNode.text;
                    const paramName = nameNode.text;
                    if (!typeName || PARAM_PRIMITIVES.has(typeName) || augmentedImports.has(paramName)) continue;
                    const resolvedSource = analysis.importsByLocal.get(typeName)
                        ?? analysis.injectedDeps?.get(typeName)
                        ?? typeName;
                    augmentedImports.set(paramName, resolvedSource);
                }
            }
        }
        queue.push({
            callerId: moduleNode.id,
            funcName: entryHandlerName!,
            memberCalls: entryFunc.memberCalls,
            calls: entryFunc.calls,
            importsByLocal: augmentedImports,
            injectedDeps: analysis.injectedDeps,
            localVarTypes: entryFunc.localVarTypes,
            filePath: filePath,
            depth: 0,
        });
    }

    const maxDepth = 8;
    const visited = new Set<string>();

    while (queue.length > 0) {
        const { callerId, funcName, memberCalls, calls: callerCalls, importsByLocal, injectedDeps, localVarTypes, filePath: currentFilePath, depth } = queue.shift()!;
        
        const visitKey = `${currentFilePath}::${funcName}`;
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);

        if (memberCalls && memberCalls.size > 0) {
            for (const [receiver, methods] of memberCalls) {
                // Skip self-references (Java 'this', Python 'self')
                if (receiver === 'this' || receiver === 'self') {
                    continue;
                }

                // Resolve receiver to a source dependency
                // Priority: imports → injectedDeps → localVarTypes (e.g. serializer = RegisterSerializer(...))
                let source = importsByLocal.get(receiver) || injectedDeps?.get(receiver) || localVarTypes?.get(receiver);
                if (!source) {
                    const lowerReceiver = receiver.toLowerCase();
                    for (const [local, src] of importsByLocal.entries()) {
                        if (local.toLowerCase() === lowerReceiver) { source = src; break; }
                    }
                    if (!source && injectedDeps) {
                        for (const [local, src] of injectedDeps.entries()) {
                            if (local.toLowerCase() === lowerReceiver) { source = src; break; }
                        }
                    }
                    if (!source && localVarTypes) {
                        for (const [local, src] of localVarTypes.entries()) {
                            if (local.toLowerCase() === lowerReceiver) { source = src; break; }
                        }
                    }
                }

                // Tier 3: LSP fallback snapshot scan — resolves types tree-sitter missed
                // (generics, re-exports, interface→impl, etc.)
                if (!source && lspFallbackResolver && snapshotFiles) {
                    const resolved = lspFallbackResolver.resolveFromSnapshot(receiver, snapshotFiles);
                    if (resolved) {
                        source = resolved.filePath;
                    }
                }

                if (!source) continue;

                if (isFrameworkNoise(source) || isDataModel(receiver, source)) continue;

                const extNodeId = getOrCreateParticipant(receiver, source, currentFilePath);
                const extNode = nodes.find(n => n.id === extNodeId);
                const participantDiff = extNode?.diff || 'unchanged';

                for (const method of methods) {
                    const edgeId = nextId('edge');
                    edges.push({
                        id: edgeId, source: callerId, target: extNodeId,
                        label: `${receiver}.${method}()`, edgeType: 'message', diff: participantDiff, styleKind: 'normal',
                    });
                    // Add return message (reverse direction)
                    edges.push({
                        id: nextId('edge'), source: extNodeId, target: callerId,
                        label: 'result', edgeType: 'message', diff: participantDiff, styleKind: 'normal',
                        meta: { isReturn: true },
                    });

                    // Trace deeper if snapshot files are provided
                    if (snapshotFiles && depth < maxDepth) {
                        const resolved = resolver ? resolver(source, currentFilePath) : undefined;
                        if (resolved && resolved.filePath) {
                            const targetFile = snapshotFiles[resolved.filePath];
                            // Add anchor for edge navigation.
                            // Include symbol only when the method is actually defined in the target file
                            // (i.e. has a flow graph). For inherited methods (e.g. serializer.is_valid()),
                            // only set filePath so the click falls back to the file diagram.
                            // Find the callee function in the target file.
                            // Python stores methods as 'ClassName.method'; also check bare name.
                            const targetFuncRecord = targetFile?.symbols?.functions?.find(
                                f => f.name === method || f.name.endsWith(`.${method}`)
                            );
                            anchors[edgeId] = targetFuncRecord
                                ? { filePath: resolved.filePath, symbol: targetFuncRecord.name }
                                : { filePath: resolved.filePath };
                            if (targetFile) {
                                // OOP languages store functions as "ClassName.methodName"; check both exact and suffix.
                                const targetFunc = targetFile.symbols.functions.find(
                                    f => f.name === method || f.name.endsWith(`.${method}`)
                                );
                                if (targetFunc) {
                                    // Normalize Record<string,string[]> → Map (survives JSON round-trip)
                                    const rawMC = targetFunc.memberCalls;
                                    const memberCallsMap: Map<string, Set<string>> | undefined = rawMC instanceof Map
                                        ? rawMC
                                        : rawMC && Object.keys(rawMC).length > 0
                                            ? new Map(Object.entries(rawMC).map(([k, v]) => [k, new Set(Array.isArray(v) ? v : [])]))
                                            : undefined;
                                    // Normalize Record<string,string> → Map
                                    const rawDeps = targetFile.symbols.injectedDeps;
                                    const injectedDepsMap: Map<string, string> | undefined = rawDeps instanceof Map
                                        ? rawDeps
                                        : rawDeps ? new Map(Object.entries(rawDeps).filter(([, v]) => typeof v === 'string') as [string, string][])
                                        : undefined;
                                    const rawLVT2 = targetFunc.localVarTypes;
                                    const targetLocalVarTypes: Map<string, string> | undefined = rawLVT2 instanceof Map ? rawLVT2
                                        : rawLVT2 ? new Map(Object.entries(rawLVT2).filter(([, v]) => typeof v === 'string') as [string, string][])
                                        : undefined;
                                    queue.push({
                                        callerId: extNodeId,
                                        funcName: targetFunc.name,
                                        memberCalls: memberCallsMap,
                                        calls: targetFunc.calls ? new Set(targetFunc.calls) : undefined,
                                        importsByLocal: new Map(targetFile.symbols.imports.map(i => [i.specifiers[0]?.local || i.source, i.source])),
                                        injectedDeps: injectedDepsMap,
                                        localVarTypes: targetLocalVarTypes,
                                        filePath: resolved.filePath,
                                        depth: depth + 1,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        } else if (depth === 0) {
            // Fallback for root module if no specific member calls are found (e.g. tree-sitter lacking coverage)
            for (const [localName, extNodeId] of participantNameToId) {
                const extNode = nodes.find(n => n.id === extNodeId);
                const cleanName = extNode?.label || localName;
                const participantDiff = extNode?.diff || 'unchanged';
                edges.push({
                    id: nextId('edge'), source: moduleNode.id, target: extNodeId,
                    label: `${cleanName}()`, edgeType: 'message', diff: participantDiff, styleKind: 'normal',
                });
            }
        }

        // Direct constructor/function calls (e.g. RegisterSerializer(...), TodoSerializer(...))
        // These appear in the flat `calls` set but not in memberCalls. Emit one message edge
        // per call that resolves to a non-noise import not already covered by memberCalls.
        if (callerCalls) {
            for (const callName of callerCalls) {
                // BUG-POLAR-4: FastAPI DI markers (Depends/Query/…) + raised
                // exception constructors are not real runtime calls — filter them
                // from the Python/analysis sequence path too (JS path handled above).
                if (isSequenceNoiseCall(callName)) continue;
                const source = importsByLocal.get(callName) || localVarTypes?.get(callName);
                if (!source || isFrameworkNoise(source) || isDataModel(callName, source)) continue;
                if (memberCalls?.has(callName)) continue; // already covered
                // BUG-POLAR-17: this is a DIRECT call (`callName(...)`), so a snake_case
                // name is a free function → map to its module, not a per-fn class lane.
                const extNodeId = getOrCreateParticipant(callName, source, currentFilePath, 'function');
                const participantDiff = nodes.find(n => n.id === extNodeId)?.diff || 'unchanged';
                const callEdgeId = nextId('edge');
                edges.push({
                    id: callEdgeId, source: callerId, target: extNodeId,
                    label: `${callName}()`, edgeType: 'message', diff: participantDiff, styleKind: 'normal',
                });
                // Return message
                edges.push({
                    id: nextId('edge'), source: extNodeId, target: callerId,
                    label: 'result', edgeType: 'message', diff: participantDiff, styleKind: 'normal',
                    meta: { isReturn: true },
                });
                // Add anchor for navigation: clicking this edge opens the called function/class
                const resolvedCall = resolver ? resolver(source, currentFilePath) : undefined;
                if (resolvedCall?.filePath) {
                    anchors[callEdgeId] = { filePath: resolvedCall.filePath, symbol: callName };
                }
            }
        }
    }

    // When the handler body changed, also mark message edges FROM the handler module node
    // as modified — they represent calls whose calling context changed.
    if (handlerBodyChanged) {
        for (const edge of edges) {
            if (edge.edgeType === 'message' && edge.source === moduleNode.id && edge.diff === 'unchanged') {
                edge.diff = 'modified';
            }
        }
    }

    // Propagate participant diff to remaining unchanged message edges.
    // If a participant is modified/added, edges to/from it should inherit that status
    // so the message lines visually reflect the change.
    for (const edge of edges) {
        if (edge.edgeType !== 'message' || edge.diff !== 'unchanged') continue;
        const sourceNode = nodes.find(n => n.id === edge.source);
        const targetNode = nodes.find(n => n.id === edge.target);
        const pDiff = (targetNode?.diff && targetNode.diff !== 'unchanged') ? targetNode.diff
            : (sourceNode?.diff && sourceNode.diff !== 'unchanged') ? sourceNode.diff
            : undefined;
        if (pDiff) {
            edge.diff = pDiff;
        }
    }

    // Issue 336 (parity with buildSequenceGraph above): drop participant nodes
    // that carry zero incident message edges — they're imports the handler
    // never actually called and add visual noise. Diff ghosts (added/deleted/
    // modified) are preserved so the diff overlay still shows them.
    const connectedNodeIds = new Set<string>();
    for (const e of edges) {
        if (e.source) connectedNodeIds.add(e.source);
        if (e.target) connectedNodeIds.add(e.target);
    }
    const prunedNodes = nodes.filter(n => {
        if (n.type !== 'participant') return true;
        if (connectedNodeIds.has(n.id)) return true;
        if (n.diff && n.diff !== 'unchanged') return true;
        return false;
    });

    const graphId = entryHandlerName ? `sequence:${filePath}:${entryHandlerName}` : `sequence:${filePath}`;
    normalizeAnchorPaths(prunedNodes, anchors, snapshotFiles); // #862 — relative anchor paths
    return { graphId, type: 'sequence', nodes: prunedNodes, edges, anchors, meta: { filePath, fileName, handlerName: entryHandlerName } };
}

// ─── #824 — synthetic one-participant sequence for IaC / unresolved handlers ──

/**
 * Build the minimal honest L3 sequence for an api record whose handler the
 * sequence builders skipped (IaC-extracted Serverless/SAM/CDK routes, or
 * handlers without a parsed call chain): API Client → handler module with
 * a single message edge. Keeps the L2b click destination consistent with
 * every other HTTP route ("appears everywhere your HTTP routes do") and
 * gives tours/deep links a real graph instead of the #839 fallback chain.
 * `meta.synthetic = true` lets the renderer (and tests) tell it apart.
 */
export function buildSyntheticSequenceGraph(api: ApiRecord): DiagramGraph {
    const fileName = baseName(api.filePath);
    const clientId = 'participant_synthetic_client';
    const moduleId = 'participant_synthetic_module';
    const edgeId = 'edge_synthetic_0';
    return {
        graphId: `sequence:${api.filePath}:${api.handlerName}`,
        type: 'sequence',
        nodes: [
            {
                id: clientId, type: 'participant', label: 'API Client',
                subtitle: '«actor»', body: 'Inbound requests',
                diff: 'unchanged', anchor: { filePath: api.filePath },
            },
            {
                id: moduleId, type: 'participant', label: fileName,
                subtitle: '«module»', body: fileName,
                diff: 'unchanged', anchor: { filePath: api.filePath, symbol: api.handlerName },
            },
        ],
        edges: [{
            id: edgeId, source: clientId, target: moduleId,
            label: `${String(api.method).toUpperCase()} ${api.route}`,
            edgeType: 'message', diff: 'unchanged', styleKind: 'normal',
        } as GraphEdge],
        anchors: { [edgeId]: { filePath: api.filePath, symbol: api.handlerName } },
        meta: {
            synthetic: true,
            apiId: api.apiId,
            method: api.method,
            route: api.route,
            handlerName: api.handlerName,
        },
    };
}
