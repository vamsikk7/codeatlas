/**
 * specs/ruby.ts — Ruby language spec.
 *
 * Smallest spec — Ruby's tree-sitter grammar surfaces require statements
 * as `call` nodes, so `importTypes: ['call']` over-matches and
 * `getImports` filters to `require` / `require_relative` calls only.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const RUBY_SPEC: LanguageSpec = {
    functionTypes: ['method', 'singleton_method'],
    classTypes: ['class', 'module'],
    importTypes: ['call'], // require/require_relative
    variableTypes: ['assignment'],
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
        const paramText = params ? nodeText(params, source) : '';
        return `def ${name}${paramText ? `(${paramText})` : ''}`;
    },
    getImports(node, source) {
        // Filter to only require/require_relative calls
        const text = nodeText(node, source);
        const match = text.match(/(?:require|require_relative)\s+['"]([^'"]+)['"]/);
        if (match) {
            const modulePath = match[1];
            const parts = modulePath.split('/');
            return [{ local: parts[parts.length - 1], source: modulePath }];
        }
        return [];
    },
    getVariableName(node) {
        const left = findChild(node, 'identifier') ?? findChild(node, 'instance_variable') ?? findChild(node, 'constant');
        return left?.text ?? null;
    },
};
