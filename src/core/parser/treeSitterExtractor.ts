/**
 * treeSitterExtractor.ts
 *
 * Universal symbol extractor using Tree-sitter.
 * Replaces Babel-based symbolExtractor.ts for non-JS languages.
 *
 * Extracts: functions, classes, imports, variables, decorators
 * Returns the same FileAnalysis / EntityRecord types so all downstream
 * graph builders (sequence, file, flow), diff engine, and call graph work unchanged.
 *
 * As of Issue #703 (Phase 3), all per-language `LanguageSpec` definitions
 * live in `specs/<lang>.ts` and are aggregated by `specs/index.ts`. This
 * module is the dispatcher: it owns the AST walk, the call extractor,
 * and the Dart regex fallback used when the bundled tree-sitter-dart
 * grammar can't parse Dart 3.x syntax.
 */

import { type SupportedLanguage, parseSource } from './treeSitterParser';
import type { EntityRecord } from '../graph/graphTypes';
import {
    type LanguageSpec,
    type TSNode,
    LANGUAGE_SPECS,
    findChild,
    findChildByField,
    nodeText,
} from './specs';

export type { TSNode, LanguageSpec } from './specs';

// Re-use existing FileAnalysis shape from symbolExtractor
export interface FileAnalysis {
    entities: EntityRecord[];
    funcs: Map<string, EntityRecord>;
    vars: Map<string, EntityRecord>;
    importsByLocal: Map<string, string>;
    /** Class-field type dependencies NOT covered by explicit imports (e.g. same-package DI in Java/Spring). */
    injectedDeps: Map<string, string>;
    /** MCP-EVAL-4 — function names referenced by a framework wrapper (`Depends(fn)`). */
    frameworkRefs: Set<string>;
    fileName: string;
}

// ─── Helper functions ──────────────────────────────────────────────────────

function firstLineOf(text: string): string {
    const idx = text.indexOf('\n');
    return idx >= 0 ? text.slice(0, idx) : text;
}

