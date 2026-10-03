/**
 * specs/kotlin.ts — Kotlin language spec.
 *
 * Two Kotlin-specific tree-sitter conventions to watch for:
 *   - Class names are `type_identifier`, NOT `simple_identifier` — so
 *     `getClassName` tries `type_identifier` first.
 *   - Delegation specifiers (Kotlin's combined "extends/implements"
 *     mechanism) require differentiating between `constructor_invocation`
 *     (= superclass call) and plain `user_type` (= protocol/interface).
 *     We take the first as `extendsClass` and put the rest into
 *     `implementsInterfaces`.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const KOTLIN_SPEC: LanguageSpec = {
    functionTypes: ['function_declaration'],
    classTypes: ['class_declaration', 'object_declaration', 'interface_declaration'],
    importTypes: ['import_header'],
    variableTypes: ['property_declaration'],
    getFunctionName(node) {
        const nameNode = findChild(node, 'simple_identifier');
        return nameNode?.text ?? null;
    },
    getClassName(node) {
        const nameNode = findChild(node, 'type_identifier') ?? findChild(node, 'simple_identifier');
        return nameNode?.text ?? null;
    },
    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const params = findChildByField(node, 'function_value_parameters');
        const paramText = params ? nodeText(params, source) : '()';
        return `fun ${name}${paramText}`;
    },
    getImports(node, source) {
        const text = nodeText(node, source);
        const match = text.match(/import\s+([\w.]+)/);
        if (match) {
            const fullPath = match[1];
            const parts = fullPath.split('.');
            return [{ local: parts[parts.length - 1], source: fullPath }];
        }
        return [];
    },
    getVariableName(node) {
        const nameNode = findChild(node, 'simple_identifier');
        if (nameNode && nameNode.parent?.type === node.type) {
            return nameNode.text;
        }
        const binding = findChild(node, 'variable_declaration');
        if (binding) {
            const id = findChild(binding, 'simple_identifier');
            return id?.text ?? null;
        }
        return null;
    },
    getDecorators(node, source) {
        const decorators: string[] = [];
        let prev = node.previousSibling;
        while (prev && prev.type === 'annotation') {
            decorators.push(nodeText(prev, source));
            prev = prev.previousSibling;
        }
        // Also check modifiers
        const modifiers = findChild(node, 'modifiers');
        if (modifiers) {
            for (const child of modifiers.children) {
                if (child.type === 'annotation') {
                    decorators.push(nodeText(child, source));
                }
            }
        }
        return decorators;
    },
    getClassHierarchy(classNode, _source) {
        let extendsClass: string | undefined;
        const implementsInterfaces: string[] = [];
        // Kotlin: class Foo : Bar(), IBaz, IQux
        // Tree-sitter: delegation_specifiers or super_types
        const delegation = findChild(classNode, 'delegation_specifiers');
        if (delegation) {
            for (const child of delegation.children) {
                if (child.type === 'delegation_specifier' || child.type === 'constructor_invocation' || child.type === 'user_type') {
                    const typeId = findChild(child, 'type_identifier')
                        ?? findChild(child, 'simple_identifier')
                        ?? findChild(child, 'user_type');
                    const name = typeId?.text ?? child.text;
                    const cleanName = name.replace(/<.*>$/, '').replace(/\(.*\)$/, '');
                    if (!cleanName) continue;
                    // First delegation specifier with constructor invocation is the superclass
                    if (!extendsClass && (child.type === 'constructor_invocation' || child.text.includes('('))) {
                        extendsClass = cleanName;
                    } else if (!extendsClass) {
                        // Could be either — take first as extends
                        extendsClass = cleanName;
                    } else {
                        implementsInterfaces.push(cleanName);
                    }
                }
            }
        }
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
    getFieldDependencies(classBodyNode, existingImports) {
        const result: Array<{ local: string; source: string }> = [];
        // Kotlin class body contains property_declaration nodes
        for (const child of classBodyNode.children) {
            if (child.type !== 'property_declaration') continue;
            // type → user_type or nullable_type
            const typeNode = findChildByField(child, 'type')
                ?? findChild(child, 'user_type')
                ?? findChild(child, 'type_reference');
            if (!typeNode) continue;
            // simple_identifier inside user_type
            const typeId = findChild(typeNode, 'simple_identifier') ?? typeNode;
            const typeName = typeId.type === 'simple_identifier' ? typeId.text : typeNode.text;
            if (!/^[A-Z][A-Za-z0-9_]*$/.test(typeName)) continue;
            if (existingImports.has(typeName)) continue;
            // Use the property name as local key (e.g. 'todoService') for BFS resolution
            const nameNode = findChildByField(child, 'name') ?? findChild(child, 'simple_identifier');
            const fieldName = nameNode?.text ?? typeName;
            result.push({ local: fieldName, source: typeName });
        }
        return result;
    },
};
