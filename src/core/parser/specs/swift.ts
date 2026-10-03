/**
 * specs/swift.ts — Swift language spec.
 *
 * Class hierarchy is awkward in Swift because there's no syntactic
 * distinction between "superclass" and "protocol conformance" — they're
 * comma-separated after the same colon. We treat the first identifier
 * as `extendsClass` only for `class_declaration`; the rest fall into
 * `implementsInterfaces`. `struct`/`enum` conformances are all
 * protocols (no super-class possible).
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const SWIFT_SPEC: LanguageSpec = {
    functionTypes: ['function_declaration', 'init_declaration'],
    classTypes: ['class_declaration', 'struct_declaration', 'protocol_declaration', 'enum_declaration'],
    importTypes: ['import_declaration'],
    variableTypes: ['property_declaration', 'variable_declaration'],
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
        return `func ${name}${paramText}`;
    },
    getImports(node, source) {
        const text = nodeText(node, source);
        const match = text.match(/import\s+(\S+)/);
        if (match) {
            return [{ local: match[1], source: match[1] }];
        }
        return [];
    },
    getVariableName(node) {
        const pattern = findChildByField(node, 'pattern') ?? findChildByField(node, 'name');
        if (pattern) {
            const id = findChild(pattern, 'identifier') ?? pattern;
            return id.type === 'identifier' ? id.text : null;
        }
        return null;
    },
    getClassHierarchy(classNode, source) {
        // Swift: class Foo: Bar, Baz, Qux — first is superclass (if class), rest are protocols
        // struct Foo: View, Equatable — all are protocol conformances
        let extendsClass: string | undefined;
        const implementsInterfaces: string[] = [];
        // Look for type_inheritance_clause or inheritance_specifier children
        const inheritClause = findChild(classNode, 'type_inheritance_clause')
            ?? findChild(classNode, 'inheritance_specifier');
        if (inheritClause) {
            // Extract all type identifiers from inheritance clause
            const typeNodes = inheritClause.descendantsOfType('type_identifier');
            for (const tn of typeNodes) {
                const name = tn.text;
                if (!extendsClass && classNode.type === 'class_declaration') {
                    extendsClass = name; // first type in class is superclass
                } else {
                    implementsInterfaces.push(name);
                }
            }
            // Fallback: regex on text if tree-sitter types differ
            if (!extendsClass && implementsInterfaces.length === 0) {
                const text = nodeText(inheritClause, source);
                const names = text.split(',').map(s => s.trim().replace(/^:\s*/, ''));
                for (const n of names) {
                    if (!n || n.includes('<') || n.includes('(')) continue;
                    if (!extendsClass && classNode.type === 'class_declaration') extendsClass = n;
                    else implementsInterfaces.push(n);
                }
            }
        }
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
};
