/**
 * specs/python.ts — Python language spec.
 *
 * The largest spec by line count because Python adds three DI extractors
 * on top of the base contract:
 *   - `getFieldDependencies` — Django-style class-attribute type hints
 *     (`service: TodoService`) + `__init__` parameter types.
 *   - `getFunctionDependencies` — FastAPI-style `Depends(...)` parameter
 *     injection on route handlers.
 *   - `getLocalVarTypes` — assignment-result tracking
 *     (`todo = Todo.objects.get(...)` → `todo: Todo`) so the BFS resolver
 *     can chase instance-method calls like `todo.save()`.
 */

import { type LanguageSpec, type TSNode, findChild, findChildByField, nodeText } from './_shared';

export const PYTHON_SPEC: LanguageSpec = {
    functionTypes: ['function_definition'],
    classTypes: ['class_definition'],
    importTypes: ['import_statement', 'import_from_statement'],
    variableTypes: ['expression_statement'], // x = ... assignments
    getFunctionName(node) {
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getClassName(node) {
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const params = findChildByField(node, 'parameters');
        const paramText = params ? nodeText(params, source) : '()';
        return `def ${name}${paramText}`;
    },
    getImports(node, source) {
        const results: Array<{ local: string; source: string }> = [];
        if (node.type === 'import_statement') {
            // import foo
            const nameNode = findChildByField(node, 'name') ?? findChild(node, 'dotted_name');
            if (nameNode) {
                results.push({ local: nameNode.text, source: nameNode.text });
            }
        } else if (node.type === 'import_from_statement') {
            // from foo import bar, baz
            const moduleNode = findChildByField(node, 'module_name') ?? findChild(node, 'dotted_name') ?? findChild(node, 'relative_import');
            const modulePath = moduleNode?.text ?? '';
            for (const child of node.children) {
                if (child.type === 'dotted_name' && child !== moduleNode) {
                    results.push({ local: child.text, source: modulePath });
                }
                if (child.type === 'aliased_import') {
                    const aliasNode = findChildByField(child, 'alias');
                    const nameNode = findChildByField(child, 'name') ?? findChild(child, 'dotted_name');
                    results.push({ local: aliasNode?.text ?? nameNode?.text ?? '', source: modulePath });
                }
            }
            if (results.length === 0 && modulePath) {
                results.push({ local: modulePath, source: modulePath });
            }
        }
        return results;
    },
    getVariableName(node) {
        // expression_statement > assignment > left
        const assignment = findChild(node, 'assignment');
        if (assignment) {
            const left = findChild(assignment, 'identifier');
            return left?.text ?? null;
        }
        return null;
    },
    getDecorators(node, source) {
        const decorators: string[] = [];
        let prev = node.previousSibling;
        while (prev && prev.type === 'decorator') {
            decorators.push(nodeText(prev, source));
            prev = prev.previousSibling;
        }
        return decorators;
    },
    getClassHierarchy(classNode, source) {
        let extendsClass: string | undefined;
        const implementsInterfaces: string[] = [];
        // Python: class Dog(Animal, Serializable):
        // Tree-sitter: class_definition has 'superclasses' field or argument_list child
        const superclasses = findChildByField(classNode, 'superclasses')
            ?? findChild(classNode, 'argument_list');
        if (superclasses) {
            const bases: string[] = [];
            for (const child of superclasses.children) {
                if (child.type === 'identifier' || child.type === 'attribute') {
                    const name = child.type === 'attribute' ? (child.text.split('.').pop() ?? child.text) : child.text;
                    bases.push(name);
                }
            }
            if (bases.length > 0) {
                extendsClass = bases[0];
                for (let i = 1; i < bases.length; i++) {
                    implementsInterfaces.push(bases[i]);
                }
            }
        }
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
    /**
     * Extract type-annotated dependencies from a Python class body.
     * Handles two common Django/Python DI patterns:
     *   1. Class-level annotations:  service: TodoService
     *   2. __init__ parameter types: def __init__(self, service: TodoService):
     * Returns { local: fieldName, source: typeName } pairs for BFS resolution.
     */
    getFieldDependencies(classBodyNode, existingImports) {
        // Python built-in types to skip
        const PYTHON_BUILTINS = new Set([
            'str', 'int', 'float', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple',
            'None', 'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple',
            'Type', 'ClassVar', 'Final', 'Callable', 'Awaitable', 'Coroutine',
            'Request', 'Response', 'HttpRequest', 'HttpResponse', 'JsonResponse',
            'QuerySet', 'Manager',
        ]);
        const result: Array<{ local: string; source: string }> = [];
        const seen = new Set<string>();

        for (const child of classBodyNode.children) {
            // Pattern 1: class-level type annotations → `name: TypeName` (typed_parameter or expression_statement with assignment)
            if (child.type === 'expression_statement') {
                // type annotation: `service: TodoService` parsed as assignment-like in tree-sitter
                const assignment = findChild(child, 'assignment') ?? findChild(child, 'augmented_assignment');
                if (!assignment) {
                    // May be a bare annotation: annotated_assignment
                    const annotated = findChild(child, 'annotated_assignment') ??
                        (child.children.find(c => c.type === 'annotated_assignment') ?? null);
                    if (annotated) {
                        const nameNode = findChild(annotated, 'identifier');
                        const typeNode = annotated.children.find(c => c.type === 'type' || c.type === 'identifier' || c.type === 'attribute');
                        if (nameNode && typeNode) {
                            const fieldName = nameNode.text;
                            const typeName = typeNode.text.split('.').pop() ?? typeNode.text;
                            if (!/^[a-z]/.test(typeName) && !PYTHON_BUILTINS.has(typeName) && !seen.has(fieldName)) {
                                seen.add(fieldName);
                                result.push({ local: fieldName, source: existingImports.get(typeName) ?? typeName });
                            }
                        }
                    }
                }
            }
            // Pattern 1b: annotated_assignment at class body level (tree-sitter parses `x: T` this way)
            if (child.type === 'annotated_assignment') {
                const nameNode = findChild(child, 'identifier');
                // The type annotation is typically the 2nd child after ':'
                const typeId = child.children.find(c => c !== nameNode && (c.type === 'identifier' || c.type === 'attribute'));
                if (nameNode && typeId) {
                    const fieldName = nameNode.text;
                    const typeName = typeId.text.split('.').pop() ?? typeId.text;
                    if (!/^[a-z]/.test(typeName) && !PYTHON_BUILTINS.has(typeName) && !seen.has(fieldName)) {
                        seen.add(fieldName);
                        result.push({ local: fieldName, source: existingImports.get(typeName) ?? typeName });
                    }
                }
            }
            // Pattern 2: __init__ parameter type annotations
            if (child.type === 'function_definition') {
                const nameNode = findChildByField(child, 'name');
                if (nameNode?.text !== '__init__') continue;
                const params = findChildByField(child, 'parameters');
                if (!params) continue;
                for (const param of params.children) {
                    // typed_parameter: `service: TodoService`
                    if (param.type === 'typed_parameter') {
                        const paramName = findChild(param, 'identifier');
                        if (!paramName || paramName.text === 'self') continue;
                        const typeAnnotation = param.children.find(c => c.type === 'identifier' || c.type === 'attribute' || c.type === 'type');
                        if (typeAnnotation && typeAnnotation !== paramName) {
                            const typeName = typeAnnotation.text.split('.').pop() ?? typeAnnotation.text;
                            if (!PYTHON_BUILTINS.has(typeName) && !seen.has(paramName.text)) {
                                seen.add(paramName.text);
                                result.push({ local: paramName.text, source: existingImports.get(typeName) ?? typeName });
                            }
                        }
                    }
                }
            }
        }
        return result;
    },
    getFunctionDependencies(functionNode, existingImports) {
        const PYTHON_BUILTINS = new Set([
            'str', 'int', 'float', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple',
            'None', 'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple',
            'Type', 'ClassVar', 'Final', 'Callable', 'Awaitable', 'Coroutine',
            'Request', 'Response', 'HttpRequest', 'HttpResponse', 'JsonResponse',
            'QuerySet', 'Manager', 'Depends', 'Security', 'BackgroundTasks', 'WebSocket'
        ]);
        const result: Array<{ local: string; source: string }> = [];
        const seen = new Set<string>();
        const params = findChildByField(functionNode, 'parameters');
        if (!params) return result;

        function extractTyped(node: TSNode) {
            if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
                const paramName = findChild(node, 'identifier');
                if (paramName && paramName.text !== 'self') {
                    const typeAnnotation = node.children.find(c => (c.type === 'type' || c.type === 'identifier' || c.type === 'attribute') && c !== paramName);
                    if (typeAnnotation) {
                        const typeName = typeAnnotation.text.split('.').pop() ?? typeAnnotation.text;
                        if (!PYTHON_BUILTINS.has(typeName) && !seen.has(paramName.text)) {
                            seen.add(paramName.text);
                            result.push({ local: paramName.text, source: existingImports.get(typeName) ?? typeName });
                        }
                    }
                }
            }
            // Issue 728: recurse into ALL children, including typed_parameter.
            // The `if` block above does the extraction; previously the guard
            // here skipped the typed_parameter children, so the recursion never
            // reached its own target node and FastAPI / Django typed handler
            // params silently produced zero injectedDeps.
            for (const child of node.children) {
                extractTyped(child);
            }
        }
        extractTyped(params);
        return result;
    },
    getLocalVarTypes(functionNode, existingImports) {
        const result: Array<{ local: string; source: string }> = [];
        const seen = new Set<string>();
        function walk(node: TSNode) {
            if (node.type === 'assignment') {
                const left = node.childForFieldName('left');
                const right = node.childForFieldName('right');
                if (left?.type === 'identifier' && right?.type === 'call') {
                    const varName = left.text;
                    if (!seen.has(varName) && varName !== 'self') {
                        const fn = right.childForFieldName('function') ?? right.children[0];
                        if (fn) {
                            // Walk up attribute chain to find the root class name
                            // e.g. Todo.objects.get(...) → root = 'Todo'
                            let cur: TSNode = fn;
                            while (cur.type === 'attribute' && cur.childForFieldName('object')) {
                                cur = cur.childForFieldName('object')!;
                            }
                            if (cur.type === 'identifier') {
                                const rootName = cur.text;
                                const importSource = existingImports.get(rootName);
                                // Only map if root is a known import and looks like a class (PascalCase)
                                if (importSource && /^[A-Z]/.test(rootName)) {
                                    seen.add(varName);
                                    result.push({ local: varName, source: importSource });
                                }
                            }
                        }
                    }
                }
            }
            for (const child of node.children) walk(child);
        }
        walk(functionNode);
        return result;
    },
};
