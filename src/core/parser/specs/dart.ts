/**
 * specs/dart.ts — Dart language spec.
 *
 * Dart's tree-sitter grammar (tree-sitter-wasms@0.1.13) is stuck on
 * Dart 2.x — it produces ERROR nodes for Dart 3 syntax (switch
 * expressions, `abstract final class`, sealed/base modifiers, records,
 * patterns). The dispatcher in `treeSitterExtractor.ts` falls back to a
 * regex extractor in that case, but the tree-sitter spec itself only
 * needs to handle the patterns the grammar can parse. Mixins join the
 * `implementsInterfaces` bucket because we don't have a separate
 * "mixin" field on `EntityRecord`.
 */

import { type LanguageSpec, findChild, nodeText } from './_shared';

export const DART_SPEC: LanguageSpec = {
    functionTypes: ['function_signature'],
    classTypes: ['class_definition'],
    importTypes: ['import_or_export'],
    variableTypes: ['static_final_declaration_list', 'initialized_identifier_list'],

    getFunctionName(node) {
        const id = findChild(node, 'identifier');
        return id?.text ?? null;
    },

    getClassName(node) {
        const id = findChild(node, 'identifier');
        return id?.text ?? null;
    },

    getFunctionSignature(node, source) {
        const name = this.getFunctionName(node) ?? 'anonymous';
        const params = findChild(node, 'formal_parameter_list');
        const paramText = params ? nodeText(params, source) : '()';
        const returnType = findChild(node, 'type_identifier') ?? findChild(node, 'void_type');
        const retText = returnType ? nodeText(returnType, source) + ' ' : '';
        return `${retText}${name}${paramText}`;
    },

    getImports(node, source) {
        const libImport = findChild(node, 'library_import');
        if (!libImport) return [];
        const importSpec = findChild(libImport, 'import_specification');
        if (!importSpec) return [];
        const uri = importSpec.descendantsOfType('uri');
        if (uri.length === 0) return [];
        const raw = nodeText(uri[0], source).replace(/^['"]|['"]$/g, '');
        // e.g. "package:flutter/material.dart" → "flutter/material.dart"
        const source_ = raw.replace(/^package:/, '');
        const local = source_.split('/').pop()?.replace('.dart', '') ?? source_;
        return [{ local, source: source_ }];
    },

    getVariableName(node) {
        // static_final_declaration_list → static_final_declaration → identifier
        const decl = findChild(node, 'static_final_declaration');
        if (decl) {
            const id = findChild(decl, 'identifier');
            return id?.text ?? null;
        }
        // initialized_identifier_list → initialized_identifier → identifier
        const initId = findChild(node, 'initialized_identifier');
        if (initId) {
            const id = findChild(initId, 'identifier');
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
        return decorators;
    },

    getClassHierarchy(classNode, _source) {
        let extendsClass: string | undefined;
        const implementsInterfaces: string[] = [];
        // Dart: class Foo extends Bar implements Baz, Qux
        const superclass = findChild(classNode, 'superclass');
        if (superclass) {
            const typeId = findChild(superclass, 'type_identifier');
            if (typeId) extendsClass = typeId.text;
        }
        const interfaces = findChild(classNode, 'interfaces');
        if (interfaces) {
            const typeIds = interfaces.descendantsOfType('type_identifier');
            for (const t of typeIds) {
                implementsInterfaces.push(t.text);
            }
        }
        // Dart mixins: class Foo with Mixin1, Mixin2
        const mixins = findChild(classNode, 'mixins');
        if (mixins) {
            const typeIds = mixins.descendantsOfType('type_identifier');
            for (const t of typeIds) {
                implementsInterfaces.push(t.text);
            }
        }
        return {
            extendsClass: extendsClass || undefined,
            implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : undefined,
        };
    },
};