function truncate(s: string, max: number = 200): string {
    return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── Main Extraction Function ───────────────────────────────────────────────

/**
 * Extract code symbols (functions, classes, imports, variables) from a parsed tree-sitter AST.
 *
 * @param tree - Parsed tree-sitter tree with a `rootNode` property
 * @param source - Raw source code string (used for text extraction)
 * @param language - Detected language for selecting the correct LanguageSpec
 * @param fileName - Workspace-relative file name (used in entity keys)
 * @returns FileAnalysis containing entities, funcs, vars, importsByLocal, and injectedDeps
 */
export function extractSymbols(
    tree: { rootNode: TSNode },
    source: string,
    language: SupportedLanguage,
    fileName: string = 'file'
): FileAnalysis {
    const spec = LANGUAGE_SPECS[language];
    if (!spec) {
        throw new Error(`No language spec for: ${language}`);
    }

    const entities: EntityRecord[] = [];
    const funcs = new Map<string, EntityRecord>();
    const vars = new Map<string, EntityRecord>();
    const importsByLocal = new Map<string, string>();
    const injectedDeps = new Map<string, string>();
    const frameworkRefs = new Set<string>();

    const root = tree.rootNode;

    // Walk all top-level nodes (and class members for OOP languages)
    walkNode(root, spec, source, fileName, entities, funcs, vars, importsByLocal, injectedDeps, frameworkRefs, 0);

    // MCP-EVAL-4: also collect `Depends(fn)` / `Security(fn)` references at the
    // WHOLE-FILE level. FastAPI dependency aliases are usually MODULE-level
    // (`CurrentUser = Annotated[User, Depends(_web_user)]`), which the
    // per-function walk above never reaches. The referenced providers are
    // framework-reachable even though nothing calls them directly.
    collectFrameworkRefs(root, frameworkRefs);

    return { entities, funcs, vars, importsByLocal, injectedDeps, frameworkRefs, fileName };
}

function walkNode(
    node: TSNode,
    spec: LanguageSpec,
    source: string,
    fileName: string,
    entities: EntityRecord[],
    funcs: Map<string, EntityRecord>,
    vars: Map<string, EntityRecord>,
    importsByLocal: Map<string, string>,
    injectedDeps: Map<string, string>,
    frameworkRefs: Set<string>,
    depth: number,
    parentClassName: string | null = null,
): void {
    for (const child of node.children) {
        const nodeType = child.type;

        // ── Namespace / module / import containers: recurse to find inner nodes ──
        // C# 10+ uses `file_scoped_namespace_declaration` (semicolon form, no braces)
        // which wraps the class declarations as direct children. Kotlin wraps imports
        // in an `import_list` whose children are individual `import_header` nodes.
        // Without recursion the inner nodes are never visited.
        if (
            nodeType === 'namespace_declaration' ||
            nodeType === 'file_scoped_namespace_declaration' ||
            nodeType === 'import_list' ||
            // Issue 344: tree-sitter Python wraps decorated functions in
            // `decorated_definition` (`@router.get("/") def read_items(...)`).
            // Without recursion the inner `function_definition` is never visited
            // and FastAPI/Flask/Django route handlers never get flow graphs.
            nodeType === 'decorated_definition'
        ) {
            walkNode(child, spec, source, fileName, entities, funcs, vars, importsByLocal, injectedDeps, frameworkRefs, depth, parentClassName);
            continue;
        }

        // ── Functions ──
        if (spec.functionTypes.includes(nodeType)) {
            const rawName = spec.getFunctionName(child);
            if (rawName) {
                const name = parentClassName ? `${parentClassName}.${rawName}` : rawName;
                const signature = spec.getFunctionSignature(child, source);
                const bodyText = truncate(nodeText(child, source), 3000);
                const decorators = spec.getDecorators?.(child, source) ?? [];
                const key = parentClassName ? `${fileName}::${parentClassName}::${rawName}` : `${fileName}::${rawName}`;

                // Extract calls made within this function
                const calls = new Set<string>();
                const memberCalls = new Map<string, Set<string>>();
                extractCalls(child, calls, memberCalls, frameworkRefs);

                // Python only: extract local variable type assignments (e.g. todo = Todo.objects.get(...))
                let localVarTypes: Map<string, string> | undefined;
                if (spec.getLocalVarTypes) {
                    const lvtPairs = spec.getLocalVarTypes(child, importsByLocal);
                    if (lvtPairs.length > 0) {
                        localVarTypes = new Map(lvtPairs.map(p => [p.local, p.source]));
                    }
                }

                const record: EntityRecord = {
                    kind: 'function',
                    name,
                    key,
                    signature: decorators.length > 0
                        ? `${decorators.join('\n')}\n${signature}`
                        : signature,
                    bodyText,
                    locText: `${fileName}:${child.startPosition.row + 1}`,
                    calls,
                    memberCalls,
                    localVarTypes,
                    // MCP-EVAL-4: keep the decorator source so downstream (dead-code
                    // reachability) can recognise framework-registered functions.
                    decorators: decorators.length > 0 ? decorators : undefined,
                    node: child,
                };
                entities.push(record);
                funcs.set(name, record);

                // Extract function parameter injected dependencies (e.g. FastAPI Depends)
                if (spec.getFunctionDependencies) {
                    const deps = spec.getFunctionDependencies(child, importsByLocal);
                    for (const dep of deps) {
                        if (!injectedDeps.has(dep.local)) {
                            injectedDeps.set(dep.local, dep.source);
                        }
                    }
                }

                // Issue 350: descend into the fn body to pick up nested fns
                // (Rust `async fn handler(…)` declared inside helper builders
                // like `fn admin_routes()` in axum's
                // `examples/key-value-store/src/main.rs`). Walks the body
                // block (or its equivalent — Rust `block`, Python
                // `block` / `function_definition`'s body, etc.) so the inner
                // function_item gets a flow graph.
                const bodyChild = child.children.find(c =>
                    c.type === 'block'
                    || c.type === 'function_body'
                    || c.type === 'compound_statement'
                    || c.type === 'body_statement'
                    || c.type === 'statement_block'
                );
                if (bodyChild) {
                    walkNode(bodyChild, spec, source, fileName, entities, funcs, vars, importsByLocal, injectedDeps, frameworkRefs, depth + 1, parentClassName);
                }
            }
        }

        // ── Classes ──
        if (spec.classTypes.includes(nodeType)) {
            const rawName = spec.getClassName(child);
            if (rawName) {
                // #444-C: when a class is nested inside another class (C# MediatR
                // pattern, Java inner classes, Kotlin nested classes, Swift nested
                // types) prefix the parent class name so identifiers remain
                // globally unique within the file and methods inherit the full
                // chain (e.g. `Create.Handler.Handle` not `Handler.Handle`).
                const name = parentClassName ? `${parentClassName}.${rawName}` : rawName;
                const bodyText = truncate(nodeText(child, source), 1000);
                const decorators = spec.getDecorators?.(child, source) ?? [];
                const key = `${fileName}::${name}`;

                // Extract class hierarchy (extends/implements)
                const hierarchy = spec.getClassHierarchy?.(child, source);

                const record: EntityRecord = {
                    kind: 'class',
                    name,
                    key,
                    signature: decorators.length > 0
                        ? `${decorators.join('\n')}\nclass ${name}`
                        : `class ${name}`,
                    bodyText,
                    locText: `${fileName}:${child.startPosition.row + 1}`,
                    node: child,
                    extendsClass: hierarchy?.extendsClass,
                    implementsInterfaces: hierarchy?.implementsInterfaces,
                };
                entities.push(record);

                // Also extract methods inside the class body
                const body = findChildByField(child, 'body')
                    ?? findChild(child, 'class_body')
                    ?? findChild(child, 'declaration_list')
                    ?? findChild(child, 'block');
                if (body) {
                    walkNode(body, spec, source, fileName, entities, funcs, vars, importsByLocal, injectedDeps, frameworkRefs, depth + 1, name);
                    // Collect field-injected dependencies (e.g. Spring @Autowired, Lombok DI)
                    if (spec.getFieldDependencies) {
                        const deps = spec.getFieldDependencies(body, importsByLocal);
                        for (const dep of deps) {
                            if (!injectedDeps.has(dep.local)) {
                                injectedDeps.set(dep.local, dep.source);
                            }
                        }
                    }
                }
            }
        }

        // ── Imports ──
        if (spec.importTypes.includes(nodeType)) {
            const imports = spec.getImports(child, source);
            for (const imp of imports) {
                if (!imp.local) continue;  // skip extractor edge cases that yield empty names
                importsByLocal.set(imp.local, imp.source);
            }

            const bodyText = nodeText(child, source);
            for (const imp of imports) {
                if (!imp.local) continue;
                const record: EntityRecord = {
                    kind: 'import',
                    name: imp.local,
                    key: `import::${imp.source}::${imp.local}`,
                    signature: firstLineOf(bodyText),
                    bodyText,
                    locText: `${fileName}:${child.startPosition.row + 1}`,
                };
                entities.push(record);
            }
        }

        // ── Variables (top-level OR class-level fields at depth 1) ──
        if (depth <= 1 && spec.variableTypes.includes(nodeType)) {
            const name = spec.getVariableName(child);
            if (name) {
                // Skip if it's actually a function (arrow function assigned to var)
                if (!funcs.has(name)) {
                    const bodyText = truncate(nodeText(child, source));
                    const record: EntityRecord = {
                        kind: 'variable',
                        name,
                        key: `${fileName}::${name}`,
                        signature: firstLineOf(bodyText),
                        bodyText,
                        locText: `${fileName}:${child.startPosition.row + 1}`,
                    };
                    entities.push(record);
                    vars.set(name, record);
                }
            }
        }
    }
}

/**
 * Extract function/method call names from a node and its descendants.
 * Populates both a flat `calls` set (method names only) and a `memberCalls` map
 * (receiver → set of method names, e.g. todoService → {save, findAll}).
 */
/**
 * MCP-EVAL-4: walk the WHOLE file collecting first-arg function references of
 * framework-invocation wrappers (`Depends(fn)`, `Security(fn)`). Covers both
 * module-level dependency aliases and in-function param defaults.
 */
function collectFrameworkRefs(node: TSNode, refs: Set<string>): void {
    if (node.type === 'call' || node.type === 'call_expression') {
        const fn = node.childForFieldName('function') ?? node.children[0];
        if (fn && (fn.type === 'identifier' || fn.type === 'simple_identifier')
            && (fn.text === 'Depends' || fn.text === 'Security')) {
            const args = node.childForFieldName('arguments') ?? node.children.find(c => c.type === 'argument_list' || c.type === 'arguments');
            const firstArg = args?.children.find(c => c.type === 'identifier' || c.type === 'attribute');
            if (firstArg) refs.add(firstArg.text.split('.').pop() ?? firstArg.text);
        }
    }
    for (const child of node.children) collectFrameworkRefs(child, refs);
}

function extractCalls(node: TSNode, calls: Set<string>, memberCalls?: Map<string, Set<string>>, frameworkRefs?: Set<string>): void {
    if (node.type === 'call_expression' || node.type === 'invocation_expression' || node.type === 'method_invocation' || node.type === 'call') {
        const funcNode = node.childForFieldName('function')
            ?? node.childForFieldName('name')
            ?? node.children[0];

        // MCP-EVAL-4: a framework-invocation wrapper — `Depends(get_db_session)`,
        // `Security(...)`, `Provide[...]` — REGISTERS its first-arg function with
        // the framework; that provider is reachable even though the static call
        // graph never sees a direct call to it. Record the referenced name.
        if (frameworkRefs && funcNode && (funcNode.type === 'identifier' || funcNode.type === 'simple_identifier')
            && (funcNode.text === 'Depends' || funcNode.text === 'Security')) {
            const argsNode = node.childForFieldName('arguments') ?? node.children.find(c => c.type === 'argument_list' || c.type === 'arguments');
            const firstArg = argsNode?.children.find(c => c.type === 'identifier' || c.type === 'attribute');
            if (firstArg) frameworkRefs.add(firstArg.text.split('.').pop() ?? firstArg.text);
        }

        // For Java `method_invocation`, the object is directly on the node, and the name is the method name identifier
        if (node.type === 'method_invocation') {
            const obj = node.childForFieldName('object');
            const prop = node.childForFieldName('name');
            if (prop && (prop.type === 'identifier' || prop.type === 'simple_identifier')) {
                calls.add(prop.text);
                if (memberCalls && obj && (obj.type === 'identifier' || obj.type === 'simple_identifier' || obj.type === 'this')) {
                    const receiver = obj.text;
                    if (!memberCalls.has(receiver)) memberCalls.set(receiver, new Set());
                    memberCalls.get(receiver)!.add(prop.text);
                }
            }
        } else if (funcNode) {
            if (funcNode.type === 'identifier' || funcNode.type === 'simple_identifier') {
                calls.add(funcNode.text);
            } else if (funcNode.type === 'member_expression' || funcNode.type === 'member_access_expression'
                || funcNode.type === 'field_expression' || funcNode.type === 'attribute') {
                // foo.bar() → extract "bar" into calls, and foo→bar into memberCalls
                const obj = funcNode.childForFieldName('object')
                    ?? funcNode.children[0];
                const prop = funcNode.childForFieldName('property')
                    ?? funcNode.childForFieldName('name')
                    ?? funcNode.childForFieldName('attribute');
                if (prop) {
                    calls.add(prop.text);
                    // Capture receiver.method pair for sequence diagrams
                    let receiverNode = obj;
                    while (receiverNode && (receiverNode.type === 'member_expression' || receiverNode.type === 'member_access_expression' || receiverNode.type === 'field_expression' || receiverNode.type === 'attribute')) {
                        receiverNode = receiverNode.childForFieldName('object') ?? receiverNode.children[0];
                    }
                    if (memberCalls && receiverNode && (receiverNode.type === 'identifier' || receiverNode.type === 'simple_identifier' || receiverNode.type === 'this')) {
                        const receiver = receiverNode.text;
                        if (!memberCalls.has(receiver)) memberCalls.set(receiver, new Set());
                        memberCalls.get(receiver)!.add(prop.text);
                    }
                }
            } else if (funcNode.type === 'scoped_identifier' || funcNode.type === 'qualified_identifier') {
                // Foo::bar()
                const nameNode = funcNode.childForFieldName('name');
                if (nameNode) calls.add(nameNode.text);
            }
        }
    }

    for (const child of node.children) {
        extractCalls(child, calls, memberCalls, frameworkRefs);
    }
}

/**
 * Parse a source string with the language-specific tree-sitter grammar and
 * extract every entity (function, class, variable, import) in one step.
 *
 * For non-JS/TS languages this is the primary symbol extractor. For JS/TS we
 * use the Babel-based path in `symbolExtractor.ts` because Babel has richer
 * support for TypeScript types + decorators.
 *
 * Languages with no registered tree-sitter grammar (e.g. plain text, JSON,
 * binary blobs) return an empty `FileAnalysis` so callers don't need to
 * branch on language; mobile detection still runs via regex in
 * `mobileDetector.ts`.
 *
 * @param source - Raw source code string
 * @param fileName - Workspace-relative path (used in entity keys + for path-
 *                   gated extractors)
 * @param language - Detected language; selects the LanguageSpec
 * @returns FileAnalysis with `entities`, `funcs`, `vars`, `importsByLocal`,
 *          `injectedDeps`. Empty arrays for languages without a grammar.
 * @throws Never — wasm/grammar load failures are logged and yield an empty
 *         analysis. Callers should treat the return value as best-effort.
 */
export async function extractFileSymbolsMultiLang(
    source: string,
    fileName: string,
    language: SupportedLanguage
): Promise<FileAnalysis> {
    // Languages without a tree-sitter grammar return empty analysis
    // (mobile detection still works via regex in mobileDetector.ts)
    if (!LANGUAGE_SPECS[language]) {
        return emptyFileAnalysis(fileName);
    }
    // Issue 346: bundled tree-sitter-dart grammar (tree-sitter-wasms@0.1.13)
    // doesn't recognize Dart 3.x syntax (switch expressions, abstract-final-
    // class, sealed/base modifiers, records, patterns). Tree-sitter still
    // produces a tree but with ERROR nodes, and downstream extraction may
    // throw or yield 0 entities. Fall back to a regex extractor so the file
    // still gets a file graph + symbol set (better than dropping it on the
    // floor, until the grammar is bumped).
    if (language === 'dart') {
        try {
            const tree = await parseSource(source, language);
            const tsAnalysis = extractSymbols({ rootNode: tree.rootNode as any }, source, language, fileName);
            const root: any = tree.rootNode;
            const treeHasErrors = root.hasError === true;
            // Use tree-sitter result if it produced entities AND no errors.
            // Otherwise merge with regex fallback (regex is additive — it can
            // only add entities tree-sitter missed, never override).
            if (tsAnalysis.entities.length > 0 && !treeHasErrors) return tsAnalysis;
            return mergeDartFallback(tsAnalysis, source, fileName);
        } catch {
            // Hard parse failure — synthesize from regex only.
            return extractDartViaRegex(source, fileName);
        }
    }
    // #903 — the non-Dart path had NO try/catch, so a missing/failed grammar
    // `.wasm` threw to the caller — contradicting the `@throws Never` contract
    // above and surfacing as the swallowed `[Rebuild] Failed` / cascade-skip
    // class. Degrade to an empty analysis (like the no-grammar branch) and warn
    // once per language so a genuinely-missing grammar is diagnosable.
    try {
        const tree = await parseSource(source, language);
        return extractSymbols({ rootNode: tree.rootNode as any }, source, language, fileName);
    } catch (err: any) {
        if (!grammarLoadWarned.has(language)) {
            grammarLoadWarned.add(language);
            // eslint-disable-next-line no-console
            console.error(`[treeSitterExtractor] grammar load/parse failed for '${language}' — files of this language yield empty entities (best-effort). ${err?.message ?? err}`);
        }
        return emptyFileAnalysis(fileName);
    }
}

/** Empty best-effort analysis — used for no-grammar languages AND #903 load failures. */
function emptyFileAnalysis(fileName: string): FileAnalysis {
    return {
        entities: [],
        funcs: new Map(),
        vars: new Map(),
        importsByLocal: new Map(),
        injectedDeps: new Map(),
        frameworkRefs: new Set(),
        fileName,
    };
}

/** #903 — one warning per language whose grammar failed to load (avoids log spam). */
const grammarLoadWarned = new Set<string>();

/**
 * Walk from a function-signature regex match position forward through the
 * source to extract the function body text. Handles both:
 *   - block body `name(...) { ... }` — walks balanced braces
 *   - expression body `name(...) => expr;` — captures the expression up to `;`
 * Returns empty string if no body opener is found within 100 chars (e.g.
 * an `abstract`/`external` declaration with no body).
 *
 * Critical for #445-A: this body text is what `buildFlowGraphFromBodyText`
 * uses to construct a flow graph for Dart functions, since the regex
 * extractor doesn't produce tree-sitter nodes.
 */
function extractDartBody(source: string, matchStart: number, matchText: string): string {
    const end = matchStart + matchText.length;
    const last = matchText[matchText.length - 1];
    if (last === '{') {
        // Block body — walk balanced braces starting at the `{`.
        let depth = 1;
        let i = end;
        while (i < source.length && depth > 0) {
            const c = source[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            // Skip strings to avoid counting braces inside literals.
            else if (c === '"' || c === "'") {
                const quote = c;
                i++;
                while (i < source.length && source[i] !== quote) {
                    if (source[i] === '\\') i++;
                    i++;
                }
            }
            i++;
        }
        // Body text is everything between the `{` and the matching `}`.
        // Bounded so a runaway brace-walk doesn't return the rest of the file.
        const bodyEnd = depth === 0 ? i - 1 : Math.min(source.length, end + 3000);
        return source.slice(end, bodyEnd).trim();
    }
    // Expression body `=> expr;` — already includes the `=>` in matchText.
    // Capture up to the next `;` (or `\n\n` for empty-statement Dart code).
    let i = end;
    let semi = source.indexOf(';', i);
    if (semi < 0 || semi - i > 1000) semi = i + 200;
    return source.slice(end, Math.min(source.length, semi)).trim();
}

/**
 * Issue 346: regex-based Dart entity extractor used as a fallback when the
 * bundled tree-sitter-dart grammar can't parse Dart 3.x syntax.
 *
 * Captures top-level class declarations (with widget-base detection),
 * top-level functions, and class methods. Imports are pulled from
 * `import 'package:foo/bar.dart';` lines.
 *
 * Approximation, not full AST. Good enough to:
 *   - give every Dart file a file graph (so the L4 ratio doesn't tank)
 *   - feed the symbol extractor enough names to build the cluster graph
 *   - mark the file as "parse-recovered" instead of "parse-failed"
 */
function extractDartViaRegex(source: string, fileName: string): FileAnalysis {
    const entities: any[] = [];
    const funcs = new Map<string, any>();
    const vars = new Map<string, any>();
    const importsByLocal = new Map<string, string>();
    const injectedDeps = new Map<string, string>();

    // Strip line + block comments and string literals so identifiers inside
    // them don't fire as entities. Conservative — we don't try to handle
    // multi-line raw strings perfectly.
    const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

    // Imports: `import 'package:foo/bar.dart' as alias;` or `as` omitted.
    const importRe = /^\s*import\s+['"]([^'"]+)['"](?:\s+as\s+(\w+))?\s*;/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(source)) !== null) {
        importsByLocal.set(m[2] || m[1].split('/').pop()!.replace(/\.dart$/, ''), m[1]);
    }

    // Dart 3.x extension types: `extension type Money(int amount) { … }`
    // and `extension type const Distance(double meters) { … }`. These
    // declare a new type that wraps a primitive.
    const extTypeRe = /^[ \t]*extension\s+type\s+(?:const\s+)?(\w+)(?:<[^>]+>)?\s*\([^)]*\)\s*(?:implements\s+[\w,<>\s]+?)?\s*\{/gm;
    while ((m = extTypeRe.exec(stripped)) !== null) {
        const name = m[1];
        const entity = {
            kind: 'class' as const,
            name,
            key: `class:${name}`,
            signature: `extension type ${name}`,
            bodyText: '',
            locText: m[0].trim(),
            calls: new Set<string>(),
            usesVars: new Set<string>(),
            usesImports: new Set<string>(),
        };
        entities.push(entity);
        funcs.set(name, entity);
    }

    // Dart mixin declarations: `mixin Foo on Bar { … }` or `mixin Foo { … }`.
    const mixinRe = /^[ \t]*(?:base\s+)?mixin\s+(\w+)(?:<[^>]+>)?\s*(?:on\s+[\w,<>\s]+?)?\s*(?:implements\s+[\w,<>\s]+?)?\s*\{/gm;
    while ((m = mixinRe.exec(stripped)) !== null) {
        const name = m[1];
        if (funcs.has(name)) continue; // class with same name takes priority
        const entity = {
            kind: 'class' as const,
            name,
            key: `class:${name}`,
            signature: `mixin ${name}`,
            bodyText: '',
            locText: m[0].trim(),
            calls: new Set<string>(),
            usesVars: new Set<string>(),
            usesImports: new Set<string>(),
        };
        entities.push(entity);
        funcs.set(name, entity);
    }

    // Dart enum declarations: `enum Foo { a, b, c; void method() { … } }`.
    // Modern Dart enums can have methods and constructors.
    const enumRe = /^[ \t]*enum\s+(\w+)(?:<[^>]+>)?\s*(?:with\s+[\w,<>\s]+?)?\s*(?:implements\s+[\w,<>\s]+?)?\s*\{/gm;
    while ((m = enumRe.exec(stripped)) !== null) {
        const name = m[1];
        if (funcs.has(name)) continue;
        const entity = {
            kind: 'class' as const,
            name,
            key: `class:${name}`,
            signature: `enum ${name}`,
            bodyText: '',
            locText: m[0].trim(),
            calls: new Set<string>(),
            usesVars: new Set<string>(),
            usesImports: new Set<string>(),
        };
        entities.push(entity);
        funcs.set(name, entity);
    }

    // Top-level class declarations, including Dart 3.x modifier combos
    // (`abstract final class`, `sealed class`, `base class`, `interface
    // class`, `mixin class`).
    const classRe = /^[ \t]*(?:abstract\s+|final\s+|interface\s+|base\s+|sealed\s+|mixin\s+)*class\s+(\w+)(?:<[^>]+>)?\s*(?:extends\s+(\w+)(?:<[^>]+>)?)?\s*(?:with\s+([\w,<>\s]+?))?\s*(?:implements\s+[\w,<>\s]+?)?\s*\{/gm;
    while ((m = classRe.exec(stripped)) !== null) {
        const name = m[1];
        const extendsClass = m[2] ?? undefined;
        const entity = {
            kind: 'class' as const,
            name,
            key: `class:${name}`,
            signature: `class ${name}`,
            bodyText: '',
            locText: m[0].trim(),
            calls: new Set<string>(),
            usesVars: new Set<string>(),
            usesImports: new Set<string>(),
            extendsClass,
        };
        entities.push(entity);
        funcs.set(name, entity);
    }

    // Top-level functions / class methods. Captures lines like:
    //   `Widget build(BuildContext context) {`
    //   `void onTap() {`
    //   `Future<List<int>> fetch(...) async {`
    //   `Stream<T> watch() async*`
    // Excludes constructor `: super(…)` lines (those start with `:`).
    const methodRe = /^[ \t]+(?:static\s+|@override\s+|abstract\s+|external\s+|final\s+|const\s+)*(?:[\w$]+(?:<(?:[^<>]|<[^<>]*>)*>)?(?:\?|!)?(?:\s+|\?\s+))?(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?:async\*?|sync\*|=>|\{)/gm;
    while ((m = methodRe.exec(stripped)) !== null) {
        const name = m[1];
        // Skip Dart reserved words that the regex could mistake for method names.
        if (/^(if|for|while|switch|return|new|throw|try|catch|finally|case|do|else|in|is|as|var|final|const|class|enum|extends|implements|with|abstract|super|this|null|true|false|void|dynamic|sync|async|await|yield)$/.test(name)) continue;
        if (funcs.has(name)) continue; // already added (class with same name) — keep class
        const bodyText = extractDartBody(source, m.index ?? 0, m[0]);
        const entity = {
            kind: 'function' as const,
            name,
            key: `function:${name}`,
            signature: `function ${name}()`,
            bodyText,
            locText: m[0].trim(),
            calls: new Set<string>(),
            usesVars: new Set<string>(),
            usesImports: new Set<string>(),
        };
        entities.push(entity);
        funcs.set(name, entity);
    }

    // Top-level functions at column zero (not indented inside a class).
    // Return-type pattern allows one level of nested generics (e.g.
    // `Future<List<int>>`, `Stream<Map<String, T>>`) — common in Dart.
    const topFnRe = /^(?:[\w$]+(?:<(?:[^<>]|<[^<>]*>)*>)?(?:\?|!)?\s+)?(\w+)\s*\([^)]*\)\s*(?:async\*?|=>|\{)/gm;
    while ((m = topFnRe.exec(stripped)) !== null) {
        // Only accept if the match is at the start of a line (column 0) — a
        // top-level function declaration.
        const before = stripped.lastIndexOf('\n', m.index!);
        if (m.index! - before !== 1) continue;
        const name = m[1];
        if (/^(if|for|while|switch|return|new|throw|try|catch|finally|case|do|else|in|is|as|var|final|const|class|enum|extends|implements|with|abstract|super|this|null|true|false|void|dynamic|sync|async|await|yield|main)$/.test(name) && name !== 'main') continue;
        if (funcs.has(name)) continue;
        const bodyText = extractDartBody(source, m.index ?? 0, m[0]);
        const entity = {
            kind: 'function' as const,
            name,
            key: `function:${name}`,
            signature: `function ${name}()`,
            bodyText,
            locText: m[0].trim(),
            calls: new Set<string>(),
            usesVars: new Set<string>(),
            usesImports: new Set<string>(),
        };
        entities.push(entity);
        funcs.set(name, entity);
    }

    return {
        entities: entities as any,
        funcs,
        vars,
        importsByLocal,
        injectedDeps,
        frameworkRefs: new Set(),
        fileName,
    };
}

/**
 * Merge a tree-sitter (possibly-erroneous) Dart analysis with a regex
 * fallback. Tree-sitter wins for entities it found; regex fills gaps. Used
 * when tree-sitter produced a tree with ERROR nodes — we keep what it
 * surfaced, and add what it missed.
 */
function mergeDartFallback(tsAnalysis: FileAnalysis, source: string, fileName: string): FileAnalysis {
    const fallback = extractDartViaRegex(source, fileName);
    const merged: FileAnalysis = {
        entities: [...tsAnalysis.entities],
        funcs: new Map(tsAnalysis.funcs),
        vars: new Map(tsAnalysis.vars),
        importsByLocal: new Map(tsAnalysis.importsByLocal),
        injectedDeps: new Map(tsAnalysis.injectedDeps),
        frameworkRefs: new Set(tsAnalysis.frameworkRefs),
        fileName,
    };
    for (const [name, entity] of fallback.funcs) {
        if (!merged.funcs.has(name)) {
            merged.funcs.set(name, entity);
            merged.entities.push(entity);
        }
    }
    for (const [k, v] of fallback.importsByLocal) {
        if (!merged.importsByLocal.has(k)) merged.importsByLocal.set(k, v);
    }
    return merged;
}
