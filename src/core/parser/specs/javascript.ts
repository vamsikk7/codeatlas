/**
 * specs/javascript.ts — JavaScript language spec.
 *
 * `typescript.ts` re-uses this spec via spread + override (TS adds
 * `interface_declaration` to `classTypes` and supplies decorator +
 * class-hierarchy extractors). Both share the same import / function /
 * variable accessors.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const JAVASCRIPT_SPEC: LanguageSpec = {
    functionTypes: ['function_declaration', 'arrow_function', 'function', 'method_definition', 'generator_function_declaration'],
    classTypes: ['class_declaration', 'class'],
    importTypes: ['import_statement'],
    variableTypes: ['variable_declaration', 'lexical_declaration'],
    getFunctionName(node) {
        // function_declaration → name field
        const nameNode = findChildByField(node, 'name');
        if (nameNode) return nameNode.text;
        // method_definition → name is the property
        const propNode = findChild(node, 'property_identifier');
        if (propNode) return propNode.text;
        return null;
    },
    getClassName(node) {
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const params = findChildByField(node, 'parameters');
        const paramText = params ? nodeText(params, source) : '()';
        return `${name}${paramText}`;
    },
    getImports(node, source) {
        const results: Array<{ local: string; source: string }> = [];
        const sourceNode = findChild(node, 'string') ?? findChildByField(node, 'source');
        const modulePath = sourceNode ? sourceNode.text.replace(/['"]/g, '') : '';

        // import X from '...'
        const defaultImport = findChild(node, 'identifier');
        if (defaultImport) {
            results.push({ local: defaultImport.text, source: modulePath });
        }

        // import { X, Y } from '...'
        const namedImports = findChild(node, 'import_clause');
        if (namedImports) {
            const named = findChild(namedImports, 'named_imports');
            if (named) {
                for (const spec of named.children) {
                    if (spec.type === 'import_specifier') {
                        const localNode = findChildByField(spec, 'alias') ?? findChildByField(spec, 'name') ?? findChild(spec, 'identifier');
                        if (localNode) results.push({ local: localNode.text, source: modulePath });
                    }
                }
            }
        }

        if (results.length === 0 && modulePath) {
            results.push({ local: modulePath, source: modulePath });
        }
        return results;
    },
    getVariableName(node) {
        const declarator = findChild(node, 'variable_declarator');
        if (declarator) {
            const nameNode = findChildByField(declarator, 'name');
            return nameNode?.text ?? null;
        }
        return null;
    },
};
