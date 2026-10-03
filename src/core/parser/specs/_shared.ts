/**
 * specs/_shared.ts — Types + helpers shared by every per-language spec.
 *
 * Companion to the Issue #703 plugin-architecture refactor (frameworks +
 * mobile). Tree-sitter specs differ in two ways:
 *   - Their dispatch is a 1-to-1 language → spec map (no per-language
 *     iteration), so we use a typed map rather than a Registry class.
 *   - Spec objects are *data* (function tables), not plugin classes with
 *     identity / metadata. They self-describe via the `LanguageSpec`
 *     interface and that's all the dispatcher needs.
 *
 * This module exposes:
 *   - `TSNode` — a structural interface matching the bits of
 *     `web-tree-sitter`'s `Node` class we actually touch. Re-declared here
 *     because the package uses `declare module` which makes the real
 *     `Node` class hard to import standalone.
 *   - `LanguageSpec` — the per-language contract (node-type lists +
 *     accessor functions).
 *   - `nodeText`, `findChild`, `findChildByField` — three small helpers
 *     used by ≥2 specs.
 *
 * Per-spec helpers that are only used by one language (e.g. PHP's
 * `PHP_BUILTINS`, Go's receiver-name extraction) deliberately live inside
 * their spec file to keep this module thin.
 */

/**
 * Locally-defined interface matching the bits of web-tree-sitter's Node
 * class we actually consume. Defined here because `web-tree-sitter` uses
 * `declare module` which makes its `Node` class type difficult to import
 * standalone.
 */
export interface TSNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: TSNode[];
    parent: TSNode | null;
    previousSibling: TSNode | null;
    nextSibling: TSNode | null;
    childForFieldName(fieldName: string): TSNode | null;
    descendantsOfType(types: string | string[]): TSNode[];
}

/**
 * Per-language node-type table + accessors.
 *
 * Each language has different tree-sitter AST node names for the same
 * concepts (e.g. `function_declaration` in JS vs. `method_declaration` in
 * Java vs. `function_item` in Rust). A `LanguageSpec` packages up the
 * node-type names + the per-language code to pull names, signatures,
 * imports, decorators, etc. so the dispatcher (`extractSymbols` /
 * `walkNode` in `treeSitterExtractor.ts`) can treat all languages
 * uniformly.
 */
export interface LanguageSpec {
    /** Node types that represent function/method declarations */
    functionTypes: string[];
    /** Node types that represent class declarations */
    classTypes: string[];
    /** Node types that represent import statements */
    importTypes: string[];
    /** Node types for variable declarations */
    variableTypes: string[];
    /** How to get the name from a function node */
    getFunctionName: (node: TSNode) => string | null;
    /** How to get the name from a class node */
    getClassName: (node: TSNode) => string | null;
    /** How to build a function signature */
    getFunctionSignature: (node: TSNode, source: string) => string;
    /** Extract import info: localName → modulePath */
    getImports: (node: TSNode, source: string) => Array<{ local: string; source: string }>;
    /** How to get the name from a variable declaration */
    getVariableName: (node: TSNode) => string | null;
    /** Optional: extract decorators/annotations from a node */
    getDecorators?: (node: TSNode, source: string) => string[];
    /**
     * Optional: extract class-field type dependencies from a class body node.
     * Used for DI frameworks (Spring @Autowired, Kotlin constructor injection, C# DI)
     * where dependencies are field-injected and not necessarily imported.
     * Returns pairs of { local: typeName, source: typeName }.
     */
    getFieldDependencies?: (classBodyNode: TSNode, existingImports: Map<string, string>) => Array<{ local: string; source: string }>;
    /**
     * Optional: extract dependencies from a function/method node.
     * Used for DI frameworks like FastAPI where dependencies are injected into route handlers.
     */
    getFunctionDependencies?: (functionNode: TSNode, existingImports: Map<string, string>) => Array<{ local: string; source: string }>;
    /**
     * Optional: extract local variable type assignments within a function body.
     * Python only: maps `todo = Todo.objects.get(...)` → { local: 'todo', source: '.models' }
     * enabling BFS to resolve instance method calls like `todo.save()`.
     */
    getLocalVarTypes?: (functionNode: TSNode, existingImports: Map<string, string>) => Array<{ local: string; source: string }>;
    /**
     * Optional: extract class hierarchy (extends/implements) from a class node.
     * Returns { extendsClass, implementsInterfaces } where both are optional.
     */
    getClassHierarchy?: (classNode: TSNode, source: string) => { extendsClass?: string; implementsInterfaces?: string[] };
}

export function nodeText(node: TSNode, source: string): string {
    return source.slice(node.startIndex, node.endIndex);
}

export function findChild(node: TSNode, type: string): TSNode | null {
    for (const child of node.children) {
        if (child.type === type) return child;
    }
    return null;
}

export function findChildByField(node: TSNode, fieldName: string): TSNode | null {
    return node.childForFieldName(fieldName);
}
