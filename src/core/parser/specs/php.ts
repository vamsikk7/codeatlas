/**
 * specs/php.ts — PHP language spec.
 *
 * Field-dependency extractor handles both classic property declarations
 * (`private UserService $userService;`) and PHP 8 constructor property
 * promotion (`__construct(private UserService $userService)`). The latter
 * is the modern Laravel / Symfony idiom for DI.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const PHP_SPEC: LanguageSpec = {
    functionTypes: ['function_definition', 'method_declaration'],
    classTypes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
    importTypes: ['namespace_use_declaration'],
    variableTypes: ['property_declaration'],
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
        return `function ${name}${paramText}`;
    },
    getImports(node, source) {
        const results: Array<{ local: string; source: string }> = [];
        const clauses = node.descendantsOfType('namespace_use_clause');
        for (const clause of clauses) {
            const nameNode = findChild(clause, 'qualified_name') ?? findChild(clause, 'name');
            if (nameNode) {
                const fullPath = nameNode.text;
                const parts = fullPath.split('\\');
                const local = parts[parts.length - 1];
                results.push({ local, source: fullPath });
            }
        }
        return results;
    },
    getVariableName(node) {
        const nameNode = findChild(node, 'property_element');
        if (nameNode) {
            const varNode = findChild(nameNode, 'variable_name');
            return varNode?.text ?? null;
        }
        return null;
    },
    getDecorators(node, source) {
        // PHP 8+ attributes: #[Route('/')]
        const decorators: string[] = [];
        let prev = node.previousSibling;
        while (prev && prev.type === 'attribute_list') {
            decorators.push(nodeText(prev, source));
            prev = prev.previousSibling;
        }
        return decorators;
    },
    getClassHierarchy(classNode, _source) {
        let extendsClass: string | undefined;
        const implementsInterfaces: string[] = [];
        // PHP: class Foo extends Bar implements Baz, Qux
        const baseClause = findChildByField(classNode, 'base_clause') ?? findChild(classNode, 'base_clause');
        if (baseClause) {
            const nameNode = findChild(baseClause, 'name') ?? findChild(baseClause, 'qualified_name');
            if (nameNode) extendsClass = nameNode.text.split('\\').pop();
        }
        const implClause = findChildByField(classNode, 'class_interface_clause') ?? findChild(classNode, 'class_interface_clause');
        if (implClause) {
            const names = implClause.descendantsOfType('name');
            for (const n of names) implementsInterfaces.push(n.text.split('\\').pop() ?? n.text);
            if (implementsInterfaces.length === 0) {
                const qualNames = implClause.descendantsOfType('qualified_name');
                for (const n of qualNames) implementsInterfaces.push(n.text.split('\\').pop() ?? n.text);
            }
        }
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
    getFieldDependencies(classBodyNode, existingImports) {
        const PHP_BUILTINS = new Set([
            'string', 'int', 'float', 'bool', 'array', 'object', 'callable', 'iterable',
            'void', 'never', 'null', 'mixed', 'self', 'static', 'parent', 'true', 'false',
            'String', 'Int', 'Float', 'Bool', 'Array', 'Object',
            'Request', 'Response', 'Collection', 'Carbon', 'Builder',
        ]);
        const result: Array<{ local: string; source: string }> = [];
        const seen = new Set<string>();

        for (const child of classBodyNode.children) {
            // Pattern 1: Property declarations — private UserService $userService;
            if (child.type === 'property_declaration') {
                const typeNode = findChild(child, 'named_type') ?? findChild(child, 'qualified_name')
                    ?? findChild(child, 'optional_type') ?? findChild(child, 'union_type');
                if (!typeNode) continue;
                // Extract actual type name (strip nullable ?)
                let typeName = typeNode.text;
                if (typeNode.type === 'optional_type' || typeNode.type === 'named_type') {
                    const inner = findChild(typeNode, 'named_type') ?? findChild(typeNode, 'qualified_name') ?? typeNode;
                    typeName = inner.text;
                }
                typeName = typeName.replace(/^\?/, '').split('\\').pop() ?? typeName;
                if (PHP_BUILTINS.has(typeName) || PHP_BUILTINS.has(typeName.toLowerCase())) continue;
                if (!/^[A-Z]/.test(typeName)) continue;
                // Get field name (strip $)
                const propElement = findChild(child, 'property_element');
                const varNode = propElement ? findChild(propElement, 'variable_name') : null;
                const fieldName = varNode ? varNode.text.replace(/^\$/, '') : typeName;
                if (seen.has(fieldName)) continue;
                seen.add(fieldName);
                result.push({ local: fieldName, source: existingImports.get(typeName) ?? typeName });
            }

            // Pattern 2: Constructor promoted parameters — __construct(private UserService $userService)
            if (child.type === 'method_declaration') {
                const nameNode = findChildByField(child, 'name');
                if (nameNode?.text !== '__construct') continue;
                const params = findChildByField(child, 'parameters');
                if (!params) continue;
                for (const param of params.children) {
                    // property_promotion_parameter or simple_parameter with visibility + type
                    if (param.type === 'property_promotion_parameter' || param.type === 'simple_parameter') {
                        const typeNode = findChild(param, 'named_type') ?? findChild(param, 'qualified_name')
                            ?? findChild(param, 'optional_type');
                        if (!typeNode) continue;
                        let typeName = typeNode.text;
                        if (typeNode.type === 'optional_type' || typeNode.type === 'named_type') {
                            const inner = findChild(typeNode, 'named_type') ?? findChild(typeNode, 'qualified_name') ?? typeNode;
                            typeName = inner.text;
                        }
                        typeName = typeName.replace(/^\?/, '').split('\\').pop() ?? typeName;
                        if (PHP_BUILTINS.has(typeName) || PHP_BUILTINS.has(typeName.toLowerCase())) continue;
                        if (!/^[A-Z]/.test(typeName)) continue;
                        const varNode = findChild(param, 'variable_name');
                        const fieldName = varNode ? varNode.text.replace(/^\$/, '') : typeName;
                        if (seen.has(fieldName)) continue;
                        seen.add(fieldName);
                        result.push({ local: fieldName, source: existingImports.get(typeName) ?? typeName });
                    }
                }
            }
        }
        return result;
    },
};
