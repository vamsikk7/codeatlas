/**
 * specs/typescript.ts — TypeScript language spec.
 *
 * Composed on top of `javascript.ts` (TS shares most of JS's accessors)
 * with two additions:
 *   - `interface_declaration` joins `classTypes` so TS interfaces show
 *     up as class-shaped entities.
 *   - `getDecorators` + `getClassHierarchy` are supplied (JS doesn't have
 *     decorators or `implements` clauses).
 */

import { type LanguageSpec, findChild, nodeText } from './_shared';
import { JAVASCRIPT_SPEC } from './javascript';

export const TYPESCRIPT_SPEC: LanguageSpec = {
    ...JAVASCRIPT_SPEC,
    functionTypes: [...JAVASCRIPT_SPEC.functionTypes],
    classTypes: [...JAVASCRIPT_SPEC.classTypes, 'interface_declaration'],
    importTypes: [...JAVASCRIPT_SPEC.importTypes],
    getDecorators(node, source) {
        const decorators: string[] = [];
        // Look for decorator nodes immediately before the function/class
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
        // TypeScript/JS: class Foo extends Bar implements IBaz, IQux
        // Tree-sitter: class_heritage children include extends_clause and implements_clause
        const heritage = findChild(classNode, 'class_heritage');
        if (heritage) {
            const extendsClause = findChild(heritage, 'extends_clause');
            if (extendsClause) {
                // First type_identifier or generic_type child
                const typeId = findChild(extendsClause, 'type_identifier')
                    ?? findChild(extendsClause, 'identifier')
                    ?? findChild(extendsClause, 'generic_type');
                if (typeId) {
                    extendsClass = typeId.type === 'generic_type'
                        ? (findChild(typeId, 'type_identifier')?.text ?? typeId.text)
                        : typeId.text;
                }
            }
            const implClause = findChild(heritage, 'implements_clause');
            if (implClause) {
                const typeIds = implClause.descendantsOfType('type_identifier');
                for (const t of typeIds) implementsInterfaces.push(t.text);
                // Also check for plain identifiers
                if (implementsInterfaces.length === 0) {
                    for (const child of implClause.children) {
                        if (child.type === 'identifier') implementsInterfaces.push(child.text);
                    }
                }
            }
        }
        // Fallback: scan children directly for extends/implements keywords
        // Some tree-sitter grammars put them as direct children of class_declaration
        if (!extendsClass && !heritage) {
            for (let i = 0; i < classNode.children.length; i++) {
                const child = classNode.children[i];
                if (child.type === 'extends' || child.text === 'extends') {
                    const next = classNode.children[i + 1];
                    if (next && (next.type === 'type_identifier' || next.type === 'identifier')) {
                        extendsClass = next.text;
                    }
                }
                if (child.type === 'implements' || child.text === 'implements') {
                    for (let j = i + 1; j < classNode.children.length; j++) {
                        const sibling = classNode.children[j];
                        if (sibling.type === 'type_identifier' || sibling.type === 'identifier') {
                            implementsInterfaces.push(sibling.text);
                        }
                        if (sibling.type === '{' || sibling.type === 'class_body') break;
                    }
                }
            }
        }
        if (extendsClass) extendsClass = extendsClass.replace(/<.*>$/, '');
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
};
