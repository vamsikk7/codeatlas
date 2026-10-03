/**
 * specs/csharp.ts — C# language spec.
 *
 * Notable: `getDecorators` returns the full attribute_list text rather
 * than enumerating individual attributes — C# packs many attributes into
 * one square-bracket group (`[HttpGet, Route("/api")]`) and downstream
 * code splits them on commas as needed.
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const CSHARP_SPEC: LanguageSpec = {
    functionTypes: ['method_declaration', 'constructor_declaration'],
    classTypes: ['class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration'],
    importTypes: ['using_directive'],
    variableTypes: ['field_declaration', 'property_declaration'],
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
        const typeNode = findChildByField(node, 'type') ?? findChildByField(node, 'returns');
        const returnType = typeNode ? nodeText(typeNode, source) + ' ' : '';
        return `${returnType}${name}${paramText}`;
    },
    getImports(node, source) {
        const text = nodeText(node, source);
        const match = text.match(/using\s+(?:static\s+)?(\S+);/);
        if (match) {
            const ns = match[1];
            const parts = ns.split('.');
            return [{ local: parts[parts.length - 1], source: ns }];
        }
        return [];
    },
    getVariableName(node) {
        const declarator = findChild(node, 'variable_declarator') ?? findChild(node, 'variable_declaration');
        if (declarator) {
            const nameNode = findChildByField(declarator, 'name') ?? findChild(declarator, 'identifier');
            return nameNode?.text ?? null;
        }
        return null;
    },
    getDecorators(node, source) {
        const decorators: string[] = [];
        const attrList = findChild(node, 'attribute_list');
        if (attrList) {
            decorators.push(nodeText(attrList, source));
        }
        return decorators;
    },
};
