/**
 * specs/go.ts — Go language spec.
 *
 * Notable wrinkle: `getFunctionName` prefixes method names with the
 * receiver type (Issue #489). Without this, files declaring `Bind()` on
 * multiple receiver types — e.g. `UserPayload.Bind`, `ArticleRequest.Bind`
 * — collide on identical graph IDs (`flow:<file>:Bind`).
 */

import { type LanguageSpec, findChild, findChildByField, nodeText } from './_shared';

export const GO_SPEC: LanguageSpec = {
    functionTypes: ['function_declaration', 'method_declaration'],
    classTypes: ['type_declaration'], // Go uses type declarations for structs/interfaces
    importTypes: ['import_declaration'],
    variableTypes: ['var_declaration', 'const_declaration', 'short_var_declaration'],
    getFunctionName(node) {
        const nameNode = findChildByField(node, 'name');
        const methodName = nameNode?.text ?? null;
        if (!methodName) return null;
        // #489: Go method receivers (`func (u *UserPayload) Bind()`) all
        // produce the same bare name without a receiver-aware extraction,
        // colliding on `flow:<file>:Bind` when a file declares the same
        // method name on multiple receiver types. Prefix the method name
        // with the receiver type so the resulting graph IDs are distinct
        // (`UserPayload.Bind`, `ArticleRequest.Bind`).
        if (node.type !== 'method_declaration') return methodName;
        const receiver = findChildByField(node, 'receiver');
        if (!receiver) return methodName;
        // receiver is a parameter_list wrapping at least one parameter_declaration.
        const paramDecl = findChild(receiver, 'parameter_declaration');
        const typeNode = paramDecl ? findChildByField(paramDecl, 'type') : null;
        if (!typeNode) return methodName;
        // type may be `pointer_type` wrapping `type_identifier` (`*UserPayload`)
        // OR a bare `type_identifier` (`UserPayload`) OR `generic_type` for
        // generics (uncommon for receivers, but tolerate). Unwrap pointer.
        let receiverTypeNode = typeNode;
        if (receiverTypeNode.type === 'pointer_type') {
            const inner = findChild(receiverTypeNode, 'type_identifier')
                ?? findChild(receiverTypeNode, 'generic_type');
            if (inner) receiverTypeNode = inner;
        }
        if (receiverTypeNode.type === 'generic_type') {
            const inner = findChild(receiverTypeNode, 'type_identifier');
            if (inner) receiverTypeNode = inner;
        }
        const receiverName = receiverTypeNode.text;
        if (!receiverName) return methodName;
        return `${receiverName}.${methodName}`;
    },
    getClassName(node) {
        // type_declaration > type_spec > name
        const typeSpec = findChild(node, 'type_spec');
        if (typeSpec) {
            const nameNode = findChildByField(typeSpec, 'name');
            return nameNode?.text ?? null;
        }
        return null;
    },
    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const params = findChildByField(node, 'parameters');
        const paramText = params ? nodeText(params, source) : '()';
        // For method declarations, include receiver
        const receiver = findChildByField(node, 'receiver');
        const receiverText = receiver ? nodeText(receiver, source) + ' ' : '';
        return `func ${receiverText}${name}${paramText}`;
    },
    getImports(node, source) {
        const results: Array<{ local: string; source: string }> = [];
        // import "fmt" or import ( "fmt" \n "os" )
        const importSpecs = node.descendantsOfType('import_spec');
        for (const spec of importSpecs) {
            const pathNode = findChild(spec, 'interpreted_string_literal');
            if (pathNode) {
                const importPath = pathNode.text.replace(/"/g, '');
                const parts = importPath.split('/');
                const localName = parts[parts.length - 1];
                const aliasNode = findChildByField(spec, 'name');
                results.push({ local: aliasNode?.text ?? localName, source: importPath });
            }
        }
        // Single import
        if (results.length === 0) {
            const pathNode = findChild(node, 'interpreted_string_literal');
            if (pathNode) {
                const importPath = pathNode.text.replace(/"/g, '');
                const parts = importPath.split('/');
                results.push({ local: parts[parts.length - 1], source: importPath });
            }
        }
        return results;
    },
    getVariableName(node) {
        const varSpec = findChild(node, 'var_spec') ?? findChild(node, 'const_spec');
        if (varSpec) {
            const nameNode = findChildByField(varSpec, 'name') ?? findChild(varSpec, 'identifier');
            return nameNode?.text ?? null;
        }
        // short_var_declaration: x := ...
        if (node.type === 'short_var_declaration') {
            const left = findChild(node, 'expression_list');
            const firstId = left ? findChild(left, 'identifier') : null;
            return firstId?.text ?? null;
        }
        return null;
    },
};
