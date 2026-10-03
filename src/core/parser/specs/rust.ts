/**
 * specs/rust.ts — Rust language spec.
 *
 * `getImports` was rewritten in Issue #262 to handle three `use` shapes
 * (wildcard, brace group, plain path) explicitly — the prior single
 * regex greedily consumed the trailing `::` before a brace group and
 * yielded empty local names for `use casbin::{CoreApi, ...}`.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const RUST_SPEC: LanguageSpec = {
    functionTypes: ['function_item', 'impl_item'],
    classTypes: ['struct_item', 'enum_item', 'trait_item'],
    importTypes: ['use_declaration'],
    variableTypes: ['let_declaration', 'const_item', 'static_item'],
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
        const returnType = findChildByField(node, 'return_type');
        const retText = returnType ? ' ' + nodeText(returnType, source) : '';
        return `fn ${name}${paramText}${retText}`;
    },
    getImports(node, source) {
        // Issue 262: previous regex greedily consumed the trailing `::` before
        // a brace group, so `use casbin::{CoreApi, ...}` yielded an empty
        // `lastPart` and produced import entities with empty labels.
        const text = nodeText(node, source);

        // Wildcard: `use foo::bar::*;`
        const wildcard = text.match(/use\s+([\w][\w:]*?)::\*/);
        if (wildcard) {
            return [{ local: '*', source: wildcard[1] }];
        }

        // Brace group: `use foo::bar::{Baz, Qux as Renamed, Quux};`
        const braced = text.match(/use\s+([\w][\w:]*?)::\{([^}]+)\}/);
        if (braced) {
            const basePath = braced[1];
            // Issue 729: take the LAST segment of an `X as Y` split so the
            // alias wins when present (matches plain-path behavior). Prior
            // code used `[0]` and silently dropped the rename, so file-graph
            // nodes for `use foo::{Bar as Renamed}` were keyed on `Bar`.
            return braced[2]
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(item => {
                    const parts = item.split(/\s+as\s+/);
                    return parts[parts.length - 1].trim();
                })
                .filter(local => local !== 'self')
                .map(local => ({ local, source: basePath }));
        }

        // Plain path: `use std::io;` or `use foo::Bar as Baz;`
        const plain = text.match(/use\s+([\w][\w:]*?)(?:\s+as\s+([\w]+))?\s*[;\n]/);
        if (plain) {
            const usePath = plain[1];
            const renamed = plain[2];
            const parts = usePath.split('::').filter(Boolean);
            const last = renamed ?? parts[parts.length - 1];
            if (last) return [{ local: last, source: usePath }];
        }
        return [];
    },
    getVariableName(node) {
        const pattern = findChildByField(node, 'pattern');
        if (pattern) {
            const id = findChild(pattern, 'identifier') ?? pattern;
            return id.type === 'identifier' ? id.text : null;
        }
        const nameNode = findChildByField(node, 'name');
        return nameNode?.text ?? null;
    },
    getDecorators(node, source) {
        const decorators: string[] = [];
        let prev = node.previousSibling;
        while (prev && prev.type === 'attribute_item') {
            decorators.push(nodeText(prev, source));
            prev = prev.previousSibling;
        }
        return decorators;
    },
};
