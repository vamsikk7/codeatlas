/**
 * specs/c.ts — C language spec (also used for C++).
 *
 * Function-name extraction is the tricky part: tree-sitter C wraps the
 * name in nested `declarator` nodes — possibly `pointer_declarator >
 * function_declarator > declarator > identifier`. We unwrap one level
 * of pointer indirection and then dig for the inner identifier.
 *
 * The `specs/index.ts` map points both `c` and `cpp` at this spec —
 * C++ uses essentially the same patterns with additions we don't track
 * yet (namespaces, templates).
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const C_SPEC: LanguageSpec = {
    functionTypes: ['function_definition'],
    classTypes: ['struct_specifier', 'enum_specifier', 'union_specifier'],
    importTypes: ['preproc_include'],
    variableTypes: ['declaration'],
    getFunctionName(node) {
        const declarator = findChildByField(node, 'declarator');
        if (declarator) {
            // function_declarator → declarator → identifier
            const funcDeclarator = declarator.type === 'function_declarator' ? declarator : findChild(declarator, 'function_declarator');
            if (funcDeclarator) {
                const nameNode = findChildByField(funcDeclarator, 'declarator');
                return nameNode?.text ?? null;
            }
            // pointer_declarator → function_declarator
            if (declarator.type === 'pointer_declarator') {
                const inner = findChild(declarator, 'function_declarator');
                if (inner) {
                    const nameNode = findChildByField(inner, 'declarator');
                    return nameNode?.text ?? null;
                }
            }
            return declarator.text;
        }
        return null;
    },
    getClassName(node) {
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const declarator = findChildByField(node, 'declarator');
        const funcDecl = declarator?.type === 'function_declarator' ? declarator : (declarator ? findChild(declarator, 'function_declarator') : null);
        const params = funcDecl ? findChildByField(funcDecl, 'parameters') : null;
        const paramText = params ? nodeText(params, source) : '()';
        const typeNode = findChildByField(node, 'type');
        const returnType = typeNode ? nodeText(typeNode, source) + ' ' : '';
        return `${returnType}${name}${paramText}`;
    },
    getImports(node, _source) {
        // #include <stdio.h> or #include "myfile.h"
        const pathNode = findChild(node, 'string_literal') ?? findChild(node, 'system_lib_string');
        if (pathNode) {
            const importPath = pathNode.text.replace(/[<>"]/g, '');
            return [{ local: importPath, source: importPath }];
        }
        return [];
    },
    getVariableName(node) {
        const declarator = findChild(node, 'init_declarator');
        if (declarator) {
            const nameNode = findChildByField(declarator, 'declarator');
            return nameNode?.text ?? null;
        }
        return null;
    },
};
